# Hypergraph Architecture (Contributor Guide)

This document provides low-level architectural details for contributors to Hypergraph. For user-facing documentation, see the main README.

## Table of Contents

1. [Component Overview](#component-overview)
2. [Data Flow](#data-flow)
3. [Component Details](#component-details)
4. [Event Encoding](#event-encoding)
5. [Index Structure](#index-structure)
6. [Autobase Integration](#autobase-integration)
7. [Corestore Namespaces](#corestore-namespaces)
8. [Replication Flow](#replication-flow)
9. [Multi-Device Support](#multi-device-support)
10. [Critical Implementation Details](#critical-implementation-details)

## Component Overview

Hypergraph is composed of the following core components:

```
Hypergraph (main entry point)
├── UserCore (single-writer Hypercore for entities/content)
├── ContextBase (multi-writer Autobase for relations/tags/moderation)
├── RoleBase (Autobase for role registry and permissions)
├── GraphView (Hyperbee materialized view with indexes)
├── IdentityManager (keet-identity-key wrapper for multi-device support)
├── PeerDiscovery (event emitter for peer join/leave)
└── GraphQuery (fluent query interface)
```

### Component Responsibilities

| Component | File | Responsibility |
|-----------|------|----------------|
| Hypergraph | `src/hypergraph.js` | Main API, coordinates all components |
| UserCore | `src/user-core.js` | Manages user's personal Hypercore (entities, content) |
| ContextBase | `src/context-base.js` | Manages collaborative Autobase contexts |
| RoleBase | `src/role-base.js` | Manages role-based access control |
| GraphView | `src/view.js` | Materialized view with Hyperbee indexes |
| IdentityManager | `src/identity-manager.js` | Identity and device key management |
| PeerDiscovery | `src/peer-discovery.js` | Peer join/leave event emission |
| GraphQuery | `src/query.js` | Fluent query interface |
| RolesRegistry | `src/roles-registry.js` | Role permission checking logic |

## Data Flow

### Write Path (Creating an Entity)

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
7. Indexes updated in GraphView's Hyperbee
```

### Write Path (Creating a Relation)

```
1. graph.relate({ from, to, type, context })
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

### Read Path (Querying)

```
1. graph.query().type('post').toArray()
   ↓
2. GraphQuery builds index range query
   ↓
3. GraphView.bee.get() on index (e.g., nt:post:...)
   ↓
4. Returns matching entity IDs
   ↓
5. GraphView.bee.get() on node records (n:<id>)
   ↓
6. Returns full entity data
```

## Component Details

### Hypergraph (Main Entry Point)

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

### UserCore (Single-Writer Hypercore)

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

### ContextBase (Multi-Writer Autobase)

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

### RoleBase (Autobase for Role Registry)

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

### GraphView (Materialized View)

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

## Event Encoding

**File**: `src/encodings/event.js`

Events are encoded/decoded using a binary format for efficiency.

**Event Structure**:
```js
{
  type: 'entity/create' | 'content/append' | 'relation/create' | 'tag/add' | ...,
  id: string,
  author: string,
  timestamp: number,
  ...type-specific fields
}
```

**Encoding**:
```js
encodeEvent(event) → Buffer
```

**Decoding**:
```js
decodeEvent(Buffer) → event
```

**Supported Event Types**:
- `entity/create` - Create entity
- `entity/tombstone` - Delete entity (tombstone)
- `content/append` - Append content
- `relation/create` - Create relation
- `relation/delete` - Delete relation
- `tag/add` - Add tag
- `tag/remove` - Remove tag
- `identity/profile` - Identity profile update
- `roles/setRolePermissions` - Set role permissions
- `roles/addMember` - Add member to role
- `roles/removeMember` - Remove member from role

## Index Structure

All indexes are stored in GraphView's Hyperbee with UTF-8 keys and JSON values.

### Node Indexes

```
n:<entityId> → { id, type, author, deleted, createdAt }

nt:<type>:<createdAt>:<entityId> → { id }
```

### Content Indexes

```
c:<entityId>:<seq> → { contentType, body }
```

### Edge Indexes

```
e:<from>:<type>:<createdAt>:<to> → { from, to, type, author, createdAt, deleted }

i:in:<to>:<type>:<createdAt>:<from> → { ref: <full e: key> }

er:<from>:<type>:<to> → { ref: <full e: key> }

cnt:in:<to>:<type> → { count }
cnt:out:<from>:<type> → { count }
```

### Tag Indexes

```
t:<tag>:<createdAt>:<entityId>:<author> → { createdAt }

tref:<tag>:<entityId>:<author> → { ref }
```

### Moderation Indexes

```
m:t:<targetId>:<createdAt>:<coreKeyHex>:<seq> → { eventId, action, target, author, createdAt, signature }

m:a:<author>:<createdAt>:<targetId>:<coreKeyHex>:<seq> → { eventId, action, target, author, createdAt, signature }
```

### Identity Indexes

```
id:profile:<pubkey> → { username, bio, ... }
```

### Checkpoint Indexes

```
meta:user:<keyHex>:lastSeq → { seq }
meta:context:<keyHex>:checkpoint → { checkpoint }
```

**Timestamp Encoding**: All timestamps are 16-digit zero-padded decimal strings:
```js
String(timestamp).padStart(16, '0')
```

## Autobase Integration

ContextBase and RoleBase use Autobase for multi-writer CRDT operations.

### Autobase View Opening

When Autobase opens a writer's view, it calls the `open` callback:

```js
async #openView (store, key) {
  const core = store.get({ key })
  await core.ready()
  const bee = new Hyperbee(core, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
    extension: false
  })
  await bee.ready()
  return bee
}
```

### Autobase View Application

When Autobase applies a writer's output, it calls the `apply` callback:

```js
async #applyView (batch, viewBee) {
  for (const node of batch) {
    const event = decodeEvent(node.value)
    // Process event and update indexes
  }
}
```

### Autobase Checkpoints

ContextBase uses Autobase checkpoints to track progress:

```js
const checkpoint = this.#base.linearizer.indexers.get(localWriter).clock
this.#contextCheckpoints.set(contextKeyHex, checkpoint)
```

## Corestore Namespaces

Corestore namespaces are used to isolate cores from different components.

### Namespace Structure

```
Root Corestore
  ├── namespace('user:<keyHex>') → UserCore's Hypercore
  ├── namespace('ctx:<autobaseKeyHex>') → ContextBase's Autobase
  └── namespace('role:<roleBaseKeyHex>') → RoleBase's Autobase
```

### Namespace Usage

**UserCore**:
```js
const core = store.get({ key: userCoreKey })
```

**ContextBase**:
```js
const ns = store.namespace(this.#namespace) // namespace = autobaseKeyHex
const autobase = new Autobase(ns, bootstrapKey, opts)
```

**RoleBase**:
```js
const ns = store.namespace(this.#namespace) // namespace = roleBaseKeyHex
const autobase = new Autobase(ns, bootstrapKey, opts)
```

**Critical Detail**: Namespaces prevent core key conflicts between different contexts and RoleBase instances.

## Replication Flow

Hypergraph does not handle networking directly. Replication is the responsibility of the application.

### Manual Replication Pattern

```js
const swarm = new Hyperswarm()

swarm.on('connection', (conn, info) => {
  store.replicate(conn)  // Replicate all cores in the store
})

swarm.join(graph.discoveryKey, { server: true, client: true })
await swarm.flush()
```

### Writer Authorization Flow

When a peer connects:

1. Application calls `graph.handlePeerConnection(peerKey, contextKey)`
2. Hypergraph forwards to ContextBase.handlePeerConnection()
3. In open mode: ContextBase automatically adds peer as writer
4. In closed mode: ContextBase emits 'writer-request' event for approval

### DHT Announcement Timing

**Critical**: Peers must announce on DHT BEFORE creating data:

```js
const d = swarm.join(topic, { server: true, client: true })
await d.flushed()  // Wait for DHT announcement
// Now safe to create data
await graph.put({ type: 'message' })
```

If data is created before announcement, other peers won't discover it.

## Multi-Device Support

Hypergraph supports multiple devices per identity through the IdentityManager.

### Identity vs Device Keys

- **Identity key**: Long-term cryptographic identity (same across all devices)
- **Device key**: Per-device keypair (each device has its own)
- **Attestation proof**: Cryptographic proof that a device belongs to an identity

### Device-to-Identity Mapping

GraphView maintains a mapping from device keys to identity keys:

```js
view.registerDeviceIdentity(deviceKeyHex, identityKeyHex)
```

This mapping is used for author resolution in queries.

### UserCore Per Device

Each device has its own UserCore, but all devices share the same identity:

```
Device 1: UserCore key = device1PublicKey, identity = identityPublicKey
Device 2: UserCore key = device2PublicKey, identity = identityPublicKey
```

### Opening Remote User Cores

To open another device's core:

```js
await graph.openUserCore(remoteDeviceKeyHex)
```

This creates a UserCore instance for the remote device without a keyPair (read-only).

## Critical Implementation Details

### RoleBase: createRoleBase vs openRoleBase

**Do NOT call `openRoleBase()` immediately after `createRoleBase()`**.

`createRoleBase()` already attaches the RoleBase to the graph instance. Calling `openRoleBase()` again with the same key attempts to reopen an already-open instance, causing "Autobase failed to open" errors.

**Correct usage**:
```js
// Creating a new RoleBase
const roleKeyHex = await graph.createRoleBase()
const owner = graph.key.toString('hex')
await graph.roleBase.init(owner)
await graph.roleBase.append(...)

// Opening an existing RoleBase (from another peer)
await graph.openRoleBase(roleKeyHex)
```

### ContextBase KeyPair Handling

**Do NOT pass keyPair to Autobase constructor**. Let Autobase handle local writer creation automatically.

This matches the old hypergraph behavior and avoids "Autobase failed to open" errors. Writers are managed via the `addWriter()` method after the context is ready.

### GraphView Update is Caller-Driven

The application must call `graph.update()` after replication to process new events. GraphView does not automatically update.

### Windows File Locking

Windows has aggressive file locking that can cause EPERM errors during cleanup when RocksDB handles are still open. Use retry logic with exponential backoff when deleting test directories.

### Checkpoint Management

GraphView maintains checkpoints for both UserCores (last sequence) and ContextBases (Autobase checkpoints). These are stored in the view's Hyperbee under the `meta:` prefix.

### Event Ordering

Events are ordered by timestamp within indexes. Timestamps are encoded as 16-digit zero-padded decimal strings to ensure correct sorting.

### Signature Verification

ContextBase can verify cryptographic signatures on relations (enabled by default). This ensures that only the entity's author can create relations involving that entity.
