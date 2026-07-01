# Hypergraph

A minimal graph database optimized for P2P social apps on the Holepunch ecosystem.

Hypergraph provides a local graph API for building decentralized applications with:
- **Graph operations**: Entities, relations, tags, content, and queries
- **Identity system**: Mnemonic recovery, device attestation, multi-device support
- **Collaborative contexts**: Multi-writer CRDTs for relations, tags, and moderation
- **Role-based permissions**: RoleBase for access control and moderation

## Table of Contents

1. [Architecture](#architecture)
2. [Design Philosophy](#design-philosophy)
3. [Core Concepts](#core-concepts)
4. [Storage Model](#storage-model)
5. [Identity System](#identity-system)
6. [Contexts](#contexts)
7. [Role System](#role-system)
8. [API Reference](#api-reference)
9. [Quickstart](#quickstart)
10. [Networking](#networking)
11. [Indexes](#indexes)

**For Contributors**: See [docs/architecture.md](docs/architecture.md) for low-level implementation details and [CHANGELOG.md](CHANGELOG.md) for version history.

## Architecture

Hypergraph is a thin composition over lower-level Holepunch libraries:

```
+------------------+
|    Hypergraph    |   Main API
+------------------+
        |
        +-- UserCore          per-user Hypercores (entities, content)
        |
        +-- ContextBase       Autobase (relations, tags, moderation)
        |
        +-- GraphView         Hyperbee indexes (materialized view)
        |
        +-- RoleBase          Autobase (role registry, permissions)
        |
        +-- IdentityManager   keet-identity-key (identity, devices)
```

**Dependencies:**
- **Hypercore**: Append-only logs for data storage
- **Corestore**: Core management and namespace isolation
- **Autobase**: Multi-writer CRDT for collaborative contexts
- **Hyperbee**: Materialized view and key-value indexes
- **keet-identity-key**: Identity management with mnemonic recovery

## Design Philosophy

Hypergraph follows the building block pattern established by Hyperbee:

1. **Separation of concerns**: Data storage is separate from networking. Hypergraph provides a local API; replication is handled by the application (typically via Hyperswarm).

2. **Single-writer ownership**: Each user writes to their own Hypercore. This ensures clear write ownership and conflict-free replication.

3. **Multi-writer collaboration**: Collaborative data (relations, tags, moderation) lives in Autobase contexts where multiple peers can contribute without conflicts.

4. **Materialized views**: Queries are never run against raw logs. Instead, a Hyperbee view maintains indexes that are incrementally updated as new events arrive.

5. **Append-only immutability**: All data is append-only. Deletes are implemented as tombstones. This provides a verifiable audit trail.

## Core Concepts

### Entities

Entities are the nodes in your graph. They represent things like posts, users, comments, etc.

- Each entity has a unique ID, type, and author
- Entities are stored in the author's personal UserCore
- Soft deletes use tombstones (the entity is marked as deleted but not removed)

### Content

Content is append-only data attached to entities (e.g., post body, file data).

- Each content append creates a new version with a sequence number
- Content is stored in the author's UserCore
- Only the latest version is typically queried

### Relations

Relations connect entities (e.g., reply-to, likes, follows).

- Relations are stored in collaborative contexts (Autobase)
- Multiple peers can create relations in the same context
- Relations can be deleted (unrelate) with precise key reconstruction

### Tags

Tags are author-scoped labels for entities (e.g., "important", "spam").

- Only the entity's author can tag it
- Tags are stored in collaborative contexts
- Tags support time-ordered queries

### Contexts

A context is a collaborative workspace for relations, tags, and moderation events.

- Each context is an isolated Autobase instance
- Contexts have two write modes: `open` (anyone can write) and `closed` (role-based)
- Contexts are identified by their Autobase key, not human-readable names

## Storage Model

### User Cores (Single-Writer)

Each user has a personal Hypercore that stores their events:

```
User A core:
  seq 0: { type: 'entity/create', id: 'post/1', author, timestamp }
  seq 1: { type: 'content/append', entityId: 'post/1', body: 'Hello', contentType: 'text' }
  seq 2: { type: 'entity/create', id: 'post/2', author, timestamp }
```

**Key properties:**
- Only the owner can write to their UserCore
- Replication is conflict-free (single writer)
- The core key identifies the user

### Context Autobases (Multi-Writer)

Relations, tags, and moderation events are stored in shared Autobases:

```
Context Autobase (key = <autobaseKeyHex>):
  Writer A seq 0: { type: 'relation/create', from: 'post/2', to: 'post/1', relationType: 'reply', ... }
  Writer B seq 0: { type: 'tag/add', entityId: 'post/1', tag: 'important', ... }
  Writer A seq 1: { type: 'relation/delete', from: 'post/2', to: 'post/1', relationType: 'reply', createdAt: <original>, ... }
```

**Key properties:**
- Each writer appends to their own underlying Hypercore
- Autobase merges all writers into a single deterministic view using a DAG
- Contexts are isolated using Corestore namespaces

### View Layer

The view is a Hyperbee instance that holds all indexes as materialized state:

```
View updates are caller-driven:
  1. Call graph.update() after replication
  2. View processes new events from user cores and contexts
  3. Indexes are incrementally updated
  4. Queries run against the view, not raw logs
```

**Key properties:**
- Never query raw logs directly
- Updates are incremental (only process new events)
- Checkpoints track the last processed sequence per core

## Identity System

Hypergraph includes a comprehensive identity system built on keet-identity-key:

### Identity vs Device Keys

- **Identity key**: Long-term cryptographic identity (same across all devices)
- **Device key**: Per-device keypair (each device has its own)
- **Attestation proof**: Cryptographic proof that a device belongs to an identity

### Multi-Device Support

Each device has its own UserCore, but all devices share the same identity:

```
Device 1: UserCore key = device1PublicKey, identity = identityPublicKey
Device 2: UserCore key = device2PublicKey, identity = identityPublicKey
```

The view maintains a device-to-identity mapping for author resolution.

### Mnemonic Recovery

Identity can be recovered from a 12-word mnemonic phrase:

```js
const graph = new Hypergraph(store, { mnemonic: 'word1 word2 ... word12' })
```

## Contexts

### Write Modes

Contexts support two write modes:

**Open Mode (default)**
- No role/privilege checks
- Writers can be added freely via `context.addWriter(coreKey)`
- Suitable for public contexts

**Closed Mode**
- Writers must be explicitly authorized
- Requires an attached RoleBase
- Author must have `context.write` privilege
- Suitable for private or moderated contexts

### Context Isolation

Contexts are isolated at two levels:

1. **Logical isolation**: Different Autobase bootstrap keys create separate contexts
2. **Physical isolation**: Corestore namespaces prevent core conflicts

### Creating Contexts

```js
// Create an open context
const ctxKey = await graph.createContext({ writeMode: 'open' })
const ctx = await graph.openContext(ctxKey, { writeMode: 'open' })

// Create a closed context (requires RoleBase)
const ctxKey = await graph.createContext({ writeMode: 'closed' })
const ctx = await graph.openContext(ctxKey, { writeMode: 'closed' })
```

## Role System

The RoleBase provides role-based access control for contexts and moderation.

### Role Registry

The role registry is stored in an Autobase and includes:

```js
{
  roles: {
    owner: ['*'],                    // All permissions
    admin: ['content.delete', 'user.ban', 'mod.add'],
    mod: ['content.delete', 'user.ban'],
    member: ['content.create', 'content.reply']
  },
  members: {
    '<pubkey>': 'owner'
  }
}
```

### Authorization Checks

Before performing privileged actions, Hypergraph checks:

```js
if (!can(registry, author, requiredPermission)) {
  throw new Error('Not authorized')
}
```

### Moderation

Moderation actions are signed by the author's keypair:

```js
await graph.moderateAction({
  context: moderationContext,
  action: 'content.flag',
  target: 'post/1',
  reason: 'spam'
})
```

Peers validate signatures against the role registry before applying actions.

### Creating vs Opening RoleBase

`createRoleBase()` creates a new RoleBase and automatically attaches it to the graph instance. Do NOT call `openRoleBase()` immediately after `createRoleBase()` - this will cause "Autobase failed to open" errors.

Use `openRoleBase(key)` only when opening an existing RoleBase from another peer after replication.

**Correct usage:**
```js
// Creating a new RoleBase
const roleKeyHex = await graph.createRoleBase()
const owner = graph.key.toString('hex')
await graph.roleBase.init(owner)
await graph.roleBase.append(...)

// Opening an existing RoleBase (from another peer)
await graph.openRoleBase(roleKeyHex)
```

## API Reference

### Entities

```js
// Create an entity (author derived from identity.deviceKeyPair)
const post = await graph.put({ type: 'post' })
// Returns: { id, type, author, createdAt }

// Soft delete an entity
await graph.del(post.id)

// Read an entity
const node = await graph.get(post.id)
```

### Content

```js
// Append content to an entity
await graph.putContent(post.id, 'Hello world', 'text')

// Read latest content
const content = await graph.getContent(post.id)
// Returns: { contentType, body }
```

### Relations

```js
// Create a relation
await graph.relate({
  from: 'comment/1',
  to: 'post/1',
  type: 'reply',
  context: commentsContext
})

// Delete a relation
await graph.unrelate({
  from: 'comment/1',
  to: 'post/1',
  type: 'reply',
  context: commentsContext
})

// Traverse relations
for await (const edge of graph.edges('post/1', { direction: 'in', type: 'reply' })) {
  console.log(edge.from) // comment/1
}
```

### Tags

```js
// Add a tag (only entity author can tag)
await graph.tag(post.id, 'important', { context: tagsContext })

// Remove a tag
await graph.untag(post.id, 'important', { context: tagsContext })

// Query by tag (with trust filtering)
for await (const node of graph.getByTag('important', { authors: [author] })) {
  console.log(node.id)
}
```

### Queries

```js
// Fluent query interface
const results = await graph.query()
  .type('post')
  .toArray()

// Query with filters
const results = await graph.query()
  .type('post')
  .author(author)
  .toArray()
```

## Quickstart

```js
const Corestore = require('corestore')
const { Hypergraph } = require('hypergraph')

const store = new Corestore('./data')
const graph = new Hypergraph(store)
await graph.ready()

// Author is automatically derived from identity.deviceKeyPair
const post = await graph.put({ type: 'post' })
await graph.putContent(post.id, 'Hello!', 'text')

// Create a context for tags
const tagsContext = await graph.createContext()
await graph.tag(post.id, 'important', { context: tagsContext })

// Query by tag
const author = graph.identity.deviceKeyPair.publicKey.toString('hex')
for await (const node of graph.getByTag('important', { authors: [author] })) {
  console.log(node.id)
}

// Create a context for moderation
const moderationContext = await graph.createContext()
// Note: moderationAction() is typically used through higher-level storage APIs
// See examples/forum/storage.js for a complete moderation implementation

await graph.close()
await store.close()
```

## Networking

Hypergraph provides a local API and does not handle networking directly. Replication is the responsibility of the application, typically using Hyperswarm.

### Manual Replication

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

### DHT Announcement Timing

For reliable peer discovery, peers must announce on the DHT BEFORE creating data. If a peer creates data before announcing, other peers will not be able to discover and replicate that data.

Always wait for `d.flushed()` after `swarm.join()` before writing data:

```js
const d = swarm.join(topic, { server: true, client: true })
await d.flushed()  // Critical: wait for DHT announcement
// Now safe to create data
await graph.put({ type: 'message' })
```

### Bootstrap/Export API

For joining existing graphs, use the bootstrap/export API:

```js
// Export graph state from an existing peer
const bootstrap = await graph.export()
// Returns: { version, userCoreKey, contexts: [{key, writeMode}], timestamp, networking? }

// Join a graph using bootstrap data
const graph = new Hypergraph(store)
await graph.join(bootstrap)
```

### Event-Based Peer Discovery

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

### Selective Replication

You can replicate specific cores by joining their discovery keys:

```js
// Replicate only a specific context
const ctx = await graph.openContext(ctxKey)
swarm.join(ctx.discoveryKey, { server: true, client: true })
```

## Indexes

The view maintains materialized indexes for efficient queries. All indexes are stored in a Hyperbee with UTF-8 keys and JSON values.

### Node Indexes

```js
// Node record:
n:<entityId> → { id, type, author, deleted, createdAt }

// Type index (time sortable):
nt:<type>:<createdAt>:<entityId> → { id }
```

### Content Indexes

```js
// Content versions:
c:<entityId>:<seq> → { contentType, body }
```

### Edge Indexes

```js
// Outgoing edges:
e:<from>:<type>:<createdAt>:<to> → { from, to, type, author, createdAt, deleted }

// Incoming edge index:
i:in:<to>:<type>:<createdAt>:<from> → { ref: <full e: key> }

// Edge ref (uniqueness + lookup):
er:<from>:<type>:<to> → { ref: <full e: key> }

// Edge counts:
cnt:in:<to>:<type> → { count }
cnt:out:<from>:<type> → { count }
```

**Index design notes:**
- `createdAt` is embedded in edge keys for efficient time-ordered range scans
- The `er:` index enforces one active edge per (from, type, to) triple
- Edge counts are incremented on create and decremented on delete (clamped at 0)
- In P2P delivery, if a delete arrives before its create, the count may read one low temporarily

### Tag Indexes

```js
// Tags (time sortable):
t:<tag>:<createdAt>:<entityId>:<author> → { createdAt }

// Tag reference (for deletions):
tref:<tag>:<entityId>:<author> → { ref }
```

**Tag design notes:**
- Tags are author-scoped (only the entity's author can tag it)
- This prevents spam and keeps tag indexes low-noise

### Moderation Indexes

```js
// Moderation by-target:
m:t:<targetId>:<createdAt>:<coreKeyHex>:<seq> → { eventId, action, target, author, createdAt, signature }

// Moderation by-author:
m:a:<author>:<createdAt>:<targetId>:<coreKeyHex>:<seq> → { eventId, action, target, author, createdAt, signature }
```

**Moderation design notes:**
- Moderation actions are signed by the author's keypair
- Peers validate signatures against the role registry before applying
- This enables verifiable offline moderation without trusting any central authority

### Timestamp Encoding

All timestamps embedded in keys are stored as 16-digit zero-padded decimal strings:

```js
String(timestamp).padStart(16, '0')
```

This ensures correct sorting across different digit lengths. Plain decimal strings do not sort correctly (e.g., "1000" < "999" alphabetically).

## Performance Considerations

Since Hypergraph is built on append-only logs, it cannot match the O(1) performance of native graph databases for complex queries (e.g., shortest path algorithms).

**Query complexity is O(n)** for multi-hop traversals.

However, this is acceptable for P2P social apps because:
- Hypercore (built on RocksDB) is very fast for sequential reads
- Multiple indexes optimize common queries
- Most queries are 1-hop fan-outs (e.g., "get all posts from this user", "get all replies to this post")

## Testing

```bash
npm test
```

Run the brittle test suite:

```bash
npm run test:brittle
```

## Platform-Specific Considerations

**Windows**: Windows has aggressive file locking that can cause EPERM errors during cleanup when RocksDB handles are still open. Use retry logic with exponential backoff when deleting test directories.
## License

MIT
