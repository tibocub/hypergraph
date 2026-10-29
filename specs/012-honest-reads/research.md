# Research: Honest reads and change signals

Code facts checked on master `ca356fc` (2026-10-29), and the decisions taken from them.

## R1 — Why edits fire no `change` (H16)

- **Found**: `lib/index/indexer.js` `#one()` adds a type to `changed` for an edit/delete only
  `if (row && await this.#settle(...))`. `#settle()` (`indexer.js:735`) returns `true` only when a delete
  wins; an edit that becomes the latest version updates the row and returns `false`. So no member, the
  editing device included, gets `change` for an edit. Live queries (which listen to `change`) miss edits
  too. Forum tests passed because no test watches a live list across an edit.
- **Decision**: `#settle()` returns what happened (`null`, an edit applied, or the winning delete with
  its stamp and device); `#one()` records an entry for either.
- **Alternative rejected**: keep listening to `'logs'` (SwarmFS's shortcut): fires on every log growth,
  says nothing about which records.

## R2 — `change` payload: ids, not a feed (H14)

- **Found**: every indexer path builds `changed = new Set()` of types and calls `space.changed(changed)`
  → `Space.#changed(types)` (`space.js:1518`), which bumps `_indexed`, emits `change`, `_progress`,
  schedules `'logs'`. About 12 `changed.add(row.type)` sites in `indexer.js` (put, edit/delete settle,
  moderate, take-down, retag, uncount for cuts and write limits, rebuild). Each has the row in hand.
- **Decision**: `changed` becomes a `Map` keyed by record id hex → `{ id, type, deleted }`; `#changed`
  emits `{ types: [...distinct types], records: [...values] }`. A later entry for the same id in a batch
  replaces the earlier one (a put then a delete in one batch reports the delete).
- **Alternative rejected**: `space.changes({ since: cursor })`. Needs a new index table (`@hg/changes` is
  per-target, not ordered by arrival), written in every transaction and pruned. Its one gain is surviving
  a restart; both consumers do a full read at open anyway. Cost/benefit: no.

## R3 — Reads at once (Rule 1)

- **Found**: `Space._bounded(fn, timeout = this.hg.readTimeout)` (`space.js:1357`) loops: read; if
  incomplete and time left, `#widenFor(need)` then wait for `_progress`. With `timeout` 0 it returns
  before `#widenFor` — so a big space's newest-first reading would never widen for an at-once read.
  `_live()` (`space.js:1487`) already calls `#widenFor` after an incomplete answer.
- **Found**: dropped content (story 6) is fetched inside the read by `_shaped(rows, deadline)` →
  `#content(row, deadline)`, which gives up at once when `deadline` has passed — so an at-once read would
  never fetch it. `indexer.restore()` emits nothing.
- **Decision**:
  - `_bounded(fn, timeout = 0)`; before returning an incomplete answer it calls `#widenFor(need)`.
  - `_shaped` with no time left starts `#content(row, Date.now() + BOUND_MS)` in the background, once per
    id at a time (a `Set` of ids being fetched), not awaited.
  - `#content` reports the restored row through `#changed` (entry `{ id, type, deleted: null }`), so
    live queries and apps re-read.
- **Found**: `get()`, `linked`, `count`, `sum`, `tags`, `edges`, `getByTag`, `query().latest` all go
  through `_bounded` with the caller's `timeout`. `decisions()` (`space.js:1171`) isn't bounded: it lists
  the decision log as held, already at once (its `complete` comes from the log); it takes no `timeout`.

## R4 — What keeps a 5 s bound (FR-004)

- **Found** uses of `this.hg.readTimeout` that aren't app reads: `#unless` (`space.js:997`, catch up with
  decision recorders before refusing), `#sealer` (`space.js:721`, a private space's key before writing),
  decision append `wait` (`space.js:1688`, `Math.max(readTimeout, 5000)`), the refill of dropped content
  (`space.js:2161`), `edit()` of a dropped record (`space.js:546`), `_live`'s deadline (`space.js:1498`).
- **Decision**: one constant `BOUND_MS = 5000` in `lib/space.js` for the first five; `_live` runs at
  once (deadline now) like every read, relying on R3's background work and FR-005's re-run.
  `catchUp(ms)` returns at once when no recorder is connected (`decisions/log.js:120`), so tests don't
  pay 5 s for nothing. `readTimeout` disappears from `lib/index.js:61` and the docs.
- **Rejected**: an app-wide default wait (keeps blocking first screens one option away); renaming the
  per-read `timeout` to `wait` (no new meaning, churn for every caller).

## R5 — `'spaces'` on a name arriving (H12)

- **Found**: `Hypergraph` emits `'spaces'` only in `#keep()` (`index.js:909`) and `leaveSpace()`
  (`index.js:745`). `space.name` is `state.name` from the decision log; a joined space's name arrives in
  a later decision batch, applied in `Space.#onDecisions()`, which ends with `emit('_decided')`.
- **Decision**: one `#spacesChanged()` in `Hypergraph`: emits `'spaces'` when
  `JSON.stringify(this.spaces())` differs from the last one emitted. Called from `#keep`, `leaveSpace`,
  and each non-personal space's `_decided`. Sub-spaces are spaces in that list, so `subspaces()` is
  covered.
- **Rejected**: list a space only once named (hides a space we hold; the next field would need the same).

## R6 — `'members'` and `'decisions'` (Space)

- **Found**: `members()` derives from decision state and from `directory.logs` (a member's device
  logs). Logs are accepted in the directory's `accepted(log)` callback (`space.js:171`). Decisions apply in
  `#onDecisions()`.
- **Decision**: `#onDecisions()` emits `'decisions'` and `'members'`; `accepted(log)` emits `'members'`
  when the log is a device log of a member (not this device's own, not an identity log). No diffing:
  FR-013 allows extra events, and `#onDecisions` runs once per decision batch.

## R7 — `'devices'`, `'settings'` (Hypergraph)

- **Found**: `devices()` reads personal-space `hg/device` rows minus `personal.isRemoved` (from
  `hg/device-remove`); `settings()` reads `hg/setting` rows. The personal space's `change` is already
  watched in `#openPersonal()` (`index.js:277`) for `hg/space`.
- **Decision**: in that listener, `types` including `hg/device` or `hg/device-remove` → `'devices'`;
  `hg/setting` → `'settings'`.

## R8 — `status().complete`, and `'status'` when it flips (FR-012)

- **Found**: `_statusChanged()` (`space.js:2039`) emits when a signature of `policy, access, held, heldFrom,
  belowPolicy, budget, warnings` changes; it runs after decisions, storage passes and key changes, not
  after indexing or after `directory.known` turns true (`directory.js:373`). Completeness flips there.
- **Decision**: `status()` gains `complete: this.isComplete()`; the signature adds `complete` and the
  settlers' count; `#logsChanged()`'s timer (at most every 100 ms after a change) also calls
  `_statusChanged()`; the directory tells the space when `known` turns true (a callback next to
  `accepted`), which calls `_statusChanged()`. `isComplete()` is in-memory (replicator count, directory
  flag): cheap at 10/s.

## R9 — Live queries and completeness (FR-005)

- **Found**: `_live` re-runs only on `change` of its type. A page can become complete without any record
  of its type arriving (another type's blocks, a peer's directory looked at).
- **Decision**: while its last answer was incomplete, a live query also re-runs on `_progress` (fired by
  every `#changed` and every decision batch) and on `'status'`. Its existing `running`/`again` flags
  coalesce bursts.

## R10 — `get().deleted` (H15)

- **Found**: an author's delete is kept in `@hg/changes` (`kind: DELETE`, `target`, `author`, `device`,
  `stamp`) after the record's row is deleted; `inspect({ record })` (`space.js:2020`) already judges
  whether it counts (`b4a.equals(ch.author, log.identity)` with the record's log). Take-downs are
  `state.isRemoved(id)`.
- **Decision**: `get()` with no row looks up `@hg/changes` for `target = id` (one range read, only when
  the row is missing) and returns `deleted: { by: 'author', stamp, device }` for a delete that counts,
  `{ by: 'space' }` if `state.isRemoved(id)`, else `null`. Same judgement as `inspect`, shared in one
  helper.

## R11 — How many tests lean on the 5 s wait

- **Found**: `test/next/helpers.js:98` opens every test instance with `readTimeout: 2000`; 7 tests set
  their own (`invites.js:112`, `personal.js:96`, `rebuild.js:66,81`, `versions.js:118,126`); forum tests
  call `eventually()` ~230 times, but some reads right after another member's write rely on the implicit
  wait. Not counted exactly (the suite can't be run with the change before `lib/` is free: H17 worker).
- **Decision**: implementation runs the full next suite (Node and Bare) once with the new default and
  fixes each failure by asserting what an app would do (`eventually`, a live helper, or `{ timeout }`),
  never by adding a sleep. Expect tens of call sites.

## R12 — SwarmFS's shortcuts, checked in its code (`E:\Code\P2P\SwarmFS`, `21cb51b`)

- `lib/holdings.js:72` and `lib/sync.js:15`: `const LOCAL = { timeout: 200 }`, passed to `get` and
  `all(query)` reads. Delete: default is at once.
- `lib/swarmfs.js:180-183`: `space.on('change', changed)` + `space.on('logs', changed)` with a
  `shortcut:` comment naming H16. Delete the `'logs'` line.
- `lib/sync.js` `read()` (line ~129): full re-read of folders and files per change → use
  `change.records` to re-read only those (and keep the full read at open/resume).
- `bin/swarmfs.js:259-265` `drive()`: `until(sfs, 'spaces', find)` — unchanged, now fast (H12).
- `bin/swarmfs.js:68-76` one-shot `ls`: reads `d.list()` after `online()`; with at-once reads it should
  pass `{ timeout: WAIT }` through `list()` to keep waiting for the other device's entries.
- `lib/swarmfs.js:32-33`: passes `readTimeout` to `Hypergraph.open`; remove.

## R13 — Found while building: `complete` turns true a moment early on reconnecting

- **Found** (`test/next/net/honest-reads.js`, `{ timeout }` test, about 1 run in 2): a member reopened with
  its only peer offline reads `complete: false`; when the peer comes back, `complete` turns true as soon as
  the peer's list of logs has been looked at (`directory.js` `#known()`), a moment before Hypercore has
  heard that one of those logs grew. A read in that moment answers complete without the newest records.
  Older than spec 012 (the same check decided waiting reads before); `bounded.js` already looped on
  `complete && items.length === 2` around it.
- **Not fixed here**: it touches replication's notion of "known" (Principle I tier); a follow-up should make
  `known` wait for each listed log's remote length (or count a log as missing until its first update after
  connecting), with a regression test. The test marks it `shortcut:`.

## R14 — Measured after building (2026-10-29)

- Next suite: 285 tests, 93 s before; see the implementation report for after. Tests that leaned on the
  old 5 s wait: 9 reads in 4 files (`forum/budgets.js`, `forum/policies.js`, `net/newest-first.js`,
  `net/big-directory.js`), each fixed by the read asking `{ timeout }` (an old page, an opened post, a
  newcomer's first pages). No other forum test needed a change: they already used `eventually()`.
