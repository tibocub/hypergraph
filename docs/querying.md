# Querying

Hypergraph provides a fluent query interface for efficient graph queries backed by materialized indexes.

## Query API

### Fluent Query Interface

```js
// Query by type — chronological order, using the time-sorted nt: index
const results = await graph.query()
  .type('post')
  .toArray()

// Query with filters
const results = await graph.query()
  .type('post')
  .author(author)
  .toArray()
```

Default order (with no `.type()` filter) is also chronological, via a separate,
type-agnostic index (`nc:`) — not the raw, unordered entity-id keyspace. Both are real,
efficient indexed scans, not a full table scan followed by an in-memory sort.

### Sorting by Anything Else

```js
// Sort by a derived value that isn't stored on the entity at all — e.g. a vote
// count computed from edges. Attach it via .filter() as an enrichment step first.
const results = await graph.query()
  .type('post')
  .filter(async (node) => {
    let count = 0
    for await (const _e of graph.edges(node.id, { direction: 'in', type: 'vote' })) count++
    node.voteCount = count
    return true // never actually excludes anything — this is enrichment, not filtering
  })
  .sortBy('voteCount', 'desc')
  .limit(20)
  .toArray()
```

Unlike the chronological default (a lazy, streaming, indexed scan), `sortBy()` buffers all
matching results in memory before sorting — there's no way to index a value that isn't
stored on the entity itself. `limit()` is applied *after* sorting when `sortBy()` is used, not
during the initial scan — otherwise the "top N" could be wrong.

### Edge Traversal

```js
// Traverse relations
for await (const edge of graph.edges('post/1', { direction: 'in', type: 'reply' })) {
  console.log(edge.from) // comment/1
}
```

Relations can carry an optional numeric `value` (e.g. a vote's +1/-1), included when present
on the edge object returned here.

### Tag Queries

```js
// Query by tag (with trust filtering)
for await (const node of graph.getByTag('important', { authors: [author] })) {
  console.log(node.id)
}
```

Note: tag lookups currently do a full scan with a per-node check — there's no dedicated tag
index yet (unlike type/author, below). Worth revisiting if tag-heavy queries become a real
bottleneck.

### Type Queries

```js
// Get entities by type, chronologically — an efficient, indexed scan (nt:), the same
// index query().type() uses internally
for await (const node of graph.getByType('post')) {
  console.log(node.id)
}
```

### Author Queries

```js
// Get entities by a specific author
for await (const node of graph.getByAuthor(authorPubkeyHex)) {
  console.log(node.id)
}
```

This scans that author's own UserCore directly rather than any shared index — a UserCore
already only contains that person's own entities, so no separate author index is needed at
all. Returns nothing if that author's core hasn't been opened/replicated locally yet (see
`openUserCore()`).

## Indexes

Hypergraph maintains materialized indexes for efficient queries:

### Node Indexes
- `n:<entityId>` - Node records. NOT chronologically ordered across multiple authors —
  keyed by `<type>/<authorCoreKeyHex>/<seq>`, and a core key's hex ordering has nothing to do
  with when its owner actually wrote something
- `nt:<type>:<createdAt>:<entityId>` - Type index (time-sorted) — what `query().type()` and
  `getByType()` actually use
- `nc:<createdAt>:<entityId>` - Type-agnostic time index — what `query()`'s default,
  unfiltered order actually uses

### Edge Indexes
- `e:<from>:<type>:<createdAt>:<to>` - Edge records (includes an optional `value` field)
- `i:in:<to>:<type>:<createdAt>:<from>` - Incoming edge index
- `er:<from>:<type>:<to>` - Edge references
- `cnt:in:<to>:<type>` - Edge counts (incoming)
- `cnt:out:<from>:<type>` - Edge counts (outgoing)

### Tag Indexes
- `t:<tag>:<createdAt>:<entityId>:<author>` - Tags (time-sorted)
- `tref:<tag>:<entityId>:<author>` - Tag references

## Performance Considerations

Since Hypergraph is built on append-only logs, it cannot match the O(1) performance of native graph databases for complex queries (e.g., shortest path algorithms).

**Query complexity is O(n)** for multi-hop traversals, and for `sortBy()` (which must buffer
and sort every matching result — see above).

However, this is acceptable for P2P social apps because:
- Hypercore (built on RocksDB) is very fast for sequential reads
- Multiple indexes optimize common queries
- Most queries are 1-hop fan-outs (e.g., "get all posts from this user", "get all replies to this post")

## View Updates

Queries run against the GraphView (materialized view), not raw logs. The application must call `graph.update()` after replication to process new events:

```js
// After replication
await graph.update()

// Now queries will reflect new data
const results = await graph.query().type('post').toArray()
```

## See Also

- [Storage Model](storage-model.md) - How indexes are stored
- [Glossary](glossary.md) - Materialized view terminology
