# Networking

Hypergraph provides a local API and does not handle networking directly. Replication is the responsibility of the application, typically using Hyperswarm.

## Manual Replication

The simplest approach is to replicate the entire Corestore:

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

## Bootstrap/Export API

For joining existing graphs, use the bootstrap/export API:

```js
// Export graph state from an existing peer
const bootstrap = await graph.export()
// Returns: { version, userCoreKey, contexts: [{key, writeMode}], timestamp, networking? }

// Join a graph using bootstrap data
const graph = new Hypergraph(store)
await graph.join(bootstrap)
```

## Event-Based Peer Discovery

Hypergraph emits events for peer join/leave:

```js
graph.on('change', (event) => {
  if (event.type === 'peer-join') {
    console.log('Peer joined:', event.userCoreKey)
  } else if (event.type === 'peer-leave') {
    console.log('Peer left:', event.userCoreKey)
  }
})
```

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

## See Also

- [Glossary](glossary.md) - P2P networking terminology
- [Contexts and Roles](contexts-and-roles.md) - Context write modes and authorization
