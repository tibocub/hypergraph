# Tasks: Moderation tools (F10–F13)

Test-first per the constitution: each story's test before its code.

## Phase 1 — F13 restricted puts (US1)

- [x] T001 Forum test: theme restricted to `decide` (owner/admin put; member `NOT_ALLOWED`; forged put hidden; demoted admin keeps earlier) — `test/next/forum/moderation-tools.js`
- [x] T002 Unit: `put` parse and `INCOMPATIBLE_TYPES` on change — `test/next/unit/types.js`
- [x] T003 `put` in `declare()` and the type snapshot — `lib/types.js`
- [x] T004 Write check in `_put` — `lib/space.js`
- [x] T005 Read rule `gate.mayPut` applied in query, linked/count/sum, get — `lib/gate.js`, `lib/index/query.js`, `lib/space.js`
- [x] T006 Permission cuts on role change (own permissions too), removal and ban — `lib/decisions/apply.js`; unit test

## Phase 2 — F12 reports (US2)

- [x] T007 Forum test: report, reports() grouped/counted, NOT_ALLOWED for members, dismissed by remove, content unreadable
- [x] T008 `hg/report` built-in type, `report()`, `reports()` — `lib/types.js`, `lib/space.js`

## Phase 3 — F10 moderated lists (US3)

- [x] T009 Forum test: hidden/flagged lists however old, revealed left out, paging
- [x] T010 `Query#moderated()` — `lib/index/query.js`

## Phase 4 — F11 ban drop all (US4)

- [x] T011 Forum test: two devices, a board, newcomer; already-banned; one decision
- [x] T012 Unit: apply of `drop: 'all'` zeroes cuts, sub-space cuts, overrides earlier ones
- [x] T013 Encoding trailing `drop`; apply; `moderateAction` option — `lib/encodings.js`, `lib/decisions/apply.js`, `lib/space.js`

## Phase 5 — Polish

- [x] T014 Docs: `docs/next/api.md`, `docs/next/concepts.md`; CHANGELOG (apply-time: update together)
- [x] T015 `npm run test:next`, `test:next:bare`; SwarmFS `npm run test:all`
