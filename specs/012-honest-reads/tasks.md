---

description: "Tasks for spec 012: honest reads and change signals"
---

# Tasks: Honest reads and change signals

**Input**: `specs/012-honest-reads/` — [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md)
(R1–R12: code facts and line numbers), [data-model.md](data-model.md), [contracts/api.md](contracts/api.md),
[quickstart.md](quickstart.md)

**Tests**: test-first everywhere (constitution II): each test task is written and seen failing before
the implementation task after it. Tests run with `node scripts/test-runner.js <files>`; Bare with
`npm run test:all` at the end.

**Order**: User stories in this order — US2 (P1), US1 (P1), US4, US3, US5. US2 comes before US1 although
both are P1: US1's background work (fetched content) reports through US2's change entries, and the
test suite that US1 moves leans on US2's events.

**Docs**: each story updates the docs it changes in the same story (doc-sync-on-change).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1–US5 from spec.md

---

## Phase 1: Setup

- [ ] T001 Check that the H17 worker's `lib/` change is merged into master; bring this branch up to date with master (the app's sync tool, not `git merge` by hand) — no `lib/` edit before that
- [ ] T002 Run `node scripts/test-runner.js next` once on the updated branch and keep its pass count and wall time as the baseline for SC-006 (the runner records times in `.test-times.json`)

---

## Phase 2: User Story 2 — `change` says which records changed, edits included (Priority: P1) 🎯 MVP

**Goal**: every record whose answer changed is in `change`'s `records: [{ id, type, deleted }]`, edits included (H14, H16).

**Independent Test**: two devices; put, edit, delete a record on one; each step's `change` on the other lists that id; `deleted` set only for the delete.

### Tests for User Story 2 (write first, see them fail)

- [ ] T003 [US2] Write `test/next/net/change-records.js` (two devices of one identity, set up as `test/next/forum/devices.js` does with `forum.addDevice` + `forum.joinWithCode`, local DHT): (a) PC `put` → phone `change.records` has `{ id, type: <type>, deleted: null }`; (b) PC `edit` → phone `change` lists the id with `deleted: null` (fails today: H16); (c) PC `del` → phone lists it with `deleted: { by: 'author', stamp, device }`, `stamp` equal to the delete's stamp (from `inspect({ record })`), `device` the PC's device key; (d) the same three on the writing device itself; (e) `types` equals the distinct types of `records`
- [ ] T004 [US2] Add to `test/next/net/change-records.js`: a moderator's `hide`/`reveal` lists the record with `deleted: null`; `moderateAction('remove')` and `ban … { from }` list each record that went with `deleted: { by: 'space' }`; an edit by a member not allowed to edit (written through a modified app as in `test/next/net/adversarial.js`) is never listed
- [ ] T005 [US2] Add to `test/next/forum/live.js`: a live list follows an edit made on another member's app (the title shown changes) — fails today

### Implementation for User Story 2

- [ ] T006 [US2] In `lib/index/indexer.js`, make `#settle(tx, row, changes, clears, fresh)` return `null` (nothing applied), `{ deleted: { by: 'author', stamp, device } }` (a delete won: the allowed DELETE change's `stamp` and z32 `device`) or `{ edited: true }` (an edit became the latest version); update its callers in `#one()` and `#uncount`/rebuild paths so an applied edit counts as a change (R1)
- [ ] T007 [US2] In `lib/index/indexer.js`, turn every `changed = new Set()` into a `Map` keyed by the record id's hex with values `{ id, type, deleted }` (id as `enc.idToString`); at each of the ~12 `changed.add(row.type)` sites set the entry (`deleted: null`, or the author delete from T006, or `{ by: 'space' }` in `#takeDown`, the cut path and write-limit `#uncount`); a later entry for the same id replaces the earlier one (R2)
- [ ] T008 [US2] In `lib/space.js` `#changed(changes)`: emit `change` with `{ types: [...distinct types], records: [...changes.values()] }`; keep `_indexed++`, `#keysLater()` (now `has` on types derived from the entries), `_progress`, `#logsChanged()`, `_holdLater()`; update `_live`'s `onchange` and `lib/index.js:277`'s personal listener to the payload (they read `types`, unchanged)
- [ ] T009 [US2] Run T003–T005 and `node scripts/test-runner.js next`; fix only what this story broke
- [ ] T010 [US2] Update `docs/next/api.md` ("Spaces and invites": `forum.on('change', ({ types, records }) => {})` with the entry shape and "edits included") and `specs/011-spaces-core/contracts/api.md` line `forum.on('change'…)` (mark "spec 012")

**Checkpoint**: H16 fixed; SwarmFS could already drop its `'logs'` listener.

---

## Phase 3: User Story 1 — Reads answer at once (Priority: P1)

**Goal**: every read answers from what is held, at once; `{ timeout }` opts into waiting; the work a read needs still starts.

**Independent Test**: with the only other member offline, every read answers in < 50 ms with `complete: false`; with `{ timeout: 2000 }` it waits, and answers early once complete.

### Tests for User Story 1 (write first, see them fail)

- [ ] T011 [US1] Write `test/next/net/honest-reads.js`: (a) only holder offline → `query().latest`, `get`, `linked`, `count`, `sum`, `tags`, `edges`, `getByTag` each answer in < 50 ms with `complete: false` on a space of 1,000 records (SC-001); (b) `{ timeout: 3000 }` with the holder back after 1 s answers complete in about 1 s, not 3 s; (c) a private space member whose key hasn't arrived (`status().access === 'waiting'`) reads at once, `complete: false`
- [ ] T012 [US1] Add to `test/next/net/honest-reads.js`: (d) a record whose content was dropped here (budget, as `test/next/net/bounded.js` "dropped content" test sets up) read at once is left out with `complete: false`, and a `change` listing its id follows once its holder is online, after which `get(id)` returns it; (e) a newcomer to a big space (made "big" for the test with `testing.bigSpaces({ records: 20 })` from `lib/testing.js`, as `test/next/net/big-directory.js` does for logs; see `test/next/net/newest-first.js`) reads the first page at once, then a live query of it reaches `complete: true` with no further call
- [ ] T013 [US1] Rewrite `test/next/net/bounded.js` to the new contract: "incomplete within the bound" becomes "incomplete at once" plus "with `{ timeout }`: within it"; keep "a lone member's reads are complete at once" and "a member whose log nobody holds does not make answers incomplete"
- [ ] T014 [US1] Add to `test/next/net/honest-reads.js`: (f) a refused write (`setRole` by a member whose promotion was just decided on another connected device) still catches up first and succeeds — writes keep their 5 s bound (FR-004, spec US1 scenario 5)

### Implementation for User Story 1

- [ ] T015 [US1] `lib/index.js`: remove `READ_TIMEOUT` and `this.readTimeout`; `lib/space.js`: add `const BOUND_MS = 5000 // writes' and background waits (spec 012 FR-004)` and use it in `#unless`, `#sealer`, the decision append `wait`, the dropped-content refill, and `edit()` of a dropped record (research R4)
- [ ] T016 [US1] `lib/space.js` `_bounded(fn, timeout = 0)`: before returning an incomplete answer, call `this.#widenFor(need)` (also when `left <= 0`) (R3)
- [ ] T017 [US1] `lib/space.js` `_shaped(rows, deadline)` / `#content`: when the deadline has passed, start `#content(row, Date.now() + BOUND_MS)` for each dropped row in the background (not awaited; a `Set` of ids in flight so one fetch per id at a time; errors to `safetyCatch`); `#content` reports a restored row through `#changed` as `{ id, type, deleted: null }` (R3)
- [ ] T018 [US1] `lib/space.js` `_live`: run with deadline `Date.now()` (no wait); while its last answer was incomplete, also re-run on `_progress` (coalesced by the existing `running`/`again` flags); stop listening when stopped (R9)
- [ ] T019 [US1] Remove `readTimeout` from `test/next/helpers.js:98` and the seven tests that pass it (`test/next/forum/invites.js:112`, `personal.js:96`, `rebuild.js:66,81`, `versions.js:118,126`; adapt each test's intent: e.g. `invites.js`'s "joining waits past the read bound" keeps its point with `redeemInvite`'s own 30 s), and from `bench/next/first-page.js:83`, `bench/next/_writer.js:38`
- [ ] T020 [US1] Run `node scripts/test-runner.js next`; fix every test that leaned on a read's implicit wait the way an app would (`eventually()` from `test/next/helpers.js`, a live helper, or `{ timeout }` on that read) — never a sleep; list the files changed in the commit message
- [ ] T021 [US1] Update `docs/next/api.md` (open: `readTimeout` gone; "Queries": "every read answers at once; `{ timeout }` waits while incomplete"; remove the "this device's own: complete at once, no waiting" special case comment), `docs/next/concepts.md` "Complete answers" (no 5 s), `docs/next/deleting-and-incomplete.md` "Incomplete" ("answers from what this device holds, at once"), and `specs/011-spaces-core/contracts/api.md` (`readTimeout`, `timeout` lines, `fromDevice` H10 comment), marked "spec 012"

**Checkpoint**: SC-001 holds; H10's special case is gone from docs.

---

## Phase 4: User Story 4 — Every other read has its event (Priority: P2)

**Goal**: the FR-010 table holds: `'spaces'` on a name arriving (H12), new `'members'`, `'decisions'`, `'devices'`, `'settings'`, `status().complete`.

**Independent Test**: each table row: change the thing on another device, see the event here.

### Tests for User Story 4 (write first, see them fail)

- [ ] T022 [US4] Write `test/next/net/events.js`, one test per FR-010 row: (a) phone paired after the space was named gets `'spaces'` again with the name (H12, as `E:\Code\P2P\SwarmFS\specs\repro-h12-space-name.mjs`), within 1 s of the name being readable (SC-003); (b) a sub-space created on one member fires `'spaces'` on another; (c) `setRole` and `removeRole` fire `'members'` on another member; a member's newly paired device log arriving fires `'members'`; (d) any decision fires `'decisions'`; (e) `addDevice` completed and `removeDevice` fire `'devices'` on the other device; `setSetting` on one device fires `'settings'` on the other; (f) a space incomplete while its only other holder is offline fires `'status'` with `complete: true` when the holder comes back; a private space's key arriving fires `'status'` with `access: 'full'`; (g) no event after `close()`
- [ ] T023 [US4] Add to `test/next/net/honest-reads.js`: a live query whose last answer was incomplete re-runs and reports `complete: true` when completeness flips with no record of its type arriving (e.g. only the peer's directory looked at)

### Implementation for User Story 4

- [ ] T024 [US4] `lib/index.js`: add `#spacesChanged()` emitting `'spaces'` only when `JSON.stringify(this.spaces())` differs from the last emitted; call it from `#keep`, `leaveSpace`, and a `_decided` listener on every non-personal space as it is opened (R5)
- [ ] T025 [US4] `lib/index.js` `#openPersonal`: in the personal `change` listener, emit `'devices'` when `types` has `hg/device` or `hg/device-remove`, `'settings'` when it has `hg/setting` (R7)
- [ ] T026 [US4] `lib/space.js`: `#onDecisions()` emits `'decisions'` and `'members'` (after `_decided`); the directory's `accepted(log)` callback emits `'members'` when the log is another member's device log (not an identity log) (R6)
- [ ] T027 [US4] `lib/space.js` `status()`: add `complete: this.isComplete()`; `_statusChanged()`'s signature adds `complete` and `settlers` count; `#logsChanged()`'s timer also calls `_statusChanged()`; `lib/directory.js`: when `known` turns true (line ~373) call a new `known()` callback the space passes next to `accepted`, which calls `_statusChanged()` (R8)
- [ ] T028 [US4] `lib/space.js` `_live`: while its last answer was incomplete, also re-run on `'status'` (with T018's `_progress`) (R9)
- [ ] T029 [US4] Update `docs/next/api.md`: the read → event table (contracts/api.md) near the top of "Records"/"Queries" or its own section "Knowing when to read again", the rule "an event may come when nothing changed; never a change without its event; listen first, then read", the new events in "Spaces and invites", "Devices", "Who, what, who is online", and `status()`'s `complete`; `specs/011-spaces-core/contracts/api.md` the same lines, marked "spec 012"

**Checkpoint**: H12 fixed; every read has its event.

---

## Phase 5: User Story 3 — Deleted, or not here yet (Priority: P2)

**Goal**: `get(id)` returns `deleted`: `{ by: 'author', stamp, device }`, `{ by: 'space' }`, or `null` (H15).

**Independent Test**: a member holding a record's delete gets `deleted` with the stamp; an unknown id gets `deleted: null`.

### Tests for User Story 3 (write first, see them fail)

- [ ] T030 [US3] Write `test/next/net/get-deleted.js`: (a) author deletes → other member's `get(id)` is `{ record: null, deleted: { by: 'author', stamp, device } }` with the stamp shown by `inspect({ record: id })`; (b) a moderator's `remove` → `deleted: { by: 'space' }`; (c) an id never heard of → `deleted: null`; (d) a held record → `deleted: null` with the record; (e) a "delete" of someone else's record written by a modified app (as in `test/next/net/adversarial.js`) → `deleted: null`; (f) a delete whose record's log isn't known here → `deleted: null`

### Implementation for User Story 3

- [ ] T031 [US3] `lib/space.js`: one helper `#deletedOf(id)` that, for an id with no row, reads `@hg/changes` for `target = id` and returns `{ by: 'author', stamp, device }` for a DELETE whose `author` equals the identity of the record's log (known here), `{ by: 'space' }` if `this.state.isRemoved(id)`, else `null`; use it in `get()` (returns `{ record, complete, deleted }`) and in `inspect({ record })`'s `deleted` judgement so both judge alike (R10)
- [ ] T032 [US3] Update `docs/next/api.md` "Records" (`get` line: `{ record, complete, deleted }`, what each means), `docs/next/deleting-and-incomplete.md` "Deleted" (an app can say "deleted" vs "not here yet"), `specs/011-spaces-core/contracts/api.md` `get` line, marked "spec 012"

**Checkpoint**: H15 answered.

---

## Phase 6: User Story 5 — The forum tests use the honest path (Priority: P2)

**Goal**: CLAUDE.md rule 3: forum lists show `complete` and follow live updates.

**Independent Test**: a newcomer's live list goes from its first answer (`complete: false`) to the full page (`complete: true`) with no polling in app code.

- [ ] T033 [US5] Write `test/next/forum/honest.js` (against `forum.js` only, like the other forum tests): (a) a newcomer opens a forum of 50 posts; its `liveLatest` first reports `complete: false` (any number of posts), then the 20 newest with `complete: true`; (b) with every other member offline, `forum.latest()` answers at once, `complete: false`; (c) a live thread (`liveThread`) follows a comment edited and one deleted on another member's app; (d) `liveMembers` follows a role given; `liveForums` shows a sub-forum's name made on another member
- [ ] T034 [US5] `test/next/forum/forum.js`: list helpers `latest`, `comments`, `byTopic`, `postsPage`, `column`, `polls`, `tagged`, `modLog` return `{ items, complete }`; `liveLatest(forum, onUpdate, n)` passes `({ items, complete })`; add `liveThread(forum, post, onUpdate)` (comments of a post via `linked` + `change` records naming a comment on it), `liveMembers(forum, onUpdate)` (`people()` on `'members'`), `liveForums(hg, onUpdate)` (`forums()` on `'spaces'`), each returning `stop()`; keep each helper as short as an app would write it — anything awkward is an API bug to report, not to hide
- [ ] T035 [US5] Update every forum test calling the changed helpers to take `.items` where it only compares lists (`test/next/forum/*.js`, `test/next/net/*.js` users of `forum.latest` etc.); run `node scripts/test-runner.js forum`

**Checkpoint**: the honest path is tested where apps learn the API.

---

## Phase 7: Polish & cross-cutting

- [ ] T036 [P] `CHANGELOG.md`: one dated entry for `hypergraph/next` (breaking: reads at once, `readTimeout` removed, `change.records`, new events, `get().deleted`, `status().complete`; migration in three lines; link `specs/012-honest-reads/`)
- [ ] T037 [P] `E:\Code\P2P\SwarmFS\specs\requests-to-hypergraph.md`: mark H12, H14, H15, H16 done with what SwarmFS can change (spec.md "What changes for each consumer") and SC-007 to measure; only that file in SwarmFS — its code changes and the measurement are its own session's
- [ ] T038 `grep -rn readTimeout lib test/next bench/next tools docs/next specs/011-spaces-core` finds nothing but this spec's history; `grep -rn "timeout: 0" tools/inspector/index.js` — remove the now-default `{ timeout: 0 }` there only if the inspector reads stay at once (they do)
- [ ] T039 Run `npm run test:all` (v1 and next, Node and Bare); compare next's wall time with T002's baseline (SC-006)
- [ ] T040 Run the quickstart's SwarmFS repros (`node specs/repro-h12-space-name.mjs`, `npx brittle-node specs/repro-h16-edit-change.mjs` from `E:\Code\P2P\SwarmFS`) and record their output in the commit message
- [ ] T041 Run `cd E:\Code\P2P\HyperBBS && npm test` and `cd E:\Code\P2P\hyperDNS && npm test` (v1, expected unchanged; hub rule)
- [ ] T042 Measure once with `npm run bench:quick` (not a big run: machine-load rule) that indexing time didn't grow with `change` entries; note the numbers in `research.md` R2

---

## Dependencies & execution order

- T001 → everything (H17 is in `lib/` now).
- US2 (T003–T010) → US1 (T017 reports through US2's entries; T020 leans on events) → US4 → US3 → US5 → Polish.
- US3 only needs US2 (the `deleted` shape); it could run right after US2 if US1's test churn takes long.
- US5 needs US1, US2, US4 (its live helpers use `change.records`, `'members'`, `'spaces'`).
- Within a story: test tasks first, seen failing; then implementation; then docs.

## Parallel opportunities

- Few: almost every implementation task edits `lib/space.js`. Safe in parallel: T003/T011/T022/T030 test files (different files) once their story is next; T036 and T037 (different files); T041's two suites.

## Implementation strategy

- **MVP**: US2 alone (H16 + H14): smallest diff, unblocks SwarmFS's `'logs'` removal and its one-entry re-read.
- Then US1 (the big test churn), US4 (H12), US3 (H15), US5 (forum), Polish — one branch, one merge, since US1 is the breaking part and the docs must land with it.
