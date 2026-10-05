---

description: "Tasks for 003-fast-forward-contexts (phase 1)"
---

# Tasks: Fast-Forward Joins, Indexer Topology and App Validation Rules — Phase 1

**Input**: spec.md, plan.md, research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: failing test before every `src/` change (constitution Principle II); encodings and apply
are in the non-negotiable tier.

Story map: US1 = agreed state (single indexer), US2 = fast-forward joins, US3 = app rules.
Phase 2 (not in this file): appointing more indexers (FR-003/006), converting version 1
contexts (US4 #2) — blocked on deterministic permission checks (research R4).

## Phase 1: Setup

- [ ] T001 Add `ACK_INTERVAL: 1000` to `src/tuning.js` with a comment pointing at research R1
- [ ] T002 `bench/scale.js` fetch-child: report whether the context fast-forwarded (`'fast-forward'` event, attached before `ready`) alongside `applyCalls`

## Phase 2: Foundational — the context record

- [ ] T003 Test first in `test/brittle/core/event-encoding.js`: `context/init` `{ version, rules }` round-trips; an unknown future type code still decodes to `{ type: undefined }` without throwing
- [ ] T004 Add `context/init` (type code 14: `version` uint, `rules` string) to `src/encodings/event.js`
- [ ] T005 Test first in `test/brittle/core/contexts.js`: `createContext()` → `context.status()` reports `{ version: 2, rules: '' }`; a `context/init` appended by a non-bootstrap writer, or a second one, is ignored
- [ ] T006 `src/hypergraph.js` `createContext({ rules })` appends `context/init` first; `src/context-base.js` applies it (bootstrap writer only, once) into `meta:context`, and adds `status()`

## Phase 3: US1 — agreed state with a single indexer

- [ ] T007 [US1] Test first in `test/brittle/core/contexts.js`: in a version 2 context the creator `isIndexer`, a writer added via `addWriter` (open) and via signed `roles/addWriter` (closed) is writable but not an indexer; in a version 1 context (built without `context/init`) an added writer is an indexer as before
- [ ] T008 [US1] Test first in `test/brittle/replication/indexers.js`: 3 writers each flush 1,000 relations concurrently; within 10 s of stopping every peer's `status().confirmedLength === status().length` and indexes are identical (SC-003)
- [ ] T009 [US1] Test first in `test/brittle/replication/indexers.js`: with the creator's device disconnected, two writers' events still apply on both; confirmed once the creator reconnects
- [ ] T010 [US1] `src/context-base.js`: indexer flag for added writers from the context record (v1: indexer, v2: non-indexer, unknown: `host.interrupt`); Autobase `ackInterval: tuning.ACK_INTERVAL`

## Phase 4: US2 — fast-forward joins

- [ ] T011 [US2] Test first in `test/brittle/replication/fast-forward.js`: a writer makes 40 bulk calls of 500 relations; a fresh peer opening the context fast-forwards (event fired, ≤ 2 apply calls), lists folders identical to the writer's, holds less than half the context view's blocks after reading one folder, and applies a relation written after it joined
- [ ] T012 [US2] Test first in the same file: `openContext(key, { fastForward: false })` replays (no fast-forward event, every batch applied) and ends with the same index
- [ ] T013 [US2] `src/context-base.js` + `src/hypergraph.js`: `fastForward` on by default, `fastForward: false` option on create/open
- [ ] T014 [US2] Benchmark: `bench/scale.js` at 100k and 1M (`BENCH_DIR`, `RSS_LIMIT_MB`); record SC-001/SC-002 in `bench/README.md`

## Phase 5: US3 — app rules

- [ ] T015 [P] [US3] Test first in `test/brittle/core/context-rules.js`: a rule rejecting relations to a "locked" folder — rejected through `relate()`, through `graph.batch()`, and through a raw `context.appendBatch()`; accepted ones indexed; counts unaffected by rejected ones
- [ ] T016 [P] [US3] Test first in `test/brittle/core/context-rules.js`: a "name unique in folder" rule using `reader.edges()` sees the index as before the event (second duplicate in the same batch rejected); a throwing rule and a rule returning a non-`true` value reject without crashing apply
- [ ] T017 [P] [US3] Test first in `test/brittle/core/context-rules.js`: opening with a different `rules.id` (or none, against a context that has one) rejects `openContext()` with "Context rules mismatch"; a context recorded with version 99 interrupts with "unsupported context version"
- [ ] T018 [US3] Test first in `test/brittle/replication/fast-forward.js`: a writer's raw rule-breaking events are absent on a replaying peer and on a fast-forwarding peer (SC-004)
- [ ] T019 [US3] `src/context-base.js`: rules option, read-only `reader` over the apply batch (`hasEdge`, `edges`, `countIn`, `countOut`, `hasTag`), validation for app data events after built-in checks, mismatch → `host.interrupt` + `'error'`; `src/hypergraph.js`: pass rules through, reject `openContext()` on mismatch

## Phase 6: Polish

- [ ] T020 [P] `docs/contexts-and-roles.md`: topology, trust model, app rules
- [ ] T021 [P] `docs/contributors/autobase-integration.md`, `docs/contributors/event-encoding.md`, `docs/storage-model.md`, `docs/networking.md`, `docs/contributors/index-structure.md` (`meta:context`), README (rules example)
- [ ] T022 CHANGELOG entry (breaking: added writers are non-indexers in new contexts; acks + fast-forward on; mixed versions unsupported; new event type)
- [ ] T023 `npm test`, HyperBBS, hyperDNS

## Dependencies

Setup → Foundational → US1 → US2 → US3 → Polish. US3's replication test (T018) needs US2.
