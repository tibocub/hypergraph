# Quickstart: checking open spaces at scale

Prerequisites: this branch, `npm install` done, local DHT (the tests make their own).

## Scenarios

1. **Join with every admin offline**: `node test/next/forum/public.js`. Owner makes the forum public,
   closes; a newcomer joins with `publicLink()`, posts; a third member reads the post and lists the
   newcomer. The decision log's length didn't move.
2. **Door stays open**: same file: making it private again is refused; `revokeInvite(publicLink)` is
   `NOT_ALLOWED`; a banned joiner's new device log counts for nothing.
3. **Invite links unchanged**: `node test/next/forum/invites.js`.
4. **Silent members**: `test/next/forum/public.js` "a joiner who never wrote isn't listed, then is".
5. **Closed logs**: `node scripts/test-runner.js test/next/replication/` (a record in a closed log
   arrives; a newcomer fetches a closed log from a member).
6. **Ranges**: `node test/next/unit/ranges.js` (0, 1, many differences; a lying peer).
7. **Everything**: `npm test`, `npm run test:next`, `npm run test:next:bare`; SwarmFS, HyperBBS, hyperDNS
   `npm test`.

## Perf

```bash
git stash; git checkout master; npm run perf; git checkout 016-open-spaces-at-scale; git stash pop
npm run perf
npm run perf:compare
```

Expected: `members.public-cost`, `members.public-join-kb`, `logs.held-start`, `logs.settle-kb` flat
from 1k to 10k; `members.decision` unchanged (invite links still decisions).
