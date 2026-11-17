# Spec 027: renewing a space (research first)

**Created**: 2026-11-17 · **Asked by**: Tibo, grilled 2026-11-17 · **Status**: research (no build until the lead and
Tibo review it) · **With**: HyperBrowser spec 023 (the app side, written after this research)

## Why

Security after an incident or a ban. Today (022): content is sealed with epoch keys and `space.rotateKey()` changes
them at once (new content hidden from the removed person, nothing rewritten); but a private space's **disk key**
(Autobase `encryptionKey`, hides members, types, timing) can't change on stored data, so whoever has it (a removed
member, an old holder) and the core keys keeps fetching new ciphertext and reading its metadata. Renewing gives the
space new cores and a new disk key. Also: an optional **truncation** (keep the last N months) so spaces don't grow
forever. ROADMAP 2026-11-13 refused "own per-block rotating crypto"; the research may argue otherwise with evidence.

## Decided (Tibo, 2026-11-17)

- **D1** Manual, by owners and admins, and **suggested by the app after a removal**.
- **D2** One action **"Secure this place"**: `rotateKey()` at once, then the renew in the background. "Renew" alone too
  (for truncation).
- **D3** **Gradual**: the renewed space is used at once (new writes go to new cores); old content is copied in the
  background; until it's copied, readers read old parts from the old cores with the old key (several key versions
  live together). A device that gets the space mid-renew uses what exists (old copies) without waiting for the copy
  to finish (Tibo's case: a space moving to another device).
- **D4** The old space gets a signed **"moved to"** record; readers, links and bookmarks follow it; the old space is
  read-only, and holders drop it 30 days after the copy is done.
- **D5** **Members carried over** without new invites (new disk key sealed to each current device, as 022 does on
  redemption); removed people not; old invite links stop working.
- **D6** Private spaces; public spaces only for truncation.
- **D7** **Truncation** only when renewing ("keep the last N weeks/months/years"); members warned that older history
  goes (copies others already have can't be recalled).

## Research questions (`research.md`, stop and report before building)

- **RQ1 Hypercore/Autobase**: can a live Autobase change its `encryptionKey` (or add a new one for new blocks)? How
  `encryptionKey`, block encryption and `_coreOpts` work today (022's code), what a new core per writer costs, how
  Autobase handles a writer set moving to new cores. If something upstream makes this much simpler, say so first.
- **RQ2 How others rotate keys on big data gradually**: LUKS2 online re-encryption, database encryption-at-rest key
  rotation (Postgres/MySQL TDE, wrapped keys: key-encryption key vs data key, cloud key services), Matrix (Megolm)
  and Signal group key rotation, MLS (RFC 9420), Keet; lazy vs eager re-encryption, what each guarantees during the
  transition.
- **RQ3 Does `rotateKey()` already cover content?** What a removed member with the old disk key and core keys can still
  learn after `rotateKey()` alone, and after a renew. Holders: what each sees during and after.
- **RQ4 Design**: old cores readable until copied (D3), how readers merge old and new (no duplicates, order kept,
  links and record ids across the move), the "moved to" record (D4), truncation (D7), what happens if the person
  renewing goes offline mid-copy (another owner/admin continues?), two admins renewing at once.
- **RQ5 Cost**: time, disk and uploads for a 200 MB and a 10 GB space, at today's speeds; what holders (023/024) must
  re-download.

## Deliverables

`specs/027-renew-space/research.md` (answers with sources, a recommended design, what it changes in D1–D7, open
questions for Tibo), and a small experiment if RQ1 or RQ4 needs one (`research/renew/`). No `lib/` change.

## Not in 027's research

HyperBrowser's UI (spec 023 later). Holder picking (025).
