# Contract: context options, status and app rules

Additions to `require('hypergraph')`. Existing calls keep working unchanged.

## `graph.createContext(opts?)`

| option | type | default | meaning |
|---|---|---|---|
| `writeMode` | `'open' \| 'closed'` | `'open'` | unchanged |
| `rules` | `{ id: string, validate: Function }` | none | app rules; `id` is recorded in the context |
| `fastForward` | boolean | `true` | `false`: this peer always replays and verifies everything itself |

Creates a **version 2** context: the creator is the only indexer, and every writer added later
writes without indexing. Records `{ version: 2, rules: rules?.id || '' }` as the context's first
event.

## `graph.openContext(key, opts?)`

Same options. `rules.id` must match the id the context was created with (or both absent).
On a mismatch the context is interrupted and `openContext()` rejects with
`Error('Context rules mismatch: context uses "<a>", this peer provides "<b>"')`; a mismatch found
later (e.g. the record arrives after open) emits `'error'` on the context with the same message.
A context recorded with an unknown version is interrupted the same way.

## `rules.validate(event, reader) → boolean | Promise<boolean>`

Called in apply for `relation/create`, `relation/delete`, `tag/add`, `tag/remove`, `message`,
after the built-in checks (signature, ownership) have passed.

- `event`: the decoded event (plain object, read-only by contract).
- `reader` (read-only, sees the context's index as it was just before this event):
  - `await reader.hasEdge(from, type, to)` → boolean (an active edge)
  - `await reader.edges(entityId, { direction: 'out' | 'in', type?, limit? })` → array of
    `{ from, to, type, author, createdAt, value? }`
  - `await reader.countIn(entityId, type)` / `await reader.countOut(entityId, type)` → number
  - `await reader.hasTag(entityId, tag)` → boolean
- Accept: return (or resolve to) `true`. Anything else, a throw, or a rejection: the event is
  skipped — not indexed, no effect on other events, apply continues.
- Must be deterministic: same inputs → same answer on every peer. No clock, randomness, network,
  or state outside `event` and `reader`.

## `context.status()`

```js
{
  version: 2,            // 1 for contexts created before this feature
  rules: 'swarmfs/v1',   // '' when none
  isIndexer: true,
  writable: true,
  length: 1234,          // system length known locally
  confirmedLength: 1230  // signed by the indexers; history up to here cannot change
}
```

## Trust model (documented in `docs/contexts-and-roles.md`)

- A version 2 context is confirmed by its creator's device. A peer that joins by fast-forward
  adopts the creator-signed state without re-running the built-in checks or app rules on the
  history.
- Writers' events are applied by every peer as they arrive; until the creator's device confirms
  them, their order can still change.
- App rules and built-in checks stop bad events from entering the signed state. They do not stop
  a writer from appending them to its own log; peers that replay still download those bytes,
  peers that fast-forward do not.
