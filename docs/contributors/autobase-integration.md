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
async #applyView (batch, view, host) {
  for (const { value: event } of batch) {
    if (event.type === 'roles/addWriter') {
      const key = Buffer.isBuffer(event.key) ? event.key : Buffer.from(event.key, 'hex')
      await host.addWriter(key, { indexer: true })
      continue
    }
    // ...dispatch on event.type, apply to the view
  }
}
```

## Tracking Progress

GraphView tracks how much of each context's Autobase view it has already indexed with a
simple length counter (`context.view.length`), stored per context in
`#contextCheckpoints` — not a linearizer/indexer clock. On each `update()`, it compares the
current view length against the last-seen length and only processes the new range.

## See Also

- [Corestore Namespaces](corestore-namespaces.md) - How ContextBase (and any Autobase-backed
  structure) isolates cores
