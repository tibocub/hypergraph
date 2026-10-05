# Data Model: Scale Indexing

Nothing here changes an **event** (user-core or context oplog). Every structure below is a
derived, per-peer index, and can be rebuilt from the logs.

## Conventions (layout 2)

- **Key**: an `index-encoder` tuple. Element 0 is always a one-byte **index tag** (table below),
  so each index is one contiguous range, and a prefix of a tuple is a valid range query.
- **EntityId** inside a key is three members: `(typeOrRaw: string, author: buffer, seq: uint)`.
  - A canonical id `<type>/<64 lowercase hex>/<decimal seq, no leading zeros>` encodes as
    `(type, author bytes (32), seq)`.
  - Any other string (relations may point at arbitrary strings) encodes as `(raw, <empty>, 0)`.
    The two never collide: a parsed id always has a 32-byte author member, a raw one an empty one.
  - Decoding rebuilds the exact original string.
- **Timestamps** and **seqs** are `uint` members; they sort numerically.
- **Values** are `compact-encoding` structs holding only what the key and the pointed-to log
  entry cannot supply. `∅` = empty value (zero-length buffer).
- Booleans are packed into one `flags` uint per value.

## Global view (GraphView) — core `graph-view/2`

| tag | index | key members after the tag | value | today (layout 1) |
|---|---|---|---|---|
| 0x00 | format | — | `{ version: 2 }` | none |
| 0x01 | node | EntityId | `{ createdAt, flags(deleted), deletedAt? }` | `n:<id>` → `{id,type,author,deleted,createdAt,version,...}` |
| 0x02 | node by type, time | type, createdAt, author, seq | ∅ | `nt:<type>:<ts>:<id>` → `{id}` |
| 0x03 | node by time | createdAt, type, author, seq | ∅ | `nc:<ts>:<id>` → `{id}` |
| 0x04 | content version | EntityId, contentSeq | ∅ — content is read from the author's user core at `contentSeq` | `c:<id>:<seq>` → full record incl. body |
| 0x05 | profile | author | `{ seq }` of the latest `identity/update` | `id:profile:<hex>` → `{author,username,bio,seq}` |
| 0x06 | user-core progress | coreKey | `{ lastSeq }` | `meta:user:<hex>:lastSeq` |
| 0x07 | context-view progress | viewKey | `{ length }` | `meta:contextView:<hex>:length` |

Derived on read (never stored): node `id`, `type`, `author`, `version` (= seq); content
`entityId`, `contentType`, `body`, `encrypted`, `scope`, `epoch`, `nonce`, `createdAt` (all from
the content event itself); profile `username`, `bio`.

`deletedBy` is not stored: a tombstone is only accepted from the entity's own author.

**Content read path**: latest version = reverse range on `(0x04, EntityId)` limit 1 → `contentSeq`
→ `userCores.get(author).get(contentSeq)` → decode event → same record shape as today. If the
author's core is not open locally or the block is not held: `null` (FR-016 edge case).

## Context view — Autobase view, layout fixed by the context's record

(Revised during implementation, research.md "R8 revised": views are shared since fast-forward.)

| context record (`meta:context`, from `context/init`) | layout used |
|---|---|
| `layout: 2` (every context created now) | 2 |
| no `layout` (every context created before) | 1 (text keys), for the context's whole life |
| any other value | apply is interrupted (`unsupported index layout N`) |

Implemented for the bulky indexes only (tags 0x10–0x16 below). The moderation, pending, message
and record entries (0x17–0x1b planned) stay text in every context.

| tag | index | key members after the tag | value | today (layout 1) |
|---|---|---|---|---|
| 0x10 | edge | from: EntityId, relType, createdAt, to: EntityId | `{ flags(deleted, hasValue), value? (float64) }` | `e:<from>:<type>:<ts>:<to>` → `{from,to,type,author,createdAt,deleted,value}` |
| 0x11 | incoming edge | to: EntityId, relType, createdAt, from: EntityId | ∅ (the edge key is rebuilt from these members) | `i:in:…` → `{ ref: <whole e: key> }` |
| 0x12 | active edge | from, relType, to | `{ createdAt }` | `er:…` → `{ ref: <whole e: key> }` |
| 0x13 | in-count | to, relType | `{ count }` | `cnt:in:…` → `{count}` |
| 0x14 | out-count | from, relType | `{ count }` | `cnt:out:…` → `{count}` |
| 0x15 | tag | tag, createdAt, entity: EntityId, author | ∅ | `t:…` → `{entityId,tag,author,createdAt}` |
| 0x16 | tag ref | tag, entity: EntityId, author | `{ createdAt }` | `tref:…` → `{ ref }` |
| 0x17 | moderation by target | target: EntityId, createdAt, coreKey, seq | `{ action, reason?, author, signature }` | `m:t:…` → full record |
| 0x18 | moderation by author | author, createdAt, target: EntityId, coreKey, seq | ∅ (rebuilds the by-target key) | `m:a:…` → full record (duplicate) |
| 0x19 | pending moderation | eventId | `{ coreKey, seq, event }` (event via `eventEncoding`) | `m:p:<id>` → JSON |
| 0x1a | pending writer change | type, key, timestamp | `{ event }` (event via `eventEncoding`) | `w:p:…` → JSON |
| 0x1b | message | timestamp, authorPrefix | `{ text, username, author }` | `msg:<ts>:<author8>` → JSON |

Derived on read: edge `author` (= `from`'s author: apply rejects any relation whose signer is not
`from`'s author, so it is never stored differently), `type`, `from`, `to`, `createdAt`; moderation
`eventId` (= sha256 of `coreKey:seq`, as today), `target`, `createdAt`, `coreKey`, `seq`.

The message key keeps today's `(timestamp, first 8 chars of author)` identity on purpose: changing
it would change which messages overwrite which, i.e. behavior, not just storage.

## Layout interface

Both layouts implement one interface (`src/index-layout/`), so apply code and readers never
build keys themselves. Shape (names indicative, fixed in tasks):

- `encode<Index>(fields) → { key, value }` and `decode<Index>(key, value) → record` per index;
- range builders for every query in use: `edgeOutRange(from, type?)`, `edgeInRange(to, type?)`,
  `tagRange(tag)`, `nodeTypeRange(type)`, `nodeTimeRange()`, `contentRange(entityId)`,
  `moderationByTargetRange(target)`, `pendingModerationRange()`, `pendingWriterRange()`;
- `keyEncoding` / `valueEncoding` for the bee the layout reads (layout 1: utf-8 / json;
  layout 2: binary / binary).

Layout 1 is the current code, moved behind this interface with no behavior change, and is the
regression baseline: every existing test runs against both layouts.

## Index progress & atomicity

| record | stored in | written |
|---|---|---|
| user-core `lastSeq` | GraphView | in the same `bee.batch()` as the index entries it covers |
| context-view `length` | GraphView | after the context's apply has flushed |
| context index entries | context view | in the apply call's `view.batch()`; Autobase owns atomicity across reorgs |

## Bulk write (in memory only)

`Batch` (see `contracts/bulk-write.md`): ordered list of operations plus `EntityRef`s for entities
created in it. Nothing is persisted until `flush()`. Validation happens entirely before the first
append. At flush:

1. Acquire the user-core write lock; read `length`; assign every `EntityRef` its seq → id.
2. Build all user-core events (entity creations, content versions incl. references, encrypted
   where requested); append them in **one** `core.append` (one hash, one signature).
3. Per context touched: build and sign relation/tag events; append them in **one**
   `base.append([...])` → one Autobase batch on every peer.
4. One `graph.update()`.

A failure between steps 2 and 3 raises `BulkWriteError` carrying which parts were written
(contract).
