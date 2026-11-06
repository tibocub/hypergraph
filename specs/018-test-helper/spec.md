# Feature Specification: A test helper for apps

**Feature Branch**: `claude/018-test-helper-227e6e` (the session's worktree branch; spec folder `018-test-helper`)

**Created**: 2026-11-06

**Status**: Done (see tasks.md).

**Input**: SwarmFS request H8 (`E:\Code\P2P\SwarmFS\specs\requests-to-hypergraph.md`), ROADMAP H7. Agreed by Tibo
on 2026-11-06 as one of three high-priority steps.

Who the "user" is: a developer on `require('hypergraph/next')` writing tests for their app (a forum, a chat,
SwarmFS).

## The problem

Every app copies hypergraph's test setup: a local DHT per test, temp folders removed afterwards, `eventually()`,
`codeOf()`. Three copies exist (hypergraph `test/next/helpers.js`, SwarmFS `test/helpers.js`, the forum example's
`test/helpers.js`), and they drift: the forum example pins hyperdht 6.32.0 while hypergraph tests with 6.36.0.
A new app developer has to learn all of it before writing a first two-member test.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A two-member test in a few lines (Priority: P1)

An app developer writes: open two instances, one creates a space and invites the other, the other sees a post.
No DHT, folder or timer code of their own. Everything opened is closed and removed after the test, and the test
process exits on its own.

**Independent Test**: the docs' example, run as a test file, passes on Node and Bare, and the process exits.

**Acceptance Scenarios**:

1. **Given** a test, **When** it opens two instances with the helper, **Then** both are online on a local DHT
   (3 nodes on 127.0.0.1) that only this test uses.
2. **Given** the test ends (pass or fail), **When** its teardown runs, **Then** the instances close first, then the
   DHT, then the temp folders are removed.
3. **Given** a wait for something that never happens, **When** its time is up, **Then** it returns `null` (no throw)
   and leaves no timer running.

### User Story 2 - Apps with their own wrapper (Priority: P2)

SwarmFS and the forum example open their own wrapper (`SwarmFS.open`, `startForum`), not `Hypergraph.open`. They
use only the helper's pieces: the DHT's bootstrap list and temp folders.

**Acceptance Scenarios**:

1. **Given** a test asks twice for the bootstrap list, **Then** it gets the same local DHT.
2. **Given** `HG_TEST_PUBLIC_DHT=1`, **Then** the bootstrap is `undefined` (the public DHT) and no local DHT starts.

### User Story 3 - Any test runner (Priority: P3)

The helper works with brittle (`t.teardown`) and Node's `node:test` (`t.after`); it does not load brittle.

### Edge Cases

- A close that hangs: bounded (10 s), logged, the rest of the teardown still runs.
- Windows keeps files locked a moment after closing: folder removal retries.
- An object with neither `teardown` nor `after`: a clear `TypeError`.

## Requirements *(mandatory)*

- **FR-001**: `require('hypergraph/testing')` gives `open(t, opts)`, `bootstrap(t)`, `tmpDir(t, label)`,
  `within(promise, ms, fallback)`, `eventually(fn, ms, every)`, `codeOf(promise)`.
- **FR-002**: `open(t, opts)` opens a `Hypergraph` in a temp folder (or `opts.dir`, to reopen one) on the test's
  DHT, online (`connectToSwarm`), closed after the test; other options go to `Hypergraph.open`.
- **FR-003**: Teardown order: instances, then the DHT, then folders, whatever order they were made in.
- **FR-004**: `HG_TEST_PUBLIC_DHT=1` switches to the public DHT.
- **FR-005**: No brittle dependency; `t` needs `teardown(fn)` or `after(fn)`.
- **FR-006**: hypergraph's internal test hooks (`lib/testing.js`) are not part of it.
- **FR-007**: Hypergraph's own next tests use it where they copied it: `test/next/helpers.js` builds on it, and the
  forum scenario tests (rule 3) use `hypergraph/testing` as an app would.
- **FR-008**: Works on Node and Bare.

## Decisions

- **Name: `hypergraph/testing`**, not `hypergraph/next/testing`. When the new core becomes the package root, a
  `next/…` path would break every app's tests; `hypergraph/testing` keeps working. It doesn't collide with the
  internal hooks: those are `hypergraph/lib/testing.js` (through the `./*` export), a different path, and stay
  internal (they bypass the API's checks: fine for hypergraph's own adversarial tests, wrong for apps). The file
  is `lib/test-helper.js`, so the two can't be mixed up in the code either.
- **No brittle dependency.** Apps may use `node:test` or another runner. The helper needs only a way to run
  something at the test's end; it keeps its own ordered cleanup list (so it needs no runner-specific `order`
  option), registered once per test.
- **hyperdht moves to `dependencies`** (pinned 6.36.0, as before). The helper loads `hyperdht/testnet`, so an
  app installing hypergraph gets the version hypergraph tests with; apps can drop their own pin.
- **No "make me a space with N members" helper.** Spaces, roles and invites are the app's own flow (two lines with
  the public API); the forum tests keep their own `threeMembers`.

## Success Criteria *(mandatory)*

- **SC-001**: The docs' two-member test is under 15 lines, with no DHT, folder or timer code.
- **SC-002**: `node scripts/test-runner.js next` and `--bare next` pass; the v1 default suite passes.
- **SC-003**: SwarmFS's suite is unchanged (not edited); the docs say what it would change to adopt it.

## Assumptions

- Apps test with Node or Bare and a runner with per-test teardown.
- SwarmFS and the forum example adopt it in their own repos later.
