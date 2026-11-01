# Data model: One engine for many sites (spec 015)

Marks: **[apply-time]** every member must run the same rule (everyone updates together); **[format]**
bytes other peers read; **[local]** this device only.

## Decision `types/set` [apply-time] [format]

A new decision type in a top space's decision log (`lib/decisions/`).

| field | type | meaning |
|---|---|---|
| `types` | string (compact JSON, ≤ 32 KB) | the full declaration, `Types#describe()` form: `{ name: { fields: [[field, kind]], links, onePerMember, editable, put, index } }` |

Apply (deterministic on every member):
1. the writer may `decide` in the space (as `settings/set`);
2. `JSON.parse` succeeds and every type declares (`declare()` rules, no `hg/` names);
3. `checkCompatible(current)` passes (adds types, appends fields, adds indexes; same links; same `put`);
4. then `state.types = declaration`, `state.typesVersion += 1`. Otherwise: no effect.

Written by `createSpace({ types })` in the space's first batch, and at open by a decider's app whose
declaration is a compatible superset. Sub-spaces: none (they use the top space's).

## Decision state additions [apply-time]

- `types`: the latest applied declaration, or `null` (a space from before this spec: the app's own
  declaration is used, as today).
- `typesVersion`: count of applied `types/set` (for "needs re-index" checks).

## Space (lifecycle) [local]

```
           use (call / live view / hold / scope)
 closed ─────────────────────────────────────▶ open ──▶ (seeded: stays open)
   ▲                                             │
   └── idle idleMs, not seeded, not in use ◀─────┘
       or evicted (LRU, over maxOpen / memory)
```

- **closed**: a `@hg/spaces` row and the `Space` object shell (key, name, parent); no cores, no topic.
- **open**: `Space._open()` done: decision log, own log, directory, topic queued.
- **in use**: refcount > 0 (calls in flight, live views, change listeners, `hold()`s, scoped handles).
- **seeded**: in the seeded set (own, pinned, recent up to `maxSeeded`): never closed while seeded.

Topic, per open or seeded space: `none → queued → joined (announced | lookup) → leaving (grace) → none`.

## `@hg/spaces` row additions [local]

| field | type | meaning |
|---|---|---|
| `used` | uint | last use (ms): orders recent visits and LRU eviction |
| `own` | bool | created by this identity (seeding priority) |
| `pinned` | bool | pinned (also kept in the personal space as setting `pinned`, a list of keys) |

## `@hg/meta` changes [local]

- `types` (global) → `types:<space hex>`: the declaration this device indexed that space with. Absent
  for a space ⇒ use the folder's old global `types` (migration, no re-index).
- `appTypes`: the app's declaration at last open (the defaults of `createSpace`).

## `instance.json` [local]

Gains per space: `types` (as `types:<space>`), `own`, `pinned`; keeps the global `types` while any space
lacks its own (older folders). A newer folder opened by an older version: not supported (the older one
reads the global `types` and ignores the rest; spaces with `types/set` decisions fail to apply there:
that is the apply-time break).

## Topic queue [local]

| field | meaning |
|---|---|
| `jobs` | ordered: priority (0 in use, 1 own, 2 pinned, 3 recent, 4 re-look), then age |
| `inflight` | at most 1 background job; priority-0 jobs run at once |
| `announced` | set of space keys announced (server), ≤ `maxAnnounced` |
| `leaving` | space key → timer (grace, default 5 min) |

## Log (directory entry) [local]

Today: key → open Hypercore. Now: key → `{ identity, device, limit, indexed, core | null, lastUse }`.
Opened on: own log, behind (activity entry / heads length > indexed), read beyond the index, budget
pass. Closed after 30 s unused. Served while closed by Corestore.

## Scoped handle [local, API]

`{ topKey, refs }`: allows the space with `topKey` and its sub-spaces; holds one "in use" ref while
alive.
