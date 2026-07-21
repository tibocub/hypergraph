# Replication Flow

Hypergraph does not handle networking directly. Replication is the responsibility of the
application. There are two ways to do this — see [Networking](../networking.md) for the
full, user-facing picture; this doc covers the lower-level, manual pattern a contributor is
more likely to need to reason about directly.

## Recommended: HypergraphNetwork

For most apps, `HypergraphNetwork` (a separate class, not a method on `Hypergraph` itself)
handles swarm setup, writer-request/grant handshaking, and bootstrap exchange —
`HypergraphNetwork.generateBootstrap()` on the owner's side, `.connectFromBootstrap()` on a
joining peer's side. This is what every example app (`forum-web`, `chat-web`,
`p2p-reddit-clone`) actually uses. See [Networking](../networking.md) for the full example.

## Manual Replication Pattern

Still valid, lower-level, and what the `forum`/`forum-web` examples' hand-rolled networking
uses directly instead of `HypergraphNetwork`:

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

Writers can later be removed the same way they're added — `ContextBase.removeWriter(key)`,
signed and permission-checked in closed mode, same as `addWriter()`.

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

- [Networking](../networking.md) - The full, user-facing networking picture, including HypergraphNetwork
- [Critical Implementation Details](critical-implementation-details.md) - Gotchas and edge cases
