# Querying

Hypergraph provides a fluent query interface for efficient graph queries backed by materialized indexes.

## Query API

### Fluent Query Interface

```js
// Query by type
const results = await graph.query()
  .type('post')
  .toArray()

// Query with filters
const results = await graph.query()
  .type('post')
  .author(author)
  .toArray()
```

### Edge Traversal

```js
// Traverse relations
for await (const edge of graph.edges('post/1', { direction: 'in', type: 'reply' })) {
  console.log(edge.from) // comment/1
}
```

### Tag Queries

```js
// Query by tag (with trust filtering)
for await (const node of graph.getByTag('important', { authors: [author] })) {
  console.log(node.id)
}
```

### Type Queries

```js
// Get entities by type
for await (const node of graph.getByType('post')) {
  console.log(node.id)
}
```

### Author Queries

```js
// Get entities by author
for await (const node of graph.getByAuthor(author)) {
  console.log(node.id)
}
```

## Indexes

Hypergraph maintains materialized indexes for efficient queries:

### Node Indexes
- `n:<entityId>` - Node records
- `nt:<type>:<createdAt>:<entityId>` - Type index (time-sorted)

### Edge Indexes
- `e:<from>:<type>:<createdAt>:<to>` - Edge records
- `i:in:<to>:<type>:<createdAt>:<from>` - Incoming edge index
- `er:<from>:<type>:<to>` - Edge references
- `cnt:in:<to>:<type>` - Edge counts (incoming)
- `cnt:out:<from>:<type>` - Edge counts (outgoing)

### Tag Indexes
- `t:<tag>:<createdAt>:<entityId>:<author>` - Tags (time-sorted)
- `tref:<tag>:<entityId>:<author>` - Tag references

## Performance Considerations

Since Hypergraph is built on append-only logs, it cannot match the O(1) performance of native graph databases for complex queries (e.g., shortest path algorithms).

**Query complexity is O(n)** for multi-hop traversals.

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
