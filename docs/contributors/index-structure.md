# Index Structure

Two kinds of Hyperbee hold indexes:

- **GraphView** (one per peer, core `graph-view/2`): node, content, identity and progress
  indexes, built from the user cores this peer follows. Binary keys and values only.
- **Each context's own Autobase view**: edge, tag, moderation, message and pending indexes,
  built by that context's apply function. GraphView never stores these; it only records how far
  each context view has been processed. Its bulky indexes use the layout the context's record
  names (below); its small records are always UTF-8 keys with JSON values.

Every entry is one Hyperbee block, and each block costs roughly 180 bytes on disk beyond its own
key and value (Merkle tree nodes, RocksDB keys, filters), so the number of entries per item
matters as much as their size — see `bench/README.md`.

All key and value code lives in `src/index-layout/`; nothing else builds these keys.

## Compact keys (layout 2)

Spec 002 (US3). A key is an [`index-encoder`](https://github.com/holepunchto/index-encoder)
tuple whose first byte is the index tag, so each index is one contiguous range and any leading
part of a tuple is a valid range query. Numbers (times, seqs) are number members, so they sort
as numbers without zero-padding. Values are `compact-encoding` structs holding only what the
key (or the author's own log) can't supply; `∅` is an empty value.

**Entity ids** (`src/index-layout/entity-id.js`) are three key members, `(type, author, seq)`:

- a derived id `<type>/<64 lowercase hex>/<seq>` becomes `(type, the 32 author bytes, seq)`;
- any other string (a relation may point at anything) becomes `(string, <empty>, 0)`. A derived
  id always has a 32-byte author, so the two never collide, and decoding gives back the exact
  original string.

One visible effect: entities with the same type and author now sort by seq as a number
(`…/9` before `…/10`); text keys sorted `…/10` first.

## GraphView (`src/index-layout/graph.js`)

| tag | index | key after the tag | value |
|---|---|---|---|
| 0x00 | format | — | `2` |
| 0x01 | node | entity id | `{ flags(deleted), createdAt, deletedAt? }` |
| 0x02 | node by type, time | type, createdAt, author, seq | ∅ |
| 0x03 | node by time | createdAt, type, author, seq | ∅ |
| 0x04 | content version | entity id, contentSeq | ∅ |
| 0x05 | profile | author | `{ seq, username, bio? }` |
| 0x06 | user log progress | core key | last indexed seq |
| 0x07 | context view progress | view key | indexed length |
| 0x08 | context layout | context key | its index layout (1 or 2), once known |

- **Derived on read**, never stored: a node's `id`, `type`, `author` and `version` (= seq), all
  from its key.
- **Node** keys are ordered by (type, author, seq) — not chronological across authors. 0x02 and
  0x03 give real chronological scans: 0x02 for `getByType()` and `query().type()`, 0x03 for the
  default `query()` ordering. `GraphView.nodeIds({ type, reverse })` walks them.
- **Content is a pointer, not a copy.** `getContent()` takes the last 0x04 key of the entity
  (the newest content seq), reads that `content/append` event back from the author's own user
  core, and returns the same record as before: `{ entityId, contentType, body, createdAt,
  encrypted, scope, epoch, nonce }`. If that log isn't open here or the block is no longer
  held, it returns `null` without throwing. External content references
  (`contentType: 'link'`) are ordinary content versions and need nothing extra.
- **Context layout** (0x08): a context's layout never changes, so the first time it is known it
  is remembered here. Readers then never look it up in the context's shared view, which on a
  peer holding only part of that view can need the network: before this, a newcomer that had
  shown a channel's latest page could not show it again offline after a restart
  (`test/brittle/replication/offline-reopen.js`).
- **Progress** (0x06) is written in the same Hyperbee batch as the entries it covers (every
  `tuning.INDEX_BATCH` events), so the two can never disagree after a crash.
- **Upgrade**: a store from before layout 2 has its index in a core named `graph-view`. On first
  open, `graph-view/2` starts empty and the next `update()` rebuilds it from the logs; the old
  core is truncated and compacted once (its format record marks this done). Hypercore's own
  `purge()` fails in the installed version, and a truncate alone leaves the bytes on disk until
  RocksDB compacts.

## Context views (`src/index-layout/context.js`)

A context's layout is fixed by its record (`meta:context.layout`, from `context/init`), so every
peer applying it builds byte-identical views — fast-forward shares them. New contexts get
layout 2; a context whose record has no `layout` (every context created before) is layout 1 for
its whole life, also after `upgrade()` to version 3. A layout this code doesn't know stops
apply (`status().interrupted`), like an unknown version. `status().layout` reports it.

Both layouts expose the same operations (`addEdge`, `removeEdge`, `activeEdge`, `getCount`,
`putCount`, `addTag`, `removeTag`, `edges`, `tagged`, `hasTag`); ContextBase's apply, its rules
reader and its public readers (`indexedEdges`, `activeEdge`, `edgeCount`, `tagged`, `hasTag`)
go through them. Both kinds of key can share one bee: binary tags are below every printable
character.

### Edges

| layout 1 key → value | layout 2 tag: key → value |
|---|---|
| `e:<from>:<type>:<createdAt>:<to>` → `{ from, to, type, author, createdAt, deleted, value?, data? }` | 0x10: from, type, createdAt, to → `{ flags(deleted, hasValue, hasData), value?, data? }` |
| `i:in:<to>:<type>:<createdAt>:<from>` → `{ ref: <e: key> }` | 0x11: to, type, createdAt, from → ∅ (the edge key is these members reordered) |
| `er:<from>:<type>:<to>` → `{ ref: <e: key> }` | 0x12: from, type, to → createdAt |
| `cnt:in:<to>:<type>` → `{ count }` | 0x13: to, type → count |
| `cnt:out:<from>:<type>` → `{ count }` | 0x14: from, type → count |

- An edge's `author` is not stored in layout 2: apply rejects any relation whose signer is not
  `from`'s author, so it is always `from`'s author.
- `value` is the optional number (a vote's ±1), `data` the optional app string (spec 004, ≤ 4
  KB), returned with the edge in both directions, so a listing needs nothing else.
- The active-edge index (`er:` / 0x12) enforces one live edge per (from, type, to).
- Counters are incremented on create and decremented on delete (clamped at 0), accumulated in
  memory per apply chunk and written once per chunk. If a delete arrives before its create, a
  count may read one low.

### Tags

| layout 1 key → value | layout 2 tag: key → value |
|---|---|
| `t:<tag>:<createdAt>:<entityId>:<author>` → `{ entityId, tag, author, createdAt }` | 0x15: tag, createdAt, entity, author → ∅ |
| `tref:<tag>:<entityId>:<author>` → `{ ref }` | 0x16: tag, entity, author → createdAt |

A tag author is two members: the 32 key bytes and `''` when it is a lowercase hex key, else
empty bytes and the string as given. Tags are author-scoped (only an entity's author can tag
it), so they suit self-categorization; `getByTag(tag)` scans one tag in time order, then looks
each entity up to confirm the tagger still authors it.

### Small records (text in both layouts)

```
meta:context → { version, rules, owner?, layout? }   # from the creator's context/init; absent = version 1, layout 1
meta:roles   → { version, roles: { role: [permission] }, members: { pubkey: role } }   # version 3
w:m:<writerKeyHex>          → { member }   # which member a writer belongs to (version 3)
w:k:<member>:<writerKeyHex> → {}           # a member's writers, to promote/demote them together
inv:<inviteKeyHex> → { role, uses, used, revoked, author, scope?, scopeBase?, roleBase? }   # invites (spec 006)
sg:<member>:<scope> → { scope, scopeBase, roleBase, member, encryptionKey, minter }   # a redeemed invite asks for a scope key

m:t:<targetId>:<createdAt>:<coreKeyHex>:<seq> → { eventId, action, target, author, reason, createdAt, coreKey, seq, signature }
m:a:<author>:<createdAt>:<targetId>:<coreKeyHex>:<seq> → (same record)
m:p:<eventId> → { eventId, coreKey, seq, event }     # moderation awaiting RoleBase sync
w:p:<type>:<key>:<timestamp> → { event }             # writer change awaiting RoleBase sync
msg:<timestamp>:<first 8 chars of author> → { text, username, author, timestamp }
```

Moderation actions are signed and checked against the role table before applying; an
unauthorized one is never indexed at all. Times in these text keys are 16-digit zero-padded
decimals (`toSortableTs()`), so they sort correctly as text.

## Scope Registry (ScopeBase's own Hyperbee, not GraphView)

```
scopes:registry → {
  [scopeId]: {
    version, id, creator, currentEpoch,
    grants: { '<pubkeyHex>:<epoch>': { sealedKey, granter, timestamp } },
    revoked: { '<pubkeyHex>': true }
  }
}
```

The actual symmetric key is never stored here in the clear — only `sealedKey` (ciphertext,
openable only by its intended recipient). See [Read Permission](../read-permission.md).

## See Also

- [Event Encoding](event-encoding.md) - Event format and encoding
- [Storage Model](../storage-model.md) - What is stored where, and what it costs
- [Read Permission](../read-permission.md) - ScopeBase and content encryption in full
