# Tasks: A test helper for apps

**Input**: [spec.md](spec.md), [plan.md](plan.md). One user-facing module; stories share it, so they run in order.

## Phase 1: Setup

- [X] T001 Export `./testing` → `./lib/app-testing.js` and move `hyperdht` (6.36.0) to `dependencies` in package.json

## Phase 2: User Story 1 - a two-member test in a few lines (P1)

- [X] T002 [US1] Test first: `test/next/unit/app-testing.js` — two instances via `open(t)` see each other's post;
      teardown order (instances, DHT, folders) on a fake `t`; `within` returns the fallback and leaves no timer
- [X] T003 [US1] `lib/app-testing.js`: per-test cleanup list, `open`, `tmpDir`, `bootstrap`, `within`, `eventually`, `codeOf`

## Phase 3: User Story 2 - apps with their own wrapper (P2)

- [X] T004 [US2] Test: same bootstrap twice per test; `HG_TEST_PUBLIC_DHT=1` gives `undefined`, in test/next/unit/app-testing.js
- [X] T005 [US2] `test/next/helpers.js` takes `within`, `eventually`, `codeOf`, `tmpDir`, `testBootstrap` from the helper
- [X] T006 [US2] `test/next/forum/_setup.js` requires `hypergraph/testing` (rule 3: as an app does)

## Phase 4: User Story 3 - any test runner (P3)

- [X] T007 [US3] Test: a `node:test`-style `t` (only `after`) and a `t` with neither (TypeError), in test/next/unit/app-testing.js

## Phase 5: Polish

- [X] T008 [P] `docs/next/testing.md` with a full two-member test; link from docs/next/api.md
- [X] T009 [P] CHANGELOG.md entry; ROADMAP.md H7 done
- [X] T010 Run `node scripts/test-runner.js next`, `--bare next`, and the v1 default suite

## Dependencies

T001 → T002 → T003 → T004–T007 → T008–T010.
