# Contract: Bulk Writes

What this feature adds to `require('hypergraph')`. The verbs, argument shapes and validation of
each operation are exactly those of the single-item method of the same name (Principle IV). Only
the timing differs: nothing is written until `flush()`.

---

## `const batch = graph.batch()`

Start collecting writes. Synchronous; reserves nothing. Any number of batches may exist; their
flushes are serialized.

## `batch.put(entity) → EntityRef`

Same input as `graph.put(entity)` (`{ type }`, no `id`). Returns an `EntityRef`:

```js
const ref = batch.put({ type: 'file' })
ref.id        // throws before flush ("EntityRef not flushed yet"); the id string after
```

An `EntityRef` is accepted, within the **same** batch, anywhere an entity id is accepted:
`putContent`, `putContentRef`, `relate`'s `from` / `to`. Passing a ref from another batch throws.

## `batch.putContent(entityIdOrRef, content, contentType?, opts?)`
## `batch.putContentRef(entityIdOrRef, reference, opts?)`

As `graph.putContent` / `graph.putContentRef`, including `opts.scope` encryption. The entity must
exist already or be created earlier in this batch. A malformed reference throws **here**, at the
call, as `putContentRef` does.

## `batch.relate({ from, to, type, context, value?, data? })`

As `graph.relate`. `from` / `to` may be ids or refs from this batch.

## `await batch.flush() → { entities, written }`

Validates everything, then writes:

- every user-core event in **one** append to the author's log;
- for each context touched, every event for it in **one** context append, which every peer
  replays as one step.

Then updates the local index once.

**Returns**

```js
{
  entities: [ { id, type, author }, … ],   // in batch.put() order; refs now resolve
  written: { userCore: true, contexts: ['<ctxHex>', …] }
}
```

**Throws, before writing anything** (`Error`), if any operation is invalid: unknown entity,
`EntityRef` from another batch, missing `context`, malformed reference, unknown scope / missing
scope key, read-only user core, or a batch already flushed.

**Throws `BulkWriteError` after a partial write**: the user-core append succeeded but a context
append failed. `err.written` has the same shape as the return value's `written`, and
`err.entities` lists the entities that now exist, so the caller can retry only the relations
instead of creating duplicate entities.

**Equivalence guarantee**: every event written by `flush()` is byte-identical in format to the
same event written by the single-item method (same signatures, same verification at apply). A
replaying peer can only tell the difference by how events are grouped.

**Single-item methods are unchanged**: `put`, `putContent`, `putContentRef`, `relate` keep their
signatures, return values, and "resolved means written and indexed" behavior.

---

## Example: importing a folder

```js
const batch = graph.batch()
const dir = batch.put({ type: 'dir' })

for (const f of files) {
  const file = batch.put({ type: 'file' })
  batch.putContentRef(file, {
    src: [`swarmwire://${f.root}`],
    size: f.size,
    type: f.mime,
    mutable: false,
    digest: `blake3:${f.root}`
  })
  batch.relate({ from: file, to: dir, type: 'in', context: ctx })
}

const { entities } = await batch.flush()   // 2 log writes, however many files
```

## Not in this contract

- `del`, `unrelate`, `tag`, `untag` in a batch: not needed for the import case that motivates
  this feature; they can be added later with the same rules.
- Transactions across peers, or atomicity between the user core and contexts. They are separate
  logs; `BulkWriteError` is the honest answer to a failure between them.
