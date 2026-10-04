# Autobase Integration

ContextBase, RoleBase, and ScopeBase all use Autobase for multi-writer CRDT operations, with
the same basic shape.

## Autobase View Opening

Autobase calls the `open` callback once, to get the Hyperbee that will become this
structure's materialized view. All three structures use the same pattern — a fixed core name,
not a key parameter:

```js
#openView (store) {
  const viewCore = store.get({ name: 'view' })
  this.#viewBee = new Hyperbee(viewCore, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  return this.#viewBee
}
```

Because the core name is fixed (`'view'`) rather than derived from anything unique to the
instance, **the Corestore session passed in here must already be namespaced** — otherwise two
different Autobase-backed structures sharing one Corestore collide on this same core name.
See [Corestore Namespaces](corestore-namespaces.md) for a real bug this caused.

## Autobase View Application

Autobase calls the `apply` callback with each new batch of events. The real signature takes
three arguments, not two — `host` is what lets the apply function call `host.addWriter()`/
`host.removeWriter()`, which can only happen from inside `apply`:

```js
async #applyView (batch, rawView, host) {
  let view = rawView.batch()              // index writes are batched (below)
  for (const { value } of batch) {
    const event = decodeEvent(value)      // values arrive as bytes (below)
    if (!event || event.decodeError) continue
    if (event.type === 'roles/addWriter') {
      const key = Buffer.isBuffer(event.key) ? event.key : Buffer.from(event.key, 'hex')
      await host.addWriter(key, { indexer: true })
      continue
    }
    // ...dispatch on event.type, apply to the view
  }
  await view.flush()
}
```

### Values are bytes; ContextBase encodes and decodes them

ContextBase gives Autobase **no `valueEncoding`**: `append()` passes `encodeEvent(event)` and
`#applyView` runs `decodeEvent()` itself. Autobase stores node values verbatim either way, so the
bytes in the oplog are identical to letting Autobase run the codec — pinned by a test in
`test/brittle/core/event-encoding.js`. The reason: Autobase's `append(array)` encodes the whole
array as one value whenever a non-binary encoding is set, which made batched appends impossible
(`specs/002-scale-indexing/research.md` R3). RoleBase and ScopeBase still use Autobase encodings.

### Batch boundaries are decided by the writer, and every peer pays for them

Autobase calls `apply` once per **writer batch** — the events one `append()` call wrote — and
flushes its system state after each one. Every peer replays every batch this way, forever. So
1,000 relations appended one at a time cost every member 1,000 apply calls, while
`ContextBase.appendBatch(events)` (used by `graph.batch()`) writes them as one batch that costs
one. `appendBatch` leaves off the `optimistic` flag `append()` uses in open mode: with an array,
Autobase splits the batch around the optimistic block and hands apply nodes with no value
(research R3). A peer that isn't a writer yet falls back to one `append()` per event.

### Index writes inside apply are batched

`#applyView` writes index entries through a Hyperbee batch flushed every `tuning.INDEX_BATCH`
(`src/tuning.js`, default 1,000) events and at the end of the call — one view append per chunk
instead of one per entry. Chunked, not one batch per call, so a hostile writer's enormous batch
cannot make the applying peer hold it all in memory. Autobase still owns atomicity across reorgs.
Edge counters (`cnt:in` / `cnt:out`) are accumulated in memory for the chunk and written once
each at the chunk's flush, so 1,000 relations into one folder write that folder's count once.

### What a joining peer pays for every view block

A peer catching up a context builds the view in a batch session, and Autobase commits it into
the real view core only once it holds the indexers' signature for that length — in practice
once, at the end of the catch-up. Hypercore's commit (`session-state.js` `_overwrite`) reads
every committed block plus two tree nodes each, all in parallel: ~5 million blocks for a
1M-relation context, which exhausts an 8 GB heap. Every index write apply makes is a block in
that commit, so keep them few (`specs/002-scale-indexing/research.md` R11).

### Multi-writer contexts and `ackInterval: 0`

Every writer is added as an indexer, and acks are off. With more than one indexer, nodes are
only confirmed once a majority build on them, which idle writers never do without acks: measured,
a 3-writer context confirmed none of its 24,013 view blocks (research R12). Single-writer
contexts are unaffected. Changing this is part of the fast-forward design, not a setting to flip.

## Tracking Progress

GraphView tracks how much of each context's Autobase view it has already indexed with a
simple length counter (`context.view.length`), stored per context in
`#contextCheckpoints` — not a linearizer/indexer clock. On each `update()`, it compares the
current view length against the last-seen length and only processes the new range.

## See Also

- [Corestore Namespaces](corestore-namespaces.md) - How ContextBase (and any Autobase-backed
  structure) isolates cores
