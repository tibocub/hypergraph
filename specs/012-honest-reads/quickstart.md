# Quickstart: checking spec 012 works

Prerequisites: this repo at the implementation branch, `npm install` done.

## 1. The new tests

```bash
node scripts/test-runner.js test/next/net/honest-reads.js test/next/net/change-records.js test/next/net/events.js test/next/net/get-deleted.js test/next/forum/honest.js
```

Expected: all pass. Before the `lib/` change, `change-records.js`'s edit test fails (H16), `events.js`'s
`'spaces'`-name test fails (H12), and `honest-reads.js`'s at-once test fails (reads wait).

## 2. The whole next suite, Node and Bare

```bash
npm run test:all
```

Expected: v1 and next pass on both. Compare next's wall time with the last run (`.test-times.json`):
not slower (SC-006). `grep -rn readTimeout test/next bench/next tools` finds nothing.

## 3. The SwarmFS repros

From `E:\Code\P2P\SwarmFS` (it links this working tree):

```bash
node specs/repro-h12-space-name.mjs
```

Expected: a second `'spaces'` line with `"name":"My files"` within about 1 s (SC-003).

```bash
npx brittle-node specs/repro-h16-edit-change.mjs
```

Expected: `after edit true` followed by a `{"types":["file"],"records":[...]}` entry, not only `logs`.

## 4. v1 consumers untouched

```bash
cd E:\Code\P2P\HyperBBS && npm test
```

```bash
cd E:\Code\P2P\hyperDNS && npm test
```

Expected: unchanged results (they use v1).

## What isn't checked here

SwarmFS's own migration (deleting `LOCAL`, the `'logs'` listener; re-reading only `records`) and its
10,000-file measurement (SC-007) run in SwarmFS's repo, by its session.
