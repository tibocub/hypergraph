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
5. graph.update() called by application
   ↓
6. GraphView processes new events from UserCore
   ↓
7. Indexes updated in GraphView's Hyperbee (n:, nt:, nc:)
```

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
5. graph.update() called by application
   ↓
6. GraphView processes new events from ContextBase
   ↓
7. Indexes updated in GraphView's Hyperbee
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
3. Encrypt body with that key (XChaCha20-Poly1305 /
   crypto_secretbox_easy), generate a fresh nonce
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
