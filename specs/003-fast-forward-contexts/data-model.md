# Data Model: Fast-Forward Joins, Indexer Topology and App Validation Rules

## New event: `context/init` (context oplog)

| field | type | notes |
|---|---|---|
| `type` | `'context/init'` | new type code 14 in `src/encodings/event.js` |
| `timestamp` | uint | as every event |
| `version` | uint | context topology version; `2` for contexts created by this feature |
| `rules` | string | the app rules id, `''` when none |

Appended by `createContext()` as the context's first event, by the bootstrap writer.

**Apply rules** (deterministic):
- Honoured only if appended by the bootstrap writer (`from.key` equals the context key) and only
  if no record exists yet; otherwise ignored.
- Writes the context record (below).

Older peers decode type code 14 as `{ type: undefined }` and ignore it (existing behavior of
`decodeEvent` for unknown codes), which is why mixed versions in one context are unsupported.

## Context record (context view)

```
meta:context → { version, rules }
```

Absent → version 1 (created before this feature). Read by apply (from its own batch) when
deciding a writer's indexer flag, and by `context.status()` / the rules check on open.

## Writer topology

| context version | writer added by `addWriter` / `roles/addWriter` events | bootstrap writer |
|---|---|---|
| 1 | indexer (unchanged) | indexer |
| 2 | **non-indexer** | indexer |
| > 2 | context interrupted ("unsupported context version") | — |

## Autobase configuration (all contexts)

| option | before | after |
|---|---|---|
| `ackInterval` | 0 | `tuning.ACK_INTERVAL` (1,000 ms) |
| `fastForward` | false | true, unless the peer passes `fastForward: false` |

## App rules (in memory only)

`{ id: string, validate(event, reader) }`, held by the ContextBase instance. Only `id` is
persisted (in `context/init`).
