# Hypergraph's Local Data Distribution: Assessment

For the factual breakdown of what's stored where (UserCore, ContextBase, RoleBase, ScopeBase,
GraphView) and their exact index shapes, see [Storage Model](storage-model.md) — this
document focuses on the resulting tradeoffs instead, to avoid maintaining the same factual
content in two places.

## Moderation & Access Control Flow

1. ContextBase receives a moderation event
2. ContextBase consults the attached RoleBase (`#isModerationAllowed`); if the RoleBase hasn't
   synced yet, the event is queued and the next `update()` decides it (it no longer waits inside
   apply, which held up the whole context)
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
   - Type, tag and edge indexes (author queries scan the author's log)
   - Worth the storage cost for P2P apps

### Weaknesses

1. **Index and block overhead:**
   - ~3x the event data per item for small items (measured, see
     [Storage Model](storage-model.md#storage-estimate-measured); was ~5x before compact keys)
   - ~183 bytes of on-disk overhead per stored block, 11 blocks per typical item — now the
     largest single cost
   - No compression at the storage layer
   - Content bodies are no longer copied into GraphView (it keeps a pointer into the author's
     log), and indexes use compact binary keys — but contexts created before keep text keys

2. **Replaying a large context is expensive** — but no longer required:
   - A peer that replays rebuilds the whole view and Autobase commits it at once (a 1M-entry
     context does not fit an 8 GB heap that way)
   - Since spec 003, a peer far behind fast-forwards to the creator-signed state instead, and
     since spec 004 a listing can come from the context alone: a 1M-entry archive is browsable
     1.2 s after joining, with 60 MB on disk

3. **No garbage collection:**
   - Tombstones remain in logs
   - Old content versions persist
   - Could add in future

4. **`getByAuthor()` isn't indexed** — it reads every event in the author's log. Fine for a
   person's posts, slow for an account holding a large archive.

### Conclusion

The data distribution model is **sound for P2P applications** where:
- Storage is less constrained than network bandwidth
- Query performance is critical
- Auditability and access control are important

The external pointer pattern is correctly implemented and matches Autobase's recommended approach. The role/moderation system is flexible enough for most use cases (forums, social networks, collaborative docs), and now has a genuinely separate read-access system (`ScopeBase`) for confidentiality, rather than trying to force write-access roles to also carry that meaning.

Storage efficiency could be improved with:
- Content deduplication (if same content posted multiple times)
- Garbage collection for old versions
- Fewer index entries per item (each costs a block, ~183 B on disk)

Measurement changed that assessment (`specs/002-scale-indexing/`, `bench/README.md`): at
community-archive scale, local storage and the cost of joining are the bottleneck, not network
latency. See `specs/research/scaling-study.md` for what can be done.

## See Also

- [Storage Model](storage-model.md) - The factual data distribution and index shapes this assessment is based on
- [Read Permission](read-permission.md) - The separate read-access system
