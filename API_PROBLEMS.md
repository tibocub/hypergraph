# Hypergraph API Problems and UX Issues

## Overview
After attempting to rewrite the CLI chat example to use the "latest API additions" instead of manually reimplementing the forum-web pattern, several critical API problems and UX issues were identified.

## Core Problem: No Built-in Networking Layer

### Issue
Hypergraph does not include built-in Hyperswarm integration. Developers must manually:
1. Set up Hyperswarm instances
2. Handle connection events
3. Call `store.replicate(conn)` on every connection
4. Call `graph.handlePeerConnection()` on every connection
5. Manage topic joining and discovery

### Impact
Every application needs to copy-paste the same 20-30 lines of Hyperswarm boilerplate code. This is error-prone and violates DRY principles.

### Example (from CLI chat)
```javascript
const swarm = new Hyperswarm()
swarm.on('connection', async (conn, info) => {
  store.replicate(conn)  // Required boilerplate
  await graph.handlePeerConnection(info.publicKey, context.key)  // Required boilerplate
})
const disc = swarm.join(CHAT_TOPIC, { server: true, client: true })
await disc.flushed()
```

## Problem: Bootstrap/Export API Doesn't Handle Networking

### Issue
The `graph.export()` and `Hypergraph.join(bootstrap)` APIs only handle context keys, not the actual P2P networking setup.

### What It Does
- Exports context keys and write modes
- Allows joining existing contexts by key

### What It Doesn't Do
- No automatic Hyperswarm topic discovery
- No automatic peer connection handling
- No automatic replication setup
- Developers still need to manually set up Hyperswarm and share topics

### Impact
The bootstrap API is misleading - it suggests it handles "joining a graph" but it only handles "opening contexts". The networking layer is still completely manual.

## Problem: Manual Replication Strategy Required

### Issue
Developers must manually decide when to call `graph.update()` to sync data from peers.

### Example
```javascript
// After sending a message
await graph.update()  // Manual sync required

// In polling loop
await context.update()  // Manual sync required
```

### Impact
- Developers need to understand when to sync
- Easy to miss sync points, leading to stale data
- No automatic background replication strategy

## Problem: Change Event Doesn't Replace Polling for All Use Cases

### Issue
While `graph.on('change')` provides a unified change event, it doesn't eliminate the need for polling in all scenarios.

### Why Polling is Still Needed
- The change event fires on local changes, but remote changes may not trigger it immediately
- Developers still need to call `graph.update()` to discover remote changes
- The event doesn't automatically sync data - it just notifies that something changed

### Impact
The unified change event is helpful but doesn't provide the "push-based" experience developers expect from a P2P database.

## Problem: Peer Discovery API Requires Manual Hyperswarm Integration

### Issue
The `graph.on('peer-join', callback)` API exists but requires developers to:
1. Still set up Hyperswarm manually
2. Still call `graph.handlePeerConnection()` manually
3. Still call `store.replicate(conn)` manually

### What It Does
- Emits events when peers join/leave
- Provides peer information

### What It Doesn't Do
- Doesn't automatically discover peers
- Doesn't automatically handle connections
- Doesn't automatically replicate data

### Impact
The peer discovery API is just a notification system, not an actual peer discovery mechanism.

## Problem: No High-Level Chat/Message API

### Issue
For common use cases like chat, developers must manually implement:
- Message storage pattern (using `graph.put()`, `graph.relate()`, `graph.edges()`)
- Message retrieval pattern
- Seen message tracking
- Username mapping

### What Would Help
A high-level API like:
```javascript
await graph.sendMessage(context, text)
for await (const msg of graph.messages(context)) { ... }
```

### Impact
Every chat application re-implements the same message storage pattern, leading to inconsistency and bugs.

## Problem: Context Write Mode Confusion

### Issue
The `writeMode: 'open'` vs `writeMode: 'closed'` distinction is not well-documented and leads to confusion.

### Questions
- When should I use open vs closed?
- Does open mode automatically add writers?
- Do I still need to call `addWriter()` in open mode?
- What's the security model for open mode?

### Impact
Developers struggle to understand the authorization model, leading to incorrect implementations.

## Problem: Inconsistent API Surface

### Issue
Some operations are instance methods, some are static, some require manual setup.

### Examples
- `graph.createContext()` - instance method
- `Hypergraph.join(bootstrap)` - static method
- `graph.handlePeerConnection()` - instance method but requires manual Hyperswarm setup
- `graph.export()` - instance method

### Impact
The API is not intuitive and requires deep understanding of the architecture to use correctly.

## Summary

The "latest API additions" (unified change event, peer discovery events, bootstrap/export) are helpful but don't actually solve the core problem: **Hypergraph requires developers to manually implement the entire P2P networking layer**.

What's needed:
1. Built-in Hyperswarm integration with automatic replication
2. Automatic peer discovery for contexts
3. Automatic background sync strategy
4. High-level APIs for common use cases (chat, social feed, etc.)
5. Better documentation and examples that don't require copy-pasting boilerplate

The forum-web and chat-web examples work not because the API is good, but because they copy-paste the same manual Hyperswarm setup code. This is not a sustainable pattern for application developers.
