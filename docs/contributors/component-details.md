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
- `#peerDiscovery` - PeerDiscovery instance (event emitter)
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
  ↓
4. Forward peer discovery events to #emitter
```

**Key Methods**:
- `put()` - Create entity via UserCore
- `putContent()` - Append content via UserCore
- `relate()` - Create relation via ContextBase
- `tag()` - Create tag via ContextBase
- `update()` - Trigger GraphView to process new events
- `openUserCore()` - Open remote user's core
- `createContext()` - Create new ContextBase
- `openContext()` - Open existing ContextBase
- `createRoleBase()` - Create new RoleBase
- `openRoleBase()` - Open existing RoleBase
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

**Evidence from code**:
- `hypergraph.js` lines 204-212: `entity/create` events appended to UserCore
- `hypergraph.js` lines 261-268: `entity/tombstone` events appended to UserCore
- `hypergraph.js` lines 297-305: `content/append` events appended to UserCore
- `view.js` lines 108-123: GraphView reads events from UserCores directly
- `view.js` lines 127-154: GraphView reads from ContextBase Autobase views separately
- UserCore events are NOT replicated into ContextBase - they are separate data structures

**Private Fields**:
- `#core` - Hypercore instance
- `#keyPair` - KeyPair for signing (owner only)
- `#keyEncoding` - Codec for keys
- `#valueEncoding` - Codec for values

**Core Structure**:
```
seq 0: { type: 'entity/create', id: 'post/1', author, timestamp }
seq 1: { type: 'content/append', entityId: 'post/1', body: 'Hello', contentType: 'text' }
seq 2: { type: 'entity/create', id: 'post/2', author, timestamp }
```

**Key Methods**:
- `append(event)` - Append event to Hypercore
- `get(seq)` - Get event by sequence number
- `events()` - Iterator over all events
- `length` - Number of events in core

**Critical Detail**: UserCore is single-writer. Only the owner (with the keyPair) can append. This ensures conflict-free replication.

**Implementation Note**: UserCore currently manually wraps a Hypercore. This may need refinement to align better with Autobase's patterns (e.g., using `Autobase.getLocalCore()` if appropriate).

## ContextBase (Multi-Writer Autobase)

**File**: `src/context-base.js`

**Purpose**: Manages collaborative contexts using Autobase for multi-writer CRDT operations.

**Private Fields**:
- `#store` - Corestore instance
- `#bootstrap` - Autobase key (null if creating new)
- `#namespace` - Corestore namespace for isolation
- `#base` - Autobase instance
- `#viewBee` - Hyperbee view of Autobase
- `#roleBase` - Attached RoleBase (for closed mode)
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

**Key Methods**:
- `append(event)` - Append event to Autobase
- `addWriter(key)` - Add writer to Autobase
- `relate()` - Create relation (helper method)
- `tag()` - Create tag (helper method)
- `handlePeerConnection()` - Auto-add writer in open mode, emit request in closed mode

**Critical Detail**: ContextBase uses Corestore namespaces to isolate context cores from each other. Each context gets its own namespace based on the Autobase key.

## RoleBase (Autobase for Role Registry)

**File**: `src/role-base.js`

**Purpose**: Manages role-based access control using an Autobase for the role registry.

**Private Fields**:
- `#store` - Corestore instance
- `#base` - Autobase instance
- `#viewBee` - Hyperbee view of Autobase
- `#registry` - RolesRegistry instance

**Role Registry Structure**:
```js
{
  roles: {
    owner: ['*'],
    admin: ['content.delete', 'user.ban', 'mod.add'],
    mod: ['content.delete', 'user.ban'],
    member: ['content.create', 'content.reply']
  },
  members: {
    '<pubkey>': 'owner'
  }
}
```

**Key Methods**:
- `init(ownerKey)` - Initialize registry with owner
- `append(event)` - Append role change event
- `can(author, permission)` - Check if author has permission
- `getRole(author)` - Get role for author

**Critical Detail**: `createRoleBase()` automatically attaches the RoleBase to the graph instance. Do NOT call `openRoleBase()` immediately after `createRoleBase()` - this causes "Autobase failed to open" errors.

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
- `get(id)` - Get entity by ID
- `edges(id, opts)` - Query edges
- `getByTag(tag, opts)` - Query by tag
- `getIdentity(pubkey)` - Get identity profile

**Critical Detail**: GraphView is caller-driven. The application must call `graph.update()` after replication to process new events.

## See Also

- [Architecture Overview](architecture-overview.md) - Component overview
- [Data Flow](data-flow.md) - How data flows through the system
