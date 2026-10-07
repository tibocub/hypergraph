# v2 prototype: communities whose cost follows what you read

**Status: prototype, unstable.** `require('hypergraph/v2')` exposes it alongside the v1 API, which
is unchanged. Names and shapes may change; nothing migrates between v1 and v2. Design, decisions
and measurements: [`specs/007-scaling-v2-prototype/`](../specs/007-scaling-v2-prototype/) and
[`specs/research/scaling-v2.md`](../specs/research/scaling-v2.md).

## Why

In v1, a channel is one shared log that one indexer orders. Joining replays or fast-forwards it,
and every member who applies it pays for every member and every message. That is fine for
small groups, but costs grow with the community. v2 is shaped so that a member pays for what it
reads and holds, not for how big or old the community is.

## How it works

- **Control log** (one Autobase per community, written only by owner, admins, mods and keepers):
  roles, channels, bans, hides, keepers. Every member holds it in full; it stays small. A member who
  never posts appears nowhere.
- **Author logs**: each author writes a channel's messages to their own Hypercore (one per author per
  channel, key derived from their identity). No ordering agreement per message.
- **Time segments**: a channel is cut into segments (one hour by default). Reading the latest
  page reads the newest segment's authors only.
- **Rosters**: a keeper lists, per segment, who posted and where their messages start (a small
  single-writer Hyperbee; authors announce over a Hypercore extension, entries are signed by the
  authors, readers merge several keepers' rosters and drop entries that don't verify).
- **Reading**: a page merges the listed authors' newest messages by `(time, author, seq)`, the same
  on every peer. `follow()` reacts when a roster grows or the control log changes, with no polling.
- **Moderation**: hides and bans are in the control log, so a member holding only today's messages
  still applies them. A ban records how long each of the author's recent logs was, so posts dated
  before the ban but written after it are still left out.
- **Replication**: `replicate: 'all' | 'sparse' | 'auto'` (default `auto`) with a `budget` in
  bytes. `all` holds everything (helpers); `sparse` holds what is read; `auto` holds everything
  while it fits the budget, else the newest segments that fit.
- **Offline**: what was shown is read again from the blocks already held; no shared index has to
  be fetched first.

## Using it

```js
const Corestore = require('corestore')
const { Community } = require('hypergraph/v2')

const community = new Community(new Corestore('./storage'), {
  identity: { keyPair, seed },   // seed derives this member's per-channel log keys
  key,                           // omit to create a community
  replicate: 'auto',             // 'all' | 'sparse' | 'auto'
  budget: 1e9                    // bytes this member keeps for the community
})
await community.ready()
swarm.on('connection', (socket) => community.replicate(socket))

const channel = await community.createChannel({ name: 'general', keep: true })  // admin and up; keep: list who posts
await community.keep(otherChannel)                                // a keeper can also keep channels others created
await community.post(channel, 'hello')
const page = await community.latest(channel, { limit: 50 })
const older = await community.before(channel, { t: page[page.length - 1].t })
const stop = community.follow(channel, (message) => {})
await community.closeChannel(channel)                             // release what reading opened
```

Full surface: [`contracts/api.md`](../specs/007-scaling-v2-prototype/contracts/api.md).

## Measured (2026-10-06, one Windows machine, 16 GB)

| | v1 | v2 |
|---|---|---|
| newcomer, latest 50 messages | 1.7 s, 0.73 MB at 10k (text on relation); 44 s, 36 MB at 100k (text in author logs) | 0.22 / 0.27 / 0.25 s and 68 / 113 / 143 KB at 10k / 1M / 10M; one page back 0.17 s, ~0.17 MB |
| channel write throughput | ~300 msg/s (one indexer applies all) | ~9,300 msg/s posted by 100 writers, all delivered |
| live arrival p50 / p95 | 24–34 / 40–159 ms | 2–15 / 20–33 ms, also with 100 authors posting their first message at once |
| disk for a peer holding everything | ~2–3 KB per message | ~211 B per message |
| silent members | ~70 KB memory each on every applying peer | nothing |
| idle cost of followed channels | 0.8 ms per `update()` for 200 channels (after fixes) | 0 ms CPU, 0 bytes per 10 s |
| offline restart, page shown again | 121 ms (after a fix) | 3 ms – 0.7 s |

Benchmarks: `bench/v2-chat.js` (channel size, throughput, replication), `bench/v2-community.js`
(member and channel counts). Commands and results: [`bench/README.md`](../bench/README.md).

## Known gaps

- A newcomer's download for the latest page grows slowly with history (68 → 143 KB from 10k to
  10M): the roster's index gets deeper (Hyperbee stores the path in every block). Logarithmic;
  one roster per segment would flatten it (not done).
- Memory with 5 channels open is ~13–17% higher in a 500-channel community than in a 10-channel
  one (was ~30–40% before a channel and its keeper became one event): every member holds the
  channel list, and applying it costs native RocksDB memory.
- A host on `auto` or `all` offers each live log to every new connection, also logs the member
  never opens (~87 B each; 500 channels: ~170 KB once per connection).
- `auto` doesn't count what is read beyond its window yet.
- A ban can't cut a log last listed in an older segment; backdated posts there show on scrollback.
- No encryption, invites or query API in v2; no compaction of old segments (decided: later, see
  research.md).
