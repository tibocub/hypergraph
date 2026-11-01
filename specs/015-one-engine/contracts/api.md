# API changes: One engine for many sites (spec 015)

Changes to `docs/next/api.md`'s surface. Everything not listed keeps its meaning.

## `Hypergraph.open(dir, opts)`

```js
const hg = await Hypergraph.open(dir, {
  types,          // optional now: the app's declaration = defaults for createSpace, and the version a
                  // decider's app records in spaces it opens. Omit for an engine (HyperBrowser).
  rules,          // unchanged (app code; ids recorded in the space by setRules)
  maxOpen,        // spaces open at once (default 64; 16 on a phone is the app's call)
  maxAnnounced,   // topics announced at once (default 32; 8 on a phone)
  memory,         // bytes for open spaces (default: none, only maxOpen)
  idleMs,         // an unused, unseeded space closes after this (default 120000)
  ...today        // password, joinCode, mnemonic, deviceName, bootstrap, budget: unchanged
})
```

A single-app engine holding fewer spaces than `maxOpen` behaves exactly as today.

## Types

- `hg.createSpace({ name, policy, private, types })` — `types` defaults to the engine's `types`;
  recorded in the space (`types/set`). An engine with neither: `TypeError` ("a space needs types").
- `space.types()` — the space's types (`hg.types()` form). New.
- `hg.types()` — the app's declaration (unchanged meaning).
- `INCOMPATIBLE_TYPES` — now raised by the space: at a decider's open of a space whose types the app's
  declaration would break, and at a write of a type or field the space lacks ("this space doesn't have
  …"). Before: at `Hypergraph.open` for the whole folder.

## Lazy spaces

- `hg.space(key)` — unchanged signature (sync, `NOT_FOUND` if not held); returns the space open or
  closed. Async methods open it. New: `await space.ready()` before sync getters that need the decision
  state (`state`, `peers()`, `helpers`, roles); `space.opened` (bool).
- `space.hold()` → `release()`: keep it open (e.g. a page showing it). Live views and `on('change')`
  listeners hold it already.
- `hg.pin(key)`, `hg.unpin(key)`, `hg.pinned()` — the seeded set the app chooses (bookmarks). Shared with
  this identity's devices.
- `hg.spaces()` — unchanged, plus `{ opened, pinned, own }` per entry.

## Scoped handle (the web-view boundary)

```js
const site = await hg.scope(siteKey)      // held or not: opened by key; or hg.scope(invite)
await site.put('post', { … })             // every Space method of that space and its sub-spaces
site.query('post').live(render)
site.on('change', …)                      // only this scope's events
site.identity                             // { publicKey }
await site.close()                        // releases the space (idle close may follow)
```

Anything else (phrase, devices, personal space, other spaces, `spaces()`, budgets, swarm) is not on the
object; a sub-space key of another top space → `NOT_ALLOWED`.

## Phone

- `await hg.suspend()` — topics paused, connections suspended, idle spaces closed; calls on closed spaces
  fail with `SUSPENDED`.
- `await hg.resume()` — the space in use first, then the seeded set through the topic queue.

## Errors

New codes: `SUSPENDED`. `NOT_ALLOWED` reused for scope violations.
