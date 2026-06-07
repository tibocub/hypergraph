# Hypergraph

A minimal graph database optimized for P2P social apps.
Built with a focus on ease of use and compatibility with hyperswarm and the holepunch ecosystem in general.

Curently provides:
- The basic graph store operations (nodes, relations, tags, queries, CRUD operations)
- A Cryptographic User ID system (ID keypairs, prove data ownership, encrypt private data, etc)
- Roles and Moderation (role-based permissions)


1. [Limitations](##limitations)
2. [Design](##design)
3. [Features](##features)
4. [Indexes (materialized view)](##indexes-\(materialized-view\))
5. [Quickstart](##quickstart)


## Limitations

Since it's built on hypercores (append-only logs), it's not possible to make operations as efficient as in native graph databases.
The point of hypergraph isn't to offer the O(1) performance of native graph databases for fast resolution of complex queries
(i.e. resolve shortest path between two node separated by many hops), but simply to provide devs with the intuitivity of the
mental model of a graph to build P2P social apps on top of the Holepunch ecosystem.

**This means hypergraph queries complexity is O(n) and will be slow to resolve a lot of hops between two nodes.**

Hopefully, in the context of a P2P social app, this shouldn't be a problem because:
- Hypercore (built on RocksDB) is very fast for sequential reads
- We keep multiple indexes (hypercores) to optimize common queries
- most queries are expected to be 1 edge deep fan-out reads (e.g. "get all posts from this user",
  "get all posts with this tag", "get all answers to this post", etc.)


## Design

Under the hood, hypergraph create multiple indexes to optimize some common queries

Hypergraph is a thin composition over:
- [Hypercore](https://github.com/holepunchto/hypercore) (append-only logs)
- [Corestore](https://github.com/holepunchto/corestore) (core management)
- [Autobase](https://github.com/holepunchto/autobase) (multi-writer logs for collaborative contexts)
- [Hyperbee](https://github.com/holepunchto/hyperbee) (materialized view + indexes)

The database provides a local API. Hypergraph is not responsible for networking, it should be handled by the app (e.g. using [Hyperswarm](https://github.com/holepunchto/hyperswarm))


## Features

- Entities
  - Create: `graph.put({ id, type, author })`
  - Soft delete (tombstone): `graph.del(id, { author })`
  - Read: `graph.get(id)`
  
- Content
  - Append-only versions: `graph.putContent(entityId, body, contentType)`
  - Read latest: `graph.getContent(entityId)`

- Relations (in contexts)
  - Create: `graph.relate({ from, to, type, author, context })`
  - Delete: `graph.unrelate({ from, to, type, author, context })`
  - Traverse: `graph.edges(entityId, { direction: 'out' | 'in', type })`

- Tags (in contexts)
  - Add: `graph.tag(entityId, tag, { author, context })`
  - Remove: `graph.untag(entityId, tag, { author, context })`
  - Query: `graph.getByTag(tag, opts)`
    - Trust filtering:
      - `graph.getByTag(tag, { author })`
      - `graph.getByTag(tag, { authors: [...] })`

- Moderation (in contexts)
  - Publish (facts only): `graph.moderateAction({ context, action, target, reason?, keyPair })`
  - Query (facts only): `graph.queryContext({ type: 'moderation', context, target, authors?, since? })`

- Queries
  - `graph.query().type(type).toArray()`


## Indexes (materialized view)

```js

//Node record:
n:<entityId>                                           → { id, type, author, deleted, createdAt }

//Type index (time sortable):
nt:<type>:<createdAt>:<entityId>                       → { id }

//Content versions:
c:<entityId>:<seq>                                     → { contentType, body }

//Outgoing edges:
e:<from>:<type>:<createdAt>:<to>                       → { from, to, type, author, createdAt, deleted }

//Incoming edge index:
i:in:<to>:<type>:<createdAt>:<from>                    → { ref: <full e: key> }

//Edge ref (uniqueness + lookup):
er:<from>:<type>:<to>                                  → { ref: <full e: key> }

//Edge counts:
cnt:in:<to>:<type>                                     → { count }
cnt:out:<from>:<type>                                  → { count }

//Tags (time sortable):
t:<tag>:<createdAt>:<entityId>:<author>                → { createdAt }

//Tag reference (for deletions):
tref:<tag>:<entityId>:<author>                         → { ref }

//Moderation by-target:
m:t:<targetId>:<createdAt>:<coreKeyHex>:<seq>          → { eventId, action, target, author, createdAt, signature }

//Moderation by-author:
m:a:<author>:<createdAt>:<targetId>:<coreKeyHex>:<seq> → { eventId, action, target, author, createdAt, signature }
```


## Quickstart

```js
const Corestore = require('corestore')
const { Hypergraph } = require('./')
const crypto = require('hypercore-crypto')

const store = new Corestore('./data')
const graph = new Hypergraph(store)
await graph.ready()

const author = graph.key.toString('hex')

await graph.put({ id: 'post/1', type: 'post', author })
await graph.putContent('post/1', 'Hello!', 'text')

const tagsContext = await graph.createContext()
await graph.tag('post/1', 'important', { author, context: tagsContext })

for await (const node of graph.getByTag('important', { authors: [author] })) {
  console.log(node.id)
}

const moderationContext = await graph.createContext()

const moderatorKeyPair = crypto.keyPair()
await graph.moderateAction({
  context: moderationContext,
  action: 'flag',
  target: 'post/1',
  reason: 'spam',
  keyPair: moderatorKeyPair
})

for await (const ev of graph.queryContext({
  type: 'moderation',
  context: moderationContext,
  target: 'post/1',
  authors: [moderatorKeyPair.publicKey.toString('hex')]
})) {
  console.log(ev.action, ev.target, ev.author)
}

await graph.close()
await store.close()
```


## Contexts

A context is an Autobase instance used to store collaborative events (relations, tags, etc).

A context is identified by a **known Autobase key**. A human-readable name is only a local alias.

Contexts support two write modes:

- `open` (default)
  - No role/privilege checks are performed when adding writers.
  - Writers are added explicitly via `context.addWriter(coreKey)`.
- `closed`
  - Only explicitly authorized writers are added.
  - `context.addWriter(coreKey, { author })` requires an attached `RoleBase` and requires `author` to have the `context.write` privilege.

Create a closed context:

```js
const ctxKey = await graph.createContext({ writeMode: 'closed' })
const ctx = await graph.openContext(ctxKey, { writeMode: 'closed' })
```

```js
const commentsContext = await graph.createContext()
await graph.relate({ from: 'comment/1', to: 'post/1', type: 'reply', author, context: commentsContext })
```


## Replication (Hyperswarm)

The app handles replication. A typical pattern:

- Join a topic
- On `swarm.on('connection')`, call `store.replicate(conn)`

Minimal example:

```js
const Hyperswarm = require('hyperswarm')

const store = new Corestore('./data')
const graph = new Hypergraph(store)
await graph.ready()

const swarm = new Hyperswarm()

swarm.on('connection', (conn) => {
  store.replicate(conn)
})

swarm.join(graph.discoveryKey, { server: true, client: true })
await swarm.flush()
```

See:

- `test/brittle/hyperswarm.js`
- `examples/hyperswarm-integration.js`
- `examples/moderation.js`
