# Implementation Plan: Moderation tools (F10–F13)

**Branch**: `014-moderation-tools` | **Spec**: [spec.md](spec.md)

## Summary

Four small additions on top of what exists: restricted puts reuse shared editing's permission cuts
(F13); reports are a built-in record sealed per moderator device with the private-space crypto (F12);
moderated lists read the decision state's moderation map instead of scanning (F10); a ban gains a
trailing `drop` field that zeroes every cut of the person (F11).

## Technical context

Node + Bare, `lib/` (hypergraph/next). Tests: brittle, `test/next/unit`, `test/next/forum`,
`npm run test:next` / `test:next:bare` (HG_TEST_JOBS=3).

## Design

### F13 — `put: { permission }` (lib/types.js, lib/space.js, lib/index/query.js, lib/decisions/apply.js)

- `declare()` parses `put` like `editable`: `{ by: 'members' }` default, `{ by: 'permission', permission }`.
  The stored type snapshot includes `put`; a change throws `INCOMPATIBLE_TYPES` (`put changed`).
- Write: `_put` checks `state.can(me, permission)` → `NOT_ALLOWED` (after `#unless` catch-up).
- Read: judged when read, as link targets are (research.md A12), so a later cut or grant needs no
  re-indexing: `gate.mayPut(types, row, state)` = `seq < state.editLimit(author, permission, log)`;
  the owner always. Applied where rows leave the index: `Query#run`, `linkedRows` callers
  (`#pointingAt`, `linked`), `get`, `taggedRows` (through Query). One helper `space._counts(row)`.
- Cuts: `lostAppPermissions` becomes `lostPermissions` (every permission but `post`, hypergraph's own
  included), and `member/remove` and `ban` record them too (`recordEditCuts`) with the decision's cut.
  Apply-time change. `reauthorize()` in the indexer keys on `state.editcuts`; unchanged (it only
  re-settles shared edits).

### F12 — reports (lib/types.js, lib/space.js, lib/private/crypto.js)

- Built-in type `hg/report { boxes: 'bytes' }`. `boxes` = compact array of `{ to: fixed32 (device),
  sealed: buffer }`, each `crypto_box_seal` of JSON `{ on, reason }` to that device's box key.
- Moderator devices: `state.writerInfo` entries whose identity `can(…, 'moderate')` in this space (the
  sub-space's state for a board), deduplicated by device.
- `report(record, { reason })`: `#mayPost`, not personal, reason ≤ 1,000 chars, `_put('hg/report')`.
- `reports()`: `#mayDecide('moderate')`; rows of `hg/report` (by-type, not hidden/removed), open the box
  for this device; group by `on`, latest per author; groups by newest report.
- Dismiss: `moderateAction('remove', id)` (existing).

### F10 — `Query#moderated(state)` (lib/index/query.js)

- `'hidden'` | `'flagged'`; else `TypeError`. Rows come from `state.moderated` (ids with that flag),
  fetched by id, filtered by type and the other filters, sorted newest first (stamp, id), paged by
  `after`. Hidden rows are included (`NOT_SHOWN` minus HIDDEN). `complete` as other queries (`need`:
  the decision state is held whole, so the oldest item's stamp).

### F11 — `ban { drop: 'all' }` (lib/encodings.js, lib/decisions/apply.js, lib/space.js)

- `moderate` decision gains trailing `drop` (optTrailingString). Client: `drop: 'all'` → cut entries
  with length 0 for every log held (#cutOf); allowed on someone already banned.
- Apply: a `ban` with `drop === 'all'` (also when already banned): `banned:` kept or set; `cut:<id>` set
  to 0 for every log in the decision's cut and every log already in their cut, overriding earlier cuts;
  the same for the cuts of every sub-space below (`sub:<k>:cut:<id>`); edit cuts zeroed alike. Logs
  nobody named already count 0 for a banned person (`limitOf`).
- The directory re-applies limits on state change (existing path for cuts).

## Apply-time changes

`drop` and the new permission cuts: every member updates together (CHANGELOG says so).

## Testing

- Unit: `test/next/unit/decisions-moderation.js` (apply: drop all, editcuts on removal/ban), types
  (put parse, incompatible), query moderated.
- Forum scenarios: `test/next/forum/moderation-tools.js`: theme restricted, reports, moderated lists,
  ban drop all across devices and a board, newcomer.
- Docs: `docs/next/api.md` (types, roles and moderation, queries), `concepts.md`, CHANGELOG.
