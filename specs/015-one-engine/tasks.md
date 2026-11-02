# Tasks: One engine for many sites

**Input**: `specs/015-one-engine/` — [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/api.md](contracts/api.md), [quickstart.md](quickstart.md)

**Started 2026-11-02** on `015-one-engine` after merging master (21dd6bd, decisions-in-place and the perf
habit in); Tibo said go without waiting for the forum trial (pinned to afae42b). T028 builds on
decisions-in-place's apply path as planned: no task assumed the old decisions code.

## Built differently (2026-11-02)

- T002, T034: no committed fixture. Corestore refuses a copied folder (its device file: "moved
  unsafely"), so a checkout can't open one. `test/next/unit/migration.js` makes the old layout with
  today's code (`testing.recordNoTypes`, `testing.oldLayout`: no `types/set`, the folder-wide `types`).
- T006: the `@hg/spaces` row can't grow (Hyperschema refuses to expand a compact struct). What the engine
  keeps per space (`used`, `own`, `parent`) is in `@hg/meta space:<hex>`; pins in the setting
  `hg/pinned` (not `pinned`: an app's setting could be called that), mirrored on each Space.
- T009/T018: seeding order is pinned, own, recent (the plan said own first): a pin is the person's
  choice. The seeded set is `maxAnnounced` top spaces (with their sub-spaces), so "behaves as today"
  holds for fewer than 32 spaces, not 64.
- T010: re-looks start for a space joined in use or announced, and again when a space is used and has
  no peers (`network.used`).
- T030: no `TypeError` "a space needs types": a space with none still holds relations, tags and
  hypergraph's own records; nothing is recorded then.
- T032: a types change while a space is in use (live view, listener) re-indexes it once its use ends,
  or at its next opening; records indexed meanwhile use the new types.
- T042: no `as` field yet: every held space is the main identity's until per-site keys exist.
- Closed spaces: `peers()` and `memberConnections()` return `[]` (honest, and the forum app's
  `online()` works); `state`, `subspaces()`, `status()`, `types()` throw "await space.ready()".
- `hg.settings()` leaves out hypergraph's own settings (`hg/...`).

## Not built (2026-11-02)

- T008: the topic-queue network test; `perf/scenarios/topics.mjs` measures the same on a 20-node DHT.
- T033: one personal-space type namespace across apps: there is no way to attach a second app's types
  to an engine yet (HyperBrowser milestone 2); one app per engine today.
- US4 (T037–T040): logs open only while used. ~45 places in replication, the indexer and Space assume
  every accepted log's core is open; left for its own change (see the lead's decision).
- T046: Bare perf numbers.

**Tests**: required by default (constitution Principle II; `types/set` is apply-time, so its tests are
non-negotiable). Each test task comes first and must fail before its implementation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1–US7 from spec.md
- Paths: `lib/` (hypergraph/next), `test/next/unit/`, `test/next/forum/` (scenario tests, CLAUDE.md
  rule 3), `perf/scenarios/` (after perf-habit merges), `docs/next/`

**Phase order** follows plan.md "Phases", not story priority: US3 and US2 are local and unblock nothing
else; US1 (apply-time) goes after them so the risky change lands on a lazy engine already tested.

---

## Phase 1: Setup

- [x] T001 Check both blockers are cleared (decisions-in-place merged, forum trial over); branch `015-one-engine-impl` from master; run `npm test` once and note the baseline counts in the PR description
- [x] T002 [P] Make a migration fixture: a folder written by master's `Hypergraph.open` (forum types, 3 spaces, one sub-space, 20 posts) saved under `test/next/fixtures/master-folder/` with the script that made it, `test/next/fixtures/make-master-folder.js`
- [x] T003 [P] Create the `perf/scenarios/topics.mjs` skeleton from `bench/one-engine/topics.mjs` (20-node local DHT, one size; metrics filled in T012)

---

## Phase 2: Foundational (blocks every story)

- [x] T004 Add error codes `SUSPENDED` and `NOT_SUPPORTED` with a failing test first in `test/next/unit/errors.js`, then `lib/errors.js`
- [x] T005 Add engine options `maxOpen` (default 64), `maxAnnounced` (default 32), `memory` (default none), `idleMs` (default 120000) to `Hypergraph.open` with validation (`TypeError` for non-positive numbers) in `lib/index.js`; test in `test/next/unit/surface.js`
- [x] T006 Add `@hg/spaces` row fields `used` (uint, last use ms), `own` (bool), `pinned` (bool), `as` (string: `'main'` or `'site'`, default `'main'`) in `lib/index/build.js`, regenerate `lib/index/spec/`; test old rows read with defaults in `test/next/unit/index-def.js`

**Checkpoint**: options and rows exist; behavior unchanged; `npm test` green.

---

## Phase 3: User Story 3 — Topics within the DHT's budget, the visit first (P1)

**Goal**: one priority queue for topic joins/leaves, an announce cap, re-looks only for spaces in use.

**Independent test**: 500 seeded spaces queued; a visited space's topic flushes within 50 ms of the same
join on an idle engine (local DHT); announced topics ≤ cap; no 750 ms tick from a burst.

### Tests for User Story 3

- [x] T007 [P] [US3] Failing unit tests in `test/next/unit/topic-queue.js`: order by priority (0 in use, 1 own, 2 pinned, 3 recent, 4 re-look, then age); at most 1 background job in flight; priority 0 runs at once; `announced` never above `maxAnnounced`; leave waits the grace period (default 5 min, test with a short one) and a rejoin within it cancels the leave
- [ ] T008 [P] [US3] Failing network test in `test/brittle/networking/` style under `test/next/unit/topic-queue-net.js` with `testSwarm(t)`: 60 spaces seeded + one visited: visit flushed first; re-looks stop for a space not in use (count `discovery.refresh` calls)

### Implementation for User Story 3

- [x] T009 [US3] Topic queue in `lib/network.js`: `join(space, priority)` / `leave(space)` enqueue; one background job in flight awaiting `flushed()`; priority 0 bypasses; `announced` set (own, pinned, recent up to `maxAnnounced` → `{ server: true, client: true }`; others in use → `{ server: false, client: true }`; others no topic); grace timer per leaving space, cleared on `close()`
- [x] T010 [US3] `#relook` only while the space is in use (refcount from US2; until then, only for spaces opened by a call) in `lib/network.js`
- [x] T011 [US3] Call sites pass priorities: `connect()`, `_open`, `#keep`, `[symbols.openSpace]`, `redeemInvite` in `lib/index.js`
- [x] T012 [US3] `perf/scenarios/topics.mjs`: `topics.visit` (queue full vs idle, ms), `topics.announced` (count), `topics.requests` (DHT requests per minute settled)

**Checkpoint**: forum scenario tests unchanged and green (`node scripts/test-runner.js forum`).

---

## Phase 4: User Story 2 — Spaces open only while used (P1)

**Goal**: held spaces closed until used; idle close; LRU under `maxOpen` / `memory`; seeded set; pins.

**Independent test**: 500 held spaces: ready < 1 s, < +50 MB, a closed space opens on first call (< 100 ms
with its first `latest(20)`), closes after `idleMs`; forum scenarios unchanged.

### Tests for User Story 2

- [x] T013 [P] [US2] Failing unit tests in `test/next/unit/lazy.js`: open with 50 held spaces and `maxOpen` 8 → only the seeded set open; `hg.space(key)` returns a closed space; any async call opens it; idle close after `idleMs`; a space with a live view, a change listener, a pending call or a `hold()` never closes; LRU evicts the least recently `used` unseeded space; `space.ready()` then sync getters work; `spaces()` entries carry `{ opened, pinned, own }`
- [x] T014 [P] [US2] Failing scenario test `test/next/forum/lazy.js`: a member holding 100 forums (`maxOpen` 8): visit one, read, post, idle close; a post arriving while closed shows at the next visit; pinned forums stay online; another device of the person sees the pins
- [x] T015 [P] [US2] Failing test: a closed space with pending writes finishes them before closing; a call during close reopens after, in `test/next/unit/lazy.js`

### Implementation for User Story 2

- [x] T016 [US2] `Space` shell state in `lib/space.js`: `opened`, `ready()`, `_ready()` awaited at the top of every async public method, `_use()/_unuse()` refcount, `hold()` → release function; `close()` returns to a reusable shell (name and parent from the row) instead of a dead object
- [x] T017 [US2] Engine lifecycle in `lib/index.js`: `_open` builds shells for every row and opens only the seeded set through one open queue (reuse `_opening`); idle timer per space; LRU by `used`; memory estimate 250 KB + 18 KB × open logs per open space (research R3); never close an in-use space
- [x] T018 [US2] Seeded set and pins in `lib/index.js`: own (created by this identity), pinned, then recent up to `maxAnnounced`; `hg.pin(key)`, `hg.unpin(key)`, `hg.pinned()` stored as personal-space setting `pinned` (list of keys) and mirrored in the row
- [x] T019 [US2] Paths that walk every space read rows for closed ones instead of opening them (research R9): `#settle` (adds rows for listed spaces), `_openSubspaces` (rows; a sub-space opens with its top space's use), `_writeHeads`, budgets (`#hold`, `storage.shares` from index sizes) in `lib/index.js`
- [x] T020 [US2] `lib/network.js` attaches only open spaces to connections; opening attaches to live connections (existing path)
- [x] T021 [US2] `perf/scenarios/engine.mjs`: sizes 100 / 500 held spaces, 5 posts each: `engine.open` (ms), `engine.rss` (MB, gc'd), `engine.visit` (ms), `engine.open-count`

**Checkpoint**: `npm test`, SwarmFS `npm run test:all`, forum example `npm test` green.

---

## Phase 5: User Story 1 — Each space carries its own types (P1) — **apply-time**

**Goal**: `types/set { version, types }` in the top space's decision log; each space validates, decodes,
indexes and enforces with its own types; re-index per space.

**Independent test**: engine without `types`; space A `{ post }`, B `{ page }`; a second engine joins both;
A's owner app adds `comment` → only A re-indexed; a forged incompatible `types/set` ignored everywhere.

### Tests for User Story 1 (non-negotiable: apply-time)

- [x] T022 [P] [US1] Failing apply tests in `test/next/unit/decisions-types.js`: `types/set` applied only if the writer may `decide`; `JSON.parse` fails → no effect; a `hg/` type name → no effect; "`version` is the current version + 1" else no effect; `checkCompatible(current)` fails → no effect; applied → view entry `types:<version>` stored and never overwritten, `state.typesVersion = version`; two concurrent ones from owner and admin → the second in order refused on every member; field limit "compact JSON, ≤ 32 KB" enforced
- [x] T023 [P] [US1] Failing unit tests in `test/next/unit/types.js`: `Types.from(describe())` round-trips, built-ins added; a decider's app opening a space with a compatible superset writes `types/set` automatically; a non-decider's never does; a write of a type or field the space lacks → `INCOMPATIBLE_TYPES` "this space doesn't have …"
- [x] T024 [P] [US1] Failing scenario test `test/next/forum/engine.js`: one engine without `types` holding a forum, a wiki and a site space, each with its own types, joined by a second engine; a wiki type change re-indexes only the wiki (forum row count and timing unchanged); sub-forums use the forum's types
- [x] T025 [US1] Update `test/next/forum/versions.js` (rule 3): "refused at open" → refused at the space (the engine opens; the forum's calls throw `INCOMPATIBLE_TYPES`); polls work once the owner's updated app opened the forum, before that a plain member's `put('poll')` throws `INCOMPATIBLE_TYPES`; old apps now decode new fields ("kept and decoded"); a forged incompatible `types/set` ignored by every member
- [x] T026 [P] [US1] `test/next/forum/rebuild.js`: a types change rebuilds one space only (new test); whole-folder rebuild after index loss unchanged

### Implementation for User Story 1

- [x] T027 [US1] `Types.from(stored)` (inverse of `describe()`, built-ins added) in `lib/types.js`
- [x] T028 [US1] Decision `types/set` encoding (`version` uint, `types` string ≤ 32 KB) in `lib/encodings.js` and apply rule per data-model.md in `lib/decisions/apply.js` on decisions-in-place's apply path; view entries `types:<version>`; state `types`, `typesVersion` in `lib/decisions/state.js`
- [x] T029 [US1] `Space#types` from the state (top space's for sub-spaces), else the engine's declaration (old spaces); `space.types()`, `space.typesVersion` in `lib/space.js`
- [x] T030 [US1] `createSpace({ types })` writes `types/set` (version 1) with `space/init`; `TypeError` "a space needs types" when neither given in `lib/index.js` / `lib/space.js`
- [x] T031 [US1] At a space's open, a decider's app with a compatible superset writes `types/set` (current + 1); incompatible → `INCOMPATIBLE_TYPES` from that space's calls, the engine still opens; remove the folder-wide `checkCompatible` in `_open` in `lib/index.js`
- [x] T032 [US1] Re-index per space on a `typesVersion` change that adds types or indexes held in that space: delete the space's rows (reuse `#purge`'s row deletion) and index its held logs again (`#restore` for one space); `@hg/meta types:<space hex>` records what each space was indexed with in `lib/index.js`
- [ ] T033 [US1] Personal space: one set of type names for every app on the engine; two declarations of one name that differ → `INCOMPATIBLE_TYPES` naming the type, in `lib/index.js`; test in `test/next/unit/types.js`

**Checkpoint**: `npm test`, Bare (`test:next:bare`), SwarmFS and forum example suites green.

---

## Phase 6: User Story 6 — Today's apps and folders move without loss (P2)

**Independent test**: the master fixture opens with no re-index; forum and SwarmFS suites unchanged.

- [x] T034 [P] [US6] Failing test `test/next/unit/migration.js` on `test/next/fixtures/master-folder/`: opens, every space readable, `index/` files unchanged (no rebuild), `types:<space>` rows written from the global `types`, global kept while any space lacks its own
- [x] T035 [US6] Migration in `lib/index.js` and `lib/instance.js`: global `@hg/meta 'types'` → `types:<space>` per row; `instance.json` gains per-space `types`, `own`, `pinned`, `as`
- [x] T036 [P] [US6] Failing test: SwarmFS-like types and forum types on one engine, each space its own, in `test/next/forum/engine.js`

---

## Phase 7: User Story 4 — Logs open only while used (P2)

**Independent test**: 2,000 logs caught up → ≤ ~20 open; a new record in a closed log arrives; a newcomer
fetches a closed log.

- [ ] T037 [P] [US4] Failing tests in `test/next/unit/logs-lazy.js` with two or three engines on `testSwarm(t)`: after catching up, open cores ≤ own + decision log + downloading; a closed log's author writes → it opens, downloads, closes after 30 s (short in test); a newcomer gets a log closed on the only holder (Corestore `_attachMaybe`)
- [ ] T038 [US4] Directory entries without a core (`{ identity, device, limit, indexed, core | null, lastUse }`) in `lib/directory.js`; open on own / behind (activity entry or heads length > indexed) / read beyond the index / budget pass; close after 30 s unused
- [ ] T039 [US4] `lib/replication.js` `hold` and `lib/space.js` `_open` stop opening every log; reads needing blocks open the core on demand
- [ ] T040 [US4] `perf/scenarios/logs.mjs`: a space with 2,000 logs caught up: `logs.open` (open cores), `logs.reopen` (start ms vs today)

---

## Phase 8: User Story 5 — A site reaches only its own spaces (P2)

**Independent test**: a handle scoped to A works on A and its sub-spaces; B, the personal space, the
phrase, devices → `NOT_ALLOWED`; a default handle throws `NOT_SUPPORTED` until per-site keys exist.

- [x] T041 [P] [US5] Failing tests `test/next/unit/scope.js`: every allow-listed `Space` method on A and its sub-spaces works; other spaces, another top space's sub-space key, personal space, phrase, devices, `spaces()`, budgets → `NOT_ALLOWED` without revealing what's held; events of B never reach it; the handle holds A in use and `close()` releases it; `hg.scope(key)` without `{ identity: 'main' }` throws `NOT_SUPPORTED` (never falls back silently); with it, `site.identity` is the main identity; a not-held key opens by key, an invite redeems
- [x] T042 [US5] `lib/scope.js` (new): `hg.scope(keyOrInvite, { identity })` → allow-list object, filtered `on/off`, `identity`, `close()`; held space row `as` written (`'main'`), `hg/space` record gains trailing field `as` (read by the person's own devices only) in `lib/types.js`
- [x] T043 [US5] Add the scope cases to `test/next/forum/engine.js` (wiki handle can't reach the forum; default handle `NOT_SUPPORTED`; main-identity handle works)

---

## Phase 9: User Story 7 — A phone: short runs, small memory (P3)

**Independent test**: on Bare, `suspend()` then `resume()` with 500 held spaces: the space in use online
first; memory under the budget.

- [x] T044 [P] [US7] Failing tests `test/next/unit/suspend.js`: `suspend()` pauses the queue, suspends the swarm, closes spaces not in use, flushes heads; a pending call on a space that closes fails with `SUSPENDED`; `resume()` brings the space in use online before the seeded set; runs under `test:next:bare`
- [x] T045 [US7] `hg.suspend()` / `hg.resume()` in `lib/index.js` and `lib/network.js` (`swarm.suspend()` / `resume()`, queue paused)
- [ ] T046 [US7] Run `npm run perf -- engine topics logs --bare` and record the numbers in research.md R8

---

## Phase 10: Polish & cross-cutting

- [x] T047 [P] `docs/next/api.md`: open options, types per space (`space.types()`, `INCOMPATIBLE_TYPES` moved), lazy spaces (`ready()`, `hold()`, pins), `hg.scope`, `suspend/resume`, new error codes
- [x] T048 [P] `docs/next/concepts.md`: one engine, types live in the space, spaces closed until used, per-site keys (shape now, derivation later)
- [x] T049 [P] CHANGELOG.md dated entry: apply-time `types/set` (everyone updates together), `INCOMPATIBLE_TYPES` now per space, no downgrade, migration; link to `specs/015-one-engine/`; ECOSYSTEM.md note for SwarmFS (personal-space types must be prefixed: `held` → `swarmfs/held`)
- [ ] T050 Forum example: re-pin, run its tests; add to its `specs/requests-to-hypergraph.md` that a member's newer types wait for an admin's open (`E:\Code\P2P\hypergraph-forum-example`)
- [ ] T051 SwarmFS: run `npm run test:all` (Node and Bare) against this working tree; file the `swarmfs/held` rename as a SwarmFS request
- [ ] T052 Full `npm test` and `test:next:bare`; check SC-001–SC-009 with the perf numbers; update ROADMAP.md "Now" item 10

---

## Dependencies & Execution Order

### Phase dependencies

- Setup (T001–T003) → Foundational (T004–T006) → US3 → US2 → US1 → US6 → US4 → US5 → US7 → Polish.
- **US1 needs decisions-in-place merged** (T028 builds on its apply path).
- US6 (migration) needs US1 (per-space `types:` rows).
- US5's idle "in use" refcount needs US2; US7 needs US2 and US3.
- US4 is independent of US1/US5/US6 (after US2); it may move earlier if a big forum needs it first.

### Within each story

Tests first and failing → implementation → the story's checkpoint suites (forum scenarios, SwarmFS, forum
example after US2 and US1).

### Parallel opportunities

- T002, T003 together; T007, T008 together; T013–T015 together; T022–T024, T026 together; T034, T036;
  T047–T049.
- One session builds the core at a time (ROADMAP "How we work"): parallelism is between test files and
  docs, not two sessions on `lib/`.

## Parallel example: User Story 1

```text
T022 decisions-types.js   T023 types.js   T024 forum/engine.js   T026 forum/rebuild.js   (all failing first)
then T027 → T028 → T029 → T030 → T031 → T032 → T033 in order (shared files)
```

## Implementation Strategy

### MVP

US3 + US2 (local only, no one needs to update together): an engine that holds 500 spaces cheaply and
visits fast. Ship and measure before the apply-time US1.

### Incremental delivery

1. US3 topics → measure `topics.*`.
2. US2 lazy spaces → measure `engine.*`; forum and SwarmFS unchanged.
3. US1 types per space + US6 migration → CHANGELOG apply-time entry; everyone updates together.
4. US4 logs → `logs.*`.
5. US5 scope (main identity only until per-site keys) → HyperBrowser milestone 1 can start.
6. US7 phone.

## Notes

- Per-site key derivation is a follow-up spec (spec.md "Out of scope"); here only the API and its
  `NOT_SUPPORTED` refusal.
- Several types versions side by side (spec.md "Future direction") is not built; T028 only keeps every
  version stored.
- Commit after each task or logical group; nothing merges without the lead's review.
