# ! Software still in ALPHA - breaking changes expected !

# Hypergraph

A minimal graph database optimized for P2P social apps on the Holepunch ecosystem.

Hypergraph provides a local graph API for building decentralized applications with:
- **Graph operations**: Entities, relations, tags, content, and queries
- **Identity system**: Mnemonic recovery, device attestation, multi-device support
- **Collaborative contexts**: Multi-writer CRDTs for relations, tags, and moderation — confirmed
  by the context's creator, joined by fast-forward, guarded by app rules
- **Role-based permissions**: Per-role access control and moderation
- **Built for scale**: bulk writes, batched indexing, and data on relations, so a member can
  browse a million-entry space a second after joining (see [Scale](#scale))

## Under the Hood

Hypergraph is a thin composition over lower-level Holepunch libraries:

**Dependencies:**
- [Hypercore](https://github.com/holepunchto/hypercore): Append-only logs for data storage
- [Corestore](https://github.com/holepunchto/corestore): Hypercore management and namespace isolation
- [Autobase](https://github.com/holepunchto/autobase): Multi-writer CRDT for collaborative contexts
- [Hyperbee](https://github.com/holepunchto/hyperbee): Materialized view and key-value indexes
- [index-encoder](https://github.com/holepunchto/index-encoder): Compact, sortable binary index keys
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
Directed edges connecting entities (reply-to, likes, follows). Stored in collaborative contexts (Autobase) where multiple peers can contribute. A relation can carry an optional numeric `value` and an optional signed `data` string (≤ 4 KB) returned with the edge — put what a listing needs there and nobody has to download authors' logs to browse.

### Contexts
Collaborative workspaces for relations, tags, and moderation. Each context is an isolated Autobase instance with two write modes: `open` (anyone can write) and `closed` (role-based). Each context keeps its own **role table**; the owner and trusted members (admins) **index** it, i.e. confirm everyone's writes; a member who joins far behind **fast-forwards** to that confirmed state instead of replaying history; apps can attach **rules** that reject events before they are indexed. See [Contexts and Roles](docs/contexts-and-roles.md).

### Roles
Role-based access control for contexts and moderation. RoleBase stores role registry with member→role mappings and role→permission mappings.

## Scale

Measured with [`bench/scale.js`](bench/README.md) (one Windows 10 machine, 16 GB RAM), a context
holding 1,000,000 file entries (one entity, one content reference and one relation each):

| | before (2026-10-04) | now |
|---|---|---|
| writing them (`graph.batch()`) | ~1.5 h projected | ~9 min, 3.3 GB on disk |
| a new member can list a folder | joining crashed (out of memory) | **1.2 s** after joining, with names and sizes from relation data |
| new member's disk | — | 60 MB (context only) / 1.5 GB (full replica of the author's log) |
| new member's peak memory | > 8 GB | 329 MB (context only) / 855 MB (full) |

How: bulk writes, batched indexing and compact index keys ([spec 002](specs/002-scale-indexing/)), confirmation and
fast-forward joins ([spec 003](specs/003-fast-forward-contexts/)), data on relations
([spec 004](specs/004-relation-data/)). What is left and why:
[scaling study](specs/research/scaling-study.md).

## Learn More

- [Storage Model](docs/storage-model.md) - How data is distributed across UserCores, ContextBases, and RoleBases
- [Local Data Distribution](docs/local%20data%20distribution.md) - Detailed analysis of storage efficiency and data duplication
- [Identity System](docs/identity-system.md) - Multi-device support, mnemonic recovery, identity vs device keys
- [Contexts and Roles](docs/contexts-and-roles.md) - Collaborative contexts, write modes, role-based access control
- [Networking](docs/networking.md) - Replication patterns, Hyperswarm integration, what joining downloads
- [Querying](docs/querying.md) - Query API, edges and their data, indexes
- [v2 prototype](docs/v2-prototype.md) - Unstable `hypergraph/v2`: communities whose cost follows what a member reads and holds, with measurements
- [Benchmarks](bench/README.md) - How to measure, and every result so far
- [Scaling study](specs/research/scaling-study.md) - Where the bytes and time go, what is left to do
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
  // data on the relation: a listing needs nothing else (spec 004)
  batch.relate({ from: file, to: dir, type: 'in', context: ctx, data: JSON.stringify({ name: f.name, size: f.size }) })
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
await (await graph.openContext(ctx, { rules })).status() // { version: 3, rules: 'myapp/v1', layout: 2, confirmedLength, ... }
```

Invite someone with a link that grants a role, redeemable while you're offline:

```js
const link = await context.createInvite({ role: 'admin', keyPair: graph.identity.deviceKeyPair })
// on their device, connected through graph.replicate():
await graph.redeemInvite(link)
```

Add `scope: scopeId` and the link also asks for read access to encrypted content: the role
arrives right away, the key as soon as a member who holds it is online
([Read Permission](docs/read-permission.md#invites-that-give-read-access)).

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
