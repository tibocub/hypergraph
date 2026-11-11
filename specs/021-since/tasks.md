# Tasks: `space.since()`

**Input**: [spec.md](spec.md), [plan.md](plan.md).

- [X] T001 Tests first: test/next/unit/since.js, test/next/net/since.js, test/next/forum/whats-new.js
- [X] T002 `since()` in lib/space.js (`OPENING`), lib/scope.js `METHODS`, `dropped` in lib/index/query.js `shape()`
- [X] T003 Forum: `forum.visit()`, `forum.unread()` (cursor kept in the person's settings)
- [X] T004 perf/scenarios/since.mjs, `npm run perf` before and after
- [X] T005 docs/next/api.md, docs/next/concepts.md, CHANGELOG.md

## Built differently

- `limit` has no default: a call without one returns everything past the cursor (the request's example passes 500).
- Hypergraph's own types are left out unless named in `types`, as `linked()` without a type.
- A record of a type not arrived yet (`_typesPending`) stops its log's cursor: not asked for, same loss as a locked record.

## Not built

- A `timeout` option, or fetching dropped content: a check answers at once.
- A way to go back for records that start counting later (spec.md, Not covered).
- A compact cursor: its size follows the number of logs.
- No test for a big space's log first read in an older period (returned as new, spec.md Not covered): it needs a
  space read by activity lists and a widened horizon, not cheap; documented instead.
