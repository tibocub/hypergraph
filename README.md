# Hypergraph

A minimal graph database optimized for P2P social apps on the Holepunch ecosystem.

Hypergraph provides a local graph API for building decentralized applications with:
- **Graph operations**: Entities, relations, tags, content, and queries
- **Identity system**: Mnemonic recovery, device attestation, multi-device support
- **Collaborative contexts**: Multi-writer CRDTs for relations, tags, and moderation
- **Role-based permissions**: Per-role access control and moderation

## Under the Hood

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
await graph.relate({
  from: 'comment/1',
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

```bash
npm install hypergraph
```

## API Reference

See the [JSDoc-generated API documentation](https://your-docs-site.com) for detailed method documentation.

## Examples

- [forum-web](examples/forum-web) - Complete forum application with networking
- [cli-chat-pattern](examples/cli-chat-pattern) - Simple chat example

## Contributing

See [docs/contributors/](docs/contributors/) for architecture details and contribution guidelines.

## License

MIT
