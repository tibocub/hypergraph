# Quickstart: Validating Fast-Forward Contexts

## 1. Nothing regressed

```bash
npm test
cd ../HyperBBS && npm test
cd ../hyperDNS && npm test
```

## 2. Feature tests

| scenario | where | proves |
|---|---|---|
| `context/init` encodes/decodes; old decoder ignores it | `test/brittle/core/event-encoding.js` | R3 |
| new context: creator indexes, added writers don't | `test/brittle/core/contexts.js` | US1 #1–2 |
| 3 writers write, everything confirmed within 10 s | `test/brittle/replication/indexers.js` | US1 #3, SC-003 |
| indexer offline: writes still apply locally, confirmed later | `test/brittle/replication/indexers.js` | US1 #4 |
| fresh peer fast-forwards a large context, listing matches | `test/brittle/replication/fast-forward.js` | US2 #1, #3 |
| fresh peer stores a fraction of the index | `test/brittle/replication/fast-forward.js` | US2 #2 |
| `fastForward: false` replays | `test/brittle/replication/fast-forward.js` | FR-011 |
| version 1 context unchanged | `test/brittle/core/contexts.js` | US4 #1, FR-019 |
| rule rejects via API and via raw append, on every peer, not in signed state | `test/brittle/core/context-rules.js`, `replication/fast-forward.js` | US3 #1, SC-004 |
| rule reads the index; throwing rule rejects | `test/brittle/core/context-rules.js` | US3 #2, #4 |
| rules mismatch / unknown version interrupt with a clear error | `test/brittle/core/context-rules.js` | US3 #3, FR-016, FR-018 |

## 3. Scale

```bash
BENCH_DIR=E:\hg-bench RSS_LIMIT_MB=12000 node bench/scale.js 1000000
```

Targets: first listing within 30 s of join; joining peer peak under 500 MB at 100k and within
20% of that at 1M (SC-001, SC-002).
