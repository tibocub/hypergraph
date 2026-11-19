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

Tests write temporary folders. Put them on a disk with room, and preferably an SSD: on a spinning
disk, files run in parallel time out.

```bash
export TMP=/path/to/tmp TEMP=/path/to/tmp HG_TEST_TMP=/path/to/tmp
```

While working, run only the files you touch, as plain scripts (`node test/next/unit/fields.js`) or
through the runner (`node scripts/test-runner.js test/next/forum/invites.js`). Run both full suites
before sending a change.

If you change a hot path (storage, replication, indexing, wire formats), run `npm run perf` before
and after and compare with `npm run perf:compare`.

## Send a change

1. Work on a branch.
2. Fix a bug or change behaviour together with a test that fails before and passes after.
3. If the public API or its behaviour changes, update the forum scenario tests in
   `test/next/forum/`, the docs in `docs/next/`, and the JSDoc in `lib/`.
   `npm run docs:check` must pass.
4. Comments say why, not what: no ticket numbers, dates or names.
5. Breaking changes get an entry in `CHANGELOG.md`: other projects use this working tree directly
   (see `ECOSYSTEM.md`).
6. Open a pull request describing what changed and how you tested it.

Larger features start with a spec in `specs/` (the spec-kit workflow: spec, plan, tasks).
