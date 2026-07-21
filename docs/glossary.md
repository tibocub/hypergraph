# Hypergraph Glossary

This glossary explains P2P and Holepunch terminology used throughout Hypergraph's documentation.

## Holepunch Stack Terms

### Hypercore
Append-only log data structure. Each Hypercore is a single-writer log that can be replicated between peers. Used in Hypergraph for UserCores (per-user data storage).

### Corestore
Factory for managing Hypercore instances. Provides namespace isolation to prevent core key conflicts. Used in Hypergraph to manage UserCores, ContextBases, RoleBase, and ScopeBase — though RoleBase itself does not namespace its own session (see Namespace Isolation, below).

### Autobase
Multi-writer CRDT built on Hypercore. Merges multiple writer cores into a single deterministic view using a causal DAG. Used in Hypergraph for ContextBase (collaborative contexts), RoleBase (role registry), and ScopeBase (read-permission key grants).

### Hyperbee
Key-value database built on Hypercore. Provides materialized views and efficient range queries. Used in Hypergraph for GraphView (indexed queries), and internally by ContextBase/RoleBase/ScopeBase for their own Autobase views.

### Hyperswarm
P2P networking library using DHT (Distributed Hash Table) for peer discovery. Peers announce topics on the DHT and discover each other. Used by applications to replicate Hypergraph data, either manually or via `HypergraphNetwork`.

### DHT (Distributed Hash Table)
Decentralized key-value store used for peer discovery. Peers announce their presence under a topic, and other peers can discover them by looking up that topic.

### Discovery Key
Hash of a Hypercore's public key, used for DHT announcements. Peers join a topic based on the discovery key to discover each other.

### Bootstrap
Initial data needed to join an existing graph. `graph.export()` produces one shape (version, user core key, contexts, timestamp); `HypergraphNetwork.generateBootstrap()` produces a different, networking-oriented shape (topic, owner core, contexts, app metadata) consumed by `.connectFromBootstrap()`. There is no `graph.join()` method — joining always goes through `HypergraphNetwork`, or a custom flow built on `export()`'s shape.

## Hypergraph-Specific Terms

### UserCore
Single-writer Hypercore that stores a user's personal data (entities, content, identity). Each device has its own UserCore (and its own random device key), but all devices share the same identity key and the same, deterministically-derived encryption keypair.

### ContextBase
Multi-writer Autobase instance for collaborative data (relations, tags, moderation). Each context is isolated and can have different write modes (open/closed).

### RoleBase
Multi-writer Autobase instance for role-based (write) access control. Stores role registry with member→role mappings and role→permission mappings. Notably, this is the one structure in the system that does NOT namespace its Corestore session — see Namespace Isolation, below.

### ScopeBase
Multi-writer Autobase instance for read-permission scopes — sealed key grants that control who can decrypt a given piece of content. A separate system from RoleBase/write-access; see [Read Permission](read-permission.md).

### GraphView
Materialized view built on Hyperbee that indexes data from UserCores and ContextBases for efficient queries. Maintains checkpoints to track progress.

### External Pointer Pattern
Design pattern where large data is stored in separate Hypercores (UserCores) and Autobases (ContextBases) store pointers/references to this data. Avoids data duplication in Autobase views.

### CRDT (Conflict-free Replicated Data Type)
Data structure that can be replicated across multiple peers and merged without conflicts. Autobase uses a causal DAG to linearize events.

### Materialized View
Pre-computed view of data that is incrementally updated as new events arrive. GraphView is a materialized view that indexes entities, relations, tags, and content.

### Write Modes
ContextBase supports two write modes:
- **Open**: Anyone can write (no permission checks)
- **Closed**: Role-based permissions (requires RoleBase)

### Identity Key vs Device Key vs Encryption Keypair
- **Identity key**: Long-term cryptographic identity (same across all devices), derived from a 12-word mnemonic
- **Device key**: Per-device signing keypair (Ed25519) — confirmed genuinely random, not derived from the mnemonic
- **Encryption keypair**: A separate, per-*identity* (not per-device) `crypto_box`/X25519 keypair, deterministically derived from the same mnemonic — used to seal read-scope keys so any of a person's devices can independently open them (see [Read Permission](read-permission.md))

### Mnemonic Recovery
12-word phrase that can recover a user's identity key (and its derived encryption keypair). Allows users to restore their identity across devices — this is also, currently, hypergraph's entire mechanism for "syncing a new device"; any nicer UX around it (QR codes, a pairing flow) is an application-layer concern built on top of this.

### Read-Scope / Epoch / Sealed Key
See [Read Permission](read-permission.md) for the full design. A **scope** is a named,
key-holder-restricted read boundary. An **epoch** is a version number for a scope's key —
rotated when membership changes; old content stays decryptable by whoever held that epoch's
key, even after later rotations. A **sealed key** is a scope's symmetric key, encrypted
(`crypto_box_seal`) to one specific recipient's encryption public key — safe to replicate
openly, since only that recipient can actually open it.

### Tombstone
Marker indicating that an entity has been deleted. Since Hypergraph is append-only, data is never actually deleted—just marked as deleted.

### Checkpoint
Record of the last processed sequence (UserCore) or view length (ContextBase/RoleBase/ScopeBase) for a core. Used by GraphView to track progress and avoid reprocessing events.

### Namespace Isolation
Corestore feature that prevents core key conflicts by prefixing core names with a namespace string. ContextBase and ScopeBase both namespace their Autobase's Corestore session this way. **RoleBase does not** — it's the one exception in the system, and mirroring its lack of namespacing for a new Autobase-backed structure has caused a real, reproduced bug before (see [Corestore Namespaces](contributors/corestore-namespaces.md)).

### Writer Authorization
Process of adding a peer as a writer to a ContextBase. In open mode, writers are added automatically. In closed mode, writers must be approved based on role permissions. Writers can also be removed the same way (`removeWriter()`).

### Relation
Directed edge between two entities (e.g., reply-to, likes, follows), with an optional numeric `value` (e.g. a vote's weight). Stored in ContextBase as collaborative data. Any authorized writer can relate any two entities — signature verification proves who created the relation, not that they own the entities it connects (this is required for the normal case of commenting on someone else's post).

### Tag
Author-scoped label for an entity (e.g., "important", "spam"). Only the entity's author can tag it. Stored in ContextBase.

### Moderation Action
Signed event that applies moderation to an entity (flag, hide, remove, reveal). Stored in ContextBase and validated against the role registry — an unauthorized attempt is rejected both client-side (immediately, with a clear error) and at the apply layer on every peer (the actual enforced boundary).

## Common P2P Concepts

### Peer
Node in the P2P network. In Hypergraph, each peer is a device running the application with its own UserCore.

### Replication
Process of synchronizing data between peers. Hypergraph does not handle networking directly—replication is the responsibility of the application (typically via Hyperswarm, either manually or via `HypergraphNetwork`).

### Mesh Network
Network topology where peers connect to multiple other peers, forming a mesh. Data can relay through multiple hops to reach all peers.

### Append-Only
Data structure where new data is only added, never modified or deleted. Hypergraph is append-only—deletes are implemented as tombstones.

### Deterministic
Produces the same output given the same input. Autobase's view is deterministic—all peers processing the same events will produce the same merged view.

### Eventual Consistency
Property of distributed systems where all peers eventually converge to the same state. Hypergraph achieves eventual consistency through Autobase's CRDT merge process.

### Causal DAG (Directed Acyclic Graph)
Graph where edges represent causal relationships between events. Autobase uses a causal DAG to linearize events in a deterministic order.

### Linearization
Process of ordering events from multiple writers into a single sequence. Autobase linearizes events using a causal DAG based on causal references.
