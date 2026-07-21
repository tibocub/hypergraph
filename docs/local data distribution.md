# Hypergraph's Local Data Distribution: Assessment

For the factual breakdown of what's stored where (UserCore, ContextBase, RoleBase, ScopeBase,
GraphView) and their exact index shapes, see [Storage Model](storage-model.md) — this
document focuses on the resulting tradeoffs instead, to avoid maintaining the same factual
content in two places.

## Moderation & Access Control Flow

1. ContextBase receives a moderation event
2. ContextBase consults the attached RoleBase (`#isModerationAllowed`, with a bounded retry
   for the case where the RoleBase hasn't synced yet)
3. RoleBase checks if the author has permission for that action
4. Unauthorized attempts are hard-rejected at the apply layer — confirmed directly that the
   fact is never recorded at all in that case, not "recorded but filtered later"

**Different rules per data:** each ContextBase can have its own RoleBase attached, so
different contexts can enforce different moderation policies (e.g. a "general" context that
only allows flagging, an "admin" context that allows removal).

**Read-access is a separate system** ([Read Permission](read-permission.md), `ScopeBase`) —
it doesn't reuse RoleBase's write-permission model directly, though it does consult the same
RoleBase for `scope.create`/`scope.grant`/`scope.revoke` permission checks. Worth keeping in
mind that write-access and read-access are two independent axes here, not one system with two
names.

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
   - Type/author (indexed), tag (full-scan today), and edge indexes
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

4. **Tag queries aren't indexed yet** — a full scan with a per-node check, unlike type/author
   queries which are. Worth revisiting if this becomes a real bottleneck.

### Conclusion

The data distribution model is **sound for P2P applications** where:
- Storage is less constrained than network bandwidth
- Query performance is critical
- Auditability and access control are important

The external pointer pattern is correctly implemented and matches Autobase's recommended approach. The role/moderation system is flexible enough for most use cases (forums, social networks, collaborative docs), and now has a genuinely separate read-access system (`ScopeBase`) for confidentiality, rather than trying to force write-access roles to also carry that meaning.

Storage efficiency could be improved with:
- Content deduplication (if same content posted multiple times)
- Garbage collection for old versions
- Optional "lightweight" GraphView mode (indexes only, no content body)
- A dedicated tag index, if tag-heavy queries become common

However, these optimizations would add complexity and may not be worth it for typical P2P use cases where storage is cheap and network latency is the bottleneck.

## See Also

- [Storage Model](storage-model.md) - The factual data distribution and index shapes this assessment is based on
- [Read Permission](read-permission.md) - The separate read-access system
