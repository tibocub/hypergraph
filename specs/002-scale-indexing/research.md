# Research: Scale Indexing to 1M+ Entries

All measurements: `bench/scale.js`, one Windows 10 machine (16 GB RAM, Node 26.4), 2026-10-04.
Experiment code lives on branch `perf-experiments` (worktree `../hypergraph-perf`) and is not
meant to be merged as-is: it uses env flags and global timers.

## R1 — Why indexing is slow: one signed, flushed append per index write

**Finding**: CPU profiles of a 5,000-file run show 26–37% of wall time idle (waiting on RocksDB
flushes in native threads), ~10% in `crypto_sign_detached` / `crypto_generichash_batch`
(signing and hashing each new hypercore length), and ~5% opening and closing a snapshot session
per Hyperbee `get`. Each `bee.put` is one `core.append`, which re-hashes, re-signs and flushes.
GraphView does ~4 puts + 1 get per entity and 1 put per content version, all awaited in sequence.

**Decision**: GraphView writes through a `bee.batch()` that is flushed every `INDEX_BATCH` events
(default 1,000) and at the end of each core's pass. The per-core progress record
(`lastSeq`) is written **into the same batch**, so index entries and progress commit atomically.

**Measured**: 10k files, author side, GraphView indexing 14.5 s → 2.6 s (5.5×).

**Rationale**: Hyperbee batches append all their blocks in one `core.append`, so one hash, one
signature and one flush cover the whole chunk. `batch.get()` sees the batch's own pending puts,
so the existing read-before-write checks (entity already exists, tombstone) keep working. Readers
outside the batch see nothing until a flush, which is what makes progress visible in chunks
(FR-004) and makes a crash lose at most one uncommitted chunk, re-processed on restart (FR-003).

**Alternatives considered**:
- *One batch per whole `update()` pass*: maximum throughput, but memory grows with the pass
  (violates FR-006) and nothing is visible until the end (violates FR-004).
- *Leave per-put writes, parallelise them*: Hyperbee serialises writes per bee anyway.

## R2 — Context replay cost is set by the writer's batch boundaries

**Finding**: Autobase calls `apply` once per *writer batch* (`node.batch` boundaries recorded in
the oplog), and after each one runs `system.flush(views)` + `system.update()`
(`autobase/lib/apply-state.js` `update()`). Hypergraph appends one event per `base.append()`, so
10,063 events → 10,063 apply calls on **every** peer, forever. Batching index writes *inside*
apply (experiment) changed almost nothing for exactly that reason: the per-call overhead
dominates.

**Decision**: a writer's bulk call appends all its events for one context in **one**
`base.append([...])`, producing one Autobase batch. Inside `#applyView`, index writes go through
a `view.batch()` flushed once at the end of the apply call (FR-002).

**Measured**: 10k files: apply calls 10,063 → 10; context write 34 s → 3.8 s; fresh-peer join
52 s → 20.7 s before R4's prefetch.

**Bounded memory against an adversarial writer (edge case)**: a hostile writer can make one
batch of any size. Autobase already holds a whole batch's nodes; hypergraph's `view.batch()`
adds pending index entries for that batch. Decision: inside apply, flush the view batch every
`INDEX_BATCH` events rather than only at the end. Autobase's own view-batching remains the
atomicity boundary (it truncates on reorg regardless), so intermediate flushes inside one apply
call are safe.

## R3 — Autobase batched appends break with a custom value encoding and with `optimistic`

**Finding 1** (`autobase@7.28.1` and latest `7.28.2`): `_appendBatch` runs
`normalize(valueEncoding, value)` on the *whole* argument before checking `Array.isArray`, so an
array is encoded as one value and hypergraph's `encodeEvent` throws `Unknown event type`.
`AppendBatch.flush()` goes through the same path.

**Finding 2**: `{ optimistic: true }` with an array sets `_optimistic = length - 1`; the local
head flush (`_addLocalHeads`) is built for a single optimistic block and splits the batch, and
apply then receives nodes with `value === undefined` (reproduced: 998 of 1,000 values
`undefined`; the existing `#applyView` crashes on `event.type`). Optimistic append is a
single-block, not-yet-a-writer mechanism; ContextBase's Autobase is not even constructed with
`optimistic: true`, so `_hasOptimisticApply` is false and the flag only has its batch-splitting
side effect for an existing writer.

**Decision**:
- ContextBase gives Autobase **binary** values: it encodes with `encodeEvent` in `append()` and
  decodes with `decodeEvent` at the top of `#applyView` (and wherever it reads oplog values).
  Autobase stores `node.value` bytes verbatim either way, so the bytes on the wire and on disk
  are **identical** to today (FR-021). A regression test pins this by comparing raw oplog blocks
  written through the old and new paths.
- Bulk appends use `{ optimistic: true }` only when the local writer is not yet a writer
  (`!base.writable`), and in that case fall back to one append per event (correct, slow, rare).
  When `base.writable`, one plain `base.append(array)`.
- `#applyView` skips `null`/`undefined` values defensively (Principle I: never crash on a node).
- Both findings to be reported upstream; not a dependency.

**Alternative considered**: an array-aware codec (prefix byte 0xff for "this is a batch", tried
in the experiment). Rejected: it works only because `normalize` round-trips through our decoder,
i.e. it depends on an Autobase internal, and it makes the codec lie about what a value is.

## R4 — Joining peers fetch the author's log one round trip at a time

**Finding**: GraphView calls `core.get(i, { timeout })` per block. On a fresh peer every block is
missing, so each is a network round trip: 10.6 s of 20.7 s at 10k files.

**Decision**: before processing a core, request blocks ahead with a non-awaited
`core.download({ start, end })` over a sliding window of `PREFETCH_WINDOW` blocks (default 4,096)
in front of the read position, re-armed as the read position passes half the window. Not
awaited, so a block no connected peer has never blocks the update (FR-005); `core.get`'s
existing timeout keeps behaving as today.

**Measured**: whole-range prefetch, 10k: join 20.7 s → 11.8 s. At 100k the per-block `get` loop
still took 105 s of 134 s with whole-range prefetch, and peak memory on the joining peer stayed at
3.7 GB. A bounded window is chosen partly because a 200k-block range request is the leading
suspect for that peak; this is verified, not assumed, in a dedicated task (FR-006).

## R5 — Bulk-write API shape

**Decision**: a builder, `graph.batch()`, with the same verbs as the single-item methods
(`put`, `putContent`, `putContentRef`, `relate`, `unrelate`, `tag`, `untag`) and one
`await b.flush()`. `b.put()` returns an `EntityRef` usable anywhere an entity id is accepted
inside the same batch; ids are resolved at flush. See `contracts/bulk-write.md`.

**Rationale**: matches the existing method vocabulary (Principle IV: one convention), mirrors
Hyperbee's own `db.batch()` → `flush()` idiom that Holepunch developers already know, and lets
relations point at entities created in the same call (FR-008) without the caller computing
sequence numbers.

**Ids at flush, not at `put()`**: an entity id is `<type>/<author>/<seq>`, and `seq` is only
known once the author's log length is fixed. A user-core write lock (R6) is held from id
assignment to append, so ids are exact.

**Alternatives considered**: `graph.putMany([...ops])` (array of tagged ops): harder to write
cross-references in, and inconsistent with Hyperbee's idiom. Making single-item methods
auto-batch on a timer: changes their durability semantics (a resolved `put()` would no longer
mean "written"), violating FR-013.

## R6 — User-core write ordering

**Finding**: `put()` derives the id from the seq returned by `append`. A bulk call must assign
ids *before* appending, because the content and relation events it builds embed those ids.

**Decision**: UserCore gets a write lock (a promise chain); `append`, `appendBatch` and the bulk
path all run under it, so `length` read under the lock is the seq the first new block will get.
All writes to a user core go through one Hypergraph instance, so an in-process lock suffices.

## R7 — Where the bytes go, and the compact layout

**Measured** (10k files, logical bytes):

| index | key | value | notes |
|---|---|---|---|
| `c:` | 93 B | 484 B | value copies the whole content body out of the user core |
| `n:` | 76 B | 231 B | value repeats id, type, author from the key |
| `nt:`, `nc:` | ~97 B | 83 B | value `{id}` repeats the key's tail |
| `e:` | 167 B | 293 B | value repeats from/to/type; `author` must equal `from`'s author (enforced at apply) |
| `i:in`, `er:` | ~160 B | 177 B | value is the *entire* `e:` key as a pointer |
| `cnt:out` | 85 B | 11 B | one per entity with an outgoing edge |

Keys spell 32-byte keys as 64 hex characters, entity ids are `type/hex/seq` text, timestamps are
16-digit zero-padded text, values are JSON.

**Decision**: a versioned **index layout** module (`src/index-layout/`), with:
- keys built with `index-encoder` (Holepunch, order-preserving tuple encoding; one new
  dependency, depends only on `b4a`), first element a one-byte index tag;
- entity ids encoded as a tuple `(type, author: fixed32, seq: uint)`, falling back to a raw
  string member for ids that don't parse (relations may point at any string);
- values compact-encoded with `compact-encoding` structs, containing only what the key and the
  pointed-to log entry cannot give back.

Full layout in `data-model.md`. Estimated logical index bytes per file: ~2.5 KB → ~0.45 KB.

**Content index points at the log**: the `c:` key already ends in the content event's seq in the
author's core, so its value becomes empty; `getContent()` reads that block from the author's
UserCore (already held locally, since it was indexed from it). Missing core or block → returns
`null` with no crash (spec edge case).

**Ordering**: hex text sorts like the bytes it encodes, and zero-padded timestamps sort like
integers, so every primary ordering is preserved. One deliberate difference: **ties at the same
millisecond** between entities of the same type and author now order by numeric seq
(`…/9` before `…/10`) instead of decimal text (`…/10` before `…/9`). No public API promises tie
order; the new order is the correct one. Recorded in CHANGELOG.

**Alternatives considered**:
- *hyperdb* (Holepunch's schema-driven, compact-encoded database over Hyperbee, with indexes and
  batching built in): the most "ecosystem-native" end state. Rejected for now: it requires a
  hyperschema code-generation build step, wants to own the Autobase apply loop and view, and
  would turn this feature into a rewrite of both views. Worth re-evaluating together with
  fast-forward, where a shared, schema-versioned view is exactly its use case.
- *Keep text keys, only compact the values*: saves ~45%; binary keys roughly halve what remains,
  and key size is paid again in every B-tree node that holds the key.

## R8 — Rebuilding indexes on upgrade

**GraphView** (wholly owned by hypergraph): the view core is named per layout version
(`graph-view` → `graph-view/2`) with a `format` record. Opening finds the current-version core;
if absent it starts empty and indexes every followed log from seq 0. Interrupted rebuild resumes
from the per-core progress records, which live in the new core. The old core is purged
(`core.purge()`) only after the new one has caught up to every log; an older library version
opening the store still finds its own old core, never the new one (spec edge case: rollback).

**Context views** (owned by Autobase): **there is no supported way to rebuild an Autobase view in
place.** Tested directly:
- Renaming the view in `open()` on an existing base: the new view starts empty, nothing is
  replayed, and the next append crashes in `apply-state.js` (`ref.tracer` of `null`).
- Opening a fresh Autobase in a new Corestore namespace with the same bootstrap key and local
  writer key pair: Autobase finds its boot record in the local writer core's user data and
  resumes the *old* system and view.
- Resetting that boot record means editing Autobase's private state. Rejected (Principle III;
  breaks silently on Autobase upgrades).

**Decision**: the layout is chosen **per context view, when the view is first written**:
- an empty view gets a `format = 2` record in its first apply and uses the compact layout;
- an existing view without the record keeps layout 1 (today's text keys) for its lifetime.

Readers and apply never touch keys directly; they call the layout object attached to the view
(`layout.edgeOutRange(from, type)`, `layout.encodeEdge(...)`, ...). Layout 1 is today's code
moved behind that interface, unchanged in behavior; layout 2 is new. Every peer still builds its
own context view (`fastForward: false`), so peers using different layouts for the same context
remain fully compatible: layout is local, not shared.

**Consequence, accepted**: devices upgraded from an older version keep layout 1 for contexts they
had already indexed until that local view is recreated (e.g. local storage wiped). New devices
and newly opened contexts get layout 2. When fast-forward is specced, a context's view becomes
shared and its format must be fixed per context; layout 1 can then be dropped in a breaking
release with a CHANGELOG migration note.

**Alternative considered**: rebuild context views by dual-writing both layouts for a while.
Rejected: doubles apply cost for the very peers this feature is trying to speed up.

## R9 — Defaults to tune during implementation

| setting | start | how it is chosen |
|---|---|---|
| `INDEX_BATCH` | 1,000 events | bench at 250 / 1,000 / 4,000; pick the knee of time vs peak memory |
| `PREFETCH_WINDOW` | 4,096 blocks | bench at 1,024 / 4,096 / 16,384 at 100k; pick lowest peak memory within 10% of best time |

Neither is public API unless measurement shows one size cannot serve both a phone and a desktop.

## R10 — The joining peer's memory peak is in Autobase, not hypergraph (measured during implementation)

**Measured** (T016, `MEMLOG=1` timeline + heap snapshot, 50k files):
- The join runs in two strict phases: the context replays first (~33 s, author's log untouched),
  then the author's log downloads and is indexed. Each update pass does contexts before it has
  seen the log's length, so the two never overlap.
- Memory stays under ~600 MB throughout, except for a spike to ~2 GB RSS / ~760 MB heap at the
  moment context replay *finishes*. `FETCH_ONLY=ctx` reproduces it (2.1 GB); `FETCH_ONLY=log`
  does not.
- Heap snapshot at the spike: ~735,000 `RocksDBGet` objects in flight, with ~1.4 M promises and
  ~690 k generators awaiting them — hundreds of thousands of concurrent storage reads, about three
  per context-view block. The shape matches Hypercore's `copyPrologue` (tree nodes + bitfield
  pages read in parallel), which Autobase calls when it moves a view core
  (`autobase/index.js` `_applyFastForwardMigration` / view migration). Not proven line by line.
- It scales with the size of the view built in one catch-up: ~2 GB at 50k, ~3–3.5 GB at 100k.

**Decision**: document, don't work around. No hypergraph knob changes it (INDEX_BATCH and
PREFETCH_WINDOW sweeps below leave it unchanged), and it disappears by design once members stop
rebuilding the context view themselves (fast-forward, the next spec). Reported upstream with the
other Autobase findings (T048).

**Consequence**: SC-005 (1M entries on a 16 GB machine) is at risk: extrapolating linearly, a
fresh peer joining a 1M-entry context would peak around 30 GB. Measured in T041 rather than
assumed.

**Sweep** (T015, 20k files; time in s, peak RSS in MB):

| setting | write | join | peak RSS writer / joiner |
|---|---|---|---|
| INDEX_BATCH 250 | 16.1 | 26.3 | 398 / 977 |
| INDEX_BATCH 1,000 | 14.0 | 23.1 | 386 / 1,056 |
| INDEX_BATCH 4,000 | 14.2 | 24.3 | 402 / 935 |
| PREFETCH_WINDOW 1,024 | 14.5 | 23.6 | 393 / 978 |
| PREFETCH_WINDOW 16,384 | 13.5 | 24.5 | 383 / 965 |

Flat within noise; defaults stay at 1,000 and 4,096.
