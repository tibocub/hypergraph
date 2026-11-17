# Research 027: renewing a space

**Date**: 2026-11-17 · **For**: the lead, then Tibo (grilling) · **No `lib/` change.** Experiment:
`research/renew/test.js` (`node research/renew/test.js`, 2 tests, pass).

## Short answer

- Upstream can't rotate the disk key. Autobase 7.28 has key *ids*, but every block key is derived from the one
  `encryptionKey` it was opened with. New key = new cores. The spec's direction stands.
- **No copying is needed.** Re-encrypting old content protects nothing: everyone who had the old key already
  had (or can get) the old ciphertext. Every system studied (KMS, MySQL, Matrix, Keybase) leaves old data
  under its old key. A renewed space = a new decision log, new message logs and a new disk key for everything new.
  The old logs stay as its **read-only history** (same record ids, so links still work).
- **Truncation needs no copy either**: Hypercore `clear()` drops old blocks; the kept ones still verify (tested).
  It doesn't need a renew, so it works for public spaces too.
- So the copy (D3), the "30 days after the copy" (D4) and "an admin goes offline mid-copy" disappear. A renew is a
  handful of decisions, done in seconds.

## RQ1: what Autobase and Hypercore allow

**Today (022).** `lib/space.js:91`: `_coreOpts = { encryption: { key: encryptionKey } }`, used for every message
log (`space.js:442,488,510,561`). The decision log is one Autobase opened with `encryptionKey` (`lib/decisions/log.js:53`).
Sub-spaces share the top space's decision log and disk key (022 research R1).

**Hypercore 11.37** (`hypercore/index.js:1148,1361`): blocks are encrypted *before* hashing (`preappend`), so the
signed Merkle tree covers ciphertext. The key is fixed into the core's signed history: you can't change it without
rewriting the core, so it has to be a new core. `setEncryption()` is pluggable per session: a provider could tag each block with a
key id (Autobase does exactly that). It's possible, but it is our own per-block crypto, which ROADMAP 2026-11-13 refused.
It would also still leak sizes, timing and the whole decision log. Not recommended.

**Autobase 7.28** (`autobase/lib/encryption.js`):
- Writer and view blocks carry a 4-byte key id (`encryptBlock`, padding bytes 4–8). Each id maps to an "entropy"
  stored in an internal `_encryption` view core.
- Block key = `hash(NS, bootstrap, encryptionKey, entropy, coreKey)` (`getBlockKey`). **The root `encryptionKey`
  is always in it.** New entropy comes only from `host.fork()` (`lib/fork.js:63`), and it is derived from
  public data (indexer keys + length, `lib/system.js generateEntropy`). So anyone holding the root key
  derives every future key. **This is not rotation against a key holder.**
- `encryptionKey` is read once at boot and saved in the local core's user data (`lib/boot.js:104`). There's no API
  to change it on a live base.
- `host.fork(indexers)` (apply-time only) moves the views to new indexer cores with the same base key and the same
  root key. It exists to recover lost indexers, not for security. Not usable here.
- New Autobase = new base key = new space key. Cost of a new space: `spaces.create` ≈ 35 ms (perf/history.jsonl, node).
  New writer core per device: one `store.get` (`logs.open` ≈ 0.6 ms/log).

**Already in our code:** a device moves to a fresh log when its old one is cut (`#openOwnLog(generation + 1)`,
`space.js:557`), and readers keep a cut log up to its cut (`gate.js checkLog`). A renew reuses this pattern.

**Verdict:** upstream doesn't make it simpler. The approach stays "new cores + new key", with no copy (RQ4).

## RQ2: how others rotate keys on big data

| System | Old data | During the change | Fits us? |
|---|---|---|---|
| LUKS2 online re-encryption | Rewritten in place, in the background, with a crash-safe "hotzone" (checksum/journal modes) [1] | Device stays mounted; two keys live together | Its threat model is the disk itself, so every sector must move. Ours: the old readers already have the old data |
| AWS KMS rotation | **Not re-encrypted**; old key versions kept to decrypt; new writes use the new version. AWS's own guidance: rotation adds no protection for data already encrypted [2][3] | Nothing to wait for | Yes: keep the old key for old data |
| MySQL InnoDB / Percona TDE | Master-key rotation re-wraps tablespace keys only, never the data [4] | Atomic, rolled forward after a crash | Same idea (wrap the old key for new members) |
| Matrix Megolm | Never re-encrypted. New session after N msgs/time and on history-visibility change [5]; old session keys shared with newcomers when history is shared (MSC3061) [6]. Rekey on leave: clients discard the outbound session [7] | Several sessions live together | Yes: our epoch keys already do this (022) |
| Signal / WhatsApp sender keys | A removal makes everyone send fresh sender keys; old messages untouched [8] | Immediate | Same as `rotateKey()` |
| MLS (RFC 9420) | Each Commit (e.g. a Remove) starts a new epoch; a removed member doesn't get its secrets [9]. Old epochs are never re-encrypted | Epochs are linear | Our epochs are the same idea |
| Keybase teams (CLKR) | New team key on removal, **lazily** (before the next write, by any online admin) [10] | Old keys kept for old data | Yes: the lazy pattern fits "any admin can finish" |
| Keet (Holepunch) | Closed source; nothing published on rotation. Autobase (its base) has none (RQ1) | – | Unverified |

**Takeaway:** only full-disk encryption re-encrypts old data, because there the stored ciphertext itself is the
threat. Group systems (Matrix, Signal, MLS, Keybase) and key services (KMS, TDE) all go *forward-only*: new key
for new data, old keys kept (wrapped) for whoever may read history. Ink & Switch's Keyhive says the same for local-first:
access you already gave out can't be taken back.

## RQ3: does `rotateKey()` already cover content?

Yes for **content**. 022 already changes the epoch key automatically when a device that may no longer read holds the
current one (`#change` → `'now'`, `space.js`). A removed member who keeps the **disk key** and the **core keys** can
still fetch new blocks. Hypercore serves anyone who knows a core's key; holders and blind peers do too, and I found no
membership gate in `lib/replication.js`. They learn:

| After… | Removed member can read |
|---|---|
| `rotateKey()` only | **The whole decision log**: who joins/leaves, roles, bans, moderation targets, new devices, grant headers, epoch changes, all with times. **Each record's metadata**: author log, `kind`, `type`, `stamp`, edit/delete `target` (`encodings.js record`, plain inside the disk layer), size, timing. **Not** fields or links (sealed with the new epoch). New members' log keys come through the decision log, so they find and fetch them |
| renew | The old space only, which is frozen: nothing new there. Of the new space: nothing if the "moved to" record is sealed per device (D4 below). Even with core keys: ciphertext, sizes and append times only (test 1) |

**Holders** (023/024 blind peers, no disk key): before, during and after, they see core keys, lengths, sizes and timing
only. A renew adds new cores to hold. In the no-copy design, the old cores stay as they are (nothing to download again).

So a renew only buys **metadata privacy going forward**: members, types and timing. That is the reason for it;
content is already handled.

## RQ4: design (recommended)

**Renew = forward-only.** The renewed space reads the old one as its history; nothing is copied.

1. **Start**: an owner/admin device creates a new Autobase (new space key) and a new disk key. Its first decision is
   `space/init` with `renewed: { from: oldKey }` and a **snapshot** of the old state: name, types, members, roles,
   bans, the epoch key ring, and `history`, the list of old logs with the length each was cut at. All current
   decider devices are added as writers right away, so any of them can carry on (not only the one who started).
2. **"Moved to"** (D4): appended to the **old** decision log, `space/moved { sealed: per current device:
   seal(newKey + newDiskKey) }`, using the box keys 022 already uses. Removed people aren't in it, so they learn
   neither the new address nor the key. Devices switch **only once this decision is indexed** (final in Autobase).
3. **Reading** (D3): the new space's directory treats the old logs as read-only history logs, each opened with the
   **old** disk key (per-log `encryption`) and kept up to its cut (the existing `checkLog` limit; the header proof is
   checked against the old space key: the predecessor counts as "this space"). Record ids are `(log key, seq)`
   (`encodings.js recordId`), so **ids, links, edits and deletes across the move are unchanged**, and there are
   no duplicates (nothing is copied). Order: by stamp across logs, as today.
4. **Late writes**: a device offline during the renew that wrote to its old log after the cut re-posts those records
   into its new log when it learns of the move. It is the author, so its signature stays valid (they get new ids; links
   to them are rare). Others ignore old-log records past the cut.
5. **Two admins at once**: two `space/moved` decisions in the old log. The first in Autobase's indexed order wins,
   and the loser's device closes its unused space. Nobody wrote to it, because devices switch only on the indexed
   decision. Today's `rotateKey()` handles races the same way (`#rotate` retries).
6. **The renewer goes offline**: before `moved` is indexed, nothing happened (another admin starts again). After it,
   every decider is already a writer of the new log (step 1). There's no long job left to finish.
7. **Newcomers after a renew**: they get the new disk key at redemption, as in 022. If history is visible, they also
   get the old disk key the same way (sealed to the device). If history is hidden (022 `history: 'hidden'`), they don't.
8. **Truncation** (D7), separate from renew: a decision `history/trim { logs: [{ log, below }] }`; the decider computes
   `below` from stamps. Each device runs `core.clear(0, below)`, drops index rows and stops fetching those blocks.
   Kept blocks still verify and keep their ids (test 2). Copies others already have can't be recalled (accepted
   in D7). The decision log itself can only be trimmed by a renew (the new one starts from a snapshot). Trimming past
   the renew point lets everyone drop the old space entirely, which is the only way to **retire** an old disk key (case:
   a stolen device's key leaked to an outsider who doesn't hold the ciphertext yet).

**Rejected**: copying old records into new cores (the spec's D3 as written). Beyond the cost (RQ5), **an admin
can't re-sign other people's records**: authorship comes from each author's own core signature. A copy would be
"carried by admin X", so readers would have to trust X not to forge old posts. Absent authors can't copy their own.
Also rejected: per-block key ids inside existing cores (own crypto, leaks the decision log anyway).

## RQ5: cost

Measured (scratch run on E:, an HDD, node, Hypercore 11.37 with encryption): local read + re-encrypt + append runs at
**14 MB/s** with 1 KB blocks (14,000 blocks/s) and **39 MB/s** with 64 KB blocks. Through hypergraph's write path,
records go at ≈ **690/s** (`forum.write`). Network upload is assumed at 10 Mbit/s (≈ 1.25 MB/s; not measured).

| | 200 MB space | 10 GB space |
|---|---|---|
| **Recommended (no copy)**: renew | ≈ new space (35 ms) + a few decisions + sealing to each device (`grants.seal` 14 ms @100, 134 ms @1000). Uploads: a few KB | Same: doesn't grow with size |
| ... holders re-download | Nothing (old cores untouched); new cores hold only new writes | Nothing |
| ... disk | +0 | +0 |
| Copy (spec D3 as written): local work | ≈ 5–15 s raw; ≈ 5 min through the write path if ~1 KB records (200k records) | ≈ 4–12 min raw; hours through the write path for small records |
| ... upload by the copier | ≈ 160 s at 1.25 MB/s | ≈ **2.3 h** |
| ... every holder/member device | re-downloads 200 MB | re-downloads **10 GB** each (5 holders ≈ 50 GB of traffic) |
| ... disk | 2× until the old space is dropped (D4: +30 days) | **20 GB** per device for a month |
| Truncation (`clear`) | Frees the cleared bytes; no transfer | Same |

## What it changes in D1–D7

- **D1** unchanged. (022 already changes the content key on removal; the app's suggestion covers metadata.)
- **D2** unchanged: "Secure this place" = `rotateKey()` + renew. But both finish in seconds, with no background work.
- **D3 changed**: nothing is copied. The renewed space is used at once and the old logs are its read-only history,
  read with the old key **for good** (not "until copied"). Tibo's mid-renew device case works without anything extra.
- **D4 changed**: "moved to" is **sealed to current devices** (removed people don't learn the new address). Old cores
  aren't dropped "30 days after the copy": they stay as history until a trim passes the renew point.
- **D5** unchanged. Plus: every current decider becomes a writer of the new decision log at once, and the old disk key
  is handed to newcomers when history is visible.
- **D6 changed**: truncation works on **public spaces too**, without a renew.
- **D7 changed**: truncation is its own action (`clear`, no copy), not tied to a renew. A renew is still how the
  decision log's history gets cut.

## Open questions for Tibo

1. OK that old content **stays under the old key** (removed people could already read it)? Recommended: yes.
2. Truncation as its **own action**, for public spaces too? Recommended: yes.
3. A "forget history" option (renew + trim to the renew point) for the stolen-key case. Needed now or later?
4. Records written to an old log by an offline device after the move: the author re-posts them with **new ids**. OK?
5. History for newcomers after a renew: follow the space's existing `history` setting? Recommended: yes.
6. Sub-spaces share the top space's disk key, so renewing a top space renews all its sub-spaces. OK?

## Not verified

- Matrix's exact rule for rekeying on leave (spec text not found; client code discards the session [7]).
- Keet's behaviour (closed source).
- Upload speed (assumed 10 Mbit/s); record size mix of real spaces (blobs vs 1 KB records).
- "No membership gate on replication": from reading `lib/replication.js`, not a test.
- How 023/024 holders handle `clear()` / a trim decision (not read; holders may keep serving cleared blocks).
- Copy speeds: one run, one machine, HDD.

## Sources

1. cryptsetup 2.2.0 release notes (online re-encryption, resilience modes): https://www.kernel.org/pub/linux/utils/cryptsetup/v2.2/v2.2.0-ReleaseNotes ;
   RHEL 10, data protection during LUKS2 re-encryption: https://docs.redhat.com/zh-cn/documentation/red_hat_enterprise_linux/10/html/managing_storage_devices/options-for-data-protection-during-luks2-re-encryption
2. AWS KMS FAQ: https://aws.amazon.com/kms/faqs/ ; rotating key material: https://docs.aws.amazon.com/kms/latest/cryptographic-details/rotate-customer-master-key.html
3. AWS Prescriptive Guidance, key rotation scope: https://docs.aws.amazon.com/prescriptive-guidance/latest/aws-kms-best-practices/data-protection-key-rotation.html
4. MySQL 5.7 InnoDB data encryption: https://docs.oracle.com/cd/E17952_01/mysql-5.7-en/innodb-data-encryption.html ; Percona rotating master key: https://docs.percona.com/percona-server/8.0/rotating-master-key.html
5. Megolm rotation: https://matrix-tutorial-andybalaam-442bdd63d97445db1c6c46653b0f7f1e6e34.gitlab.io/megolm.html ; https://spec.matrix.org/v1.17/olm-megolm/megolm/
6. MSC3061 shareable room keys: https://git.sudo.is/matrix/matrix-doc/src/branch/main/proposals/3061-shareable-room-keys.md
7. Matrix SPEC-293 (leave → rekey, open question): https://git.sudo.is/matrix/matrix.org/src/branch/main/static/jira/browse/SPEC-293 ; matrixlib `discard_session`: https://matrix-tutorial-andybalaam-442bdd63d97445db1c6c46653b0f7f1e6e34.gitlab.io/module_doc_megolm.html
8. Balbás et al., analysis of Signal/WhatsApp Sender Keys: https://eprint.iacr.org/2023/1300.pdf ; https://www.usenix.org/system/files/usenixsecurity23-balbas.pdf
9. RFC 9420 (MLS): https://rfc-editor.org/rfc/rfc9420
10. Keybase CLKR: https://book.keybase.io/docs/teams/clkr ; Teams crypto: https://book.keybase.io/docs/teams/crypto
11. Ink & Switch Keyhive notebook: https://www.inkandswitch.com/keyhive/notebook/02/
12. Code: `autobase@7.28.2` `lib/encryption.js`, `lib/fork.js`, `lib/system.js`, `lib/boot.js`; `hypercore@11.37.2` `index.js`.
