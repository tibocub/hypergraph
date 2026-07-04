# Storage Model

Hypergraph distributes data across three main data structures to optimize for P2P collaboration and storage efficiency.

## Data Distribution

### UserCore (Single-Writer Hypercore)

**Purpose**: Stores actual user-authored data payloads.

**Events stored:**
- `entity/create` - Entity creation metadata (type, author, timestamp)
- `entity/tombstone` - Entity deletion marker
- `content/append` - Actual content body (text, markdown, etc.)
- `identity/update` - User profile (username, bio)

**Key characteristic**: One UserCore per user - contains only that user's entities and content. Single-writer ensures no conflicts.

### ContextBase (Multi-Writer Autobase)

**Purpose**: Stores collaborative metadata (relations, tags, moderation) that reference entities.

**Events stored:**
- `relation/create` - Directed edge between entities (from, to, type)
- `relation/delete` - Edge removal
- `tag/add` - Tag assignment to entity
- `tag/remove` - Tag removal from entity
- `moderation/action` - Content moderation (flag, hide, remove, reveal)
- `message` - Generic messages

**External Pointer Pattern**:
- Relations store entity IDs (pointers), not full entity data
- Tags reference entity IDs
- Moderation actions reference entity IDs

**Key characteristic**: Multi-writer Autobase - all authorized peers can append. Stores lightweight references to avoid data duplication.

### RoleBase (Multi-Writer Autobase)

**Purpose**: Stores role registry for access control.

**Events stored:**
- `roles/init` - Initialize role registry
- `roles/setRole` - Assign role to member
- `roles/removeMember` - Remove member
- `roles/setRolePermissions` - Define what roles can do
- `roles/addWriter` - Add writer to RoleBase

**Key characteristic**: Centralized role registry that ContextBase consults for authorization. Can be shared across contexts or per-context.

### GraphView (Hyperbee Materialized View)

**Purpose**: Provides fast queries by indexing data from UserCores and ContextBases.

**Indexed data:**
- `n:<id>` - Node records (entities with metadata)
- `c:<entityId>:<seq>` - Content versions
- `nt:<type>:<createdAt>:<id>` - Type index (time-sorted)
- `e:<from>:<type>:<ts>:<to>` - Edge records
- `er:<from>:<type>:<to>` - Edge references
- `t:<tag>:<entityId>` - Tag references
- `m:t:<target>:<ts>:<coreKeyHex>:<seq>` - Moderation by target
- `m:a:<author>:<ts>:<target>:<coreKeyHex>:<seq>` - Moderation by author

**Key characteristic**: Materialized view - duplicates data for query performance. Incremental updates via checkpoints.

## External Pointer Pattern

The external pointer pattern avoids data duplication in Autobase views:

**Why it matters:**
- Autobase copies writer data into the view - large content would be duplicated
- UserCores serve as external storage for actual data (entities, content)
- ContextBases store pointers/references to entities via relations
- This allows reading a specific peer's data without processing the entire merged view
- Provides namespace isolation and single-writer guarantees

**Example:**
```
User A core:
  seq 0: { type: 'entity/create', id: 'post/1', author, timestamp }
  seq 1: { type: 'content/append', entityId: 'post/1', body: 'Hello', contentType: 'text' }

Context Autobase:
  Writer A seq 0: { type: 'relation/create', from: 'post/2', to: 'post/1', relationType: 'reply', ... }
```

The ContextBase only stores the entity IDs (`post/1`, `post/2`), not the full content.

## Storage Efficiency

### Duplication Layers

1. **UserCore → GraphView:**
   - Entity metadata (type, author, timestamp) duplicated
   - Content body duplicated in `c:<entityId>:<seq>` records
   - Identity profiles duplicated

2. **ContextBase → GraphView:**
   - Relation metadata (from, to, type, author) duplicated
   - Tag metadata (entityId, tag, author) duplicated
   - Moderation metadata (action, target, reason, author) duplicated

3. **Autobase Internal:**
   - Autobase copies writer data into its linearized view (by design)
   - This is inherent to Autobase's CRDT merge process

### Storage Estimate

**For 1MB of content:**
- UserCore: ~1MB (content events)
- GraphView content index: ~1MB (full content body duplicated)
- ContextBase: ~10-50KB (relations/tags referencing the content)
- GraphView relation/tag indexes: ~10-50KB (metadata duplicated)

**Total: ~2-3x raw data size**

**Factors affecting storage:**
- Number of relations per entity (more relations = more ContextBase data)
- Number of tags per entity
- Number of moderation actions
- Number of peers (each peer has their own UserCore)

### No Built-in Compaction

- Tombstones remain in logs (not deleted, just marked)
- Old content versions remain in UserCore (append-only)
- Could add garbage collection in future

## View Layer

The view is a Hyperbee instance that holds all indexes as materialized state:

```
View updates are caller-driven:
  1. Call graph.update() after replication
  2. View processes new events from user cores and contexts
  3. Indexes are incrementally updated
  4. Queries run against the view, not raw logs
```

**Key properties:**
- Never query raw logs directly
- Updates are incremental (only process new events)
- Checkpoints track the last processed sequence per core

## See Also

- [Local Data Distribution](local%20data%20distribution.md) - Detailed analysis of storage efficiency and data duplication
- [Glossary](glossary.md) - P2P/Holepunch terminology
