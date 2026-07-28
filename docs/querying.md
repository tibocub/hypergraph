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

If this graph instance has more than one context open, `.tag()` and `.out()`/`.in()`
traversal need to know which one to use — see "Context Scoping" below:

```js
const results = await graph.query()
  .type('post')
  .context(commentsCtx)
  .tag('pinned')
  .toArray()
```

`.context()` accepts a single context key or an array of them, same as the raw
`edges()`/`getByTag()` methods it delegates to. Not needed at all if only one context is
open, or if the query doesn't use `.tag()`/`.out()`/`.in()`.

### Live Queries

```js
const unsubscribe = graph.query()
  .type('post')
  .live((results) => {
    render(results)
  })

// later, when no longer needed:
unsubscribe()
```

`live()` runs the query immediately (the initial snapshot), then re-runs it and calls the
callback again whenever the graph has new data — whether from a local write (`put()`,
`relate()`, etc.) or data that arrived via replication (confirmed directly: a peer with a
live query open, making no local writes of its own, sees its callback re-fire purely from
another peer's data arriving over the wire, the next time `graph.update()` is called).

Re-runs are debounced (default 50ms, configurable via `{ debounceMs }`) — several changes in
quick succession (e.g. `put()` + `putContent()` + `tag()` for one logical action) coalesce
into a single re-run rather than firing once per individual change. Each re-run re-executes
the whole query from scratch rather than incrementally diffing results — the simpler,
correct-first approach; revisit only if this becomes a measured bottleneck.

The returned unsubscribe function stops listening and cancels any pending debounced re-run.
A callback that throws doesn't break the subscription — later changes still trigger further
callbacks.

`live()` requires a query created via `graph.query()` (not `queryContext()`), since it needs
a reference to the graph to subscribe to its change events.

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

### Context Scoping

Tags and relations are stored per-context (entities themselves are not — `get()`/
`getContent()`/`getByType()`/`getByAuthor()` are global). `edges()`, `getByTag()`, `hasTag()`,
and `countEdgesIn()`/`countEdgesOut()` all read from context-scoped indexes, so how they
behave depends on how many contexts this graph instance currently has open:

- **Exactly one context open**: used implicitly. No need to pass `context` — this is the
  common case and stays exactly as simple as the examples above.
- **Zero contexts open**: yields nothing (not an error).
- **More than one context open**: you must say which one(s) you mean, or it throws:

```js
// Graph has both `commentsCtx` and `moderationCtx` open — this throws:
for await (const e of graph.edges(post.id, { direction: 'in', type: 'reply' })) { /* ... */ }

// Scope it explicitly instead:
for await (const e of graph.edges(post.id, { direction: 'in', type: 'reply', context: commentsCtx })) { /* ... */ }

// context can also be an array, to search a known subset of open contexts:
for await (const n of graph.getByTag('pinned', { context: [commentsCtx, announcementsCtx] })) { /* ... */ }

// Or opt in to searching every open context at once — an explicit choice,
// not a silent default:
for await (const n of graph.getByTag('pinned', { allContexts: true })) { /* ... */ }
```

This is deliberate: a client that belongs to more than one community/authority at once (one
context per community being a common pattern) would otherwise have queries meant for one
context silently blend in data from a completely unrelated one it never asked about. Passing
`{ context }` on `.tag()` and `.out()`/`.in()` through the fluent query builder works the same
way — see `.context()` below.

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
