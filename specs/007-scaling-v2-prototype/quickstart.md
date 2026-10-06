# Quickstart: Scaling v2 Prototype

## Run the tests

```bash
node scripts/test-runner.js v2          # the prototype's own tests
npm test                                # everything (v1 unchanged)
```

## Measure

```bash
node bench/v2-chat.js 10000             # small, ~1 min
node bench/v2-chat.js 1000000           # history generated in bulk (research R9)
node bench/v2-chat.js 10000000 --writers 4
node bench/chat.js 10000                # the same scenario on v1, for the comparison
```

Expected outcomes (spec success criteria):

| check | where | expected |
|---|---|---|
| latest page, newcomer | `newcomer.latest.ms` at 10k / 1M / 10M | ≤ 2 s at every size, memory and bytes within 10% |
| bytes for the latest page | `newcomer.latest.bytes` | < 2 MB with 50 active authors |
| arrival between members | `live.arriveP50 / P95` | < 100 ms / < 500 ms |
| throughput, ~100 writers | `history.messagesPerSec` | ≥ 1,500/s (5× one v1 indexer) |
| offline restart | `newcomer.reopen.offline.ms` | < 1 s |

Keep runs within the machine's limits (CLAUDE.md): no long all-core runs; prefer the small sizes
while iterating.

## Validate by hand

1. Two peers: one creates a community and a channel, appoints itself keeper (`keep`), posts.
2. The other opens the community by key, replicates, and calls `latest()`: the post shows.
3. Ban the second peer; its new posts disappear for the first.
4. Restart the second peer offline: `latest()` still shows what it showed.
