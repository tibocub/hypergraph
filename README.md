# ! Software still in ALPHA - breaking changes expected !

# Hypergraph

A minimal graph database optimized for P2P social apps on the Holepunch ecosystem.

Hypergraph provides a local graph API for building decentralized applications with:
- **Graph operations**: Entities, relations, tags, content, and queries
- **Identity system**: Mnemonic recovery, device attestation, multi-device support
- **Collaborative contexts**: Multi-writer CRDTs for relations, tags, and moderation
- **Role-based permissions**: Per-role access control and moderation

## Under the Hood

Hypergraph is a thin composition over lower-level Holepunch libraries:

**Dependencies:**
- [Hypercore](https://github.com/holepunchto/hypercore): Append-only logs for data storage
- [Corestore](https://github.com/holepunchto/corestore): Hypercore management and namespace isolation
- [Autobase](https://github.com/holepunchto/autobase): Multi-writer CRDT for collaborative contexts
- [Hyperbee](https://github.com/holepunchto/hyperbee): Materialized view and key-value indexes
- [Keet-identity-key](https://github.com/holepunchto/keet-identity-key): Multi-device user ID management with mnemonic recovery

## Quickstart

```js
const Corestore = require('corestore')
const { Hypergraph } = require('hypergraph')

const store = new Corestore('./data')
const graph = new Hypergraph(store)
await graph.ready()

// Create an entity (author derived from identity.deviceKeyPair)
const post = await graph.put({ type: 'post' })
await graph.putContent(post.id, 'Hello world', 'text')

// Create a context for relations
const commentsContext = await graph.createContext()

// `from` and `to` must be REAL entity ids returned by put() — an id like
// 'comment/1' is not well-formed, and an edge from it is silently dropped on
// read (the author can't be recovered from the id, so the edge can't be
// verified as genuine). relate() will happily append it; edges() will never
// return it.
const comment = await graph.put({ type: 'comment' })
await graph.relate({
  from: comment.id,
  to: post.id,
  type: 'reply',
  context: commentsContext
})

// Query entities
for await (const node of graph.query().type('post')) {
  console.log(node.id)
}

await graph.close()
await store.close()
```

## Key Concepts

### Entities
Nodes in your graph (posts, users, comments). Each entity has a unique ID, type, and author. Stored in the author's personal UserCore.

### Relations
Directed edges connecting entities (reply-to, likes, follows). Stored in collaborative contexts (Autobase) where multiple peers can contribute.

### Contexts
Collaborative workspaces for relations, tags, and moderation. Each context is an isolated Autobase instance with two write modes: `open` (anyone can write) and `closed` (role-based).

### Roles
Role-based access control for contexts and moderation. RoleBase stores role registry with member→role mappings and role→permission mappings.

## Learn More

- [Storage Model](docs/storage-model.md) - How data is distributed across UserCores, ContextBases, and RoleBases
- [Local Data Distribution](docs/local%20data%20distribution.md) - Detailed analysis of storage efficiency and data duplication
- [Identity System](docs/identity-system.md) - Multi-device support, mnemonic recovery, identity vs device keys
- [Contexts and Roles](docs/contexts-and-roles.md) - Collaborative contexts, write modes, role-based access control
- [Networking](docs/networking.md) - Replication patterns, Hyperswarm integration, DHT timing
- [Glossary](docs/glossary.md) - P2P/Holepunch terminology explained

## Installation

**Not published to npm yet.** Clone it next to your project and depend on it by folder path:

```json
"dependencies": {
  "hypergraph": "file:../hypergraph"
}
```

`npm install` then creates a real link to the checkout, so edits to hypergraph are live in your
project with no reinstall. This is how the sibling projects consume it — see
[ECOSYSTEM.md](ECOSYSTEM.md).

Installing straight from GitHub (`npm install github:tibocub/hypergraph`) is refused by npm 12 by
default, which blocks git dependencies unless its `allow-git` setting is changed.

## Bulk writes

Anything bigger than a handful of writes — importing a folder, say — belongs in one batch:

```js
const batch = graph.batch()
const dir = batch.put({ type: 'dir' })
for (const f of files) {
  const file = batch.put({ type: 'file' })
  batch.putContentRef(file, { src: [`swarmwire://${f.root}`], size: f.size, type: f.mime, mutable: false })
  batch.relate({ from: file, to: dir, type: 'in', context: ctx })
}
const { entities } = await batch.flush()   // two log appends, however many files
```

It is much faster for you, and for everyone else too: other peers replay a context one write
call at a time, so the same import written item by item would stay slow for every future member.
Contract: [`specs/002-scale-indexing/contracts/bulk-write.md`](specs/002-scale-indexing/contracts/bulk-write.md).

## Contexts: confirmation, fast joins and app rules

A context's creator confirms everyone's writes; newcomers far behind fast-forward to that signed
state instead of replaying history; apps can attach deterministic rules that reject events before
they are indexed:

```js
const rules = { id: 'myapp/v1', validate: (event, reader) => event.type !== 'message' || event.text.length < 1000 }
const ctx = await graph.createContext({ rules })
await graph.openContext(ctx, { rules })
await (await graph.openContext(ctx, { rules })).status() // { version: 2, rules: 'myapp/v1', confirmedLength, ... }
```

See [Contexts and Roles](docs/contexts-and-roles.md) for the trust model.

## API Reference

See the JSDoc-generated API documentation in [`docs/api/`](docs/api/) (open `index.html` in a
browser) for detailed method documentation.

## Examples

- [forum-web](examples/forum-web) - Complete forum application with networking
- [cli-chat-pattern](examples/cli-chat-pattern) - Simple chat example

## Contributing

See [docs/contributors/](docs/contributors/) for architecture details and contribution guidelines.

## License

MIT
