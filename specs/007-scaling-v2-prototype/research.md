# Research: Scaling v2 Prototype

Measured on the dev machine (Windows 10, i7-6700K 4 cores / 8 threads, 17 GB), 2026-10-06. v1
background: `specs/research/scaling-v2.md`.

## R1 — Following many authors' logs is cheap up to ~1,000 per reader (measured)

`bench/many-cores.js`: one peer holds C logs of 100 blocks; a fresh reader opens them all by key,
reads every latest block, then follows them live.

| logs | open + read every tail | downloaded per log | memory per open log | live arrival p50 / p95 |
|---|---|---|---|---|
| 10 | 0.05 s | ~590 B | ~200 KB | 2 / 4 ms |
| 100 | 0.12 s | ~620 B | ~127 KB | 1 / 2 ms |
| 1,000 | 0.71 s | ~660 B | ~122 KB | 2 / 3 ms |
| 5,000 | 3.0 s | ~660 B | ~75 KB | 2 / 4 ms |

**Decision**: messages live in authors' own logs; a reader opens only the logs of authors active
in the segments it reads. A segment with up to ~1,000 active authors costs a reader under a second
and ~120 MB. Beyond that, a reader needs fewer logs per segment: compaction of closed segments
(FR-010) or reading only part of the roster. Caveat: all logs came from one peer over one
connection; logs spread over many peers add connections (measured later in the prototype).

## R2 — Members announcing to an Autobase as optimistic blocks still cost every indexer (measured, rejected)

`bench/roster.js`: a control log with one indexer; M members, not writers, each append one
optimistic block ("active in channel X, my log is K"), acknowledged with `host.ackWriter`.

| members | indexer memory per member | after 1 min idle | reader: read whole roster | reader memory per member |
|---|---|---|---|---|
| 200 | ~215 KB | — | 0.28 s | ~55 KB |
| 500 | ~200 KB | ~162 KB | 0.36 s | ~38 KB |
| 1,000 | ~173 KB | — | 0.50 s | ~27 KB |

v1 adds every member as a writer: ~70 KB per member on every applying peer (`bench/members.js`).
Acknowledging instead of adding does not help: the indexer keeps a lasting cost per member who
ever announced. A community where 50,000 people posted would need ~8 GB on every indexer.

**Decision**: the control log stays small and is written by admins only (members, roles,
moderation, channels, keepers). Activity does not go through it.

Harness findings, kept for whoever extends it: each simulated member needs its own Autobase
`keyPair` (every Autobase opened from one store otherwise gets the same local key), and its own
connection (an indexer never heard of a second member announced on a reused stream).

## R3 — Rosters kept by keepers, single-writer (decision, to measure in the prototype)

A channel's roster says, per segment, which authors posted and where (log key, first seq).
Options considered:

| option | cost | rejected because |
|---|---|---|
| control log entries per author per segment | R2: lasting memory per author on indexers | measured |
| every reader follows every member's log | R1 × all members: 50,000 logs ≈ 6 GB | memory |
| authors write the roster themselves into a shared multi-writer structure | same as R2 | measured |
| **keepers**: members with the `keeper` role each keep a single-writer roster per channel; authors announce to connected keepers; readers merge the rosters of all keepers they reach | one small entry per (author, segment); a plain signed log, no per-author open core | — |

A keeper can omit an author (completeness is trusted) but cannot forge one: every roster entry
carries the author's signature over (community, channel, segment, log key, first seq), and every
message is in a log signed by that author's channel key. Several keepers → readers take the
union, so one keeper hiding someone isn't enough. Authors announce through a Hypercore extension
message on the keeper's roster core (the core readers replicate anyway), so no new transport is
invented (Constitution III).

To measure in the prototype: keeper memory and disk per announced author, time from a post to the
author being listed, and a reader's cost with 2 keepers.

## R4 — Segments are fixed time slices, not control log entries (decision)

A channel's record (control log, written once) fixes its segment length (e.g. 1 hour or 1 day).
Segment `s` of a channel covers `[s × length, (s+1) × length)` by the author's claimed time. No
per-segment entry exists anywhere except in rosters, so the control log does not grow with
time or activity (FR-003). A message claiming a time beyond `now + 5 min` (the reader's clock) is
not shown until then (edge case: clock skew; same bound as v1 moderation).

## R5 — One log per (author, channel), with its own key pair (decision)

An author's messages for one channel go to one Hypercore; reading a channel's tail never reads
other channels' messages. The log's key pair is derived from the author's identity seed, the
community and the channel, so the author can reopen it on any device holding the seed; the roster
entry binds it to the author's identity with a signature. Messages need no signature of their own:
Hypercore signs the log.

Compared to one log per (author, community) with a Hyperbee keyed by channel: fewer logs per
author, but every read pays B-tree lookups and the index's blocks; per-channel logs make the tail
of a channel exactly the last blocks of each log.

## R6 — Local state in a local database (decision)

What a peer has shown (the pages: which authors' blocks, per segment) and the decisions it took
(replication mode, budget use) are kept in a local RocksDB (`rocksdb-native`, already installed
under Corestore), not in a signed replicated log: deletable, compactable, no per-entry Merkle and
signature overhead (v1 GraphView measured ~183 B per block of it). Offline, a page is rebuilt from
it and from blocks the peer holds, never from a structure whose latest version may need fetching
(the v1 offline-reopen bug).

HyperDB's RocksDB engine was considered: it needs a generated schema (hyperschema build step) for
a handful of keys; plain key/value is enough for the prototype.

## R7 — Replication `all | sparse | auto` (decision)

- `all`: download every author log listed in every roster, from the start, and follow them.
- `sparse`: download what is read, plus the current segment's logs.
- `auto` (default): estimate the community's content from the rosters (log lengths and byte
  lengths, known from each log's metadata without its blocks); `all` while it fits the budget,
  else `sparse` plus the most recent segments that fit. Re-evaluated when rosters grow.
- Budget default: a fixed figure per community (e.g. 1 GB), configurable. Disk-free-based defaults
  are left for later (platform differences).

## R8 — Moderation on partial data (decision)

Bans and hides are control log entries (admins/mods only), so every member has them in full.
- **Hide**: (author, log key, seq) → readers show it as hidden.
- **Ban**: author + the ban's time; keepers stop listing the author in segments after it; readers
  hide the author's messages claiming a time after the ban (a banned author backdating messages
  can still appear in a past segment's roster if a keeper had listed them: stated, and keepers
  refuse announcements for segments older than the current one).
- **Ban, revised (2026-10-06, found by `test/brittle/v2/moderation.js`)**: the time rule alone
  let a banned author who was already listed in the current segment keep posting: no new roster
  entry is needed to append to a listed log, and dating each post like the last one before the
  ban passes the rule. The ban now also records, for the author's logs listed in the current or
  previous segment of each channel, the length the mod sees (`cut`); readers show those logs only
  below it, the same on every peer. The time rule remains for other logs; the remaining gap is a
  log last listed in an older segment, where backdated posts can show on scrollback to that
  segment.

## R9 — Measuring at 10M without running 10M live posts (decision)

Histories are generated by writing authors' logs in bulk (many blocks per append) and roster
entries in bulk, in a few processes, within the machine's limits (CLAUDE.md). Live behavior
(arrival, throughput) is measured with up to ~100 concurrent writers in a handful of processes,
not one process per writer.
