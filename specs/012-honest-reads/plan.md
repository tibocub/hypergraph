# Implementation Plan: Honest reads and change signals

**Branch**: `012-honest-reads` | **Date**: 2026-10-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/012-honest-reads/spec.md`

## Summary

Two rules for `hypergraph/next`, replacing five one-off patches (H2, H10, H12, H14–H16):
reads answer at once from what is held, with `complete`, and wait only when given `{ timeout }`;
every read has an event that says when to read again, and `change` names the records (with how a
deleted one went). Mostly small edits in `lib/space.js`, `lib/index/indexer.js`, `lib/index.js`; the
biggest work is the test suite losing its implicit 5 s wait, and the docs. Code facts and the
reasons: [research.md](research.md).

## Technical Context

**Language/Version**: JavaScript (CommonJS), Node 20+ and Bare (both run in `test:all`)

**Primary Dependencies**: Hypercore, Corestore, Autobase (decision log), HyperDB (index) — no new
dependency

**Storage**: the local index (`@hg/records`, `@hg/changes`); no schema change

**Testing**: brittle via `node scripts/test-runner.js next` / `npm run test:all`; forum scenario tests in
`test/next/forum/`

**Target Platform**: library (`require('hypergraph/next')`)

**Project Type**: library

**Performance Goals**: a read with members offline answers in < 50 ms (was 5 s); `'status'` checks at most
every 100 ms

**Constraints**: no change to merge rules (delete wins, latest wins); no wire-format change; members on
the old and new code still converge (this is local behaviour only)

**Scale/Scope**: ~8 public behaviours, ~15 code sites, tens of test call sites, 4 docs files

## Constitution Check

*Gate before Phase 0, re-checked after Phase 1.*

| Principle | Check | Result |
|---|---|---|
| I. Correctness under concurrency & partition | No merge rule, wire format or decision changes. Reads answer earlier, never differently: same rows, same `complete`. Events are local. Adversarial deletes are judged as `inspect` does (R10). | ✅ |
| II. Test-first for replication/CRDT | Indexer change (R1, R2) touches replication-facing indexing: two-device tests for put/edit/delete/take-down events written first and seen failing (H16 fails today). Each new event and `get().deleted` gets a failing test first. | ✅ (tasks order it) |
| III. Thin composition | No new mechanism: events built from existing points (`#changed`, `#onDecisions`, `accepted`, personal `change`). No changes feed table (R2). | ✅ |
| IV. One coherent API surface | One rule per concern replaces special cases (H10's `need: 'own'` stays only as a completeness rule, not a wait rule). The read→event table is the single convention, documented once. SwarmFS's `'logs'` workaround removed. | ✅ |
| V. Alpha versioning, explicit breaks | Breaking for `hypergraph/next`: default wait 0, `readTimeout` gone, `change` payload grows (additive), new events (additive), `get()` gains `deleted` (additive). One dated CHANGELOG entry with migration. v1 untouched. | ✅ |
| Doc-sync-on-change | `docs/next/api.md`, `docs/next/concepts.md`, `docs/next/deleting-and-incomplete.md`, `specs/011-spaces-core/contracts/api.md` updated in the same change. | ✅ (tasks) |
| Regression-test-on-change | Every behaviour above has a test failing before. | ✅ |
| CLAUDE.md rule 3 (forum scenario) | Forum helpers expose `complete` and live lists; a newcomer honest-path test. | ✅ (tasks) |
| Hub rule (ECOSYSTEM.md) | HyperBBS/hyperDNS use v1: their suites are run once anyway at the end (cheap: 40 s + 15 s) to prove it. SwarmFS is told through its requests file. | ✅ |

Post-design re-check (after data-model and contracts): no new violation. Complexity Tracking: empty.

## Design

### Rule 1 — at once (R3, R4)

- `lib/index.js`: drop `READ_TIMEOUT` and `this.readTimeout`.
- `lib/space.js`: `BOUND_MS = 5000` for writes' internal waits (`#unless`, `#sealer`, decision append,
  refill, `edit()` of a dropped record).
- `_bounded(fn, timeout = 0)`; `#widenFor(need)` also before returning incomplete.
- `_shaped`: when the deadline has passed, background `#content(row, now + BOUND_MS)` per dropped row
  (deduped by id); `#content` reports the restored row as a change entry.
- `_live`: runs with deadline now; while its last answer was incomplete also re-runs on `_progress` and
  `'status'` (R9).

### Rule 2 — events (R1, R2, R5–R8)

- `indexer.js`: `changed` becomes `Map(idHex → { id, type, deleted })` at every site; `#settle()` returns
  `null | { edited: true } | { deleted: { by: 'author', stamp, device } }`; take-downs, `from` bans, cuts
  and write-limit refusals give `{ by: 'space' }`.
- `Space.#changed(map)`: emits `change` with `{ types, records }`; schedules `'logs'` and, in the same
  timer, `_statusChanged()`.
- `Space`: `'members'` from `#onDecisions()` and `accepted(log)` (a member's device log); `'decisions'`
  from `#onDecisions()`; `status()` gains `complete`, signature adds `complete` and settlers; directory's
  `known` turning true calls `_statusChanged()`.
- `Hypergraph`: `#spacesChanged()` (diffed), called from `#keep`, `leaveSpace`, every space's `_decided`;
  personal `change` → `'devices'` / `'settings'`.
- `get()`: `deleted` per R10 (one helper shared with `inspect({ record })`).

### Tests

- New, in `test/next/net/` (two devices, local DHT) — `honest-reads.js` (at-once reads,
  `{ timeout }`, background widening/fetch), `change-records.js` (put/edit/del/hide/take-down entries,
  own device and other), `events.js` (one test per FR-010 row), `get-deleted.js`.
- Forum: `forum.js` list helpers (`latest`, `comments`, `byTopic`, `postsPage`, `column`, `tagged`,
  `modLog`) return `{ items, complete }` (an app shows the hint; call sites take `.items` where they
  only compare lists); live helpers `liveLatest` (exists, now passes `complete`), `liveThread`,
  `liveMembers`, `liveForums`. A new `test/next/forum/honest.js`: newcomer, offline members, edit and
  delete in a live thread.
- Existing suite: fixed per R11.

### Docs and consumers

- `docs/next/api.md`: Rule 1 and 2 near the top; read→event table; `change` payload; `get().deleted`;
  `readTimeout` gone from `open`; `status().complete`; new events.
- `docs/next/concepts.md` "Complete answers"; `docs/next/deleting-and-incomplete.md` "Incomplete" (no more
  "waits 5 s"); `specs/011-spaces-core/contracts/api.md` lines for `readTimeout`, `change`, `get`,
  `status`, new events (mark "spec 012").
- `CHANGELOG.md`: one entry. SwarmFS `specs/requests-to-hypergraph.md`: H12, H14, H15, H16 answered with
  the list in spec.md (the lead or SwarmFS's session applies SwarmFS-side code changes; not this repo).
- `ROADMAP.md`: decision line once merged (the lead's call).

## Project Structure

### Documentation (this feature)

```text
specs/012-honest-reads/
├── spec.md
├── plan.md            # this file
├── research.md        # code facts and decisions
├── data-model.md      # change entry, deleted, events
├── contracts/api.md   # the API delta
├── quickstart.md      # how to check it works
├── checklists/requirements.md
└── tasks.md           # /speckit-tasks
```

### Source Code (repository root)

```text
lib/
├── index.js            # readTimeout removed; 'spaces' diffed; 'devices', 'settings'
├── space.js            # _bounded default 0, BOUND_MS, background fetch/widen, #changed payload,
│                       # 'members', 'decisions', status().complete, get().deleted, _live re-runs
├── directory.js        # tell the space when `known` turns true
└── index/indexer.js    # changed: Map of entries; #settle returns what happened; restore entry
test/next/
├── helpers.js          # no readTimeout
├── net/                # honest-reads.js, change-records.js, events.js, get-deleted.js
└── forum/              # forum.js helpers, honest.js, existing tests fixed
docs/next/              # api.md, concepts.md, deleting-and-incomplete.md
specs/011-spaces-core/contracts/api.md
CHANGELOG.md
```

**Structure Decision**: existing layout; no new module.

## Order and dependencies

1. **Wait for H17** (another worker edits `lib/` now): start from master after it merges.
2. Rule 2's indexer change first (H16 is a plain bug; its test fails today), then the other events,
   then `get().deleted`.
3. Rule 1 last among `lib/` changes: it is the one that moves the test suite, and the events of Rule 2
   are what the fixed tests and the forum's live helpers lean on.
4. Forum tests and docs in the same change; CHANGELOG; SwarmFS requests file answered.

## Risks

- **Test churn** (R11): tens of tests may have leaned on the implicit wait; fixing them is most of the
  work. Each fix must be what an app would do, not a sleep.
- **Event volume**: `change` with thousands of ids during an initial sync; `'members'` on every decision
  batch. Allowed (FR-013); measured once with `bench/next/first-page.js` that indexing time doesn't grow.
- **Background fetches** from at-once reads repeated by a live list: deduped per id; bounded by
  `BOUND_MS` each.
- **Bare**: events and timers only; `test:all` runs Bare too.

## Complexity Tracking

None.
