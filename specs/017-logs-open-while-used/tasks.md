# Tasks: Logs open only while used

**Input**: [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [quickstart.md](quickstart.md).
Starts from spec 016's "T024 inventory" (45 `log.core` uses in 8 files) and its unbuilt T025-T028.

## Built differently

(filled while building)

## Phase 1: Setup

- [X] T001 Check assumption (a), closed cores served, in `test/next/unit/closed-serve.js`
- [X] T002 Check assumption (b), hand-off then close with a real blind peer, in `test/next/net/handoff.js`
- [ ] T003 Record perf before: `npm run perf` once on the branch base (lands in `perf/history.jsonl`)

## Phase 2: Foundational (blocks every story)

- [ ] T004 [P] Test: entries with lengths: equal keys, one longer length is found by the exchange on both sides (the shorter side learns `{ key, length }`, the longer side sends it), a missing key still found, a message's lengths must match its keys, in `test/next/unit/ranges.js`
- [ ] T005 `Keys` keeps a length per key, items `hash(key ‖ uint(length))`, `set(key, length)`, total `digest`; keys messages carry `lengths`; `learn` gives `{ key, length }` in `lib/ranges.js`, `lib/encodings.js`
- [ ] T006 Protocol `hypergraph/space/3`; `/2` and `/1` told apart (OTHER_VERSION) in `lib/directory.js`, `lib/network.js`, `test/next/net/directory.js`
- [ ] T007 Directory entries: `length`, `byteLength` cached; `open(log)` / `release(log)` / `use(log, fn)` / `get(log, seq, opts)` / `has(log, ...)`; idle close after `IDLE_MS` (30 s; tests: `testing.idleLogs(hg, ms)`); lengths and sizes saved in the log's counters on close; close every open or opening log on space close (FR-009) in `lib/directory.js`, `lib/space.js`, `lib/testing.js`
- [ ] T008 Move every `log.core` use to cached lengths or `directory.get/has/use` in `lib/space.js`, `lib/index/indexer.js`, `lib/activity.js`, `lib/replication.js`, `lib/testing.js`; summary digest from `sorted`, with lengths

**Checkpoint**: `node scripts/test-runner.js next` green with logs still kept open (no idle close yet).

## Phase 3: User Story 1 - A big space keeps few logs open (P1) MVP

- [ ] T009 [US1] Test: 2,000 logs (scripted, both members hold them), after the idle delay ≤ ~20 open; reopening the space opens none of them; a read of a closed log's record returns it, in `test/next/net/closed-logs.js`
- [ ] T010 [US1] Replicator holds a use only while a log is behind (missing > 0) or indexing; listeners and range attach on open, go on close, in `lib/replication.js`
- [ ] T011 [US1] `_open` from rows only (FR-002): cached `len`/`bytes`/`admitted` from the counters; old rows open their core once in `lib/space.js`
- [ ] T012 [US1] Readers by activity lists (big-space newcomers) keep logs open (research R8) in `lib/directory.js`

## Phase 4: User Story 2 - "Complete" stays honest for closed logs (P1)

- [ ] T013 [US2] Test: all logs closed at the reader; the author writes while connected: `isComplete()` false until the record arrived, true after, log closed again; the same written while the reader was offline, met later, in `test/next/net/closed-logs.js`
- [ ] T014 [US2] Per channel `theirs`/`settledOn`; `directory.settled()`; claims from settled exchanges open the log and download in `lib/directory.js`
- [ ] T015 [US2] `unheard(log)`: closed logs heard only when settled; claims count for open and closed logs; claim not met in `CLAIM_MS` dropped, status `UNSERVED_LENGTH` in `lib/replication.js`, `lib/space.js`
- [ ] T016 [US2] The summary is sent again soon after a log's length changes in `lib/directory.js`

## Phase 5: User Story 3 - Closed logs are still served and helped (P1)

- [ ] T017 [US3] Test: a newcomer gets a closed log's blocks from this member alone; a helper mirrors 100 logs closed here, and one that grows, in `test/next/net/closed-logs.js`
- [ ] T018 [US3] `Helpers.hold(log)`: open, `addCore` bounded (`HAND_MS`), `sent()` check, release; unsent retried; handed again when grown in `lib/helpers.js`, `lib/replication.js`

## Phase 6: Polish

- [ ] T019 [P] Perf: `logs.held-start` (open a space holding N logs, 1k and 10k, flat) and `logs.length-settle-kb` (SC-004) in `perf/scenarios/members.mjs`
- [ ] T020 [P] Docs: `docs/next/concepts.md` (channel /3, lengths in summaries, logs closed when unused), contributors docs for touched modules
- [ ] T021 CHANGELOG entry (wire change /2 → /3), ROADMAP Decisions line
- [ ] T022 `node scripts/test-runner.js next`, `--bare next`, `npm test`, SwarmFS `npm test` and `npm run test:bare`; `npm run perf`, `npm run perf:compare`
- [ ] T023 Fill "Built differently" and "Not built"

## Dependencies

Phase 2 before all stories. US1 before US2 (claims need closed logs), US3 after T007. T019-T023 last.

## Implementation strategy

MVP = Phase 2 + US1, but US1 alone would make "complete" lie for closed logs: US2 lands in the same change.
