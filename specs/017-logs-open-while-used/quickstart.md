# Quickstart: checks for spec 017

Before any run: `export TEMP=E:/Code/P2P/.tmp TMP=E:/Code/P2P/.tmp HG_TEST_TMP=C:/Users/tiboz/AppData/Local/Temp/hg-tests`.

- `node test/next/unit/closed-serve.js`, `node test/next/net/handoff.js`: the assumptions (R0).
- `node test/next/unit/ranges.js`: a length difference is found and costs what a missing key costs.
- `node test/next/net/closed-logs.js`: 2,000 logs, ≤ ~20 open after the idle delay; reopen opens none;
  a record in a closed log arrives and `isComplete()` is false until it does (connected, and met later);
  a newcomer gets a closed log's blocks; a helper mirrors closed logs and their growth.
- `node scripts/test-runner.js next`, then `--bare next`; `npm test`; SwarmFS `npm test`, `npm run test:bare`.
- `npm run perf`, `npm run perf:compare`: `logs.held-start` flat, `logs.length-settle-kb` under 3 KB.
