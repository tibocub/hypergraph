# Spec 031: secure conversations (forward secrecy and healing)

**Created**: 2026-11-22 · **From**: ROADMAP "Next 6. Privacy", research 029 RQ4 · **Status**: built (see "Changes while building")
· **Builds on**: private spaces, key changes, padding (030), identities

## Why

Chats in HyperBrowser are private spaces. Their content is sealed with an **epoch key**. Each device gets that
key in a **grant**: a record sealed to the device's own long-term box key (its device key turned into X25519,
`lib/private/crypto.js`). Grants stay in the logs for good. So whoever gets a device's key, today or in five
years, opens every grant that device ever got. With them they read every message of every epoch it was in,
from any copy: a holder, a helper, a captured disk. Each key also unlocks the ones before it (key links).
A stolen device's key is the whole history. Healing after a theft needs a member who may decide to change the
key by hand.

This spec adds what Signal users expect:

- **Forward secrecy**: a key stolen today doesn't open messages whose keys were already deleted.
- **Healing**: a thief who copied a device's keys once, then lost the device, can't read past the next two key
  changes.

It stays inside hypergraph's model: one log per device, merged by Autobase, offline for weeks, no server.

## Decided already (constraints)

- Signal-style ratcheting chains, **one per writer log**, on libsodium (sodium-universal, already in the tree).
- Not MLS: it needs one agreed order of key changes (RFC 9750 §5.2), which a multi-writer log only has after
  the fact. Not libsignal: AGPL-3.0.
- Secure by default for 1:1 and group chats. A new device of a member sees messages from when it joined.
- Optional disappearing messages through `trimHistory`.
- A "keep history" switch for community channels (forums, big public chats) where newcomers need the past.
- Deniable authentication: opt-in per conversation, later. Leave room for it.
- An outside cryptography review before we call it safe. Safety beats speed.

## Threat model

"Reads" means content: fields and links. Metadata is what a private space already shows to whoever holds its
disk key: who writes, when, record types, padded sizes, membership.

| Who | Can learn or do | Can't |
|---|---|---|
| **Passive network observer** | IPs, connection timing and volume, the DHT topics peers announce (until Tor mode) | Read anything: connections are encrypted (Noise), and blocks are encrypted again with the disk key |
| **Member** (any device of theirs) | Read everything written from their join on. Keep copies (screenshots, a modified app keeping keys past a disappearing timer: no crypto stops this). Prove to outsiders who wrote a message, because blocks are signed by device keys tied to identities (until the deniable option) | Forge another member's message: each log is signed by its device. Read what came before their join. Undo another member's deletion of keys |
| **Ex-member** (removed or banned) | Keep what they had. See metadata after the removal, through the disk key that never changes (until `secure()` renews the space). Read messages written by a device that hadn't heard of the removal yet: an offline writer (limit below) | Read anything sealed after its writer learned of the removal. Write anything that counts (the existing cut) |
| **Stolen device, now** (thief has the unlocked engine folder) | Read the local history the device keeps. Read and write as that person in that conversation, until the device is removed (that needs the recovery phrase, as today) | Read messages whose keys were deleted before the theft: disappeared, trimmed, deleted. Read anything from before the device joined. Read anything after its removal plus one key change |
| **Device copied once, then lost by the thief** (malware snapshot, a backup copy) | What the copy held, plus messages until healing | Read past the second key change after the copy, if the thief only listens (Double Ratchet §8.2 gives the same healing, against a passive attacker). A thief who still writes as the device is only stopped by removing it |
| **Stolen device, later** (an old phone, a disk image) | Whatever its local key store still holds | Read what was written after its removal. Read messages whose keys it had deleted. On-disk deletion is best effort (database compaction, SSD wear levelling): the vault spec covers that |
| **Compromised helper or holder** (blind peer, circle member outside the conversation) | Block counts, padded sizes, append timing, which logs. Withhold, delay or drop blocks; serve old ones | Read content or metadata (no disk key). Forge or reorder blocks inside a log (signed). With keys stolen later from a member, read messages whose keys that member had already deleted |
| **Recovery-phrase thief** (phrase only, no device) | Make a new device of that person. It joins each conversation as a new device and reads from then on, if a member who may change the key lets it in. Remove the person's other devices | Read anything before that join: no conversation key comes from the phrase. Unnoticed: members see "a new device of X" (question 8) |

Out of scope: traffic analysis beyond padding (spec 028, Tor mode), quantum adversaries (room for an ML-KEM
step in the grant, like PQXDH, later), a member's own device leaking plaintext (OS traces, spec 029 RQ2).

## The design

### In one paragraph

Keep the epoch key and grants. Make them short-lived:

- A grant is sealed to a **prekey**: a fresh X25519 key each device publishes in its log of the space. The device
  deletes the prekey's secret soon after.
- On receiving an epoch key, a device derives one **chain** per writer of that epoch, then erases the epoch key.
- Each record is sealed with its own **message key**, taken one step down its writer's chain. Old chain steps are
  erased.
- Integrity is unchanged: every block is signed by its log's device key.
- Ordering is unchanged: each chain lives in one log, which has one order. Key changes are decisions, as today.

### Keys and their schedule

All primitives are in sodium-universal (the same on Node and Bare):

| Key | Made by | How | Lives |
|---|---|---|---|
| Prekey `P` (X25519) | each device, per space | `crypto_box_keypair`. Published as an `hg/prekey { key, n }` record in its own log, so it is signed by the device | Secret: the device's two newest. Older ones are erased |
| Epoch key `E` (32 B) | a member who may decide, at each key change | `randombytes_buf`. Its commitment goes in the `key/rotate` decision, as today. **New**: the decision also lists the device keys the epoch is for (32 B each: 3.2 KB at 100 devices, inside the disk encryption) | Erased once the chain starts below are derived and stored |
| Grant | the same decider | `crypto_box_seal(E, P_device)` to each listed device's newest prekey, in an `hg/grant` record (the format of today, sealed to a prekey instead of the device key) | In the logs for good. Useless once `P`'s secret is erased |
| Chain start `CK₀(W)` | each device, for each listed writer `W` | `crypto_generichash(32, "hypergraph/chain\0" ‖ space ‖ W's log key ‖ commitment, key = E)` (keyed BLAKE2b) | Replaced by later steps |
| Chain step | sender and readers | `MK_n = crypto_kdf_derive_from_key(32, 1, "hgchain1", CK_n)`, `CK_{n+1} = crypto_kdf_derive_from_key(32, 2, "hgchain1", CK_n)`. BLAKE2b, like Signal's KDF_CK split into constants 1 and 2 | `CK_n` erased once `CK_{n+1}` is stored |
| Message key `MK_n` | the same | sealing: XChaCha20-Poly1305. The additional data names space, log, seq, epoch and `n` (today's `recordAD` plus `n`). The nonce stays random (24 B): a device restored from a disk backup or a VM snapshot replays chain positions, and a random nonce keeps even that safe | Kept in the local key store while the record is kept here (below) |

Envelope: today's `{ epoch, commit, nonce, box }` gets a scheme number and the chain index `n` (1 to 3 B more).
The scheme number is kept for the deniable option only. There is no old format to read: hidden-history spaces
made before this stop working (no users, no data yet).

A writer seals with the newest epoch it holds. Its first record in an epoch is `n = 0`. A record that names an
epoch whose device list doesn't include its log is refused: a new device waits for the next key change.

**Order of writes, for crashes.** Always store the new state before erasing the old:

- the chain starts before `E` and the prekey secret;
- `CK_{n+1}` before appending record `n`.

A crash then loses a chain step (readers see a skipped index), never reuses one. A crash before storing leaves a
grant that won't open: the device asks for the next key change, as a newcomer does (`access: 'waiting'`).

### The local key store

Today keys live in memory and are re-opened from the grants after a restart. That can't work once the prekey is
erased. Each device gets a local, never-replicated store per space, in the engine's own storage:

- prekey secrets;
- its sending chain;
- receiving chains per (writer, epoch);
- message keys of the records it keeps;
- skipped keys.

Reads stay as they are: open the block, then unseal with its `MK`. So dropping old content and fetching it back
(holding part of a space) still works.

A message key is erased when:

- its record is deleted by its author;
- its record is trimmed, or older than the disappearing timer;
- its writer's device is cut before it;
- it stays unused past the skip limit.

This store is what a device thief gets. It is the same exposure as Signal's local database. The vault (next in
the roadmap) is what protects it at rest.

### New members and new devices

Every newcomer, a new device of an existing member included, is handled the way `history: 'hidden'` handles
one today:

- the newcomer publishes its first prekey when it joins;
- a member who may decide changes the key for the new device list;
- the newcomer reads from that epoch on.

It never gets an older epoch key, chain or link. What came before doesn't count as missing for it, so its reads
are complete.

A writer that hadn't heard of the newcomer kept writing in the old epoch. The newcomer never reads those
records, even ones written after its join. They count as "before you joined", not as missing. That is the
honest limit of a log nobody orders in real time (question 3).

A restored identity (recovery phrase) is a new device: it reads nothing from before its restore in any secure
conversation. It reads the personal space, forums and visible-history spaces as today.

### Removal, and healing after a compromise

**Removal** (of a member, a device or a ban). The decider who records it changes the key at once, for the
devices left, as today:

- every writer moves to the new epoch at its next record;
- the removed device has no grant, so it reads nothing sealed after that.

**Healing.** A thief who copied a device's state holds its prekey secrets and current chains. Members who may
decide change the key:

- on a timer: every 7 days, or after 1,000 records by one writer since the last change, whichever comes first
  (question 5);
- by hand: `rotateKey()`, as today.

Each change is sealed to each device's newest prekey. Each device publishes a new prekey after it opens a grant
sealed to its newest. So:

- the first key change after the copy may still be sealed to a prekey the thief holds;
- the second is not.

A thief who only listens is out after two key changes. One who writes with the device's key is an active
attacker: only removing the device stops them. That needs the recovery phrase, and hypergraph already signs that
removal with the identity.

The cost is O(devices) per key change: one grant and one prekey per device, about 512 B each, padded. Nothing
grows as O(n²): writers don't distribute their own chains.

### Late, out of order, offline for weeks

- **Within one writer**: hypercore downloads blocks in any order (newest first for a newcomer). A reader who gets
  record `n + k` before `n` derives the steps in between and keeps their message keys as **skipped keys**. It is
  cheap: about 1 µs per step.
- **Limits**, after Signal's (libsignal `consts.rs`: `MAX_FORWARD_JUMPS` 25,000, `MAX_MESSAGE_KEYS` 2,000;
  Double Ratchet §3.1, §8.4):
  - a chain index past 65,535 in one epoch is refused (writers change the key well before);
  - at most 100,000 skipped keys per space (3.2 MB);
  - a skipped key unused for 90 days is erased (question 4). The record is then asked for again (resends, below).
    If no resend comes, it counts as gone, not missing, and reads stay complete.
- **Across epochs**: a reader keeps a writer's chain of epoch `e` until that writer's first record in a newer
  epoch arrives, or the 90 days pass. A device offline for weeks writes in its last epoch, and members who had
  that epoch read it when it comes back.
- **The offline writer's limit**: it doesn't know about a removal made while it was away. A removed member who
  had that epoch can read those records. Members get those records late anyway, and the cut already keeps the
  removed member's own late writes out.
- **Two key changes at once** (a partition): both stay readable, keyed by commitment as today (`keys.others`). A
  chain belongs to (epoch, commitment, writer).
- **Decision reordering**: Autobase may reorder unsettled decisions. Chains don't depend on that order. Only the
  epoch's device list does, and it is written in the epoch's own decision.

### Resends: a message is lost only if no author device has it

**When.** A member's device can no longer open a record it should read. Either its skipped key expired, or it
dropped the writer's old-epoch chain, while the block was still missing or unreadable. It then asks the author.

**The request.** A `hg/resend { log, seqs }` record in the member's own log, sealed in the current epoch:

- `log` and `seqs` name the records, as ranges;
- at most 1,000 records per request;
- it is subject to the space's write limit, like any record.

**The answer.** Any device of the same identity as the original's writer may answer. That device:

- opens its own copy: its own records are never dropped, and their message keys are in its key store;
- writes a resend record in its own log, carrying the original's fields and links and naming the original
  (`resendOf: { log, seq }`);
- shows it under the original's record id, stamp and place.

Readers deduplicate: one that holds the original ignores the resend.

**Sealed to the requester only, not under the current key.** The answer is sealed to the requesting device's
newest prekey (`crypto_box_seal` of a one-time key), not to the epoch. This differs from "re-post under the
current key" on purpose. Everyone in the current epoch reads what is sealed under the current key, and that
includes newcomers who joined after the original. They would read history from before their join, which hidden
history forbids.

**Who gets an answer.** The author answers only when all of these hold:

- the requesting device is in the current epoch's device list. An ex-member is never in it, so it gets nothing.
- the requesting device was in the original record's epoch device list. It was entitled to the record then.
- the record still exists for the author: not deleted, not trimmed, not past the disappearing timer.

**Holders never re-encrypt.** They can't read. A way for them to transform keys (proxy re-encryption) would
give whoever holds blocks a key-shaped capability. Resends come from an author device or not at all.

**Limits:**

- The message is lost if no device of the author survives with it: all lost or removed, or the record dropped
  by a modified app.
- A disappeared, trimmed or deleted message is never resent. That is the point of those features.
- A resend waits for an author device to come online. Until then the record stays missing, and reads stay
  incomplete. After a further 30 days with no answer it counts as gone.
- The author is trusted to resend what it wrote. A reader that holds both the original and a resend that
  differs from it keeps the original, and the inspector flags the mismatch. Readers holding only the resend
  can't check it (review item 11).

**Floods:**

- An author answers each (record, requesting device) pair at most once;
- it sends at most 1 MB of resends per space per day, and the rest waits;
- it ignores requests from a device whose own log is past the write limit.

A requester asks again only after 7 days without an answer.

### Where it lives, and what apps see

- **hypergraph core** (`lib/private/`, `lib/space.js`): the prekeys, chains, local key store, timer and limits.
  Everything cryptographic is in the core, never in a site.
- **The switch is the one that exists**: `setHistory('hidden')` becomes the secure mode. `'visible'` (the
  default) is the "keep history" model of today. Both on one switch, because a newcomer reading the past means
  someone keeps old keys to hand over, and that is exactly the absence of forward secrecy (question 1).
- **New**: `space.setDisappearing(ms | null)`, who may decide. Every member's device erases message keys older
  than the timer. A device that may decide trims (`trimHistory`) on the same timer, to free holders' space.
  `space.disappearing` reads it.
- **Unchanged**: `put`, `edit`, `query`, `since`, live queries, `status().access`, record ids, padding,
  `secure()`, `renew()`.
- **Records whose keys are gone** (disappeared, expired skipped keys) are left out, and reads stay complete.
- **HyperBrowser Chat**: calls `setHistory('hidden')` on every conversation it creates. A group admin can switch
  to "keep history" (question 2). It shows the timer and device notices (questions 7, 8).

## Interactions

- **Padding (030)**: the chain index is inside the padded, encrypted block. It costs +0.11% on chat lines;
  1.8% of them move up one size (measured below).
- **Key changes**: `rotateKey()`, removals and the new timer all make a new epoch. A hidden-history space already
  changes the key for each newcomer. Unchanged: `renew()`/`secure()` (new disk key and logs), for when metadata
  must stop reaching an ex-member too (question 9).
- **`trimHistory` and disappearing messages**: erasing message keys is what makes a message unreadable
  everywhere, and erasure is local. Trimming only frees space. A copy a holder or a modified app kept stays
  unreadable once honest members have erased the keys. A modified member app can keep keys or plaintext; say so
  in the UI, as Signal does.
- **"Keep history"** (`'visible'`): unchanged from today (key links, grants to device keys, no forward secrecy).
  Switching visible → hidden: forward secrecy from the next epoch on; older epochs keep today's keys. Switching
  hidden → visible: later newcomers read from the switch on. The hidden epochs' keys are gone and can't be
  linked.
- **Holders and helpers**: unchanged. They hold disk-encrypted blocks and are never granted anything. A helper
  withholding blocks makes readers keep skipped keys longer, up to the limits.
- **Identities and recovery phrases**: each identity has its own engine folder and its own local key store, so
  nothing is shared between identities. No conversation key comes from the phrase. A restored identity reads
  secure conversations from its restore on, and only once a member who may change the key is online.
- **Sub-spaces and circles**: a private sub-space can be hidden-history too (same code). Circles keep holding
  blocks they can't read.

## Room for deniable authentication (later, opt-in)

Today authentication is the hypercore signature of a device key that a proof ties to the identity. Anyone who
gets a block can check that. Deniability needs that link to be checkable only by members, through a DH-based
handshake (X3DH §4.4). Concretely: a per-conversation writer key, introduced to members by a MAC over a shared
DH secret, not by a signed proof in the log header. Kept open now by:

- the scheme number in the envelope;
- no identity signature inside sealed payloads (none today: keep it that way);
- one function binding a writer log to an identity, so it can be swapped for a deniable one;
- grants that are already sender-anonymous (`crypto_box_seal`).

The blocking issue, for that later spec: holders store signed blocks, and roles are checked against identities.

## Costs (measured)

`research/secure-chats/cost.js`, crypto only, medians of 5 × 20,000, Node 26.4 and Bare 1.35, one desktop core:

| | Node | Bare |
|---|---|---|
| chat line, padded block | 264.0 → 264.3 B (+0.11%) | same |
| send, µs/message (today → chains) | 1.70 → 3.50 | 1.80 → 3.30 |
| receive, µs/message | 1.50 → 2.25 | 1.25 → 2.05 |
| skipped key, µs | 1.00 | 0.85 |
| key change at 10 devices: decider / each device | 0.71 / 0.085 ms | 0.70 / 0.070 ms |
| key change at 100 devices | 7.10 / 0.150 ms | 6.45 / 0.100 ms |
| written per key change | 512 B per device | same |

Per message, the crypto is a few µs, against hypergraph's ms-level write path (private.write: about 460
records/s). Per week, a 10-device chat writes about 5 KB of keys, a 100-device one about 50 KB, plus one per
newcomer. Not measured: the local key store's writes (one small write per message, next to the index write
that already happens) and phones.

## What gets tested

Regression first, as the constitution asks for replication code.

- **Unit** (`test/next/unit/chains.js`, new):
  - KDF test vectors;
  - skip in order and out of order;
  - the 65,535 and 100,000 caps;
  - the 90-day expiry;
  - a crash between storing and appending never reuses a step;
  - an epoch key and prekey secret are gone from the store after use;
  - resends: only to a device entitled then and now, never for a disappeared, trimmed or deleted record, once per
    (record, device), within the daily cap.
- **Forum scenarios** (`test/next/forum/`):
  - `history.js`:
    - hidden: a newcomer reads from its join on;
    - a copy of a member's key store taken before a disappearing timer can't open those records from a
      holder's blocks afterwards;
    - a copied store stops reading after two key changes;
    - visible stays as today.
  - `devices.js`: a new device and a restored identity read a hidden space from their join on, nothing
    before.
  - `private.js`: removal is cut off at the next key change (exists; add the hidden variant).
  - `partition.js`:
    - an offline writer's records from an old epoch are read when it comes back;
    - a record whose skipped key expired comes back by resend from the author's other device, while a
      newcomer since then and an ex-member get nothing;
    - a writer that missed a removal: documented limit, asserted.
  - `renew.js`: renewing a hidden space keeps its chains' limits.
  - A new `disappearing.js`: the timer erases keys on every member, and the deciders trim.
- **Perf**:
  - `perf/scenarios/private.mjs` gets a hidden-history run (write, read, bytes per record);
  - `chat.mjs` runs its room private and hidden (fan-out with a key change mid-way);
  - a key change at 50 and 100 devices, timed (in `members.mjs`).
  - Run before and after: this is the hot write path.
- **Downstream**: HyperBrowser `test/chat.test.js` (conversations are hidden-history), SwarmFS's suite.

## For the outside review

What a reviewer should start from:

1. The key schedule table above: domain separation, keyed BLAKE2b for the chain start, `crypto_kdf` steps,
   AEAD additional data, random nonces under one-time keys.
2. Prekeys: one per device per space, the two newest kept, a new one after each grant. Is "healed after two
   changes" right, and what does an active thief with the device key keep?
3. Grants via `crypto_box_seal` with a commitment check (`commitOf`) and no additional data: can a grant be
   replayed to another epoch or space?
4. The epoch's device list in the decision, and refusing writers not in it. Concurrent key changes (`others`),
   and Autobase reordering unsettled decisions.
5. Skipped keys and old-epoch chains: the limits, the withholding attack (Double Ratchet §8.4), the
   restore-from-backup replay.
6. The local key store: erasure order, crash safety, what an LSM database and SSDs keep after a delete.
7. Interaction with the disk key that never changes: what an ex-member learns.
8. The removal window for offline writers.
9. Downgrade: `'visible'` switched on by a malicious decider. Does the UI warn members?
10. Metadata: prekey and grant records show key-change timing to members (not to holders).
11. Resends (change 3): a request names a log and its seqs and holds a one-time reply public key; the
    author's device seals those records' message keys to it.
    - the entitlement checks (in the record's epoch, in the current one) and the "still exists" check;
    - the reply key: one-time, erased after its first answer or 90 days;
    - a wrong key from a modified author device only makes the record not open (blocks are signed);
    - floods: once per (record, device), 1 MB a day, ask again after 7 days, gone after 30;
    - whether a resend request reveals which records a member lacks to other members.
12. Prekeys used once (change 1), the `held` signal and the 3 s wait before a newcomer's key change.

## Prior art (primary sources)

| | What it does | We take | We don't, and why |
|---|---|---|---|
| **Signal Double Ratchet** (rev. 4, 2025-11-04, https://signal.org/docs/specifications/doubleratchet/) | Per-message keys from KDF chains (§2.2). A DH ratchet heals after a compromise (§2.3, §8.2). `MAX_SKIP` and deletion of skipped keys (§3.1, §8.4) | The chain step (one constant for the message key, one for the next chain key); skip limits; erase on use | Its per-pair DH ratchet: a group of n devices would need n² sessions. We heal by key changes sealed to fresh prekeys instead |
| **Signal Sender Keys** (libsignal `rust/protocol/src/sender_keys.rs`, `group_cipher.rs`, `consts.rs`, read 2026-11-22) | One chain per sender (HMAC constants 0x01/0x02); a signing key per sender-key state; `MAX_FORWARD_JUMPS` 25,000, `MAX_MESSAGE_KEYS` 2,000 | One chain per writer, which fits one hypercore per device | Per-sender distribution over pairwise channels (O(n) per sender, so O(n²) after a removal) and its signing key: our blocks are already signed by the log |
| **Matrix Megolm** (https://gitlab.matrix.org/matrix-org/olm/-/raw/master/docs/megolm.md, no date shown) | A 4-part ratchet that skips ahead in at most 1,020 hashes; "partial forward secrecy"; no backward secrecy by itself (fix: new sessions often); Ed25519 signature per message | Sharing a ratchet at an index gives access "from that point on"; new sessions on a timer | Its multi-part ratchet: our linear chain skips 10,000 steps in 10 ms and epochs end well before that. Per-message signatures: hypercore already signs |
| **Matrix history sharing** (MSC4268, merged 2026-04-08, https://github.com/matrix-org/matrix-spec-proposals/pull/4268; MSC3061 reverted 2024-10-29) | Sharing old keys with newcomers is opt-in, flagged per message, from the inviter only | "Keep history" is a separate, visible choice | Per-message flags: one switch per conversation is enough here |
| **MLS** (RFC 9420, July 2023, https://www.rfc-editor.org/rfc/rfc9420.html; RFC 9750, April 2025) | Epochs changed by Commits; a secret tree with one ratchet per sender (§9); delete keys once used, keep unused ones a while for out-of-order delivery (§9.2) | Per-sender ratchets inside an epoch; the deletion schedule | TreeKEM and Commits: the group must agree on one Commit per epoch (RFC 9750 §5.2). Forks over Autobase are draft-level research (DMLS). Its log(n) gain doesn't matter at chat sizes. No deniability claim (RFC 9750 §8.2.3) |
| **DCGKA** (Weidner et al., CCS 2021, https://eprint.iacr.org/2020/1281) | Group key agreement with forward secrecy and healing, needing causal order only | Confirms that causal order is enough | Full text not read (PDF refused): its details aren't relied on here |

Sources marked "read" were fetched 2026-11-22. RFC 9750, MSC4268 and DCGKA come from research 029 (fetched
2026-11-21). The RFC 9420 §16.6 definitions were read as a summary only.

## Questions, answered (2026-11-22)

Every recommendation was taken, except for questions 4 and 10.

1. **One switch?** Yes: secure mode is `setHistory('hidden')`, with no new flag. Keeping history and forward
   secrecy contradict each other.
2. **Chat defaults.** Every new 1:1 and group is hidden. A group admin may switch to "keep history" after a
   warning. Forums stay visible.
3. **Messages written between a join and the writer hearing of it.** The newcomer never reads them. No grace
   period: it would be a forward-secrecy hole every member carries.
4. **Skipped keys.** Kept 90 days. **Changed:** when one expires, the member asks the author's devices for a
   resend (see "Resends"). A message is lost only if no author device has it.
5. **Timer key changes.** Every 7 days or 1,000 records by one writer, made by any device that may decide while
   online.
6. **Who may change the key in a 1:1.** Chat makes both people of a 1:1 admins (no core change).
7. **Disappearing messages.** A per-conversation setting, made by whoever may decide: off, 1 h, 1 day, 7 days or
   30 days. Off by default, with a note that a modified app can keep messages.
8. **New-device notices.** Yes: "X added a device" in each conversation. The core gives a `devices` change per
   member, and Chat shows a line.
9. **Renew after a removal.** Not automatic. Chat offers "secure this group" after a removal.
10. **Old hidden-history spaces.** **Changed:** no upgrade and no compatibility (no users, no data yet). Old
    hidden-history spaces stop working, and there is no CHANGELOG step.
11. **Wording before the review.** The UI says "encrypted", never "forward secret" or "secure", until the outside
    review is done.
12. **Size.** No cap. A `status()` warning past 200 devices.

## Changes while building

Agreed with the lead before building:

1. **A prekey is one-time.** Its secret is erased once the grants sealed to it are opened and the chains are
   stored. "The two newest" are the two newest **unused** ones. Kept after use, it would let a thief re-open
   the current grant from the logs and rebuild every chain of that epoch from step 0, disappeared messages
   included. A grant sealed to a prekey already used (a race) doesn't open: the device publishes a prekey
   whose `held` is below the current epoch, and a decider changes the key again. Tested: a used prekey
   opens nothing; the race recovers.
2. **An epoch lists writer logs**, not devices: the chain start needs the log's key, and a reader may not
   know a device's log when the grant arrives. Grants stay addressed to the device.
3. **A resend carries the message key**, sealed to a one-time reply key the request holds, not a copy of
   the fields. The asker opens the original block (the author's log always serves it): the author is never
   trusted for content and there is nothing to deduplicate. The author still refuses a record that is
   deleted, trimmed or past the timer, and checks the asker was in the record's epoch and is in the current
   one, before sealing. Review item 11 changes accordingly.
4. **The disappearing test copies the key store after the timer** (it opens nothing). A copy taken before
   the timer still holds the keys and opens the records from any kept block: the documented limit.
5. **An old epoch's chain goes** once its writer wrote in a newer epoch and every earlier block of its log is
   read (or after 90 days), not when the newer record arrives: blocks download in any order.

Found while testing:

- **`held` counts only epochs whose winning key the device holds.** Two key changes at once give two keys for
  one epoch number; holding the loser said "I have it" and the device was never served again.
- **A key change for a newcomer or a device lacking the key waits 3 s after the last one.** Devices publish
  fresh prekeys once they opened a grant; a change made at once sealed to the old ones and, with two
  deciders online, set off the next change, again and again.
- **A device that may decide waits before writing** (within the 5 s a write waits) when a member just came in
  (its join decided in the last 30 s, its prekey not here yet) or a newcomer's key change is due: it changes
  the key, then writes, so the newcomer reads it. Other writers write with the key they hold.
- **Joining takes a key change**: `status().access` is `'waiting'` until the newcomer's epoch exists, and
  what is written before doesn't reach it. Tests and apps wait for `'full'`.
- **Shared types** (agreed with the lead). A newcomer read nothing written before it came, app state
  included: SwarmFS's `site` record (which app a space runs) and members' `profile` names, so no one could
  join an encrypted Chat. A type may declare `shared: true` (opt-in, refused with a `text` or `bytes`
  field): in a private top space its records are sealed with a key from the disk key (scheme 2), whatever the
  history setting, and a trim keeps them. **The limit: an ex-member keeps the disk key, so it keeps reading
  shared records (names, the site record) until the space is renewed (`secure()`).** Holders read nothing. In
  a private sub-space a shared type is sealed like any other. SwarmFS marks `site` and `profile` shared.

Open points:

- **Read-only members**: a member whose role can't write publishes no prekey, so it can't read a secure
  conversation. Chat members all write; a `read` role (decisions.md follow-up H5) would need prekeys too.
- **Local key store size**: a key per kept record, in memory and in the engine's table (about 100 B each).

## Not checked

- Megolm's page has no date.
- RFC 9420 §14 to 16 were not read verbatim.
- DCGKA's full text was not read.
- Costs on a phone.
- The local key store's write cost.
- Whether RocksDB's deletes reach the disk (the vault spec's job).
