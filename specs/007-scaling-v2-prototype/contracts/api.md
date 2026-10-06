# Contract: v2 Prototype API (unstable)

```js
const { Community } = require('hypergraph/v2')
```

Everything here is a prototype: names and shapes may change. It does not touch the v1 API.

## Opening

```js
const community = new Community(store, {
  key,                 // community key (hex or Buffer); omit to create a new community
  identity,            // { seed?, keyPair } — the member; seed derives per-channel log keys
  replicate: 'auto',   // 'all' | 'sparse' | 'auto'
  budget: 1e9,         // bytes of content this peer agrees to keep for this community
  localPath            // directory for the local database (default: next to the store)
})
await community.ready()
community.key          // Buffer
community.replicate(stream) // wire a replication stream: control log, rosters, author logs, wakeup
await community.close()
```

## Administration (control log; signed by `identity`)

```js
await community.setRole(pubkeyHex, 'admin' | 'mod' | 'keeper' | null)
const channelId = await community.createChannel({ name, segmentMs = 3600000 })
await community.ban(pubkeyHex, { reason })
await community.unban(pubkeyHex)
await community.hide({ author, log, seq }, { reason })
await community.keep(channelId)   // as a keeper: start a roster for the channel
community.channels()              // [{ id, name, segmentMs }]
community.role(pubkeyHex)         // 'owner' | 'admin' | 'mod' | 'keeper' | null
```

Each throws if the signer's role doesn't allow it (and apply ignores it on every peer anyway).

## Messages

```js
const ref = await community.post(channelId, text, { reply: ref? })
// ref = { author, log, seq, t }

const page = await community.latest(channelId, { limit = 50 })
// [{ author, log, seq, t, text, hidden: boolean }], newest first

const older = await community.before(channelId, { t, limit = 50 })   // scrollback

const stop = community.follow(channelId, (message) => {}, { pollMs = 500 })   // live, newest only
stop()
```

`follow` re-reads the rosters as soon as one grows (an author's first post in a segment), and
also every `pollMs` (a keeper that joined later has a roster nobody watches yet).

Order: by `t`, then author key, then seq (identical on every peer). Messages from banned authors
after their ban and messages claiming a time more than 5 minutes ahead are left out; hidden messages
come back with `hidden: true` and no text.

## Introspection (for benchmarks and tests)

```js
await community.stats()
// { openLogs, rosterKeepers, heldBytes, budget, mode, controlLength }

await community.postAs(identity, channelId, text)   // post as another identity through this peer
```

`postAs` exists so one benchmark process can post as many authors (same log and roster entry as
that identity's own `post()`); prototype only.
