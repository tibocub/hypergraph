# Spec 030: padding private records

**Created**: 2026-11-21 · **From**: research 029 RQ5 (decided with Tibo) · **Status**: built

## Why

A private space's blocks are encrypted, but their length shows: holders (members' devices keeping copies, in
circles), the network and the disk tell a 3-character reply from a long post. Padding hides it.

## Decided

- **256 B minimum, then Padmé** (research 029: +31% on a private forum's blocks, 55 sizes left instead of 419).
- **Stored, inside the encryption.** Holders are members too, so transport-only padding was rejected. The padding is
  encrypted with the block, so it is random-looking and can't be stripped or compressed away.
- **Versioned**: a better scheme can replace this one without breaking old data.

## What

- **Where**: `OwnLog.append` (`lib/log.js`) encodes a record with `enc.encodeRecord(r, { pad })`, `pad` true when
  the log's core is encrypted (`core.encryption`). Hypercore encrypts the padded block as written; every reader goes
  through `enc.decodeRecord`, which unpads.
- **Format**: `uint 16` (a marker: a record starts with its kind, 0 to 2) · `uint scheme` (1) · `uint length` ·
  the record's `length` bytes · zeros to `pad(3 + length)` bytes in all, where `pad(n)` = 256 for n ≤ 256, else
  Padmé(n). A block whose scheme isn't known is refused (`INVALID_RECORD`, "padded with scheme N"); a padded
  record's inner length is capped at 64 KB as before.
- **A private board in a public space** has no disk key (its blocks aren't encrypted, only its fields and links
  are sealed): there the sealed payload is padded instead, inside its box (`pc.sealRecord(..., { pad })`): the
  payload ends itself, then a scheme byte (1), then zeros; old readers already skip trailing bytes. Its record
  type and framing stay in the clear, as before, so sizes differ by type name only. Near the 64 KB limit it is
  padded less, so a record that fit still fits.
- **Covered**: every record of a private space and its sub-spaces (same disk key), of the personal space, and of
  circles (their `hg/holder` records); SwarmFS's inline small files are records, so they are padded in private
  spaces.
- **Not covered**:
  - public spaces (not encrypted: padding hides nothing);
  - a log's header (block 0, the same size for every device);
  - decision logs: Autobase wraps each value in its own oplog block (heads, checkpoints, acks), which varies
    in size by itself (an owner's blocks: 275, 1594, 289, 302, 837, 837 B), and an older peer would skip padded
    decisions and diverge silently. Their own step, inside Autobase;
  - big files' blob cores (their size shows, as 029 said);
  - the local blind-peer records of a holder (never replicated).

## Compatibility

- **Old data**: unpadded blocks start with their kind (0 to 2) and read as before; new blocks are padded. A log can
  mix both; nothing to migrate.
- **Old code**: a build from before this reads a padded block as a malformed record (`Unknown record kind`) and
  skips it. Peers must update together (CHANGELOG). A padded sealed payload (a private board in a public space)
  reads in old builds too.
- **Why +40% here, not research 029's +31%**: 029 priced every block of every core (decision logs and views
  included, bigger on average); this counts records only.

## Tests

`test/next/unit/padding.js`: records a few bytes apart store the same size; the length round-trips; a holder's
copy shows only padded sizes; an old unpadded block still reads; an unknown scheme is refused; public spaces stay
unpadded; a sealed payload pads, opens, and still fits near 64 KB. `test/next/forum/private.js`: a private board's
posts, comments and votes, as a member without its key holds them, are one size; a long post shows its rough size
only. Perf:
`perf/scenarios/private.mjs` (write, read, bytes stored per record).

## Numbers

`research/privacy/padding/overhead.mjs`: 3 members of a private forum on a local DHT write 1,200 records; texts
are slices of `docs/next/*.md` (English prose), log-normal lengths, medians chat 40, comment 150, post 600
characters (assumed, not measured from users); simulated times, a log-normal gap per action (median 20 s).
"Real" is the record as encoded (sealing included), "padded" the block before the core's 8 B nonce.

| Records | n | real B (mean) | padded B (mean) | overhead | sizes seen | 128 B minimum | compress first |
|---|---|---|---|---|---|---|---|
| chat lines | 602 | 181 | 271 | +49% | 21 | +40% | +44% |
| votes (reactions) | 305 | 109 | 256 | +134% | 1 | +17% | +134% |
| comments | 241 | 346 | 391 | +13% | 35 | +13% | −11% |
| posts | 52 | 939 | 966 | +3% | 33 | +3% | −42% |
| members' records (`hg/grant`) | 4 | 195 | 256 | +31% | 1 | +31% | +31% |
| all | 1,204 | 229 | 321 | **+40%** | | +22% | +23% |

Deferred optimizations, against the padded total (386 KB; estimates, none built):

- **128 B minimum**: −13% (votes drop from +134% to +17%); votes would then show as one size and chat lines
  start splitting from them at 128 B.
- **Compressing before padding** (deflate on the opened fields): −12%, all from posts and long comments; short
  texts don't compress. Careful: compressing secret text next to text an attacker chooses leaks through size.
- **Packing records written within 200 ms**: 0% (1,204 records in 1,202 blocks): people don't write twice in
  200 ms. It pays only for bursts written by code (an import, a folder of small files): the same records
  packed back to back into blocks of up to 4 KB would cost −27%.

The perf scenario (`private.mjs`, 500 records, one writer; medians of two runs each, Node / Bare):

| | before | after |
|---|---|---|
| private.write (records/s) | 480 / 400 | 459 / 486 |
| private.read (ms) | 0.81 / 0.77 | 0.70 / 0.73 |
| private.bytes (B/record) | 335.6 | 427.2 (+27%) |

Writes and reads move within the noise; storage grows by the padding.
