---

description: "Tasks for 002-scale-indexing"
---

# Tasks: Scale Indexing to 1M+ Entries

**Input**: Design documents from `/specs/002-scale-indexing/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/bulk-write.md, quickstart.md

**Tests**: failing-first test before every `src/` behavior change (constitution Principle II).
Encoding (`src/context-base.js` value encoding) and apply changes are in the non-negotiable tier.

**Story map** (spec.md): US1 = fast join (P1) · US2 = bulk writes (P1) · US3 = compact indexes (P2).

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Extend `bench/scale.js` with: `--sizes` flag reporting per-core `length`/`byteLength` and per-index-prefix count/key bytes/value bytes for GraphView and the context view (port `bench/sizes.js` logic from the `perf-experiments` branch); fresh-peer split timings (user-core `get`, index apply, context apply); apply-call count; keep current default (batch path) and `--api` modes (FR-023)
- [X] T002 Record the 2026-10-04 baseline table from spec.md in a new `bench/README.md` with machine description and how to run, so later results have a reference

---

## Phase 2: Foundational

**Purpose**: shared by US1 and US2.

- [X] T003 Write failing test in `test/brittle/core/user-core.js`: concurrent `append()` and `appendBatch()` calls on one UserCore return seqs that match the blocks actually written (no interleaving between reading `length` and appending)
- [X] T004 Add a write lock (promise chain) to `src/user-core.js` covering `append`, `appendBatch`, and a new `withWriteLock(fn)` that runs `fn(length)` under the lock (R6)
- [X] T005 Write failing test in `test/brittle/core/event-encoding.js`: the raw oplog block bytes written by `ContextBase.append(event)` for each event type (relation create/delete, tag add/remove, moderation, message, roles/addWriter) are byte-identical before and after the change below, captured as fixtures from the current code first (FR-021)
- [X] T006 In `src/context-base.js`, give Autobase binary values: `append()` encodes with `encodeEvent`, `#applyView` decodes each `node.value` with `decodeEvent`, every other oplog read decodes too; skip `null`/`undefined`/`decodeError` values without throwing (R3; Principle I)
- [X] T007 Add `ContextBase.appendBatch(events)` in `src/context-base.js`: when `base.writable`, one `base.append(encodedArray)` with no `optimistic` flag; otherwise fall back to the existing single `append()` per event (R3). Test first in `test/brittle/core/contexts.js`: 100 events in one call all apply; the writer's oplog nodes carry one batch (first node `batch === 100`, read through `context.base.local`)

**Checkpoint**: full `npm test` green; no behavior change yet.

---

## Phase 3: User Story 1 — A new member joins a large context quickly (P1)

**Goal**: join ≥ 4× faster, bounded memory, progress visible during a pass, crash-safe.

**Independent test**: `node bench/scale.js 100000`, fresh-peer join ≤ 2.6 min, retained ≤ 100 MB;
plus the tests below.

### Tests (write first, must fail)

- [X] T008 [P] [US1] `test/brittle/core/view.js`: crash safety. Inject a failure after K events through a test-only GraphView option (`opts._afterIndexEvent`), restart, update; the index equals an uninterrupted peer's (every `n:`/`nt:`/`nc:`/`c:` entry present once, edge counts identical) (FR-003, SC-007)
- [X] T009 [P] [US1] `test/brittle/core/view.js`: progress visibility. While one `update()` indexes 5,000 events, a concurrent reader observes a growing, non-zero number of entities before the pass completes (FR-004)
- [X] T010 [P] [US1] `test/brittle/core/view.js` (in-memory replication rather than the DHT-based partial-replication.js, so it is deterministic): a peer that has only part of another user's log (the rest held by no connected peer) completes `update()` without hanging, indexes what it has, and finishes later when the rest arrives (FR-005)
- [X] T011 [P] [US1] `test/brittle/core/contexts.js`: apply flushes its view batch every `INDEX_BATCH` events inside one Autobase batch of 3×`INDEX_BATCH` events, and the resulting index equals the one built from single appends (R2, bounded memory)

### Implementation

- [X] T012 [US1] `src/view.js` `update()`: index each user core through `bee.batch()`, flushing every `INDEX_BATCH` (default 1,000) events and at the end of the core; write `meta:user:<hex>:lastSeq` into the same batch; reads inside apply functions go through the batch (R1)
- [X] T013 [US1] `src/view.js`: sliding-window prefetch, non-awaited `core.download({ start, end })` of `PREFETCH_WINDOW` (default 4,096) blocks ahead of the read position, re-armed at half the window, only for cores not writable locally (R4)
- [X] T014 [US1] `src/context-base.js` `#applyView`: write index entries through `view.batch()`, flushed every `INDEX_BATCH` events and at the end of the apply call; pending-moderation and pending-writer drains keep using the view directly after the flush (R2)
- [X] T015 [US1] Benchmark checkpoint: run `bench/scale.js` at 10k and 100k; tune `INDEX_BATCH` (250 / 1,000 / 4,000) and `PREFETCH_WINDOW` (1,024 / 4,096 / 16,384) per research R9; record in `bench/README.md`
- [X] T016 [US1] Find the joining peer's 3.7 GB peak RSS at 100k (heap snapshot + RSS sampling around prefetch and apply); fix if it is in hypergraph, document if it is in a dependency; target SC-003 and FR-006

**Checkpoint**: SC-001 and SC-003 met or the gap documented with its cause.

---

## Phase 4: User Story 2 — Add thousands of entries in one call (P1)

**Goal**: `graph.batch()` per `contracts/bulk-write.md`.

**Independent test**: import 10,000 files through one batch; reads equal single-item writes; a
second peer replays it in one step per bulk call.

### Tests (write first, must fail)

- [X] T017 [P] [US2] `test/brittle/core/bulk-write.js`: equivalence. The same 50 entities + contents (inline, reference, scoped-encrypted) + relations written via `graph.batch()` and via single methods yield identical `get`, `getContent`, `edges`, `countEdgesIn/Out`, `query()` results (FR-007, FR-010, FR-013)
- [X] T018 [P] [US2] `test/brittle/core/bulk-write.js`: `EntityRef` used as `putContentRef` target and `relate` from/to resolves; `flush()` returns `entities` in `put()` order; `ref.id` throws before flush; a ref from another batch throws (FR-008)
- [X] T019 [P] [US2] `test/brittle/core/bulk-write.js`: one invalid op (malformed reference, unknown entity, missing context, unknown scope) rejects `flush()` and leaves user core and context lengths unchanged (FR-009)
- [X] T020 [P] [US2] `test/brittle/core/bulk-write.js`: a context append failing after the user-core append raises `BulkWriteError` with `written.userCore === true`, `written.contexts` excluding the failed one, and `entities` listing what now exists (FR-012)
- [X] T021 [P] [US2] `test/brittle/core/bulk-write.js`: bulk write works in open and closed context modes with the same permission outcome as single writes (FR-011)
- [X] T022 [P] [US2] `test/brittle/replication/bulk-replay.js`: peer B replays a context written by 3 bulk calls of 1,000 relations; B's index equals A's, and B's apply ran in 3 Autobase batches (US2 #4). Plus: a hostile writer's single 20,000-event batch with interleaved malformed and forged relations applies without crash, rejecting exactly the forged/malformed ones
- [X] T023 [P] [US2] `test/brittle/replication/bulk-replay.js` (in-memory, deterministic; concurrent-writes.js needs the DHT): two writers each flush a bulk batch to the same context concurrently, including one duplicate relation; both peers converge to identical edges and counts (Principle I)

### Implementation

- [X] T024 [US2] Create `src/batch.js`: `Batch` (ops list, `put` → `EntityRef`, `putContent`, `putContentRef` with immediate `formatReference` validation, `relate`), `EntityRef`, `BulkWriteError { written, entities }`
- [X] T025 [US2] `Batch.flush()` in `src/batch.js`: validate all ops (entities exist or are earlier refs; contexts resolvable; scopes known and key held) before any write; then under `UserCore.withWriteLock`, assign ids from `length`, build user-core events (encrypt scoped content exactly as `putContent`), one `appendBatch`; then per context build + sign relations exactly as `relate()`, one `ContextBase.appendBatch`; then one `view.update()`; emit the same `change` events as the single methods, once per item
- [X] T026 [US2] Add `graph.batch()` to `src/hypergraph.js`; factor the event-building/signing of `put`, `putContent`, `relate` into private helpers shared with `src/batch.js` so the two paths cannot drift (FR-010)
- [X] T027 [US2] Switch `bench/scale.js` default write path from raw appends to `graph.batch()`; rerun 100k; check SC-002

**Checkpoint**: US1 + US2 shippable on their own (no format change). Run consumer suites
(T047) here too.

---

## Phase 5: User Story 3 — Indexes take a fraction of today's disk (P2)

**Goal**: layout 2 per `data-model.md`; GraphView rebuilt on upgrade; context views pick a layout
at first write.

**Independent test**: `node bench/scale.js 100000 --sizes`: index bytes ≤ 0.85 KB/entry, disk
≤ 0.47 GB per member; all queries identical across layouts.

### Step A — layout interface, layout 1 only (pure refactor)

- [X] T028 [US3] `npm install index-encoder` (adds to `package.json` dependencies)
- [X] T029 [P] [US3] Write `test/brittle/core/entity-id.js`: round-trip of canonical ids (`<type>/<64 lowercase hex>/<decimal seq, no leading zeros>`) and raw strings (empty-author member), including types containing `/` and `:`, and ids that almost parse (uppercase hex, leading-zero seq, 63-char hex) staying raw; tuple ordering matches today's string ordering except numeric seq ties
- [X] T030 [US3] Create `src/index-layout/entity-id.js` (EntityId ↔ `(typeOrRaw: string, author: buffer, seq: uint)`, data-model "Conventions")
- [X] T031 [US3] Create `src/index-layout/layout-1.js`: today's key templates and JSON values for every index in data-model.md's two tables, behind the interface (`encode*`/`decode*`, range builders, `keyEncoding`/`valueEncoding`) — done for context indexes only (`src/index-layout/context.js` `layout1`); GraphView has no layout 1 path (research "R8 revised")
- [X] T032 [US3] Route all key construction through the layout: `src/view.js` (apply + `getNode`, `getContent`, `getEdges`, `getByTag`, `getByType`, `getByAuthor`, `getIdentity`, progress records), `src/context-base.js` (every `#apply*`, drains, `get`/`createReadStream` callers), `src/hypergraph.js` (`unrelate`, `#countEdges`, moderation query at `m:t:`), `src/query.js` (`nt:`/`nc:` scans), `tools/inspector-server/hgq-v0.js`. No string key template may remain outside `src/index-layout/` — done; the small context records (moderation, pending, messages, `meta:`) stay text by design
- [X] T033 [US3] Full `npm test` green with layout 1 only (proves the refactor changed nothing) — done together with Step B: layout 1 stays exercised by the legacy-context tests; full suite 305/305

### Step B — layout 2

- [X] T034 [P] [US3] Write `test/brittle/core/index-layout.js`: run the query matrix (by id, type, author, tag, edges in/out with and without type, edge counts, content incl. references and encrypted, chronological `query()`, moderation by target/author, pending moderation/writer drains, messages) against a graph built with layout 1 and one built with layout 2 from identical events; results identical (FR-018, SC-006) — done as `test/brittle/core/index-layout.js`: operation-level comparison of both layouts on one bee, plus legacy-vs-new contexts through the graph API
- [X] T035 [P] [US3] Write `test/brittle/core/index-upgrade.js`: (a) a store with an old `graph-view` core opens with `graph-view/2`, rebuilds, all queries match; (b) interrupted rebuild resumes to the same result; (c) the old core is purged only after catch-up; (d) an existing context view without a format record keeps layout 1 and keeps working after more appends; (e) a fresh context view gets layout 2 and its `format` record (FR-019, FR-020, R8) — done as `test/brittle/core/index-upgrade.js`; (b) is the existing interrupted-pass test in `view.js`, (c) revised: the old core is dropped on first open, (d)/(e) in `index-layout.js`
- [X] T036 [P] [US3] Extend `test/brittle/core/content-encryption.js` and `test/brittle/core/view.js`: with layout 2, `getContent` reads the body from the author's log; scoped content decrypts or returns the no-key shape as before; a missing author core or missing block returns `null` without throwing (FR-016, US3 #4) — done in `test/brittle/core/index-upgrade.js` (missing block → null) and the existing view/encryption tests
- [X] T037 [US3] Create `src/index-layout/layout-2.js`: `index-encoder` keys with the one-byte tags and members from data-model.md; values as `compact-encoding` structs exactly as listed ("`{ createdAt, flags(deleted), deletedAt? }`" for node, "∅" for node-by-type/time, incoming edge, tag, moderation by author; "`{ flags(deleted, hasValue), value? (float64) }`" for edge; "`{ createdAt }`" for active edge and tag ref; "`{ count }`" for counters; "`{ action, reason?, author, signature }`" for moderation by target; events via `eventEncoding` for pending entries); derived fields rebuilt on decode per data-model "Derived on read" — done for 0x10–0x16 (`src/index-layout/context.js` `layout2`) and GraphView (`src/index-layout/graph.js`)
- [X] T038 [US3] Create `src/index-layout/index.js`: format record read/write; `layoutForGraphView()` → 2; `layoutForContextView(view)` → 2 if empty or `format = 2`, else 1 (data-model table) — revised: `layoutFor(record)` in `src/index-layout/context.js`, layout from `context/init` (not first apply)
- [X] T039 [US3] `src/view.js` + `src/hypergraph.js`: GraphView opens core `graph-view/2`; rebuild from seq 0 when new; purge the old `graph-view` core only after every followed log has caught up; `getContent` resolves the body through the author's UserCore at the indexed content seq — done; old core dropped by truncate + compact (Hypercore `purge()` is broken)
- [X] T040 [US3] `src/context-base.js`: select the layout at open (`layoutForContextView`), write the `format` record in the first apply of an empty view, and use the selected layout in apply and reads — done; layout from the `context/init` record, `status().layout`
- [X] T041 [US3] Benchmark checkpoint: `bench/scale.js 100000 --sizes`; check SC-004; then `bench/scale.js 1000000` for SC-005; record both in `bench/README.md` — done: 100k index bytes ~0.68 KB/entry, writer disk 0.32 GB (SC-004 met); 1M recorded

**Checkpoint**: all three stories done.

---

## Phase 6: Polish & Cross-Cutting

- [X] T042 [P] Update `docs/storage-model.md` and `docs/contributors/index-structure.md`: layout 2 keys/values, content pointer, per-view layout choice, GraphView rebuild (doc-sync) — done, plus querying.md, contexts-and-roles.md, component-details.md, event-encoding.md, local data distribution.md
- [X] T043 [P] Update `docs/contributors/autobase-integration.md` and `docs/contributors/data-flow.md`: binary Autobase values, batch boundaries set by the writer, batched apply, prefetch window — verified present (written during spec 002 P1 / 003 doc passes)
- [X] T044 [P] Update `docs/contributors/component-details.md` (Autobase config block, UserCore lock, `batch.js`) and `docs/local data distribution.md` (new byte figures) — verified present (written during spec 002 P1 / 003 doc passes)
- [X] T045 [P] Update `README.md` API section with `graph.batch()` and the folder-import example from `contracts/bulk-write.md` — verified present (written during spec 002 P1 / 003 doc passes)
- [X] T046 Add one dated CHANGELOG.md entry linking `specs/002-scale-indexing/`: `graph.batch()`, one-time GraphView rebuild on first open, same-millisecond tie order, new `index-encoder` dependency, context views keep their layout until recreated
- [X] T047 Run `npm test`, then `cd ../HyperBBS && npm test` and `cd ../hyperDNS && npm test` (SC-008) — 305/305 (all five stages), HyperBBS and hyperDNS green (2026-10-05)
- [X] T048 Report both Autobase findings upstream (array `normalize` with custom `valueEncoding`; `optimistic` with arrays yielding `undefined` values) with minimal reproductions from `research.md` R3; draft the issue text for the user to file
- [X] T049 Delete the `perf-experiments` branch and `../hypergraph-perf` worktree once their numbers are recorded in `bench/README.md` — done 2026-10-05 (branch had no unmerged commits, worktree was clean)

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → (US1 ∥ US2) → US3 → Polish.
- US1 and US2 both need T004 (lock) and T006/T007 (binary values, batched append); after
  Phase 2 they touch different code (`view.js`/apply vs `batch.js`/`hypergraph.js`) except
  T014 vs T025 (both in `context-base.js`; do T014 first).
- US3 Step A (T028–T033) must finish green before Step B. US3 is independent of US2's API.
- T047 runs at the US2 checkpoint and again at the end.

## Parallel Opportunities

- T008–T011 (US1 tests) in parallel; T017–T023 (US2 tests) in parallel.
- T029 with T031; T034–T036 in parallel; T042–T045 in parallel.

## Implementation Strategy

**MVP = Phases 1–4** (US1 + US2): no stored-format change, ships the 7.5× / 4.6× gains, and is
safe to merge alone. Then US3 as a second merge once its tests and the 1M run pass.

Totals: 49 tasks — Setup 2, Foundational 5, US1 9, US2 11, US3 14, Polish 8.

## Phase 7: Added during implementation (from measurements)

- [X] T050 [US1] Coalesce edge counters per apply chunk in `src/context-base.js` (`#bumpCount`, written at chunk flush); test first in `test/brittle/core/contexts.js` (300 relations into one folder: 1,501 → 1,202 view blocks; mixed create/delete counts stay exact) — research R11
- [X] T051 [US1] `openUserCore()` starts a following background download of another user's core in `src/hypergraph.js`; test first in `test/brittle/core/view.js` (all blocks and later appends arrive with no `update()`); partial-log test setup reworked to clear blocks instead of relying on a partial download
- [X] T052 `bench/scale.js`: `RSS_LIMIT_MB` guard for the joining peer, `BENCH_DIR` for store location, results saved after every phase, stores kept whenever a phase fails
- [X] T053 First 1M run recorded in `bench/README.md` (writer completes; joiner replays everything, then dies in Autobase's final view commit) — research R11
- [ ] T054 Decide the fast-forward design (indexer topology, acks, trust model with app validation) in its own spec — research R12, R13; blocks SC-005
