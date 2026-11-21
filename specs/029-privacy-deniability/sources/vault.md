# 029 research: a deniable vault file (VeraCrypt-style), prior art

All sources were accessed on 2026-11-21. "Undated" means the page shows no date, so it is the live page as of that day. **[unverified]** marks claims I could not check in a primary source.

## 1. VeraCrypt: header, hidden volume, limits

**Layout.** A volume is laid out like this ([Volume Format Specification](https://veracrypt.io/en/VeraCrypt%20Volume%20Format%20Specification.html), undated):

- 0..65535: the standard header (64 KiB).
- 65536..131071: the hidden-volume header. If there is no hidden volume, this area holds random bytes.
- 131072: data starts here.
- Size − 131072: the backup of the standard header.
- Size − 65536: the backup of the hidden header (random if unused).

Inside each header, only 512 bytes are used:

- Bytes 0–63: the salt, in clear (64 bytes, which looks random).
- Bytes 64–511: encrypted. They hold the magic `"VERA"`, the version, a CRC-32 of bytes 256–511, the hidden volume size, the volume size, the data-area start and length, flags, the sector size, a CRC-32 of bytes 64–251, and the master keys from byte 256.

The source constants are in `src/Common/Volumes.h`: `TC_VOLUME_HEADER_SIZE` = 64 KiB, `TC_HIDDEN_VOLUME_HEADER_OFFSET` = 65536, `TC_VOLUME_HEADER_EFFECTIVE_SIZE` = 512, and `TC_VOLUME_DATA_OFFSET` = 131072 ([GitHub, master](https://github.com/veracrypt/VeraCrypt/blob/master/src/Common/Volumes.h)). The cross-platform code lives in `src/Volume/VolumeHeader.cpp`, `VolumeLayout.cpp`, `Volume.cpp` and `Pkcs5Kdf.cpp` ([src/Volume](https://github.com/veracrypt/VeraCrypt/tree/master/src/Volume)).

**How the password finds the header: trial decryption at two fixed offsets.** VeraCrypt reads bytes 0–511 and bytes 65536–66047. It then tries every combination of KDF and PRF, cipher or cascade, and key size on the first header. It accepts a header only if the decrypted bytes start with "VERA" and both CRCs match. If that fails, it tries the same combinations on the hidden header. If neither matches, it reports "wrong password, corrupted volume, or not a VeraCrypt volume". Hiding these parameters is what keeps the file looking random ([Encryption Scheme](https://veracrypt.io/en/Encryption%20Scheme.html), undated; [Hidden Volume](https://veracrypt.io/en/Hidden%20Volume.html), undated). The master keys never change, so changing the password only re-encrypts the header.

**KDF and PIM** ([Header Key Derivation](https://veracrypt.io/en/Header%20Key%20Derivation.html), undated; [PIM](https://veracrypt.io/en/Personal%20Iterations%20Multiplier%20%28PIM%29.html), undated):

- The salt is 512 bits.
- With PBKDF2, non-system volumes default to 500,000 iterations. With a PIM, iterations = 15,000 + PIM×1000.
- Argon2id is allowed for non-system volumes, with parallelism fixed at 1:
  - memory = min(64 + (PIM−1)×32, 1024) MiB;
  - iterations = 3 + ⌊(PIM−1)/3⌋ when PIM ≤ 31, else 13 + (PIM−31).
  - The default is PIM 12, which gives 416 MiB and 6 passes.
- VeraCrypt always derives 192 bytes of key material.
- The PIM is a second secret. Without it, a mount has to try every PIM.

**Hidden-volume placement.** The hidden volume sits in the outer volume's free space and ends at the outer volume's end. The wizard scans the outer filesystem's cluster bitmap to find the largest free run ([Hidden Volume](https://veracrypt.io/en/Hidden%20Volume.html)).

**Protection on write.** The user mounts the outer volume and also gives the hidden password. VeraCrypt decrypts the hidden header in RAM only to learn the range the hidden volume covers.

- Any write into that range is refused with "invalid parameter".
- The whole outer volume then becomes read-only until it is unmounted. The docs say this is deliberate: failing only some writes would itself reveal the hidden volume.
- Nothing about this is recorded on disk ([Protection of Hidden Volumes](https://veracrypt.io/en/Protection%20of%20Hidden%20Volumes.html), undated).
- In code: `Volume::CheckProtectedRange` sets `HiddenVolumeProtectionTriggered` and throws `VolumeProtected`; `WriteSectors` checks the flag on every write ([Volume.cpp](https://github.com/veracrypt/VeraCrypt/blob/master/src/Volume/Volume.cpp), master).

**License.** VeraCrypt is "multi-licensed under Apache License 2.0 and the TrueCrypt License version 3.0", and "the product as a whole is governed by the TrueCrypt License" ([License.txt](https://github.com/veracrypt/VeraCrypt/blob/master/License.txt)). This supports the decision not to reuse its code. The format ideas themselves are not code.

**Known attacks and limits:**

- **Multiple snapshots.** VeraCrypt's own docs say that an adversary who sees the volume at several points in time can tell which sectors changed. Changes inside "free" space then need an explanation ([Security Requirements for Hidden Volumes](https://veracrypt.io/en/Security%20Requirements%20for%20Hidden%20Volumes.html), undated).
- The same page warns about three more leaks:
  - wear levelling on SSDs and USB sticks;
  - journaling host filesystems, where NTFS can keep an old copy of a file container;
  - the OS or apps writing file names, temp files or passwords to unencrypted disks. Its advice is a hidden OS or a RAM-only live system.
- **Czeskis, St. Hilaire, Koscher, Gribble, Kohno, Schneier**, "Defeating Encrypted and Deniable File Systems: TrueCrypt v5.1a and the Case of the Tattling OS and Applications", USENIX HotSec 2008 ([paper](https://www.usenix.org/legacy/events/hotsec08/tech/full_papers/czeskis/czeskis_html/), July 2008):
  - Windows Vista's Recent Items `.lnk` files leaked hidden file names and volume serial numbers.
  - Word's auto-recover files stayed on C:.
  - Google Desktop cached copies of the files.
  - On multiple snapshots, the paper says "seemingly random bytes on the hard drive will change", which shows the hidden data. It studied mainly the one-time-access case.
- **Fredrickson, Barker, Long**, "A Multiple Snapshot Attack on Deniable Storage Systems", MASCOTS 2021 ([arXiv 2110.04618](https://arxiv.org/abs/2110.04618), 9 Oct 2021). This is the first concrete attack of this kind. It uses the pattern of consecutive block changes between two images, detects "moderately sized and large hidden volumes with high probability", and the authors say it applies to "most, if not all, implemented deniable storage systems".

**For us:** our vault is one file inside a P2P app's data directory, so the OS and app leaks apply in full. Any cache, index, log or thumbnail written outside the vault breaks deniability. That is a bigger risk than the format.

## 2. Deniable storage systems

| System | Venue / date | Layout | Threat model | Cost | Fit for us |
|---|---|---|---|---|---|
| **Mobiflage** (Skillen, Mannan) | NDSS 2013; TDSC 2014 | Hidden volumes sit at an offset in random-filled external storage. The offset "is derived from the user's deniable password", so no header points to them. | Single snapshot. The authors warn about TRIM and ext4. | "no data expansion"; setup takes about 2× longer (two random fills); throughput "limited impact", no figures on the page | The idea of a password-derived offset, with no index, matches us. **[unverified]**: the exact derivation formula; the PDF text could not be extracted. |
| **HIVE** (Blass, Mayberry, Noubir, Onarlioglu) | CCS 2014 | Write-only ORAM: every write goes to random places, so public and hidden writes look the same. Linux block device. | Multi-snapshot, with a formal definition. | Abstract: O(1) communication with polylog client memory. Measured: 0.095 MB/s public read and 0.013 MB/s public write on an HDD (from PD-DM's table); Shufflecake's paper cites about 200× slowdown and 50% wasted space. | Too slow for us. |
| **DEFY** (Peters, Gondree, Peterson) | NDSS 2015 | A log-structured deniable file system on YAFFS, built for flash. Supports several deniability levels and secure deletion. | Snapshot adversary. | "comparable" slowdown to WhisperYAFFS | Only the idea carries over: append-only logs fit flash. |
| **DataLair** (Chakraborti, Chen, Sion) | PoPETs 2017(3) | Public data stays fast. Only hidden writes go through a cheaper write-only ORAM, and they are hidden among random free-block choices. | Multi-snapshot | HDD, MB/s. dm-crypt / DataLair / HIVE: public read 225.56 / 84.10 / 0.88; public write 210.10 / 2.00 / 0.57; hidden read n/a / 6.00 / 5.36; hidden write n/a / 2.92 / 0.60. Usable space at most 50% of the device. | The core idea is that public writes must look random so that hidden writes can hide among them. |
| **Artifice** (Barker et al.) | USENIX FOCI 2019 (Aug 2019). The user remembered MSST 2017: **[unverified]**, I found no such paper; there is an MSST 2020 follow-up. | Hidden blocks are mixed with entropy blocks by erasure codes into "carrier blocks" kept in a normal file system's free space. Any subset of the carriers rebuilds the data, so it repairs itself after overwrites. | Single snapshot plus operational security; the page states no multi-snapshot claim. | no figures on page | The useful idea is redundancy against being overwritten by the decoy. |
| **MobiCeal** (Chang, Zhang, Chen et al.) | DSN 2018 | Block layer. "Dummy writes" go to free space, so changes to hidden data can be blamed on dummy activity. | Multi-snapshot | About 18% overhead versus Android FDE; switching modes takes under 10 s. Known gap: with no public writes between two snapshots, hidden writes show (S&P 2020 poster). | Cheap, and it matches us well. |
| **PD-DM** (Chen, Chakraborti, Sion) | PoPETs 2019(1) | Every physical write goes to the next sequential address (log head). Each public write carries a hidden or dummy write, so the write trace looks the same with or without hidden data. A spare factor ρ of free space is reserved. | Multi-snapshot | HDD 5400 rpm, MB/s. dm-crypt / PD-DM / HIVE: public read 97.3 / 17.45 / 0.095; public write 88.0 / 1.35 / 0.013; hidden read n/a / 12.03 / 0.113; hidden write n/a / 1.46 / 0.016. PD-DM is 100–150× faster than HIVE on sequential I/O and 330× on random I/O. | The best known multi-snapshot design. The price is about 60× slower public writes than plain encryption. |
| **Shufflecake** (Anzuoni, Gagliardoni) | CCS 2023 (extended abstract); arXiv 2310.04589 v3, 22 Aug 2024 | Up to 15 nested volumes, 1 MiB slices, random slice allocation (details in §4–6). | Provable single snapshot only. | 4 KiB fio, MB/s. Shufflecake / dm-crypt / VeraCrypt: random write 26.77 / 38.43 / 39.07; sequential write 176.87 / 247.14 / 247.75. About 30% slower. | The closest match to us: several identities, trial-decrypted slots, slice maps. |
| **INVISILINE** (Pinjala, Carbunar, Chakraborti, Sion) | IEEE S&P 2024 | Hidden data is stored inside the IVs of a normal dm-crypt layout, so the disk looks like plain dm-crypt ("plausible invisibility"). | Multi-snapshot | About 19 GB hidden per 1 TB; no cost to public I/O; hidden writes about 4.5 MB/s | Tied to dm-crypt's layout; the idea is to hide inside the randomness a format already needs. |
| **RecoCoDe** (Estrada-Galiñanes, Milicevic) | PETS FOCI 2024 | "Simple entanglements" (an erasure code) in Shufflecake hidden volumes, to survive overwrites while a volume is closed. | n/a (reliability) | The paper shows a 3% storage-overhead case. mdadm RAID on Shufflecake cost 1–3× on reads and 2–5× on writes. | Relevant if we allow overcommit. |

Sources for the table:

- Mobiflage: [project page](https://ccsl.carleton.ca/~askillen/mobiflage) (undated) and [NDSS 2013 page](https://www.ndss-symposium.org/ndss2013/implementing-deniable-storage-encryption-mobile-devices).
- HIVE: [ePrint 2014/344](https://eprint.iacr.org/2014/344) (received 2014-05-19, revised 2014-09-04). The PDF itself returned 403, so the measured figures come from PD-DM's Table 2.
- DEFY: [NDSS 2015 page](https://www.ndss-symposium.org/ndss2015/defy-deniable-encrypted-file-system-log-structured-storage) (Feb 2015).
- DataLair: [PoPETs 2017-0035 PDF](https://www.petsymposium.org/popets/2017/popets-2017-0035.pdf), Table 1 and §5.2; [arXiv 1706.10276](https://arxiv.org/abs/1706.10276) (30 Jun 2017).
- Artifice: [FOCI '19 page](https://www.usenix.org/conference/foci19/presentation/barker).
- MobiCeal: [NSF PAR record](https://par.nsf.gov/biblio/10068616) (DSN 2018, DOI 10.1109/DSN.2018.00054). The figures come from search snippets of that record: **[partly unverified]**, the full text was not read.
- PD-DM: [PoPETs 2019-0009 PDF](https://www.petsymposium.org/popets/2019/popets-2019-0009.pdf), §3, §4.3, §5 and Table 2.
- Shufflecake: [arXiv 2310.04589v3](https://arxiv.org/html/2310.04589v3) (22 Aug 2024).
- INVISILINE: [author page](https://sandeepkiranp.github.io/publication/invisiline/) (S&P, July 2024).
- RecoCoDe: [FOCI 2024 PDF](https://www.petsymposium.org/foci/2024/foci-2024-0013.pdf).

**Other 2024–2026 work.** I found no paper called "Sonic" in this field **[not found]**. Two other items:

- PEARL, a deniable flash translation layer using WOM codes (USENIX Security 2021, [PDF](https://www.usenix.org/system/files/sec21summer_chen-chen.pdf)).
- MDEFTL, listed on ResearchGate with a date of Dec 2025. **[unverified]**: venue unknown.

Both live in the flash firmware layer, which an app cannot reach.

The main 2024–2026 change to Shufflecake is in the code, not a new paper. Version 0.5.0 (2024-09-01) made the "Lite" scheme the default and moved the old one to "Legacy". The latest release is v0.6.2 (2026-09-21) ([CHANGELOG](https://codeberg.org/shufflecake/shufflecake-c/raw/branch/main/CHANGELOG.md); [shufflecake.net](https://shufflecake.net/)). The paper's §6 describes Lite: XTS instead of CTR, so no IVs are stored, it is crash-consistent, and it is still single-snapshot only.

**Shufflecake license:** GPLv2 or later ([shufflecake.net](https://shufflecake.net/); [repo README](https://codeberg.org/shufflecake/shufflecake-c)). Reading the design is fine. Copying its code into an MIT or Apache JS library is not.

## 3. Defences against an adversary who sees the file twice

| Defence | What it costs (from the papers) |
|---|---|
| **Write-only ORAM** (HIVE) | Every write goes to random places. 0.013–0.095 MB/s on an HDD, and about 50% of the space is wasted (PD-DM Table 2; Shufflecake intro). |
| **Write-only ORAM for hidden data only** (DataLair) | Public reads at 37% of dm-crypt (84 vs 226 MB/s). Public writes are about 100× slower (2.0 vs 210 MB/s). At most 50% of the device is usable. |
| **Log-structured, every write sequential, each public write carries a hidden or dummy write** (PD-DM) | Public writes 1.35 vs 88 MB/s for dm-crypt (about 65×). Public reads 17.5 vs 97 MB/s. Plus a reserved spare factor ρ. |
| **Dummy writes into free space** (MobiCeal) | About 18% overhead. Fails when no public writes happen between two snapshots (S&P 2020 poster); the fix proposed is dummy writes while idle. |
| **Shufflecake's proposals** (§6, not built) | *Trivial random refresh*: re-randomise free slices with probability p1 and used slices with p2. The paper flags it as insecure against many snapshots, because the signal adds up. *Subsampling*: copy each real write, with probability p, as a re-randomisation at the same offset in a chosen free slice. It suffers counting attacks, answered by splitting free space into N_MAX−N fake volumes. *Ghost file systems*: fake volumes that run real file systems and give up slices when needed. The website's planned fix is "a daemon that simulates user activity on the empty space of the topmost unlocked volume". No costs are published. |
| **Hiding in randomness the format already needs** (INVISILINE) | No cost to public I/O, but only about 1.9% of capacity (19 GB per TB) and 4.5 MB/s for hidden writes. |
| **Rewriting the whole file each time** | No paper measures this. It is obviously sound: every byte changes, so nothing stands out. It costs a full file write per save, which only works for small vaults. **[my inference, not from a source]** |

Key rule from DataLair §1 and PD-DM §3: every change to free-looking space must be explained by normal public activity, so the write pattern must not depend on whether hidden data exists. For us, the simplest version is that every save rewrites a fixed or random set of slots of the same size, whether they are real or dummy. No design beats single-snapshot security cheaply; every multi-snapshot design pays 18% (MobiCeal, weakest) up to 65× (PD-DM) on writes.

## 4. How a password finds its slot without a stored index

- **VeraCrypt:** two fixed offsets (0 and 65536) plus their backups. It tries every KDF and cipher combination on each and checks the "VERA" magic and the CRCs (§1). Weakness: only two volumes, and the cost of trying grows with the number of algorithms.
- **Shufflecake** (arXiv v3 §3; site):
  - The device starts with a master block. It holds one KDF salt shared by all volumes and N_MAX = 15 encrypted cells. Cells for volumes that do not exist are random.
  - The password goes through Argon2id with the global salt to give a key-encryption key. The software then tries that key on each cell with authenticated encryption (AES-GCM), so a wrong key just fails.
  - Each opened volume's header holds the key of the volume below it. Opening volume i therefore opens 0 to i−1 as well.
  - There are always 15 headers, which hides how many volumes exist.
  - The KDF history: Scrypt in 0.2.0; Argon2id with one global salt from 0.3.0 (2023-07-11); parameters lowered in 0.3.1 ([CHANGELOG](https://codeberg.org/shufflecake/shufflecake-c/raw/branch/main/CHANGELOG.md)). **[unverified]**: the current Argon2id m and t values; the repo pages blocked automated reading.
- **Mobiflage:** the hidden volume's offset is derived from the password, so there is nothing to find ([project page](https://ccsl.carleton.ca/~askillen/mobiflage)).
- **For us:** one global salt plus N fixed slots lets one Argon2id run serve every slot, followed by N cheap AEAD tries. With a salt per slot, the unlock costs N Argon2id runs. Shufflecake moved to a single salt in 0.3.0 for this reason. **[inference; the changelog does not say why]**

**Argon2id parameter recommendations:**

- **RFC 9106 §4** (Sep 2021, [rfc-editor](https://www.rfc-editor.org/rfc/rfc9106.html)):
  - First recommended: t=1, p=4, m=2 GiB.
  - Second recommended, for low memory: t=3, p=4, m=64 MiB.
  - Both use a 128-bit salt and a 256-bit tag.
- **OWASP Password Storage Cheat Sheet** ([page](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), undated, live 2026-11-21). These are minimums of equal strength, all p=1:
  - m=46 MiB, t=1
  - m=19 MiB, t=2
  - m=12 MiB, t=3
  - m=9 MiB, t=4
  - m=7 MiB, t=5

  These target server login, which is a different job from protecting data offline.
- **libsodium** ([crypto_pwhash_argon2id.h](https://raw.githubusercontent.com/jedisct1/libsodium/master/src/libsodium/include/sodium/crypto_pwhash_argon2id.h), master; [docs](https://doc.libsodium.org/password_hashing/default_phf), undated):

  | Preset | opslimit | memlimit | Timing (docs) |
  |---|---|---|---|
  | INTERACTIVE | 2 | 64 MiB | none given |
  | MODERATE | 3 | 256 MiB | about 0.7 s on a 2.8 GHz Core i7 |
  | SENSITIVE | 4 | 1 GiB | about 3.5 s on a 2.8 GHz Core i7 |

  - `SALTBYTES` = 16.
  - The docs suggest about 1 s for an online login and about 5 s for a desktop app that asks for the password once per session.
  - The docs say to store the parameters, not rely on the constants, because the constants can change.
  - The CPU and date behind the docs' timings are unknown.
- **VeraCrypt's Argon2id default** is 416 MiB and 6 passes (PIM 12; §1).
- **For a vault file:** the parameters cannot sit in clear in the file, because that would mark it as a vault. Either fix them in the app version, or make them part of a secret such as a PIM. VeraCrypt does the latter.

**AEAD size:** XChaCha20-Poly1305 uses a 24-byte nonce (random nonces are safe), a 32-byte key and a 16-byte tag. Secretstream adds 17 bytes per message and a 24-byte header ([libsodium AEAD doc](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction); [secretstream header](https://raw.githubusercontent.com/jedisct1/libsodium/master/src/libsodium/include/sodium/crypto_secretstream_xchacha20poly1305.h)). The 16, 24 and 32 sizes are libsodium's documented constants; the fetched pages named them without their numbers.

## 5. Growing a vault without the passwords

- **Shufflecake:** each volume header stores `numslices`, which "fixes the size of the slice maps, even in the case that the device is resized" (arXiv v3 §3). The format expects the device might be resized, but neither the paper nor the README describes a resize command. The README says "adding more volumes after initialization is not yet supported" ([repo](https://codeberg.org/shufflecake/shufflecake-c)). **[no system found that grows a deniable volume blind]**
- **VeraCrypt:** the backup headers sit at the end of the file (Size−131072 and Size−65536). Appending bytes therefore moves "the end", and the backups stop being where they should be. The docs do not cover growing a hidden volume. **[unverified: VeraCrypt's volume-expander tool for hidden volumes]**
- **What follows from the designs** **[inference]**:
  - With slice maps from logical to physical slices (Shufflecake, PD-DM, DataLair), new physical space can be appended as fresh random slices, without any password.
  - Each volume only learns about the new slices when it is next opened. Until then, its slice map ignores them. That is fine, because random allocation only picks from slices the open volumes know are free.
  - The leak: the file size changes, which an adversary with two snapshots sees. The growth step should therefore be something every user does, and look the same with or without hidden volumes, for example in fixed steps of a size the app always uses.
  - Fixed slice tables sized for the maximum (Shufflecake's `numslices`) limit growth unless each table also leaves room for more.

## 6. Space accounting: "X GB left" and avoiding overwrites

- **Shufflecake is honest that it does not avoid them.**
  - Every volume reports the full device size (overcommit).
  - Writing past real capacity gives I/O errors.
  - A volume that is not open is invisible, so its slices look free and can be allocated to an open volume. That corrupts the closed volume. The design accepts this, because refusing those slices would reveal them.
  - The advice is to "unlock all volumes for daily use" ([shufflecake.net FAQ](https://shufflecake.net/); README).
  - When slice maps collide, the code gives the slice to the higher volume, and the lower one loses that slice (`HandleCorruption`, arXiv v3 §5). Version 0.4.2 (2023-11-28) allocates fresh slices for corrupted volumes (CHANGELOG).
  - `sflc list` shows "approximate usage" for the volumes that are open, and nothing about closed ones (README).
- **VeraCrypt does the same in a simpler way.** It protects the hidden volume only when the hidden password is typed at mount time (§1). Without it, the outer volume can overwrite the hidden one.
- **DataLair Full and PD-DM** keep one shared pool of physical blocks. Space not used by hidden data is open to public data, and the reverse (DataLair §5.2). DataLair limits the total use to 50% of the device.
- **Mitigations:**
  - erasure codes in the hidden volume (RecoCoDe; Artifice's self-repair);
  - VeraCrypt-style protection when the hidden password is given;
  - honest UI. **[inference]** The only number the app can show truthfully is "free space as seen by the identities open now". A correct display requires opening all identities. A decoy session should say space is approximate, and it should not suggest anything about closed volumes.
- **Overhead numbers:**
  - Shufflecake (arXiv v3 §5): 4 KiB blocks; a 1 MiB slice (256 blocks) is stored in 257 blocks, one of them an IV block, which is under 0.4% overhead. Each volume header is about 4 MiB for a 1 TiB disk, about 60 MiB total. Usable space is 1019.91 GiB of 1 TiB, over 99.6%. Fragmentation keeps space efficiency above 90% at 10% fill and 95% at 25% fill. The site says metadata takes under 0.5% of 1 TB in the worst case.
  - Shufflecake Lite uses XTS, so it stores no IV block.
  - VeraCrypt: 256 KiB fixed: four 64 KiB header areas, two at the start and two at the end. No per-block metadata, because XTS adds no authentication.
  - Our case **[inference]**: XChaCha20-Poly1305 per block costs 24 + 16 = 40 bytes. That is about 1% of a 4 KiB block, and about 0.004% of a 1 MiB chunk. Using the block number as an implicit nonce cannot work with re-randomisation; a random 24-byte nonce per write is the safe choice.

## Bottom line for the design

- Copy the structure, not the code. Shufflecake gives the shape: one salt, N trial-decrypted AEAD slots, slice maps, random allocation. It is GPL, so we must not copy its code.
- Accept single-snapshot security as the honest target. It is the level of VeraCrypt and Shufflecake. Say so in the docs.
- If we want any multi-snapshot claim, the cheapest proven idea is MobiCeal or PD-DM style: the write pattern does not depend on whether hidden data exists, using dummy writes, at a cost of about 18% to 65×.
- Show free space only for the identities that are open, and warn that closed ones can be overwritten. Consider erasure codes.
- The larger risk is leaks outside the vault (Czeskis 2008), not the format.
