# Implementation Plan: Scale Indexing to 1M+ Entries

**Branch**: `002-scale-indexing` | **Date**: 2026-10-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-scale-indexing/spec.md`

## Summary

Two independent halves, shipped in order.

**P1, no format change**: stop paying one signed, flushed disk write per index entry, and stop
making every peer replay a bulk import one event at a time. GraphView and context apply write
indexes in batches; context events from one bulk call are appended as one Autobase batch; a
joining peer prefetches the author's log in a sliding window; and a public `graph.batch()`
builder lets an app write thousands of entities, contents and relations in two log appends. An
experiment measured 7.5× faster writes and 4.6× faster joins at 100k entries.

**P2, local index format change**: indexes are two thirds of stored bytes, and mostly
redundancy. A versioned *index layout* replaces text keys and JSON values with order-preserving
binary keys (`index-encoder`) and compact values holding only what can't be derived, and the
content index points at the author's log instead of copying the body. Estimated index bytes per
entry: ~2.5 KB → ~0.45 KB. GraphView is rebuilt automatically on upgrade; context views keep
their layout for life, because Autobase has no supported way to rebuild a view in place
(research R8, tested).

## Technical Context

**Language/Version**: Node.js (26.x tested), CommonJS, matching `src/`.

**Primary Dependencies**: autobase 7.28, corestore 7, hypercore 11, hyperbee 2.27,
compact-encoding 3 (already direct). **New**: `index-encoder` (Holepunch, order-preserving tuple
keys; only dependency `b4a`) — P2 only.

**Storage**: GraphView Hyperbee (local core, now `graph-view/2`); context views (Autobase-owned
Hyperbee); user cores and context oplogs unchanged.

**Testing**: brittle under `test/brittle/{core,networking,replication}`; `bench/scale.js` for
measurements.

**Target Platform**: Node.js; Bare/mobile is a downstream goal (swarmwire runs there), so no
native additions.

**Project Type**: Library.

**Performance Goals**: SC-001 – SC-005 in spec (100k: join ≤ 2.6 min, bulk write ≤ 1.5 min,
retained ≤ 100 MB, index ≤ 0.85 KB/entry; 1M completes on 16 GB).

**Constraints**:
- No event wire-format change (FR-021): peers on this and the previous version still replicate.
- Consumers symlinked to this tree: HyperBBS and hyperDNS suites must pass unchanged.
- Never crash in apply on any node (Principle I), including batches from a hostile writer.

**Scale/Scope**: touches `src/view.js`, `src/context-base.js`, `src/user-core.js`,
`src/hypergraph.js`, `src/query.js`, `tools/inspector-server/`; adds `src/index-layout/`
(layout 1, layout 2, shared EntityId codec) and `src/batch.js`; ~8 new/extended test files;
benchmark extension.

## Constitution Check

*Gate before Phase 0; re-checked after Phase 1 (below).*

### I. Correctness Under Concurrency & Partition — PASS, with obligations

- No change to which events are accepted, how they are verified, or the order Autobase
  linearizes them. Bulk writes produce the same events, grouped.
- New risks and their answers:
  - *Atomicity of index vs progress*: committed in one Hyperbee batch (R1). Test: kill mid-pass,
    restart, compare to an uninterrupted peer (SC-007).
  - *Hostile giant batch*: apply flushes its view batch every `INDEX_BATCH` events, so memory is
    bounded; `null`/`undefined` node values skipped (R2, R3).
  - *Concurrent bulk writers*: Autobase reorders batches as it does single events; the
    duplicate-relation rule (`er` lookup) runs inside apply as today. Extend
    `replication/concurrent-writes.js` with two bulk writers.
  - *Partial replication*: prefetch is never awaited; existing `get` timeout path unchanged (R4).
  - *Layout mismatch between peers*: impossible to observe; layouts are local (R8).

### II. Test-First for Replication & CRDT Behavior — PASS

Encoding (`context-base` valueEncoding change), apply and view changes are in the
non-negotiable tier. Each gets a failing-first test (quickstart §2), including the oplog
byte-equality test that guards FR-021, and every existing context-view test runs against both
layouts.

### III. Thin Composition Over Holepunch Primitives — PASS, one justified divergence

Uses Hyperbee batches, Autobase batches, hypercore `download`, `index-encoder`,
`compact-encoding` — all Holepunch primitives. hyperdb was considered and deferred (R7). The
divergence: hypergraph keeps two context-view layouts instead of rebuilding Autobase views,
because the only rebuild route edits Autobase private state (see Complexity Tracking).

### IV. One Coherent API Surface — PASS

`graph.batch()` reuses the single-item verbs and their validation exactly, and follows
Hyperbee's own `batch()` → `flush()` idiom (R5, contract). Single-item methods unchanged.

### V. Alpha Versioning & Explicit Breaking Changes — PASS

No wire break. Visible changes, each a CHANGELOG line: GraphView rebuild on first open (one-time
cost), tie order at the same millisecond (R7), new `graph.batch()`, new dependency.

### Doc-sync-on-change — obligations

Same change must update: `docs/storage-model.md`, `docs/contributors/index-structure.md`,
`docs/contributors/autobase-integration.md`, `docs/contributors/data-flow.md`,
`docs/contributors/component-details.md`, `docs/local data distribution.md`, `README.md`
(API section for `batch()`), `bench/README.md` (new). Checked in tasks, not deferred.

## Project Structure

### Documentation (this feature)

```text
specs/002-scale-indexing/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/bulk-write.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code

```text
src/
├── batch.js                 # NEW  graph.batch() builder, EntityRef, BulkWriteError
├── index-layout/            # NEW  (P2)
│   ├── entity-id.js         #      EntityId <-> tuple members
│   ├── layout-1.js          #      today's text keys, moved behind the interface
│   ├── layout-2.js          #      index-encoder keys, compact values
│   └── index.js             #      pick layout for a view; format record
├── view.js                  # batched indexing, prefetch window, layout-driven keys, rebuild
├── context-base.js          # binary Autobase values, bulk append, batched apply, layout-driven keys
├── user-core.js             # write lock
├── hypergraph.js            # batch(), getContent via log pointer, unrelate/countEdges via layout
└── query.js                 # range queries via layout
tools/inspector-server/      # decode via layout instead of string keys
bench/scale.js, bench/README.md
test/brittle/core/{bulk-write,index-layout,index-upgrade}.js           # NEW
test/brittle/replication/bulk-replay.js                                # NEW
test/brittle/core/{view,event-encoding,content-encryption}.js,
test/brittle/replication/concurrent-writes.js                          # extended
```

**Structure Decision**: single library project; new code lives next to the modules it serves.

## Delivery order

1. **P1a** batched GraphView indexing + atomic progress + prefetch window (no API change).
2. **P1b** binary Autobase values + batched apply + `graph.batch()`.
3. Benchmark checkpoint: SC-001 – SC-003; tune `INDEX_BATCH` / `PREFETCH_WINDOW`; find the 3.7 GB
   joining-peer peak.
4. **P2a** layout interface with layout 1 only; all tests green (pure refactor).
5. **P2b** layout 2 + GraphView rebuild + per-view context layout choice.
6. Benchmark checkpoint: SC-004, SC-005 (1M); docs; CHANGELOG; consumer suites.

Each step leaves the tree green, so the branch can stop after P1 and still ship.

## Post-design Constitution re-check

Re-checked after writing `data-model.md` and `contracts/bulk-write.md`: no new violation.
`data-model.md` stores no value that apply could compute differently on two peers (every derived
field comes from the key or the signed event), and the bulk contract adds no rule that differs
from the single-item path.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Two context-view index layouts coexist | Existing local context views can't be rebuilt: Autobase 7 replays nothing into a renamed view (and crashes), and a fresh namespace resumes the old state from the boot record in the writer core (R8, both tested) | Resetting Autobase's boot record edits private internals and would break silently on upgrade; dual-writing both layouts doubles apply cost for the peers this feature speeds up; leaving context views uncompacted forgoes half the saving. Layout 1 is removed when fast-forward fixes a format per context. |
| Batched append bypasses Autobase's `valueEncoding` (binary values, hypergraph encodes) | Autobase `normalize()` encodes an array as one value, breaking batched appends with any custom encoding (R3) | An array-aware codec relies on `normalize` round-tripping through our decoder, i.e. on an Autobase internal |
