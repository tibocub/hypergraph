# Autobase Integration

ContextBase and RoleBase use Autobase for multi-writer CRDT operations.

## Autobase View Opening

When Autobase opens a writer's view, it calls the `open` callback:

```js
async #openView (store, key) {
  const core = store.get({ key })
  await core.ready()
  const bee = new Hyperbee(core, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
    extension: false
  })
  await bee.ready()
  return bee
}
```

## Autobase View Application

When Autobase applies a writer's output, it calls the `apply` callback:

```js
async #applyView (batch, viewBee) {
  for (const node of batch) {
    const event = decodeEvent(node.value)
    // Process event and update indexes
  }
}
```

## Autobase Checkpoints

ContextBase uses Autobase checkpoints to track progress:

```js
const checkpoint = this.#base.linearizer.indexers.get(localWriter).clock
this.#contextCheckpoints.set(contextKeyHex, checkpoint)
```

## See Also

- [Corestore Namespaces](corestore-namespaces.md) - How ContextBase isolates cores
