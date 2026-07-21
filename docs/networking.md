# Networking

Hypergraph provides a local API and does not handle networking directly. Replication is the responsibility of the application, typically using Hyperswarm.

## Recommended: HypergraphNetwork

`HypergraphNetwork` (a separate class from `Hypergraph` itself, in `src/networking.js`)
handles swarm setup, bootstrap exchange, and the writer-request/grant handshake. This is what
every example app (`forum-web`, `chat-web`, `p2p-reddit-clone`) actually uses.

**Owner side** — generate a bootstrap descriptor to share with others:

```js
const bootstrap = HypergraphNetwork.generateBootstrap(graph, {
  topic: crypto.randomBytes(32),
  contexts: { comments: commentsContextKey, moderation: moderationContextKey },
  metadata: { /* app-specific, e.g. moderation policy config */ }
})

const networking = new HypergraphNetwork(graph, store, swarm, {
  topic: bootstrap.topic,
  contexts: bootstrap.contexts,
  role: 'owner'
})
await networking.connect()
```

**Joining peer side** — consume that bootstrap descriptor:

```js
const networking = await HypergraphNetwork.connectFromBootstrap(graph, store, swarm, bootstrap, { role: 'peer' })
// this also opens the owner's user core automatically, via bootstrap.ownerCore
await networking.connect()
```

There is no `graph.join(bootstrap)` method on `Hypergraph` itself — joining an existing graph
always goes through `HypergraphNetwork` as above, not through `Hypergraph` directly.

### Peer Discovery Events

`HypergraphNetwork` (not `Hypergraph`) emits peer lifecycle events:

```js
networking.on('peer-join', (info) => { /* ... */ })
networking.on('writer-granted', (msg) => { /* ... */ })
networking.on('writer-error', (msg) => { /* ... */ })
```

`Hypergraph.on()` only ever emits `'change'` — it throws for any other event name. If you
want peer-join/leave notifications, subscribe on your `HypergraphNetwork` instance, not on
`graph` itself.

## Manual Replication

Still valid for apps that want lower-level control (this is what `forum`/`forum-web`'s
hand-rolled networking does instead of `HypergraphNetwork`):

```js
const Hyperswarm = require('hyperswarm')

const store = new Corestore('./data')
const graph = new Hypergraph(store)
await graph.ready()

const swarm = new Hyperswarm()

swarm.on('connection', (conn, info) => {
  // Replicate all cores in the store
  store.replicate(conn)
})

swarm.join(graph.discoveryKey, { server: true, client: true })
await swarm.flush()
```

## DHT Announcement Timing

**Critical**: Peers must announce on the DHT BEFORE creating data. If a peer creates data before announcing, other peers will not be able to discover and replicate that data.

Always wait for `d.flushed()` after `swarm.join()` before writing data:

```js
const d = swarm.join(topic, { server: true, client: true })
await d.flushed()  // Critical: wait for DHT announcement
// Now safe to create data
await graph.put({ type: 'message' })
```

## Bootstrap Export (for your own custom joining flow)

If you're not using `HypergraphNetwork.generateBootstrap()`/`.connectFromBootstrap()` and want
to build a custom flow instead, `graph.export()` gives you the graph's own state to work from:

```js
const bootstrap = await graph.export()
// Returns: { version, userCoreKey, contexts: [{key, writeMode}], timestamp, networking? }
```

There is no corresponding `graph.import()`/`graph.join()` — consuming this shape into a new
`Hypergraph` instance (opening the right user core and contexts) is left to the application,
or to `HypergraphNetwork.connectFromBootstrap()`'s own (differently-shaped) bootstrap
descriptor above.

## Selective Replication

You can replicate specific cores by joining their discovery keys:

```js
// Replicate only a specific context
const ctx = await graph.openContext(ctxKey)
swarm.join(ctx.discoveryKey, { server: true, client: true })
```

## Writer Authorization

When a peer connects to a context:

1. Application calls `graph.handlePeerConnection(peerKey, contextKey)`
2. Hypergraph forwards to ContextBase.handlePeerConnection()
3. In open mode: ContextBase automatically adds peer as writer
4. In closed mode: ContextBase emits 'writer-request' event for approval

`HypergraphNetwork` handles this handshake automatically when used; the above is the
lower-level mechanism underneath it, relevant if you're replicating manually instead.

## See Also

- [Glossary](glossary.md) - P2P networking terminology
- [Contexts and Roles](contexts-and-roles.md) - Context write modes and authorization
- [Read Permission](read-permission.md) - Key distribution for read-access scopes (a related but separate exchange from writer authorization)
