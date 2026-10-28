# Data model: Honest reads and change signals

No stored data changes (no index table, no wire format). These are the shapes apps see.

## Change entry

One record whose answer changed, in `change`'s `records`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | the record's id |
| `type` | string | its type (`hg/tag`, `hg/relation`, `hg/grant` included, as `types` today) |
| `deleted` | `null` \| Deleted | `null`: put, edited, hidden, revealed, flagged, content back; else how it went |

One entry per id per event; within one indexing batch the last state wins (put then delete → the delete).

## Deleted

Same shape in a change entry and in `get(id)`.

| Shape | When |
|---|---|
| `{ by: 'author', stamp, device }` | its author's delete counts here; `stamp` the delete's stamp (spec 011 "Latest wins"), `device` the z32 key of the device that wrote it |
| `{ by: 'space' }` | gone by the space: a moderator's take-down, a ban `from` it, its author cut (removed, banned), a write limit refused it |

Rules:
- A delete by anyone but the record's author never gives `deleted` (judged as `inspect({ record })`).
- `get(id)` reports `by: 'space'` only for take-downs (`state.isRemoved(id)`); a record left out by a cut
  or a write limit reads `deleted: null` (nothing kept says why; `change` said `by: 'space'` when it went).
- A record later brought back (write limit raised, unban with records still held) comes back as an entry
  with `deleted: null`.

## Events (state transitions)

| Event | Emitter | Payload | Fires when |
|---|---|---|---|
| `change` | space | `{ types, records }` | an indexing batch changed some answer; content fetched back |
| `spaces` | hg | `spaces()` | the list or a listed field (name, parent) differs from the last emitted |
| `members` | space | none | a decision batch applied; a member's device log accepted |
| `decisions` | space | none | a decision batch applied |
| `status` | space | `status()` | its signature changed: policy, access, held, heldFrom, belowPolicy, budget, warnings, settlers' count, `complete` |
| `devices` | hg | none | personal `hg/device` / `hg/device-remove` changed |
| `settings` | hg | none | personal `hg/setting` changed |
| `peers`, `logs`, `member-connection`, `member-disconnection` | space | unchanged | unchanged |

Payload rule: the value for a sync read, nothing for an async one (read again).
Extra events are allowed; a change with no event is a bug. No event after `close()`.

## `status().complete`

`true` when this device holds everything it knows of in the space and reached another member since it
opened (or is the space's only member on its only device) — `isComplete()`, spec 011's meaning.
