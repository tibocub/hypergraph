# Research 029: privacy and deniability

Written 2026-11-21. Sources were read on that day unless a date is given; "undated" means the page shows no date.
Local code means the installed copy in `E:\Code\P2P\hypergraph\node_modules` (corestore 7.13.0, hypercore
11.37.2, hypercore-storage 3.3.2, rocksdb-native 3.19.1, hyperswarm 4.17.2, autobase 7.28.2, sodium-native 5.1.0)
and Electron 42.11.18 from HyperBrowser's `node_modules`. Measurements ran on this machine (Windows 10, data on E:,
a spinning disk). Prototypes: `research/privacy/` (how to run them: its README). **[unverified]** marks what I
couldn't check against a primary source.

## The short answer

- **The vault is feasible, and the format is the easy part.** Copy Shufflecake's shape (one salt, a fixed number
  of encrypted slots tried with one Argon2id run, 1 MiB slices placed at random), not its code (GPL). The
  prototype's crypto runs at ~0.9 GB/s, so speed depends only on writing in large pieces: random 4 KiB pages ran
  at 3–5 MB/s on this disk, random 1 MiB pieces at 64 MB/s, the same as a plain file.
- **Two decisions need changing:**
  - **D4/D9 (shared capacity).** Identities that share space and don't know about each other overwrite each other.
    Every system that shares space (VeraCrypt, Shufflecake) solves this the same way: the hidden password also
    opens the identities below it. So identities must be **nested**: decoy < hidden 1 < hidden 2.
  - **D7 (random sync delays).** In a simulation, delays of up to an hour didn't stop a holder from linking a hidden
    identity to the main identity on the same device: both come online at the same moments, and 100 of 100 were
    linked within 14 days. What protects is that the two identities **share no holder and no connection** (Tor
    circuits, holders, circles), and not delays.
- **Storage inside the vault:** hypercore and the local index both sit on rocksdb-native, which can only write to
  real files. The clean path is a **vault file system inside a fork of rocksdb-native** (C++, RocksDB's
  `FileSystem` interface), plus routing hypergraph's four small files (`instance.json`, `logs`, the recovery
  phrase, `CORESTORE`) through the vault. A virtual drive (WinFsp, FUSE) needs drivers and doesn't work on Android.
- **Device traces:** a non-`persist:` Electron session wrote **nothing** of the site's data to disk in my test,
  while a `persist:` one wrote it into 8 files. What no app can avoid (Prefetch, SRUM, swap, hibernation) shows
  that HyperBrowser ran, not which identity. Full-disk encryption is the honest advice. Site profiles can't live in
  the vault file (Chromium needs a real folder), so **hidden identities' site sessions stay in memory** (D9 changes
  slightly).
- **Secure chats:** not full MLS. MLS needs one agreed Commit per epoch, and the only JS implementation (ts-mls) is
  unaudited; libsignal is AGPL. At ≤50 members, **Sender-Keys-style chains, one per writer core, rekeyed
  pairwise** fit Autobase best. Deniability (D6) conflicts with hypercore signing every block: it needs
  **short-lived writer keys per epoch**, opt-in.
- **Padding:** Padmé costs +3% on real blocks from a private forum, a 256 B floor plus Padmé +31%, and four fixed
  buckets (256 B / 1 / 4 / 16 / 64 KiB) +107%. Tor's 498-byte cells already blur sizes for a network observer, not
  for holders.

---

## RQ1. The vault

### a. Layout

**What others do.**

- **VeraCrypt** ([Volume Format Specification](https://veracrypt.io/en/VeraCrypt%20Volume%20Format%20Specification.html),
  undated; `src/Common/Volumes.h`, master):
  - Two 64 KiB header areas at offsets 0 and 65536, and backups at the end. 512 bytes of each are used: a 64-byte
    salt in clear, then encrypted fields with the magic `VERA` and two CRC-32s.
  - A password finds its header by **trial decryption**: VeraCrypt tries every KDF and cipher on the first header,
    then on the hidden one ([Encryption Scheme](https://veracrypt.io/en/Encryption%20Scheme.html), undated).
  - Its Argon2id default (PIM 12) is 416 MiB and 6 passes ([PIM](https://veracrypt.io/en/Personal%20Iterations%20Multiplier%20%28PIM%29.html),
    undated).
  - Hidden-volume protection: when both passwords are given, any write into the hidden range is refused and the
    outer volume turns read-only; refusing only some writes would itself reveal the hidden volume (`CheckProtectedRange`
    in `src/Volume/Volume.cpp`; [Protection of Hidden Volumes](https://veracrypt.io/en/Protection%20of%20Hidden%20Volumes.html), undated).
  - Licence: Apache 2.0 plus TrueCrypt License 3.0, "the product as a whole is governed by the TrueCrypt License"
    ([License.txt](https://github.com/veracrypt/VeraCrypt/blob/master/License.txt)). The decision not to copy its
    code holds.
- **Shufflecake** (Anzuoni, Gagliardoni, CCS 2023; [arXiv 2310.04589 v3](https://arxiv.org/html/2310.04589v3),
  2024-08-22), the closest match to us:
  - Up to 15 volumes. A master block holds **one salt shared by all volumes** and 15 encrypted cells; cells of
    volumes that don't exist are random, so the count stays hidden.
  - The password runs Argon2id once with that salt, then that key is tried on each cell with authenticated
    encryption.
  - **Each volume's header holds the key of the volume below it**: opening volume *i* opens 0…*i*−1 too.
  - Space is cut into 1 MiB slices, placed at random; each volume keeps a slice map.
  - About 30% slower than dm-crypt (4 KiB random write 26.8 vs 38.4 MB/s; sequential 177 vs 247 MB/s).
  - Single-snapshot security only. Licence GPLv2+ ([shufflecake.net](https://shufflecake.net/)): we read the design,
    we don't copy the code. Latest release v0.6.2, 2026-09-21 ([CHANGELOG](https://codeberg.org/shufflecake/shufflecake-c/raw/branch/main/CHANGELOG.md)).
- **Mobiflage** (NDSS 2013; [project page](https://ccsl.carleton.ca/~askillen/mobiflage), undated): the hidden
  volume's offset is derived from the password, with no header at all. **[unverified]**: the exact formula.
- **Artifice** (USENIX FOCI 2019, [page](https://www.usenix.org/conference/foci19/presentation/barker)) and
  **RecoCoDe** (FOCI 2024, [PDF](https://www.petsymposium.org/foci/2024/foci-2024-0013.pdf)): erasure codes so a
  hidden volume survives being partly overwritten (RecoCoDe shows a case at 3% storage overhead).
- **DEFY** (NDSS 2015, [page](https://www.ndss-symposium.org/ndss2015/defy-deniable-encrypted-file-system-log-structured-storage)):
  a log-structured deniable file system for flash. **HIVE**, **DataLair** and **PD-DM** answer snapshot attacks (b).
- **Known attacks.**
  - Czeskis et al., "Defeating Encrypted and Deniable File Systems", USENIX HotSec 2008
    ([paper](https://www.usenix.org/legacy/events/hotsec08/tech/full_papers/czeskis/czeskis_html/)): the OS and apps
    leaked what the hidden volume held (Recent Items `.lnk` files, Word auto-recover, Google Desktop's index).
  - Fredrickson, Barker, Long, MASCOTS 2021 ([arXiv 2110.04618](https://arxiv.org/abs/2110.04618)): the first
    concrete multiple-snapshot attack; it detects moderate and large hidden volumes in "most, if not all" deniable
    storage systems.
  - VeraCrypt's own warnings ([Security Requirements for Hidden Volumes](https://veracrypt.io/en/Security%20Requirements%20for%20Hidden%20Volumes.html),
    undated): SSD wear levelling, journaling file systems that keep old copies of a container file, and leaks from
    the OS.

**Proposed layout** (built in `research/privacy/vault/vault.js`, with 4 KiB pages for simplicity):

```
[ salt 32 B ][ 16 header slots x 4 KiB ][ slices x 1 MiB ... ]   all of it random-looking
```

- **Fill**: the whole file is random bytes at creation (`randombytes_buf`), 114 MB/s here (a 10 GB vault in
  ~1.5 minutes on this disk).
- **Unlock**: Argon2id(password, salt) once → a key → subkeys for header and data (BLAKE2b) → try the AEAD on each
  of the 16 slots. A slot that opens is that identity's. A wrong password and "no identity" look the same. One
  Argon2id run serves all slots, as in Shufflecake (a salt per slot would mean 16 runs).
- **Slot contents**: the identity's slice map pointer (a list of map slices), its name, and **the key of the
  identity below it** (nesting, see d).
- **Each page or slice**: a random 24-byte nonce, ciphertext, a 16-byte tag; its own number as associated data,
  so a slice copied elsewhere fails to open. Unused space within a written page is filled with random bytes, not
  zeros.
- **Argon2id parameters**: they can't be stored in the file in clear (that would mark it as a vault), so they are
  fixed per app version, as libsodium's docs warn they must be stored or pinned. Measured here: INTERACTIVE (ops 2,
  64 MiB) 59 ms, MODERATE (ops 3, 256 MiB) 344 ms, SENSITIVE (ops 4, 1 GiB) 1,981 ms. libsodium's docs
  ([default_phf](https://doc.libsodium.org/password_hashing/default_phf), undated) give 0.7 s and 3.5 s on a
  2.8 GHz i7 and suggest about 5 s for a desktop app that asks once per session. RFC 9106 §4
  ([rfc-editor](https://www.rfc-editor.org/rfc/rfc9106.html), Sep 2021) recommends t=1, m=2 GiB, or t=3,
  m=64 MiB. **Recommendation**: SENSITIVE on desktop (2 s here), MODERATE on phones; on a weak phone 1 GiB may not
  fit, so the phone build pins MODERATE and the file says nothing about which was used (a desktop tries both).
- **Self-check** (`vault/test.js`): the file passes a byte chi-square test (random), each password finds its own
  slot, a wrong one finds nothing, and the known limit shows: an identity written alone destroyed the map of one
  that wasn't open.

### b. Snapshot attacks

Someone who copies the vault twice (two border crossings, a backup and a seizure) sees which slices changed. If the
decoy wasn't used in between and slices changed, a hidden identity exists.

| Defence | Cost (from the papers) |
|---|---|
| Write-only ORAM for everything (HIVE, [ePrint 2014/344](https://eprint.iacr.org/2014/344)) | 0.013–0.095 MB/s on a disk, ~50% of space lost |
| Write-only ORAM for hidden data only (DataLair, [PoPETs 2017](https://www.petsymposium.org/popets/2017/popets-2017-0035.pdf)) | public writes 2.0 vs 210 MB/s; at most 50% of the device usable |
| Every public write carries a hidden or dummy write, all sequential (PD-DM, [PoPETs 2019](https://www.petsymposium.org/popets/2019/popets-2019-0009.pdf)) | public writes 1.35 vs 88 MB/s |
| Dummy writes into free space (MobiCeal, DSN 2018) | ~18%; fails if nothing public was written between the two snapshots **[figures from the record's abstract only]** |
| Shufflecake's proposals (random refresh, ghost volumes) | not built, no numbers |

**Our honest target is single-snapshot security**, like VeraCrypt and Shufflecake, and the docs must say so. One
cheap step does fit us: **the decoy is never idle**. The engine of every install keeps writing (replication,
holding, index compaction), so the app can rewrite a few random free slices on every session of every identity,
the main one included (MobiCeal's dummy writes). It costs a little disk wear and gives no proof of security; it
only makes "slices changed" ordinary. Two rules come from the papers: the write pattern must never depend on
whether a hidden identity exists, and growth (c) must look the same for everyone.

### c. Growth without passwords

No system found grows a deniable volume blind (Shufflecake stores a slice count "even in the case that the device is
resized" but has no resize command; VeraCrypt's backup headers sit at the end of the file). With slice maps it is
simple, and it needs no password: **append new random slices at the end**. Old slices keep their positions; the
copy is a plain byte copy (or an in-place extension of the file). Each identity learns about the new slices only
when next opened, because allocation only picks from slices the open identities see as free. Two cautions:

- The file size changes, which a two-snapshot adversary sees. Growth should happen in **fixed steps** (for example
  doubling, or +5 GB) and as an ordinary user action that the decoy plausibly needed.
- If the map has a fixed size, it must leave room for growth (Shufflecake's `numslices`).

The vault *can't* shrink without opening every identity.

### d. Capacity math and "X GB left"

- **Fixed overhead**: salt + 16 slots = 64 KiB.
- **Per slice**: 40 bytes of nonce and tag per AEAD unit. With 4 KiB units inside a slice that is 1% (needed so
  RocksDB can rewrite part of a file); with one AEAD per 1 MiB slice it is 0.004%, but then a small change rewrites
  1 MiB.
- **Maps**: 4 bytes per 1 MiB slice, 40 KB for a 10 GB vault.
- **Fragmentation**: RocksDB writes a few dozen files (a write-ahead log, sorted tables, blob files of 256 MB,
  manifests). The last slice of each file is half empty on average: for 50 files, ~25 MB lost. Shufflecake measured
  >95% space efficiency at 25% fill.
- **Total**: about 1–2% of the vault, plus 25 MB per identity.
- **Nesting.** Shufflecake doesn't stop closed volumes from being overwritten: a closed volume's slices look free,
  so an open one may take them, and the closed one loses them. It advises opening all volumes for daily use
  (FAQ). Our prototype shows the same: writing 1,450 pages with only one identity open destroyed the other's map.
  So:
  - **Identities are nested.** Each hidden identity's slot holds the key of the identity below it, so opening the
    hidden one opens the decoy too, and writes on either side are safe. Opening only the decoy can still overwrite
    a hidden identity. That's the price of deniability, as in Shufflecake.
  - A user can't have two hidden identities that each are secret from the other on one device. That fits "one
    person, several faces"; it doesn't fit "two people share a laptop".
  - Add a small erasure code (RecoCoDe's 3%) to hidden maps and headers, so a decoy session that took a few slices
    doesn't destroy a whole identity.
- **"X GB left"** is honest only as seen by the identities that are open: free = slices not in any open map. The
  app should show it with the budget it gives hypergraph (`hg.setBudget`, `lib/storage.js`), and never show
  anything that depends on closed identities. In a decoy session the number is larger than the truth; that is the
  point, and the one real risk (overwriting) is what nesting and erasure codes reduce.

### e. Hypercore and the local index inside the vault

**What the installed code writes.**

- corestore 7.13 → hypercore-storage 3.3.2 → **rocksdb-native 3.19.1** (`new RocksDB(dbPath, …)`,
  hypercore-storage `index.js:535`). The local index is HyperDB on RocksDB too (`HyperDB.rocks(dir, def)`,
  `lib/index.js:321`).
- rocksdb-native exposes no file-system or `Env` option to JavaScript (no `Env`/`FileSystem` in `binding.cc`):
  RocksDB writes real files at a real path.
- hypercore-storage accepts a ready database object instead of a path (`CorestoreStorage(db)`: "typeof db ===
  'string' ? db : null"), and rocksdb-native's `RocksDB` takes a `state` object that wraps every call into the
  native binding (`index.js`). Both are seams for a replacement written in JavaScript.
- hypergraph itself writes four small files next to the databases: `instance.json` (rewritten atomically),
  `logs` (appended), the recovery phrase (`lib/phrase.js`), and hypercore-storage's `CORESTORE` device file
  (`device-file`, a lock).
- **The load** (`vault/hypercore-io.js`): 20,000 appends of 200 B → 16.6 MB/s, 83,000 blocks/s, 7.0 MB on disk
  (1.75×); 800 × 64 KiB → 300 MB/s (OS cache), 1.00×. All of it lands in the write-ahead log first, appended in
  order; RocksDB later writes sorted tables in order and compacts. Its files are written front to back and never
  changed in place, which suits slices. RocksDB also writes a plain-text `LOG` file (40 KB here) with paths and
  settings: inside the vault it's harmless; outside it's a trace.

**Options.**

| Option | How | Speed | Cost and limits |
|---|---|---|---|
| **A. Virtual drive** (WinFsp/Dokan on Windows, FUSE on Linux) | Mount the open identity's part of the vault as a folder; RocksDB writes there unchanged | near native; extra copies through the kernel | Needs a driver installed with admin rights; none on Android without root; the mount point is visible to every process and to OS indexers while open. Rejected. |
| **B. A vault file system in a fork of rocksdb-native** | RocksDB's C++ `FileSystem` interface (`FileSystemWrapper`; RocksDB's own encrypted file system is built the same way **[from memory of RocksDB's headers, not re-read]**): each RocksDB file becomes a list of slices in the vault | the crypto ran at 0.9 GB/s here, so writing in slices costs about what a plain file costs (below) | C++ in a fork, prebuilt for the 13 platforms rocksdb-native ships; carrying the fork through upstream updates. Covers hypercore and the local index at once. **Recommended.** |
| **C. A RocksDB replacement in JavaScript** | Feed hypercore-storage and HyperDB an object with RocksDB's API (sessions, column families, read/write batches, iterators, snapshots), kept in memory and saved as an encrypted append-only log in the vault | in memory: fast; reopening replays the log | RAM = the identity's whole data (fine for chats, not for media); the API surface hypercore-storage uses is about 15 calls, but snapshot and iterator semantics must match exactly, or replication breaks quietly. Good for a first hidden identity that only chats; not a long-term answer. |
| D. Plain RocksDB on disk, encrypted per file (RocksDB's own encrypted env) | — | native | File names, counts and sizes stay visible: not deniable. Rejected. |

**Measured** (`vault/bench.js`, 256 MB vault, 32 MB written, on E:, a spinning disk; SSD not measured, C: has no
room):

| What | Speed |
|---|---|
| Sealing pages in memory (XChaCha20-Poly1305, CPU only) | 928 MB/s |
| Random fill at creation | 114 MB/s |
| Vault write, encrypted 4 KiB pages at random places, + fsync | 5.3 MB/s |
| Plain file, 4 KiB pages at random places, + fsync | 3.4–4.6 MB/s |
| Plain file, sequential, + fsync | 57.7–60.6 MB/s |
| Plain file, random **1 MiB** pieces, + fsync | 64.0 MB/s |
| Vault read, random pages (OS cache warm) | 196–198 MB/s |

What this says: encryption isn't the cost; **where** the bytes go is. Random 4 KiB placement is ~12× slower on a
disk (SSDs suffer much less). Slices of 1 MiB, filled in order, run at plain-file speed even when the slices
themselves are scattered. So option B with 1 MiB slices should run within a few percent of today's RocksDB (my
estimate from these numbers; the fork isn't built, so this isn't measured end to end).

**Recommendation**: B, with slices of 1 MiB, AEAD per 4 KiB inside a slice, and the four small files moved into
the database or through the same layer (a small `lib/` change). If a hidden identity is wanted before the fork
exists, C for chat-only identities, labelled as such.

## RQ2. Device traces

### Electron: tested

`research/privacy/electron-traces/main.js` runs a page on a local server that sets a cookie, Local and Session
Storage, IndexedDB, Cache API, a service worker, a cacheable 700 KB response, a 30 MB blob and a WebGL shader,
all holding a marker string; then `check.js` lists every file and greps for the marker. Electron 42.11.18,
Windows 10, `userData`, `temp` and `crashDumps` redirected to a test folder.

| Session | Files written | Files holding the marker |
|---|---|---|
| `persist:site-test` | 5.5 MB under `Partitions/site-test` | **8**: Cookies, HTTP cache (3 files), IndexedDB log, Local Storage log, Service Worker script cache, Cache Storage |
| non-`persist:` (in memory) | ~83 KB of empty default-session files at the `userData` root (Local Storage, Trust Tokens, Shared Dictionary, Code Cache, `Preferences` = spellcheck only, `Local State` = the OS-crypt key) | **none**, and the site's address appears in no file |
| in memory + `--disable-gpu-shader-disk-cache` | the same | none |

The window was hidden, so no GPU shader cache was written in either run; whether a visible window writes one isn't
tested. Chromium's source says the global shader caches (`ShaderCache`, `GrShaderCache`, `GraphiteDawnCache`)
ignore the partition (`content/browser/gpu/gpu_disk_cache_factory.cc`, main), so **pass
`--disable-gpu-shader-disk-cache`** whenever a hidden identity may open. Electron's source also suggests an
in-memory session saves its preferences (last file-dialog folder, download folder) into the default session's
`Preferences` file (`shell/browser/electron_browser_context.cc`, commit of 2026-11-18); my test (no dialogs) only
saw spellcheck there, so the file-dialog case is **[unverified]**: avoid native file dialogs for hidden
identities.

**Site profiles in the vault (D9) don't work with Electron as is**: Chromium writes a `persist:` partition into a
real folder, and the vault isn't one (no mount, RQ1e option A rejected). So **hidden identities' site sessions are
in memory**, gone when the identity closes. Sites keep what must last in hypergraph (the identity's personal space
or the site's own space), which is in the vault. That's the change to D9.

### What else is written, and what to do (details and links: `sources/traces.md`)

Windows 10/11:

| Trace | Avoid? | How |
|---|---|---|
| Notification database `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db` (keeps toast text) | yes | no OS notifications for a hidden identity, or a fixed generic title with no body (D11) **[path from forensic literature]** |
| Jump lists, Recent items | yes | never `app.addRecentDocument`; `app.clearRecentDocuments()`; no native open/save dialogs for hidden identities (the common dialog adds recent items itself, [Microsoft](https://learn.microsoft.com/en-us/windows/win32/shell/appids), 2025-04-15) |
| Clipboard history, cloud clipboard | yes | add the `ExcludeClipboardContentFromMonitorProcessing` format with copied text ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats), 2025-04-15) |
| Screenshots, thumbnails of the window | reduce | `win.setContentProtection(true)` |
| thumbcache, Windows Search index | yes | media stays in the vault and is decoded to memory only |
| Crash dumps | yes | never call `crashReporter.start()` (or point `crashDumps` into memory); "the crash reporter cannot be disabled once started" ([Electron](https://www.electronjs.org/docs/latest/api/crash-reporter)) |
| HyperBrowser's own `hyperbrowser.log` | yes | write nothing about identities there, and nothing at all while a hidden one is open (D11) |
| Prefetch, Amcache, ShimCache | **no** | show only that HyperBrowser ran |
| SRUM (`SRUDB.dat`: bytes sent and received per app) | **no** | per app, not per identity ([SANS ISC](https://isc.sans.edu/diary/System+Resource+Utilization+Monitor/21927/), 2017-01-12) |
| `pagefile.sys`, `hiberfil.sys` | **no** (machine settings) | keys only: lock them in memory (`sodium_mlock`, which calls `VirtualLock`); advise `powercfg /hibernate off` |

Linux: `recently-used.xbel` from GTK file dialogs (avoid native dialogs), the systemd journal (persistent by
default; print nothing about identities), systemd-coredump (`PR_SET_DUMPABLE` 0 needs a native call), swap
(advise encrypted swap), `~/.config/<app>` and `~/.cache/<app>` (in-memory sessions).

Android (Electron doesn't run there; the shell would be a WebView plus Bare, not researched in depth):
`allowBackup="false"` plus `dataExtractionRules` (device-to-device transfer), `FLAG_SECURE` and
`setRecentsScreenshotEnabled(false)` for the Recents screenshot, `IME_FLAG_NO_PERSONALIZED_LEARNING` on inputs
(a request only: third-party keyboards may ignore it), no notifications for hidden identities, strip logs
([Android docs](https://developer.android.com/identity/data/autobackup), undated).

Pear: `pear-runtime` writes only under the folder it's given (`pear-runtime/corestore` for updates,
`pear-runtime/next/<id>` for staged updates, `app-storage`), and the platform folder (`%APPDATA%\pear` or
`%LOCALAPPDATA%\pear`, `~/.config/pear`) holds `pear.log` and a cache of DHT peers
([pear-runtime](https://github.com/holepunchto/pear-runtime), 2026-11-18; [pear constants.js](https://github.com/holepunchto/pear/blob/main/constants.js)).
That shows HyperBrowser is installed and updated, not who uses it. Keep identity stores out of `app-storage`.

**The honest advice for users** (D11): the vault hides identities in HyperBrowser's own files. It can't hide that
HyperBrowser ran, how much it sent, or what the OS swapped or hibernated. Full-disk encryption (BitLocker, LUKS,
Android's file-based encryption, on by default) plus no hibernation is what makes the rest hold. Tor Browser leaves
swap to the OS for the same reason ([design doc](https://2019.www.torproject.org/projects/torbrowser/design/),
draft 2018-06-15).

## RQ3. Several identities in hypergraph

**Today one `Hypergraph` instance is one identity in one folder**, and the folder already separates what matters:

- the device key pair is made in that folder's Corestore (`createKeyPair('hypergraph/device')`, `lib/index.js:239`),
  and **it is the swarm key pair** (`new Network(this, { keyPair: device })`, `lib/index.js:244`);
- the identity, its proof, its personal space and its recovery phrase are all per folder;
- each instance opens its own Hyperswarm (`lib/network.js:78`); the `swarm` parameter to share one exists only
  inside `Network`, not in the public options.

So "several identities in one engine" means **several instances, one folder each (inside the vault for hidden
ones), each with its own Hyperswarm**, opened one at a time or side by side. What has to change:

- **Nothing shared in `lib/`**: no shared swarm, Corestore, primary key or holder process across identities. The
  internal `swarm` parameter must stay internal; add a test that two instances never share a key.
- **The four small files** (`instance.json`, `logs`, the recovery phrase, `CORESTORE`) go through the vault (RQ1e).
- **The engine** (HyperBrowser's Bare side) keeps a map of open identities and routes each site's calls to one of
  them. Site partitions are named per identity (`site-<identity>-<key>`), and in memory for hidden identities.
- **Holding** (`setHolding`) is per instance already; a hidden identity's switch for holding (D9) is that call.
- **SwarmFS**: one instance per identity as well (it builds on the core).

**What links two identities on one device today, and what closes it:**

| Link | Today | Fix |
|---|---|---|
| IP address | every peer and DHT node sees it; both identities announce from the same IP (different ports) | Tor mode (spec 028), with one circuit per identity (SOCKS-auth isolation); D3's warning without Tor |
| Swarm key pair / device key | already one per identity folder | keep it that way |
| DHT announces | each announces its spaces from the same IP | Tor mode drops the DHT |
| Holder membership | a device holding for circles of two identities serves both from one IP, and one holder process | holding is per instance; a hidden identity's circles must not include the main identity's holders |
| Shared holders | if the same holder serves both identities, it sees both come online together | **separate holders per identity**: the simulation below shows this is the main link |
| Timing (both online at the same moments) | linkable in days | separate holders and circuits; delays don't help (RQ5c) |
| Site profiles | `persist:site-<key>` is shared by every identity | per-identity partitions; in memory for hidden ones |
| The same person's writing style, active hours, contacts | out of scope for software | say so in the docs |

## RQ4. Secure conversations

### a. MLS vs Signal-style over our logs

- **MLS needs order.** RFC 9750 (April 2025, [rfc-editor](https://www.rfc-editor.org/rfc/rfc9750.html)) §5.2: "the
  group must agree on a single MLS Commit message that ends each epoch". It allows an "eventually consistent"
  delivery service: accept a Commit, keep the old state, roll back if another wins, and delete forked state soon
  to keep forward secrecy. Autobase's causal graph with a later agreed order fits that mode, at the price of
  keeping old epoch secrets until the order is confirmed.
- **Decentralised MLS is still research.** DMLS (draft-kohbrok-mls-dmls-03, 2025-10-20, expired, no IETF standing,
  [datatracker](https://datatracker.ietf.org/doc/draft-kohbrok-mls-dmls/)) gives each fork an id and protects the
  init secret with a puncturable PRF, but has no merge procedure. Fork-Resilient CGKA (CRYPTO 2023,
  [ePrint 2023/394](https://eprint.iacr.org/2023/394)) and DCGKA (Weidner et al., CCS 2021,
  [ePrint 2020/1281](https://eprint.iacr.org/2020/1281)) handle concurrency; DCGKA needs only causal order and costs
  one pairwise message per member per key change **[details from the abstract; the PDF returned 403]**. Concurrent
  updates erode TreeKEM's log(n) advantage (Auerbach et al., CRYPTO 2025, [ePrint 2025/1035](https://eprint.iacr.org/2025/1035)).
- **Signal-style fits better.** Double Ratchet (rev. 4, 2025-11-04, [spec](https://signal.org/docs/specifications/doubleratchet/))
  for 1:1, X3DH/PQXDH ([PQXDH](https://signal.org/docs/specifications/pqxdh/), rev. 3, 2024-01-23) to start it, and
  Sender Keys for groups: each writer has one symmetric chain, handed to every member over pairwise channels
  (libsignal `sender_keys.rs`). This matches "one hypercore per writer": each chain is linear inside its own core,
  so the ordering problem disappears. At 50 members a rekey is 50 small pairwise messages.
- **Proposal**: 1:1 = Double Ratchet over a two-writer space (a prekey published in the contact's personal-space
  profile starts it). Groups = one sender chain per writer core, ratcheted forward per message (forward secrecy);
  a new chain for everyone on removal and on a timer (post-compromise security, roughly); new chains sent pairwise
  (`crypto_box` to each member's current key). This is close to our current epoch keys, which rotate on removal
  only. Session's experience is the warning: they dropped forward secrecy in 2020 because the Signal protocol "was
  not designed to be run over a decentralised network" ([Session blog](https://getsession.org/blog/session-protocol-technical-information),
  2020-12-15), and are adding it back in Protocol V2 (announced 2025-12-01, still in design). Rotation on a timer
  and deleting old keys are the parts that make forward secrecy real.

### b. Libraries

| Library | Licence | Audit | Fit |
|---|---|---|---|
| ts-mls | MIT | none ("has not undergone a formal security audit") | pure TypeScript, active (v1.6.4, 2026-08-28); not tested on Bare **[unverified]** |
| OpenMLS | MIT | none found | Rust; WASM builds "not tested" |
| mls-rs (AWS) | Apache-2.0 / MIT | none ("has not yet received a full security audit") | Rust; WASM experimental, no JS bindings |
| libsignal | **AGPL-3.0** | no public full audit found | can't go into an MIT library |
| libsignal-protocol-javascript | GPL-3.0 | — | archived 2021-08-05 |
| vodozemac (Olm/Megolm) | Apache-2.0 | Least Authority, May 2022 ([Matrix blog](https://matrix.org/blog/2022/05/16/independent-public-audit-of-vodozemac-a-native-rust-reference-implementation-of-matrix-end-to-end-encryption/)) | from JS only through matrix-sdk-crypto-wasm, the whole Matrix crypto engine |
| @noble/curves | MIT | Trail of Bits 2023 and Aug 2026, Kudelski 2023, Cure53 2024 | primitives only |

Bare runs WebAssembly when built with V8, the default ([bare issue #81](https://github.com/holepunchto/bare/issues/81),
closed 2025-05-26); on iOS through an interpreter. We already have sodium-native (X25519, XChaCha20-Poly1305,
BLAKE2b, KDFs), which is enough for a Double Ratchet and Sender Keys: the Signal specs are public domain and short.
**Recommendation**: write the ratchets on sodium-native (a few hundred lines each, with the specs' test vectors
where they exist) and pay for an outside review before calling chats "secure". No library meets "audited, MIT,
JS, fits our logs".

### c. Members, devices, removal, disappearing messages, `trimHistory`

- **New member, new device**: they get the current chains only, no history (MLS's rule, RFC 9750 §6.7; Wire does
  the same). Signal now offers a one-time transfer of chats to a newly linked device
  ([Signal blog](https://signal.org/blog/a-synchronized-start-for-linked-devices/), 2025-01-27): we can do the same
  as a device-to-device copy over the pairing connection, never through holders.
- **"Keep history for newcomers"** (community channels): the inviter hands over the old chain keys of messages sent
  while the switch was on. Matrix's first version of this (MSC3061) was reverted in October 2024 after a security
  report: a server could add a fake member and harvest old keys. Its replacement (MSC4268, merged 2026-04-08,
  [PR](https://github.com/matrix-org/matrix-spec-proposals/pull/4268)) shares only from the inviter, only to the
  invitee's verified devices, within 24 hours, and marks messages "shared by Alice". Copy those rules. The cost to
  explain: whoever later steals a member's keys reads that whole history.
- **Removal**: new chains for everyone left, sent pairwise; the removed member keeps what it already had. Same as
  today's epoch rotation.
- **Disappearing messages**: holders and members keep blocks, so deleting data is only a request. What really
  makes old messages unreadable is **deleting the chain keys** that opened them, on every member's device, after
  the timer. Then `trimHistory` frees the space. The UI must say "disappears from your devices", not "is deleted".
- **Forward secrecy and holders**: holders keep encrypted blocks for as long as they hold the space. Forward
  secrecy therefore depends entirely on key deletion, not on data deletion.

### d. Deniable authentication with hypergraph's permissions

- MLS isn't deniable: "MLS does not make any claims with regard to deniability" (RFC 9750 §8.2.3). Signal 1:1 is:
  authentication comes from shared Diffie-Hellman secrets and MACs, which either side could have made (X3DH §4.4).
  Signal's group Sender Keys carry a per-sender signature (libsignal source).
- **The conflict**: hypercore signs every block with the writer core's key, and holders store those signed blocks.
  If a writer core's key is tied to the identity (today: the core is admitted by a proof signed by the identity),
  every record is provable to anyone who gets the blocks, whatever the payload says.
- **The way out**: in a deniable space, each member writes through a **short-lived writer core per epoch**, whose
  key is introduced to the other members only over the deniable pairwise channel (RFC 9750 §8.2.1's idea:
  signature keys exchanged over a deniable channel). Inside the group, members know who wrote what (the signature
  checks against a key they were told about privately). Outside, a block proves only that some key signed it; that
  key's link to a person exists only in deniable messages. Old epoch keys are deleted, which also helps forward
  secrecy.
- **Who may write** stays a space rule, enforced by members: the space admits the epoch's writer keys (a decision
  that names them), but the admission is sealed to members and carries a MAC, not the identity's signature.
  Someone outside holding the blocks sees keys and a space, not people.
- **Cost**: a new Autobase writer per member per epoch (more cores, more decision-log entries), and a new
  decision type. Opt-in, as the source note suggests: chats default to "secure" (forward secrecy, no history),
  deniability is a further switch until the cost is measured.

## RQ5. Metadata

### a. Padding: measured

`research/privacy/padding/measure.js` writes 100 posts, 766 short chat lines, 355 comments and 379 votes into a
**private** forum through the forum scenario API (`test/next/forum/forum.js`), then reads every block of every
core as a holder sees it (ciphertext, no key). Text lengths are log-normal with medians of 40 characters (chat),
150 (comments) and 600 (posts): an assumption, not measured from real users.

Blocks: 1,650, 435 KB in all, median 160 B, p10 117 B, p90 443 B, p99 1,895 B, max 6.5 KB; 419 distinct sizes.

| Scheme | Extra bytes | Distinct sizes left |
|---|---|---|
| none | 0% | 419 |
| Signal-style steps (Signal pads to multiples of **80 B**, not 160: `PADDING_BLOCK_SIZE = 80` in Signal-Android `PushTransportDetails.java`; at 160 B) | +25% | 21 |
| Padmé ([PoPETs 2019](https://petsymposium.org/popets/2019/popets-2019-0056.php), ≤12% by design) | **+3%** | 72 |
| at least 256 B, then Padmé | **+31%** | 55 |
| powers of two from 256 B | +57% | 6 |
| buckets 256 B / 1 / 4 / 16 / 64 KiB | **+107%** | 4 |
| buckets 512 B / 4 / 16 / 64 KiB | +210% | 3 |
| buckets 1 / 16 / 64 KiB | +465% | 2 |
| SimpleX: every transport block is 16,384 B ([SMP spec](https://github.com/simplex-chat/simplexmq/blob/stable/protocol/simplex-messaging.md), v21, 2026-07-05) | ~100× here | 1 |

For comparison, Cwtch pads group text to 1,800 B ([docs](https://docs.cwtch.im/security/components/cwtch/message_formats))
and Briar frames are at most 1,024 B ([spec commit](https://code.briarproject.org/briar/briar-spec/-/commit/3231cb17b397617b33bbd14d74399177bb2ed299)).

**Bandwidth** costs less than the storage numbers above: each block on the wire also carries its Merkle proof and
protocol framing, which padding doesn't grow. Storage on holders grows by the full percentage.

**Recommendation**: "a few fixed sizes" (D7) in its strict form costs about double. **256 B floor + Padmé (+31%)**
hides what matters most here: every vote, reaction and short chat line looks the same (they are 60% of blocks), and
long texts leak only their rough size. Buckets 256 B / 1 / 4 / 16 / 64 KiB (+107%) are the strict option for chats,
where volumes are small. Padding goes inside the encryption (Padmé on the record's plaintext), so it's a change to
the private-space encoding (`lib/encodings.js`, a version bump).

### b. What holders still learn, even with padding

- which spaces (cores) they hold, how many writers each has, and how often each writes;
- when each block arrives (to the second) and from which connection (IP, unless Tor);
- rough sizes (the bucket), and big files' sizes;
- who fetches what, and when (every member's reads);
- that two identities came online together, if they share the holder (c).

What they don't learn: content, record types, who the writers are as people (beyond a key, unless they're also in
the space).

### c. Sync delays: what they hide and cost

`research/privacy/jitter/simulate.js`: 500 devices, 100 of which also run a hidden identity; devices come online
about 8 times a day for 14 days; each identity syncs with holders at the start of a session, plus 0–2 s of network
noise and a random delay of up to D. The worst case: one holder sees every identity. For each hidden identity it
ranks every main identity by how often their syncs come close in time, over what chance predicts.

| Random delay D | Hidden identities linked to their device's main identity (of 100) | the same, hidden identity open in 1 session of 4 |
|---|---|---|
| 0 s | 100 | 100 |
| 10 s | 100 | 100 |
| 1 min | 100 | 100 |
| 10 min | 100 | 100 |
| 1 h | 100 | 99 |
| 4 h | 77 | 5 |

So delays only start to help at hours, which makes chat unusable. Coming online together is the signal, and the
delay just widens the window the observer uses. **What hides it is not sharing the observer**: no common holder,
no common Tor circuit, no common circle. Delays still have a cheap use **within** a session (a few seconds on each
record, so a post's time doesn't match the moment someone was seen typing elsewhere), costing that much latency.
**Change to D7**: random delays are a small extra; per-identity holders and connections are the real defence.

### d. What Tor's cells cover

A Tor cell is 514 bytes (link protocol 4 and later), 509 of them body; a relay cell carries at most 498 bytes of
data ([tor-spec](https://spec.torproject.org/tor-spec/relay-cells.html)). So a network observer sees our traffic
in 498-byte steps: a vote and a short chat line both fill one cell, which already gives the network what our
padding gives holders. Tor's padding (connection-level PADDING cells, circuit-level padding for onion-service
setup, [padding-spec](https://spec.torproject.org/padding-spec/overview.html)) targets coarse netflow records and
circuit fingerprinting, not end-to-end timing. Cells don't hide anything from the holder at the other end, which
sees decrypted hypercore blocks: padding is still needed for holders.

## RQ6. Lessons from other projects

- **Cwtch**: profiles without a password are encrypted with a "defacto, hardcoded password", and the list of
  profiles stays hidden until a password is typed ([profile encryption](https://docs.cwtch.im/security/components/cwtch/profile-encryption)).
  This is how our main identity should work: on every install the vault is opened by a default password unless the
  user sets one, so every install has a vault, used the same way, and nothing differs for users with hidden
  identities. That's what makes D4 deniable.
- **Tor Browser**: scope every identifier to one context, and offer **New Identity** as one action (new keys, new
  connections) ([design doc](https://2019.www.torproject.org/projects/torbrowser/design/)). For us: per identity
  and per space, never global; and a "new pseudonym" button that makes a fresh identity with nothing shared.
  Letterboxing buckets window sizes: sites in hidden identities shouldn't see the real window size or fonts either
  (a fingerprinting surface not covered here).
- **Signal's sealed sender**: hiding the sender is worthless if receipts and replies flow back: users were linked
  in as few as 5 messages (Martiny et al., NDSS 2021, [paper](https://www.ndss-symposium.org/ndss-paper/improving-signals-sealed-sender/)).
  For us: automatic read receipts and "seen" markers in hidden identities' chats leak timing; off by default there.
- **SimpleX**: no user identifier, a separate queue per contact. For us: one identity key visible to every space
  links them all; per-contact keys (D2, later) are the fix, and pseudonyms per space are the cheap version now.
- **Briar**: a Tor onion service per device and no servers, with "mailboxes" for offline delivery. Our holders are
  those mailboxes; Tor mode should give holders an onion address too (spec 028) **[Briar's current docs not
  fetched]**.
- **Session**: dropping forward secrecy for reliability is the trap to avoid; timers and key deletion keep it.

**Decisions that look wrong, with the evidence:**

1. **D4/D9, shared capacity between independent identities**: they overwrite each other (prototype test;
   Shufflecake FAQ; VeraCrypt's protection needs both passwords). **Nest them** (each hidden password also opens
   the one below), add erasure codes to hidden metadata, and accept that a decoy-only session can damage a hidden
   identity.
2. **D7, random sync delays**: no effect under an hour on the main link (the simulation). Replace with per-identity
   holders and connections; keep only short per-record delays.
3. **D9, site profiles in the vault**: Chromium needs a real folder; without a virtual drive, hidden identities'
   site sessions must be in memory (tested clean). Sites keep lasting state in hypergraph.
4. **D5, "MLS-style"**: keep the properties (forward secrecy, post-compromise security, no history), drop MLS
   itself: it needs a single Commit order and has no audited JS implementation. Sender Keys per writer core fit
   Autobase.
5. **D6, deniability** holds, but only with short-lived writer cores per epoch, because hypercore signs every
   block. It's the most expensive item on the list; make it opt-in.
6. **D8, order**: move padding earlier (it's a few days of work and a format change best made before more data
   exists), and see the order below.

## Proposed build order, with rough costs

Costs are for one developer, including tests, docs and the forum scenario tests; they are estimates.

| Step | What | Cost |
|---|---|---|
| 1 | **Quick wins in HyperBrowser**: per-identity partition names; in-memory sessions for hidden identities; `--disable-gpu-shader-disk-cache`; no `crashReporter.start()`; no notification content, recent documents or native file dialogs for hidden identities; nothing written to `hyperbrowser.log` while one is open; a test like `electron-traces` in its suite | 3–5 days |
| 2 | **Padding** in private spaces: 256 B floor + Padmé inside the encryption; encoding version bump; forum tests | 3–5 days |
| 3 | **ID manager**: one `Hypergraph` instance per identity, one folder each, own swarm; engine routes sites to an identity; UI to create, name, open, close; D3's IP warning and "only over Tor" switch (refuses to connect until Tor mode exists); a test that no keys or swarms are shared; per-identity holders | 2–3 weeks |
| 4 | **Secure conversations**: Double Ratchet for 1:1, Sender Keys per writer core for groups, rekey on removal and on a timer, key deletion for disappearing messages, no history by default, the history switch with MSC4268's rules; an outside review | 6–10 weeks + review |
| 5 | **Vault, format**: file, slots, nesting, slices and maps, erasure-coded metadata, fixed-step growth, decoy dummy writes; default password for the main identity (Cwtch) | 2–3 weeks |
| 6 | **Vault, storage**: the vault file system in a rocksdb-native fork (C++, prebuilds for 13 platforms), the four small files through it, SwarmFS too; perf runs before and after | 4–6 weeks, then ongoing fork upkeep |
| 7 | **Tor mode** (spec 028), one onion and one circuit per identity | as spec 028 |
| 8 | **Deniable spaces** (short-lived writer cores per epoch), cover traffic with mixnet notices | 4+ weeks; later |

Steps 1–3 give "separate faces, honest warnings" in about a month. The vault (5–6) is the largest single cost, and
the fork is the part that stays expensive.

## Risks

- **Leaks outside the vault** matter more than the vault format (Czeskis 2008): any new feature that writes a
  cache, an index, a log or a thumbnail breaks deniability. Only a test that diffs the disk catches them, and it
  must run on each release.
- **Snapshot attacks** defeat the vault (single-snapshot security only). Users who cross borders often are the
  people who need it; the docs must say so plainly.
- **Data loss**: a decoy-only session can overwrite a hidden identity. Erasure codes reduce it; they don't remove it.
- **A home-made ratchet** without an outside review is the usual way messengers get broken; the review isn't
  optional.
- **Holder collusion and timing** link identities faster than any crypto can hide; per-identity holders depend on
  users having enough circles.
- **The rocksdb-native fork** must follow upstream (hypercore-storage pins `^3.18.0`); a format change in RocksDB
  files could break the layer.
- **The person**: active hours, writing style, contacts, and screenshots shared by others aren't software
  problems.
- **The goal**: this is a lot of machinery for "the easiest kit for server-less social apps". Steps 1–4 serve every
  user (private chats, separate pseudonyms); the vault and deniable spaces serve a small, high-risk group. Build
  them behind the same API so apps don't have to care.

## Could not verify

- The vault on an SSD (C: has no room) and RocksDB inside the vault end to end (option B isn't built).
- Whether a visible Electron window writes the global GPU shader caches, and whether a file dialog in an in-memory
  session writes to the shared `Preferences` file; Android WebView's disk behaviour.
- Windows paths from forensic literature (notification database, Prefetch, thumbcache), Linux notification history,
  Android notification history storage, zram.
- Shufflecake's current Argon2id values (the repository blocked automated reading); Mobiflage's offset formula;
  MobiCeal's numbers (abstract only); HIVE's and DCGKA's full papers (403).
- That ts-mls runs on Bare; any public audit of libsignal; Session's padding; Matrix MSC2883's status; Briar's
  current spec.
- Real message-length distributions (the padding run uses assumed medians).
- Phone Argon2id timings.
