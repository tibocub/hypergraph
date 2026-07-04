# Hypergraph's Local Data Distribution

This document provides a fact-based analysis of how Hypergraph distributes data across its underlying data structures (UserCore, ContextBase, RoleBase, GraphView), assessing storage efficiency, data duplication, and the flexibility of the moderation/role system.

## Data Distribution by Data Structure

### UserCore (Single-Writer Hypercore)

**Purpose:** Stores actual user-authored data payloads.

**Events stored:**
- `entity/create` - Entity creation metadata (type, author, timestamp)
- `entity/tombstone` - Entity deletion marker
- `content/append` - Actual content body (text, markdown, etc.)
- `identity/update` - User profile (username, bio)

**Evidence from code:**
- `hypergraph.js` lines 204-212: `entity/create` appended to UserCore
- `hypergraph.js` lines 261-268: `entity/tombstone` appended to UserCore
- `hypergraph.js` lines 297-305: `content/append` appended to UserCore
- `hypergraph.js` lines 347-356: `identity/update` appended to UserCore

**Key characteristic:** One UserCore per user - contains only that user's entities and content. Single-writer ensures no conflicts.

### ContextBase (Multi-Writer Autobase)

**Purpose:** Stores collaborative metadata (relations, tags, moderation) that reference entities.

**Events stored:**
- `relation/create` - Directed edge between entities (from, to, type)
- `relation/delete` - Edge removal
- `tag/add` - Tag assignment to entity
- `tag/remove` - Tag removal from entity
- `moderation/action` - Content moderation (flag, hide, remove, reveal)
- `message` - Generic messages

**Evidence from code:**
- `context-base.js` lines 159-178: `#applyView` switch statement handles all event types

**External Pointer Pattern:**
- Relations store entity IDs (pointers), not full entity data
- Tags reference entity IDs
- Moderation actions reference entity IDs
- Evidence: `context-base.js` lines 373-399 (relation indexing stores IDs only)

**Key characteristic:** Multi-writer Autobase - all authorized peers can append. Stores lightweight references to avoid data duplication.

### RoleBase (Multi-Writer Autobase)

**Purpose:** Stores role registry for access control.

**Events stored:**
- `roles/init` - Initialize role registry
- `roles/setRole` - Assign role to member
- `roles/removeMember` - Remove member
- `roles/setRolePermissions` - Define what roles can do
- `roles/addWriter` - Add writer to RoleBase

**Evidence from code:**
- `role-base.js` lines 101-135: `#applyRolesEvent` handles all role events

**Key characteristic:** Centralized role registry that ContextBase consults for authorization. Can be shared across contexts or per-context.

### GraphView (Hyperbee Materialized View)

**Purpose:** Provides fast queries by indexing data from UserCores and ContextBases.

**Indexed data:**
- `n:<id>` - Node records (entities with metadata)
- `c:<entityId>:<seq>` - Content versions
- `nt:<type>:<createdAt>:<id>` - Type index (time-sorted)
- `e:<from>:<type>:<ts>:<to>` - Edge records
- `er:<from>:<type>:<to>` - Edge references
- `t:<tag>:<entityId>` - Tag references
- `m:t:<target>:<ts>:<coreKey>:<seq>` - Moderation by target
- `m:a:<author>:<ts>:<target>:<coreKey>:<seq>` - Moderation by author

**Evidence from code:**
- `view.js` lines 108-123: Processes UserCore events
- `view.js` lines 127-154: Processes ContextBase events
- `view.js` lines 186-212: Entity indexing
- `view.js` lines 235-243: Content indexing

**Key characteristic:** Materialized view - duplicates data for query performance. Incremental updates via checkpoints.

## Data Duplication Analysis

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

### External Pointer Pattern Benefits

**Reduces duplication:**
- ContextBase stores entity IDs (32-64 bytes) instead of full entity data
- Large content stays in UserCore, ContextBase only stores references
- Evidence: `context-base.js` lines 373-399 shows relation indexing stores only IDs

**Enables peer-specific access:**
- Can read a specific peer's UserCore without processing entire merged view
- Useful for "show me only user X's posts" queries

### Storage Efficiency Estimate

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

**No built-in compaction:**
- Tombstones remain in logs (not deleted, just marked)
- Old content versions remain in UserCore (append-only)
- Could add garbage collection in future

## Moderation & Role-Based Access Control

### Role System Flexibility

**RoleBase capabilities:**
- Member → role mappings
- Role → permission mappings
- Per-context or shared RoleBase instances
- Evidence: `role-base.js` lines 101-135

**Authorization flow:**
1. ContextBase receives moderation event
2. ContextBase consults RoleBase via `#isModerationAllowed`
3. RoleBase checks if author has permission for action
4. Evidence: `context-base.js` lines 322-341

**Different rules per data:**
- Each ContextBase can have its own RoleBase
- Different contexts can enforce different moderation policies
- Example: "general" context allows flagging, "admin" context allows removal

### Moderation Actions

**Supported actions (v1):**
- `content.flag` - Mark as problematic
- `content.hide` - Hide from view
- `content.remove` - Delete
- `content.reveal` - Unhide
- Evidence: `context-base.js` line 235

**Moderation event structure:**
- Signed by author (cryptographic signature)
- Includes target (entity ID), action, reason, timestamp
- Evidence: `context-base.js` lines 184-223 (hashing/verification)

**Policy enforcement:**
- Application-level responsibility
- Hypergraph only records facts (who did what to what)
- Evidence: `hypergraph.js` lines 889-891 (documentation)

### Access Control Model

**Write modes:**
- `open` - Anyone can write to ContextBase (auto-add writers)
- `closed` - Role-based permissions (writer-request/approval flow)
- Evidence: `context-base.js` lines 111-128

**Role-based permissions:**
- RoleBase defines who can perform which actions
- ContextBase checks RoleBase before applying moderation
- Can restrict: who can tag, who can relate, who can moderate

## Assessment

### Strengths

1. **External pointer pattern correctly implemented:**
   - Avoids duplicating large content in Autobase
   - ContextBase stores lightweight references
   - Matches Autobase's recommended pattern (blob-base example)

2. **Flexible role system:**
   - Per-context roles
   - Fine-grained permissions
   - Can share RoleBase across contexts or keep separate

3. **Auditable moderation:**
   - Signed moderation events
   - Immutable audit trail
   - Context-specific policies

4. **Query performance:**
   - GraphView provides fast queries
   - Type indexes, tag indexes, edge indexes
   - Worth the storage cost for P2P apps

### Weaknesses

1. **GraphView duplication:**
   - 2-3x storage overhead vs raw data
   - Content body fully duplicated
   - No built-in compaction

2. **Autobase internal duplication:**
   - Autobase's linearized view adds another layer
   - Inherent to CRDT design, unavoidable

3. **No garbage collection:**
   - Tombstones remain in logs
   - Old content versions persist
   - Could add in future

### Conclusion

The data distribution model is **sound for P2P applications** where:
- Storage is less constrained than network bandwidth
- Query performance is critical
- Auditability and access control are important

The external pointer pattern is correctly implemented and matches Autobase's recommended approach. The role/moderation system is flexible enough for most use cases (forums, social networks, collaborative docs).

Storage efficiency could be improved with:
- Content deduplication (if same content posted multiple times)
- Garbage collection for old versions
- Optional "lightweight" GraphView mode (indexes only, no content body)

However, these optimizations would add complexity and may not be worth it for typical P2P use cases where storage is cheap and network latency is the bottleneck.