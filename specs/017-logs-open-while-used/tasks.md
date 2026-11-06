# Tasks: Logs open only while used

**Input**: [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [quickstart.md](quickstart.md).
Starts from spec 016's "T024 inventory" (45 `log.core` uses in 8 files) and its unbuilt T025-T028.

## Built differently

- **Assumption (a), refined** (R0): closing our session frees the core only once no peer channel wants it
  (hypercore keeps a channel while either side downloads, then 20–40 s, then corestore ~8 s). Right for serving,
  but "open cores" in tests and perf count the directory's own sessions (`testing.openLogs`), not corestore's.
- **Re-asking**: spec 016's `REASK_MS` (no new exchange for the same pair of digests for 60 s) is gone. A peer is
  asked again whenever its summary or ours changed since the last settle (`settledOn`, `settledMine`); once
  settled with an unchanged pair, never. Needed so a member whose own list changed still tells a deaf peer
  (test/next/net/directory.js "summaries settle it" caught it).
- **Readers by activity lists keep their logs open** (R8): no range exchange runs for them, so nothing could
  settle a closed log. They hold only the logs of the periods they read.
- **`logs.held-start` isn't strictly flat**: reopening reads one index row (and its counters) per held log, so
  it grows with the logs by nature; no core is opened per log (`logs.held-open`: 0). Measured before the full run:
  519 ms at 1k logs, ~1.3 s at 10k (×2.5 for ×10 logs), mostly the instance's own start at 1k.
- **Found while building `logs.length-settle-kb`**: a claim of the header block alone (0 → 1, below where
  indexing starts) didn't open the log, so the reader said complete and the summaries never agreed again. Fixed in
  `behind()` (lib/replication.js), regression test in test/next/net/closed-logs.js.
- **Unserved claims**: `testing.idleLogs(hg, ms, { claims })` shortens the 60 s for tests; the warning is
  `UNSERVED_LENGTH` with the peer and log in its message.
- **Helpers' first hand-off after a start**: every held log is opened and handed once per space start (one at a
  time, in the background), since what was handed isn't saved. A follow-up could save `handed` in the counters.
- The test runner (`scripts/test-runner.js --bare`) finds `bare` only in the checkout's own `node_modules`: in a
  worktree, link the main checkout's (`node_modules` junction, gitignored) to run Bare. Not changed here.

## Not built

- Nothing of the spec's requirements. Out of scope as the spec says: smaller indexer rows, cold storage at
  helpers, old and new versions together.
- Bounding opens: a member catching up on thousands of logs at once (claims after a long time offline) opens
  them all at once while downloading, as every log was open before 017. Bounding it (a queue) is a follow-up.

## Phase 1: Setup

- [X] T001 Check assumption (a), closed cores served, in `test/next/unit/closed-serve.js`
- [X] T002 Check assumption (b), hand-off then close with a real blind peer, in `test/next/net/handoff.js`
- [X] T003 Record perf before: `npm run perf` once on the branch base (lands in `perf/history.jsonl`)

## Phase 2: Foundational (blocks every story)

- [X] T004 [P] Test: entries with lengths: equal keys, one longer length is found by the exchange on both sides (the shorter side learns `{ key, length }`, the longer side sends it), a missing key still found, a message's lengths must match its keys, in `test/next/unit/ranges.js`
- [X] T005 `Keys` keeps a length per key, items `hash(key ‖ uint(length))`, `set(key, length)`, total `digest`; keys messages carry `lengths`; `learn` gives `{ key, length }` in `lib/ranges.js`, `lib/encodings.js`
- [X] T006 Protocol `hypergraph/space/3`; `/2` and `/1` told apart (OTHER_VERSION) in `lib/directory.js`, `lib/network.js`, `test/next/net/directory.js`
- [X] T007 Directory entries: `length`, `byteLength` cached; `open(log)` / `release(log)` / `use(log, fn)` / `get(log, seq, opts)` / `has(log, ...)`; idle close after `IDLE_MS` (30 s; tests: `testing.idleLogs(hg, ms)`); lengths and sizes saved in the log's counters on close; close every open or opening log on space close (FR-009) in `lib/directory.js`, `lib/space.js`, `lib/testing.js`
- [X] T008 Move every `log.core` use to cached lengths or `directory.get/has/use` in `lib/space.js`, `lib/index/indexer.js`, `lib/activity.js`, `lib/replication.js`, `lib/testing.js`; summary digest from `sorted`, with lengths

**Checkpoint**: `node scripts/test-runner.js next` green with logs still kept open (no idle close yet).

## Phase 3: User Story 1 - A big space keeps few logs open (P1) MVP

- [X] T009 [US1] Test: 2,000 logs (scripted, both members hold them), after the idle delay ≤ ~20 open; reopening the space opens none of them; a read of a closed log's record returns it, in `test/next/net/closed-logs.js`
- [X] T010 [US1] Replicator holds a use only while a log is behind (missing > 0) or indexing; listeners and range attach on open, go on close, in `lib/replication.js`
- [X] T011 [US1] `_open` from rows only (FR-002): cached `len`/`bytes`/`admitted` from the counters; old rows open their core once in `lib/space.js`
- [X] T012 [US1] Readers by activity lists (big-space newcomers) keep logs open (research R8) in `lib/directory.js`

## Phase 4: User Story 2 - "Complete" stays honest for closed logs (P1)

- [X] T013 [US2] Test: all logs closed at the reader; the author writes while connected: `isComplete()` false until the record arrived, true after, log closed again; the same written while the reader was offline, met later, in `test/next/net/closed-logs.js`
- [X] T014 [US2] Per channel `theirs`/`settledOn`; `directory.settled()`; claims from settled exchanges open the log and download in `lib/directory.js`
- [X] T015 [US2] `unheard(log)`: closed logs heard only when settled; claims count for open and closed logs; claim not met in `CLAIM_MS` dropped, status `UNSERVED_LENGTH` in `lib/replication.js`, `lib/space.js`
- [X] T016 [US2] The summary is sent again soon after a log's length changes in `lib/directory.js`

## Phase 5: User Story 3 - Closed logs are still served and helped (P1)

- [X] T017 [US3] Test: a newcomer gets a closed log's blocks from this member alone; a helper mirrors 100 logs closed here, and one that grows, in `test/next/net/closed-logs.js`
- [X] T018 [US3] `Helpers.hold(log)`: open, `addCore` bounded (`HAND_MS`), `sent()` check, release; unsent retried; handed again when grown in `lib/helpers.js`, `lib/replication.js`

## Phase 6: Polish

- [X] T019 [P] Perf: `logs.held-start` (open a space holding N logs, 1k and 10k, flat) and `logs.length-settle-kb` (SC-004) in `perf/scenarios/members.mjs`
- [X] T020 [P] Docs: `docs/next/concepts.md` (channel /3, lengths in summaries, logs closed when unused), contributors docs for touched modules
- [X] T021 CHANGELOG entry (wire change /2 → /3), ROADMAP Decisions line
- [X] T022 `node scripts/test-runner.js next`, `--bare next`, `npm test`, SwarmFS `npm test` and `npm run test:bare`; `npm run perf`, `npm run perf:compare`
- [X] T023 Fill "Built differently" and "Not built"

## Dependencies

Phase 2 before all stories. US1 before US2 (claims need closed logs), US3 after T007. T019-T023 last.

## Implementation strategy

MVP = Phase 2 + US1, but US1 alone would make "complete" lie for closed logs: US2 lands in the same change.
