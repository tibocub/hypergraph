---

description: "Task list for the scaling v2 prototype"
---

# Tasks: Scaling v2 Prototype

**Input**: Design documents from `specs/007-scaling-v2-prototype/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: test-first throughout (Constitution II): every implementation task follows a failing
test task for the same behavior.

**Machine load**: benchmark tasks keep to the limits in CLAUDE.md (small sizes while iterating;
big sizes with few processes, one at a time).

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Add `"exports": { ".": "./index.js", "./v2": "./src/v2/index.js" }` and `rocksdb-native` (the version Corestore already installs) as a direct dependency in `package.json`; add the `v2` group (`test/brittle/v2`) to `scripts/test-runner.js`
- [X] T002 Create `src/v2/` and `test/brittle/v2/` with a placeholder test that loads `require('../../../src/v2')`, so the group runs

## Phase 2: Foundational (blocks every story)

- [X] T003 [P] Test `test/brittle/v2/encodings.js`: message block `{ t, text, reply? }`, roster value `{ log, start, sig }`, announcement round-trip; text over 4 KB rejected
- [X] T004 [P] Test `test/brittle/v2/segments.js`: `segment(t, segmentMs)` boundaries (a time exactly on a boundary belongs to the later segment), future bound (`t > now + 5 min` not shown)
- [X] T005 [P] Implement `src/v2/encodings.js` and `src/v2/segments.js`
- [X] T006 Test `test/brittle/v2/control.js`: create a community (owner), set roles (owner → admin/mod/keeper; admin → mod/keeper; a mod can't appoint), create a channel, ban/unban, hide, keeper registration; two peers converge to the same state; an event signed by someone without the role is ignored on every peer; a forged signature is ignored
- [X] T007 Implement `src/v2/control.js` (Autobase apply, records per data-model, signature + role checks) and the control part of `src/v2/index.js` (`Community` constructor, `ready`, `replicate`, `setRole`, `createChannel`, `ban`, `unban`, `hide`, `channels`, `role`, `close`)
- [X] T008 Test `test/brittle/v2/author-log.js`: the log key is the same from the same identity seed on another store; `post()` appends `{ t, text }`; non-decreasing time enforced on read; a block from another key pair is rejected
- [X] T009 Implement `src/v2/author-log.js` (key derivation per R5, append, read range, tail)

## Phase 3: User Stories 1 + 2 — a huge channel opens like a small one; many writers, no bottleneck (P1) 🎯 MVP

**Goal**: post, roster, latest page, scrollback, live follow; measured at 10k → 10M.

**Independent test**: `bench/v2-chat.js` at 10k / 1M / 10M: latest page time, memory and bytes within budget at every size; arrival and throughput with ~100 writers.

- [X] T010 [US1] Test `test/brittle/v2/roster.js`: a keeper lists an author after its first post in a segment (announcement over the roster core's extension); a second post in the same segment adds nothing; an announcement with a bad signature, for a banned author, or for a segment older than the previous one is refused; a reader merges two keepers' rosters (union, lowest start); a keeper cannot forge an entry for another author (reader rejects it)
- [X] T011 [US1] Implement `src/v2/roster.js` (keeper: roster bee per channel, announcement handling; author: announce on first post per segment to every known keeper; reader: union of rosters, signature and ban checks) and `community.keep()`
- [X] T012 [US1] Test `test/brittle/v2/reader.js`: `latest()` returns the newest 50 across authors in (t, author, seq) order, identical on two readers; spans into the previous segment when the current one has fewer than 50; `before({ t })` returns the 50 before; a future-dated message is held back; an author whose log is unreachable doesn't block the page (others show, `stats()` reports the gap)
- [X] T013 [US1] Implement `src/v2/reader.js` (open only the logs listed for the segments read, read tails/ranges, merge) and `post`, `latest`, `before` in `src/v2/index.js`
- [X] T014 [US2] Test (extend `test/brittle/v2/reader.js`): `follow()` delivers a new post from another member within 1 s, newest only, no duplicates; following resumes after a reconnect
- [X] T015 [US2] Implement `follow()` (live download of the current segment's listed logs; new authors picked up as the roster grows)
- [X] T016 [US1] Create `bench/v2-chat.js`: history generated in bulk per R9 (authors' logs appended in large batches across segments, roster entries in bulk), a seed process, a newcomer process measuring `latest` (time, bytes, memory), `before` one segment back, reopen offline/online; live phase with up to ~100 writers in a few processes measuring throughput and arrival. Same JSON shape as `bench/chat.js` where it applies
- [X] T017 [US1] Measure at 10k, 1M, 10M (one run at a time, few processes) and v1 `bench/chat.js` at 10k for comparison; record in `specs/research/scaling-v2.md` and `bench/README.md`; check SC-001..SC-004 and write down any miss with its cause

**Checkpoint**: P1 shape validated or invalidated by numbers.

## Phase 4: User Story 3 — moderation on partial data (P1)

**Independent test**: hides and bans applied by a peer holding only the latest segment and by a late joiner.

- [X] T018 [US3] Test `test/brittle/v2/moderation.js`: a hidden message comes back `hidden: true` without text for (a) a peer holding everything, (b) a peer holding only the latest segment, (c) a newcomer who joined after the hide; a banned author's posts after the ban are left out everywhere, earlier ones stay; keepers refuse the banned author's new segments; unban restores
- [X] T019 [US3] Implement the moderation filter in `src/v2/reader.js` and ban checks in `src/v2/roster.js`; measure SC-006 (100% of members apply)

## Phase 5: User Story 5 — the rest of the community stays out of the way (P2)

- [X] T020 [US5] Extend `bench/v2-chat.js` (or `bench/v2-community.js`): communities of 1,000 and 50,000 members (roles/keepers in the control log, members only in rosters) and 10 vs 500 channels; a member with 5 channels open: memory, idle cost, startup
- [X] T021 [US5] Test `test/brittle/v2/idle.js`: with 50 channels, only the open channels' logs are open (`stats().openLogs`); closing a channel's reader releases its logs
- [X] T022 [US5] Implement whatever T020/T021 show is needed (lazy open/close of channel readers); measure SC-005

## Phase 6: User Story 4 — replication all | sparse | auto (P2)

- [X] T023 [US4] Test `test/brittle/v2/replication.js`: `all` downloads every listed log fully; `sparse` only what was read plus the current segment; `auto` holds everything under budget, switches to recent segments when over, never exceeds the budget (control log aside); a helper with `all` serves old segments to a sparse member
- [X] T024 [US4] Implement `src/v2/replication.js` (size estimate from roster + log metadata, download ranges, re-evaluation as rosters grow, dropping old segments with `core.clear`); measure SC-008

## Phase 7: Offline and polish

- [X] T025 Test `test/brittle/v2/offline.js`: a page shown, then a restart with no peer: `latest()` shows it again in under 1 s; scrollback to a segment never fetched reports it unavailable without waiting forever
- [X] T026 ~~Implement `src/v2/local.js` (RocksDB: shown pages per segment, budget decisions) and use it in the reader when peers are unreachable~~ not needed: T025 passed without it (research R6, revised); SC-007 measured: 3 ms in the test, 0.2–0.7 s in `bench/v2-chat.js`
- [X] T027 [P] Write `docs/v2-prototype.md` (what it is, how it differs from v1, how to run it, measured numbers, open questions incl. compaction FR-010); link it from `README.md` and `docs/` index
- [X] T028 [P] Update `specs/research/scaling-v2.md` with the v1 vs v2 comparison table; `bench/README.md` with v2 results; one dated `CHANGELOG.md` entry ("prototype, unstable")
- [X] T029 Run `npm test`, HyperBBS and hyperDNS suites (SC-009)
- [X] T030 Decide, from the numbers: compaction by archivers (FR-010) now, later, or not needed; record the decision in research.md

## Phase 8: Follow-ups from the measurements (2026-10-07)

The gaps `docs/v2-prototype.md` lists, each measured first, then fixed or explained.

- [X] T031 SC-001: find where the newcomer's latest-page download grows (412 KB at 10k → 490 KB at 10M): split the bytes by roster, author logs and control log at 10k and 1M; fix if it isn't inherent
- [ ] T032 SC-004: 100 authors posting for the first time in the same second, p95 arrival 1.4 s: measure where the time goes (announcement → keeper → roster replication → reader scan); fix what dominates
- [ ] T033 SC-005: memory with 5 channels open is ~10–35% higher at 500 channels than at 10: measure the control log's share (two events per channel) and try one keeper event for many channels
- [ ] T034 SC-008: `auto` doesn't count what is read beyond its window: test that scrollback beyond the window doesn't push holdings over the budget for long; implement
- [ ] T035 FR-017: a ban can't cut a log last listed in an older segment: test a banned author backdating into their last listed segment; close it
- [ ] T036 The `v2/reader.js` failure seen once under parallel load (30.8 s, no output): reproduce under load with the full log kept; fix or record

## Dependencies & Execution Order

- Phase 1 → Phase 2 → Phase 3 (MVP) → Phase 4 → Phases 5 and 6 (independent of each other) → Phase 7.
- Within a phase: each test task before its implementation task; [P] tasks touch different files.
- T017's measurements gate the rest: if SC-001..SC-004 miss badly, revisit research.md before Phase 4.

## Implementation Strategy

MVP = Phases 1–3: a community, posting, rosters, reading and following, and the 10k → 10M numbers.
Everything after builds on that only if the numbers hold.
