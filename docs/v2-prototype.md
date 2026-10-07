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
  still applies them. A ban records how long each of the author's logs was (found through the
  rosters and each keeper's author index), so posts dated before the ban but written after it are
  still left out.
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

## Private channels and invites (spec 008)

Design and measurements: [`specs/008-v2-private-channels/`](../specs/008-v2-private-channels/).

- **Private channels**: messages are sealed in the authors' logs with the channel's current key
  epoch (XChaCha20-Poly1305, bound to community, channel, log, epoch and time). Who posted, when and
  how big stays visible; members without the key, keepers and helpers get `{ text: null,
  unreadable: true }`. Only sealed messages are shown in a private channel.
- **Keys**: each member has one encryption key pair per identity (all its devices). An epoch key
  travels only sealed to one member (a **grant**), signed by an admin (or, if the channel allows,
  a key holder). Keepers keep the grants next to their roster; a member looks up only its own
  (3.4 / 10 / 23.4 KB at 10 / 1,000 / 50,000 members). The control log records each epoch's
  commitment, not the keys: one event per rotation, never per member.
- **Revoking**: `revoke()` records it, rotates to a new epoch and re-grants it to everyone else (1,000
  members: 0.4 s). The revoked member keeps what it had; nothing posted after is readable to it.
  Concurrent rotations settle on one epoch everywhere.
- **Invites**: `createInvite({ role, channels, expires, uses })` → a link with no key in it.
  `redeem(link)` reaches any control log writer online (the maker needn't be); the control log
  decides role, uses and expiry the same way on every peer; a key holder online grants the channels.
- **Cost**: a private channel's first page vs the same public one at 1M: 280 vs 247 ms, 104 vs 97 KB.

```js
const secret = await community.createChannel({ name: 'staff', private: true, keep: true })
await community.grant(secret, { identity, encryptionKey })   // the member's community.encryptionKey
await community.revoke(secret, identity)
const link = await community.createInvite({ role: 'mod', channels: [secret], uses: 5 })
const joined = await Community.join(store, link, { identity })
await joined.redeem(link)
```

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
- Private channels: a message is readable only while someone online holds its blocks (keepers
  list posts, they don't store them; run helpers on `all`). Rotation re-grants every member: 15 s
  at 50,000. Removing someone needs a rotation (no MLS-style forward secrecy).
- No query API in v2; no compaction of old segments (decided: later, see research.md).
