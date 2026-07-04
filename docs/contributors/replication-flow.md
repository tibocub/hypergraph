# Replication Flow

Hypergraph does not handle networking directly. Replication is the responsibility of the application.

## Manual Replication Pattern

```js
const swarm = new Hyperswarm()

swarm.on('connection', (conn, info) => {
  store.replicate(conn)  // Replicate all cores in the store
})

swarm.join(graph.discoveryKey, { server: true, client: true })
await swarm.flush()
```

## Writer Authorization Flow

When a peer connects:

1. Application calls `graph.handlePeerConnection(peerKey, contextKey)`
2. Hypergraph forwards to ContextBase.handlePeerConnection()
3. In open mode: ContextBase automatically adds peer as writer
4. In closed mode: ContextBase emits 'writer-request' event for approval

## DHT Announcement Timing

**Critical**: Peers must announce on DHT BEFORE creating data:

```js
const d = swarm.join(topic, { server: true, client: true })
await d.flushed()  // Wait for DHT announcement
// Now safe to create data
await graph.put({ type: 'message' })
```

If data is created before announcement, other peers won't discover it.

## See Also

- [Critical Implementation Details](critical-implementation-details.md) - Gotchas and edge cases
