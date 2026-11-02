# Quickstart: validating spec 015

Prerequisites: this repo's `npm install`; temp data on E: (`TEMP`/`TMP` → `E:\Code\P2P\.tmp`).

## 1. The topic bench (exists now)

```bash
node bench/one-engine/topics.mjs 3
node bench/one-engine/topics.mjs 20 4,6,8,10,16,40,80
```

Expected: steps of exactly ~750 ms once one slot's requests pass 80 (≈25 topics on 3 nodes, ≈5 on 20);
none with `maxWindow` 1000. Results: `research.md` R1.

## 2. After implementation

```bash
node scripts/test-runner.js test/next/unit/space-types.js test/next/unit/lazy.js test/next/unit/topic-queue.js
node scripts/test-runner.js forum
npm run perf -- engine topics logs --node
cd E:\Code\P2P\SwarmFS && npm run test:all
cd E:\Code\P2P\hypergraph-forum-example && npm test
```

Expected: SC-001–SC-009 (`spec.md`); forum scenarios with only the changes listed in `plan.md`; SwarmFS and
the forum example green against this working tree.

## 3. Migration check

Open a folder written by master (`test/next/fixtures/` gets one) with the new version: every space
readable, `index/` untouched (same files, no rebuild), `types:<space>` rows written.
