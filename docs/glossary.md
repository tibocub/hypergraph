# Hypergraph Glossary

This glossary explains P2P and Holepunch terminology used throughout Hypergraph's documentation.

## Holepunch Stack Terms

### Hypercore
Append-only log data structure. Each Hypercore is a single-writer log that can be replicated between peers. Used in Hypergraph for UserCores (per-user data storage).

### Corestore
Factory for managing Hypercore instances. Provides namespace isolation to prevent core key conflicts. Used in Hypergraph to manage UserCores, ContextBases, and RoleBases.

### Autobase
Multi-writer CRDT built on Hypercore. Merges multiple writer cores into a single deterministic view using a causal DAG. Used in Hypergraph for ContextBases (collaborative contexts) and RoleBase (role registry).

### Hyperbee
Key-value database built on Hypercore. Provides materialized views and efficient range queries. Used in Hypergraph for GraphView (indexed queries).

### Hyperswarm
P2P networking library using DHT (Distributed Hash Table) for peer discovery. Peers announce topics on the DHT and discover each other. Used by applications to replicate Hypergraph data.

### DHT (Distributed Hash Table)
Decentralized key-value store used for peer discovery. Peers announce their presence under a topic, and other peers can discover them by looking up that topic.

### Discovery Key
Hash of a Hypercore's public key, used for DHT announcements. Peers join a topic based on the discovery key to discover each other.

### Bootstrap
Initial data needed to join an existing graph. Includes the graph's version, user core key, contexts, and networking information. Exported by existing peers and used by new peers to join.

## Hypergraph-Specific Terms

### UserCore
Single-writer Hypercore that stores a user's personal data (entities, content, identity). Each device has its own UserCore, but all devices share the same identity key.

### ContextBase
Multi-writer Autobase instance for collaborative data (relations, tags, moderation). Each context is isolated and can have different write modes (open/closed).

### RoleBase
Multi-writer Autobase instance for role-based access control. Stores role registry with member→role mappings and role→permission mappings.

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

### Identity Key vs Device Key
- **Identity key**: Long-term cryptographic identity (same across all devices)
- **Device key**: Per-device keypair (each device has its own)

### Mnemonic Recovery
12-word phrase that can recover a user's identity key. Allows users to restore their identity across devices.

### Tombstone
Marker indicating that an entity has been deleted. Since Hypergraph is append-only, data is never actually deleted—just marked as deleted.

### Checkpoint
Record of the last processed sequence number for a core. Used by GraphView to track progress and avoid reprocessing events.

### Namespace Isolation
Corestore feature that prevents core key conflicts by prefixing core names with a namespace string. Used to isolate different contexts and RoleBase instances.

### Writer Authorization
Process of adding a peer as a writer to a ContextBase. In open mode, writers are added automatically. In closed mode, writers must be approved based on role permissions.

### Relation
Directed edge between two entities (e.g., reply-to, likes, follows). Stored in ContextBase as collaborative data.

### Tag
Author-scoped label for an entity (e.g., "important", "spam"). Only the entity's author can tag it. Stored in ContextBase.

### Moderation Action
Signed event that applies moderation to an entity (flag, hide, remove, reveal). Stored in ContextBase and validated against the role registry.

## Common P2P Concepts

### Peer
Node in the P2P network. In Hypergraph, each peer is a device running the application with its own UserCore.

### Replication
Process of synchronizing data between peers. Hypergraph does not handle networking directly—replication is the responsibility of the application (typically via Hyperswarm).

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
