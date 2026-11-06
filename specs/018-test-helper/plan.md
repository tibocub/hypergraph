# Implementation Plan: A test helper for apps

**Branch**: `claude/018-test-helper-227e6e` | **Date**: 2026-11-06 | **Spec**: [spec.md](spec.md)

## Summary

One new file, `lib/test-helper.js`, exported as `hypergraph/testing`: the pieces every app copied (local DHT,
temp folders, `within`, `eventually`, `codeOf`) plus `open(t)`, an online `Hypergraph` closed after the test.
`test/next/helpers.js` re-exports them instead of its own copies; the forum scenario `_setup.js` requires
`hypergraph/testing` as an app does.

## Technical Context

- **Language**: CommonJS JavaScript, Node and Bare (built-ins through the package `imports` map).
- **Dependencies**: `hyperdht/testnet` (hyperdht moves from devDependencies to dependencies, still 6.36.0).
- **Testing**: brittle (hypergraph's own); the helper itself depends on no runner.
- **Storage / performance**: none. Not a hot path (no perf scenario: test-only code).

## Design

Per test (`WeakMap` keyed by `t`), one cleanup list registered once with `t.teardown(fn, { order: 1000 })`
(brittle) or `t.after(fn)` (`node:test`). It runs, in order: close every instance `open()` made (each bounded
to 10 s), destroy the DHT, remove the folders (with retries). So it doesn't matter which was made first, and no
runner `order` option is needed beyond the one hint brittle gets (late, after the test's own teardowns at
order 0, so a test's own `hg.close()` still runs before its folder goes).

`bootstrap(t)`: `undefined` when `HG_TEST_PUBLIC_DHT` is set; else the test's testnet (3 nodes), created on
first use (`createTestnet(3)` with no teardown: the list destroys it).

### Contract (`hypergraph/testing`)

| Call | Returns |
|---|---|
| `open(t, opts?)` | a `Hypergraph`, online, in `opts.dir` or a new temp folder; `hg.dir` set; other opts to `Hypergraph.open` |
| `bootstrap(t)` | the bootstrap list of the test's local DHT (`undefined`: public DHT) |
| `tmpDir(t, label?)` | a new empty folder, removed after the test |
| `within(promise, ms, fallback = null)` | the promise's value, or `fallback` after `ms`; no timer left |
| `eventually(fn, ms = 5000, every = 25)` | `fn()`'s first truthy value, or `null` after `ms` |
| `codeOf(promise)` | the rejection's `code` (or message), or `null` if it resolves |

No `{ connect: false }`: `test/next/helpers.js` keeps its own offline `open()` (it has test-only options:
`bootstrap: null`, labels), now on the helper's `tmpDir` and `bootstrap`.

## Constitution Check

- I/II (concurrency, test-first): no replication code changes. A test of the helper itself
  (`test/next/unit/test-helper.js`): teardown order, `within` leaves no timer, public-DHT switch, `node:test`-style `t`.
- III (thin composition): wraps `hyperdht/testnet`, no new mechanism.
- IV (one API surface): replaces the copies in hypergraph's own tests, not added next to them.
- V: not breaking. CHANGELOG entry (new export, hyperdht now a dependency).
- Doc-sync: new section `docs/next/testing.md`, linked from `docs/next/api.md`.
- Rule 3: forum scenario tests use `hypergraph/testing`.

## Project Structure

```
lib/test-helper.js              new
package.json                    exports "./testing"; hyperdht → dependencies
test/next/helpers.js            re-exports the helper's pieces, keeps its own extras
test/next/forum/_setup.js       require('hypergraph/testing')
test/next/unit/test-helper.js   new
docs/next/testing.md            new; api.md links it
CHANGELOG.md, ROADMAP.md (H7 done)
```

## What SwarmFS would change to adopt it (not done here)

`test/helpers.js`: delete `eventually`, `codeOf`, `tmpDir`, `bootstrap` (≈45 lines) and import them from
`hypergraph/testing`; drop its `hyperdht` devDependency and override. Its `device()` keeps its own
`sfs.close` guard (SwarmFS wraps Hypergraph). Default `eventually` waits differ (SwarmFS 10 s / 50 ms vs 5 s / 25 ms):
pass `ms` where it relies on 10 s. The forum example: same, and its wrong 6.32.0 pin goes.
