# Contributing

## Set up

You need Node (a current release) and git. Bare is installed as a dev dependency.

```bash
git clone <this repository> hypergraph
```

```bash
cd hypergraph && npm install
```

The code to work on is `lib/` (the core, `require('hypergraph/next')`). `src/` is the old v1, frozen
until it is removed: don't change it.

## Test

```bash
npm run test:next
```

```bash
npm run test:next:bare
```

These run the core's tests on Node and on Bare, one process per file, in parallel (all cores but
two; `HG_TEST_JOBS=n` changes it). Network tests run on a small local DHT, not the internet
(`HG_TEST_PUBLIC_DHT=1` to use the public one, one file at a time).

Tests use the system temp folder; `HG_TEST_TMP` overrides it. When it has under 3 GB free, the
runner uses `HG_TEST_TMP_FALLBACK` if set and prints a line. Each test file gets a folder of its own
there, removed once it is done. The suites mostly wait on that disk (every account open and close
waits for its writes to be synced), so a fast disk matters more than more jobs.

```bash
export HG_TEST_TMP_FALLBACK=/path/to/a/disk/with/room
```

Three levels, from fast to thorough:

| Level | Command | Runs | When |
|-------|---------|------|------|
| quick | `npm run test:quick` | the tests your change affects, on Node | while working |
| merge | `npm run test:merge` | the affected tests on Node and Bare, plus a few whole forum flows | before a branch is merged |
| full | `npm run test:next` and `npm run test:next:bare` | everything | before pushing, after heavy or risky changes, in CI |

"Affected" comes from `.test-map.json` (not committed): every full Node run records which source
files each test executed. Your change is what differs from `master`, committed or not; a test runs
if it executed a changed file or is itself changed. The runner prints what it picked and why, and
runs everything instead (saying why) when the map is missing or older than the last change to a
test helper, when a helper, `package.json`, the lockfile or the runner changed, or when a source file
is new. It works per file: a test that only reads a constant from a changed file, without calling
into it, is missed. That is why merge adds the forum flows, and why the full run stays the last word.

A file that fails runs once more, alone, after the others. Passing then, it shows as
`FLAKY (passed alone)` and the summary counts it: a flaky test is a bug to fix, not a pass. Failing
twice is a real failure.

You can also run single files, as plain scripts (`node test/next/unit/fields.js`) or through the
runner (`node scripts/test-runner.js test/next/forum/invites.js`).

If you change a hot path (storage, replication, indexing, wire formats), run `npm run perf` before
and after and compare with `npm run perf:compare`.

## Send a change

1. Work on a branch.
2. Fix a bug or change behaviour together with a test that fails before and passes after.
3. If the public API or its behaviour changes, update the forum scenario tests in
   `test/next/forum/`, the docs in `docs/next/`, and the JSDoc in `lib/`.
   `npm run docs:check` and `npm run typecheck` must pass.
4. Comments say why, not what: no ticket numbers, dates or names.
5. Breaking changes get an entry in `CHANGELOG.md`: other projects use this working tree directly
   (see `ECOSYSTEM.md`).
6. Open a pull request describing what changed and how you tested it.

Larger features start with a spec in `specs/` (the spec-kit workflow: spec, plan, tasks).
