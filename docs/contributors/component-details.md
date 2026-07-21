# Component Details

## Hypergraph (Main Entry Point)

**File**: `src/hypergraph.js`

**Private Fields**:
- `#store` - Corestore instance for core management
- `#userCore` - Primary UserCore instance (this device's core)
- `#userCores` - Map of remote UserCore instances (keyHex → UserCore)
- `#contexts` - Map of ContextBase instances (keyHex → ContextBase)
- `#view` - GraphView instance (materialized view)
- `#roleBase` - RoleBase instance (optional, for permission checks)
- `#scopeBase` - ScopeBase instance (optional, for read-permission key grants — see [Read Permission](../read-permission.md))
- `#emitter` - EventEmitter for change events
- `identity` - IdentityManager instance (public)

**Initialization Flow**:
```js
constructor(store, opts)
  ↓
_open()
  ↓
1. identity.init() - Initialize identity system
  ↓
2. Create UserCore with device keyPair
  ↓
3. Create GraphView with Hyperbee
```

**Key Methods**:
- `put()` - Create entity via UserCore
- `putContent()` - Append content via UserCore (optionally encrypted — pass `opts.scope`, see [Read Permission](../read-permission.md))
- `getContent()` - Read content back, transparently decrypting if the caller holds the relevant scope key
- `relate()` - Create relation via ContextBase
- `tag()` - Create tag via ContextBase (author-only — see [Contexts and Roles](../contexts-and-roles.md))
- `query()` - Fluent query interface (see [Querying](../querying.md))
- `getByTag()` / `getByType()` / `getByAuthor()` - Direct iteration helpers, each backed by an index or UserCore scan rather than a full table scan
- `update()` - Trigger GraphView to process new events
- `openUserCore()` - Open remote user's core
- `createContext()` - Create new ContextBase
- `openContext()` - Open existing ContextBase
- `createRoleBase()` - Create new RoleBase
- `openRoleBase()` - Open existing RoleBase
- `createScopeBase()` - Create new ScopeBase
- `openScopeBase()` - Open existing ScopeBase
- `moderateAction()` - Record a signed, role-gated moderation fact (requires `opts.keyPair`)
- `handlePeerConnection()` - Handle peer join for writer authorization

## UserCore (Single-Writer Hypercore)

**File**: `src/user-core.js`

**Purpose**: Manages a single user's personal Hypercore for storing entities and content. Implements the **external pointer pattern** to avoid data duplication in Autobase views.

**Why UserCores Exist (External Pointer Pattern)**:
- Autobase copies writer data into the view - large content would be duplicated
- UserCores serve as external storage for actual data (entities, content)
- ContextBases store pointers/references to entities via relations
- This allows reading a specific peer's data without processing the entire merged view
- Provides namespace isolation and single-writer guarantees

**Where to see this in code**:
- `Hypergraph.put()` appends `entity/create` events to UserCore
- `Hypergraph.del()` appends `entity/tombstone` events to UserCore
- `Hypergraph.putContent()` appends `content/append` events to UserCore
- `GraphView.update()` reads events from UserCores directly, and separately from ContextBase Autobase views
- UserCore events are NOT replicated into ContextBase - they are separate data structures

**Private Fields**:
- `#core` - Hypercore instance
- `#keyPair` - KeyPair for signing (owner only)
- `#keyEncoding` - Codec for keys
- `#valueEncoding` - Codec for values

**Core Structure**:
```
seq 0: { type: 'entity/create', entityType: 'post', author, timestamp }
seq 1: { type: 'content/append', entityId: 'post/<authorHex>/0', body: 'Hello', contentType: 'text' }
seq 2: { type: 'entity/create', entityType: 'post', author, timestamp }
```
(Entity ids are derived as `<type>/<authorCoreKeyHex>/<seq>`, not stored directly on the event — see `GraphView#applyEntityCreate`.)

**Key Methods**:
- `append(event)` - Append event to Hypercore
- `get(seq)` - Get event by sequence number
- `createReadStream(opts)` / `createHistoryStream(opts)` - Stream decoded events
- `length` - Number of events in core

**Critical Detail**: UserCore is single-writer. Only the owner (with the keyPair) can append. This ensures conflict-free replication.

## ContextBase (Multi-Writer Autobase)

**File**: `src/context-base.js`

**Purpose**: Manages collaborative contexts using Autobase for multi-writer CRDT operations.

**Private Fields**:
- `#store` - Corestore instance
- `#bootstrap` - Autobase key (null if creating new)
- `#namespace` - Corestore namespace for isolation
- `#base` - Autobase instance
- `#viewBee` - Hyperbee view of Autobase
- `#roleBase` - Attached RoleBase (for closed mode, and for moderation/writer-change permission checks in any mode)
- `#writeMode` - 'open' or 'closed'
- `#pendingWriterRequests` - Map of pending writer requests
- `#keyPair` - KeyPair for local writer
- `#verifySignatures` - Whether to verify signatures

**Autobase Configuration**:
```js
{
  open: this.#openView.bind(this),  // Called to open writer's view
  apply: this.#applyView.bind(this), // Called to apply writer's output
  valueEncoding: { encode: encodeEvent, decode: decodeEvent },
  ackInterval: 0,
  ackThreshold: 0,
  fastForward: false
}
```

**Write Modes**:
- **Open**: No permission checks, writers added freely via `addWriter()`
- **Closed**: Requires RoleBase, writers must have `context.write` permission

Note: regardless of write mode, `moderateAction()` and writer-change events (`roles/addWriter`/`roles/removeWriter` at the context level) are always signature-verified and permission-checked against whichever RoleBase is attached — see [Contexts and Roles](../contexts-and-roles.md).

**Key Methods**:
- `append(event)` - Append event to Autobase
- `addWriter(key)` / `removeWriter(key)` - Add/remove a writer, signed and permission-gated in closed mode
- `relate()` - Create relation (helper method)
- `tag()` - Create tag (helper method)
- `handlePeerConnection()` - Auto-add writer in open mode, emit request in closed mode

**Critical Detail**: ContextBase uses Corestore namespaces to isolate context cores from each other. Each context gets its own namespace based on the Autobase key. Any future Autobase-backed structure needs to do the same — see [Corestore Namespaces](corestore-namespaces.md) for a real bug this caused when `ScopeBase` initially skipped it.

## RoleBase (Autobase for Role Registry)

**File**: `src/role-base.js`

**Purpose**: Manages role-based access control using an Autobase for the role registry.

**Private Fields**:
- `#store` - Corestore instance
- `#base` - Autobase instance
- `#viewBee` - Hyperbee view of Autobase
- `#identity` - IdentityManager instance, for signing role-change events

**Role Registry Structure** (this is `initRegistry()`'s actual, real default — see `src/roles-registry.js`):
```js
{
  version: 1,
  roles: {
    owner: ['*'],
    admin: ['mod.add', 'mod.remove', 'content.remove', 'content.hide', 'content.reveal', 'context.write'],
    mod: ['content.hide', 'content.remove', 'content.flag'],
    member: []
  },
  members: {
    '<pubkey>': 'owner'
  }
}
```
Permission strings are otherwise free-form — an app can call `roles/setRolePermissions` to grant any role any subset of these (or invent new ones, e.g. `scope.grant` — see [Read Permission](../read-permission.md)). Any pubkey not explicitly listed in `members` falls back to the `member` role if one exists.

**Key Methods**:
- `init(ownerKey)` - Initialize registry with owner
- `append(event)` - Append role change event
- `can(author, permission)` - Check if author has permission
- `getRegistry()` - Get the current registry state

**Critical Detail**: `createRoleBase()` automatically attaches the RoleBase to the graph instance. Do NOT call `openRoleBase()` immediately after `createRoleBase()` - this causes "Autobase failed to open" errors. More generally: two separate object instances of the same Autobase key can never share one Corestore at all (confirmed with a minimal repro) — this isn't specific to RoleBase, it applies to any Autobase-backed structure. Multi-peer scenarios always need separate Corestores with real replication between them.

## ScopeBase (Autobase for Read-Permission Key Grants)

**File**: `src/scope-base.js`

**Purpose**: Manages read-access scopes — named, key-holder-restricted "views" of content, structurally mirroring RoleBase but a different concern. RoleBase decides who is *allowed* to do what; ScopeBase stores sealed key material for who has actually *been granted* the ability to decrypt a given scope's content. See [Read Permission](../read-permission.md) for the full design and rationale.

**Private Fields**:
- `#store` - Corestore instance
- `#bootstrap` - Autobase key (null if creating new)
- `#namespace` - Corestore namespace for isolation (namespaced from the start, unlike RoleBase — see [Corestore Namespaces](corestore-namespaces.md))
- `#base` - Autobase instance
- `#viewBee` - Hyperbee view of Autobase
- `#identity` - IdentityManager instance, for signing and this identity's own `encryptionKeyPair`
- `#roleBase` - Attached RoleBase, for permission checks on `scope.create`/`scope.grant`/`scope.revoke`

**Key Methods**:
- `createScope(scopeId)` - Create a scope and immediately grant its creator epoch 0's key
- `grantKey(scopeId, recipientPubkeyHex, recipientEncryptionPublicKey)` - Seal the scope's current key to a new recipient (requires the granter to already hold that key themselves — an inherent cryptographic requirement, not just a permission check)
- `resolveKey(scopeId, pubkeyHex, encryptionKeyPair, epoch)` - Unseal a specific epoch's key for a specific recipient
- `revoke(scopeId, pubkeyHex)` - Mark a pubkey as no longer a current member (informational — does not, and cannot, undo a grant already received)
- `getCurrentEpoch(scopeId)` / `getRegistry()` - Read the current state

**Critical Detail**: The actual symmetric scope key never appears anywhere in this structure in the clear — only copies sealed (via `hypercore-crypto`'s `encrypt()`/`decrypt()`, wrapping libsodium's `crypto_box_seal`) to a specific recipient's `encryptionKeyPair.publicKey`.

## GraphView (Materialized View)

**File**: `src/view.js`

**Purpose**: Maintains materialized indexes in a Hyperbee for efficient queries.

**Private Fields**:
- `#bee` - Hyperbee instance
- `#userCores` - Map of UserCore instances
- `#contexts` - Map of ContextBase instances
- `#lastProcessedSeq` - Map of last processed sequence per core
- `#contextCheckpoints` - Map of Autobase checkpoints per context
- `#deviceToIdentity` - Map of device key → identity key

**Update Flow**:
```js
update()
  ↓
1. For each UserCore:
   - Get events since lastProcessedSeq
   - Process each event
   - Update indexes
   - Update lastProcessedSeq
  ↓
2. For each ContextBase:
   - Get Autobase view since last checkpoint
   - Process each event
   - Update indexes
   - Update checkpoint
```

**Key Methods**:
- `update()` - Process new events from all cores
- `getNode(id)` - Get entity by ID
- `getContent(entityId)` - Get latest content record (encrypted or plain — decryption happens one layer up, in `Hypergraph.getContent()`)
- `edges(id, opts)` - Query edges
- `getByTag(tag, opts)` - Query by tag
- `getByType(type)` - Query by type, using the time-sorted `nt:` index
- `getByAuthor(author)` - Query by author, scanning that author's own UserCore directly rather than any shared index
- `getIdentity(pubkey)` - Get identity profile

**Critical Detail**: GraphView is caller-driven. The application must call `graph.update()` after replication to process new events.

## See Also

- [Architecture Overview](architecture-overview.md) - Component overview
- [Data Flow](data-flow.md) - How data flows through the system
- [Read Permission](../read-permission.md) - ScopeBase, content encryption, and the full read-access design
