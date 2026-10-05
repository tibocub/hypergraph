# Data Flow

## Write Path (Creating an Entity)

```
1. graph.put({ type: 'post' })
   ↓
2. UserCore.append(event)
   ↓
3. Event encoded via encodeEvent()
   ↓
4. Written to user's Hypercore
   ↓
5. put() calls view.update() internally — no separate graph.update()
   call needed for the caller's own writes to be indexed immediately
   ↓
6. GraphView processes the new event from UserCore
   ↓
7. Indexes updated in GraphView's Hyperbee (n:, nt:, nc:)
```
A separate `graph.update()` call is still what picks up events from *other* peers after
replication — it's just not required for your own local writes, which self-index synchronously.

## Write Path (Bulk: `graph.batch()`)

```
1. batch.put() / putContent() / putContentRef() / relate()   (recorded, nothing written)
   ↓
2. batch.flush(): validate every operation; reject the whole batch on any error
   ↓
3. Under the UserCore write lock: assign entity ids from the core's length,
   build every entity/content event, ONE core append
   ↓
4. Per context touched: build + sign relations, ONE ContextBase.appendBatch()
   → one Autobase batch, replayed in one apply call by every peer
   ↓
5. One view.update()
```
Events are built by the same private helpers as the single-item methods, so they are
byte-for-byte the same kind of event; only the grouping differs. A failure after step 3 throws
`BulkWriteError` with what was written (`specs/002-scale-indexing/contracts/bulk-write.md`).

## Write Path (Creating a Relation)

```
1. graph.relate({ from, to, type, context, value? })
   ↓
2. ContextBase.append(event)
   ↓
3. Event encoded via encodeEvent()
   ↓
4. Written to context's Autobase (local writer core)
   ↓
5. relate() calls view.update() internally — same as put(), no
   separate graph.update() call needed for the caller's own write
   ↓
6. ContextBase's own Autobase apply function processes the new event
   (GraphView only tracks whether the context's view.length changed
   and forwards to it — it never applies relation events itself)
   ↓
7. Indexes updated in the CONTEXT's OWN Hyperbee (e:, i:in:, er:,
   cnt:, t:, tref:) — NOT GraphView's Hyperbee, which never stores
   relation/tag/moderation data
```

## Write Path (Encrypted Content)

See [Read Permission](../read-permission.md) for the full design.

```
1. graph.putContent(entityId, body, contentType, { scope })
   ↓
2. Resolve the caller's OWN current key for that scope
   (ScopeBase.getCurrentEpoch() + resolveKey() — throws if
   the scope is unknown, or if the caller doesn't hold the key)
   ↓
3. Encrypt body with that key (XSalsa20-Poly1305, i.e. libsodium's
   standard secretbox — sodium-universal's `crypto_secretbox_easy`),
   generate a fresh nonce
   ↓
4. UserCore.append({ ..., body: ciphertextHex, encrypted: true,
   scope, epoch, nonce })
   ↓
5. graph.update() → GraphView indexes the record as-is — the
   ciphertext and its scope/epoch/nonce metadata are stored in
   the clear; only the payload itself is opaque
```

Reading it back (`graph.getContent()`) mirrors this: resolve the same scope's key for the
stored epoch, and only decrypt if that succeeds — otherwise return `{ encrypted: true, body:
null }` rather than throwing or returning garbage.

## Write Path (Granting Scope Access)

```
1. graph.scopeBase.grantKey(scopeId, recipientPubkeyHex,
   recipientEncryptionPublicKey)
   ↓
2. Resolve the GRANTER's own current key for that scope
   (fails outright if they don't hold it — an inherent
   cryptographic requirement, not just a permission check)
   ↓
3. Client-side permission check against the attached RoleBase
   (scope.grant) — throws immediately if denied
   ↓
4. Seal that key to the recipient's encryptionKeyPair.publicKey
   (hypercore-crypto's encrypt(), i.e. crypto_box_seal)
   ↓
5. ScopeBase.append({ type: 'scope/keyGrant', scopeId, recipient,
   epoch, sealedKey, ... }) — signed
   ↓
6. On every peer that replicates this event: signature verified,
   then a RoleBase permission check (bounded retry if the
   RoleBase hasn't synced yet) — hard-rejected if unauthorized,
   applied to the scope registry otherwise
```

## Join Path (Opening a Context Someone Else Writes)

```
1. graph.openContext(key, { rules? })
   ↓
2. Autobase replicates the context's system core and learns the
   indexers' signed length
   ↓
3a. ≥ 16 nodes behind → FAST-FORWARD: adopt the signed state, apply
    nothing from history; view blocks are fetched when read
3b. otherwise (or fastForward: false) → REPLAY: apply every event,
    then commit the rebuilt view once signatures are known
   ↓
4. New events from then on are applied as they arrive
```

Reading a folder after fast-forward fetches only the index blocks the listing touches. With the
listing's data on the relations (spec 004), nothing else is needed — no user core is opened. A
peer that does open other users' cores (`openUserCore()`) downloads them in full in the
background and indexes them on `update()`.

## Read Path (Querying)

```
1. graph.query().type('post').toArray()
   ↓
2. GraphQuery selects the type-specific index (nt:post:...) —
   an efficient, indexed scan, not a full table scan
   ↓
3. GraphView.bee.get() on node records (n:<id>) to resolve each match
   ↓
4. Returns full entity data, in chronological order
```

`query()` with no `.type()` filter uses `nc:` (the type-agnostic chronological index) the
same way. `.sortBy(field, direction)` is different: it buffers all matching results in memory
and sorts by whatever's already on each result object (including a field attached via
`.filter()` as an enrichment step, e.g. a derived vote count) — there's no way to index a
value that isn't stored on the entity itself.

## Read Path (By Author)

```
1. graph.getByAuthor(authorPubkeyHex)
   ↓
2. Look up that author's own UserCore directly (no separate
   index at all — a UserCore already only contains that
   person's own entities)
   ↓
3. Scan its entity/create events sequentially, resolving each
   via GraphView.getNode() (respects tombstones)
```

Returns nothing if that author's core hasn't been opened/replicated locally yet.

## See Also

- [Architecture Overview](architecture-overview.md) - Component overview
- [Component Details](component-details.md) - Detailed internals of each component
- [Read Permission](../read-permission.md) - Full design for scopes and content encryption
