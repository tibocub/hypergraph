# Critical Implementation Details

## RoleBase: createRoleBase vs openRoleBase

**Do NOT call `openRoleBase()` immediately after `createRoleBase()`**.

`createRoleBase()` already attaches the RoleBase to the graph instance. Calling `openRoleBase()` again with the same key attempts to reopen an already-open instance, causing "Autobase failed to open" errors.

More generally, this is one case of a broader rule: **two separate object instances of the
same Autobase key can never share one Corestore at all** (confirmed directly with a minimal
repro — hangs immediately). This applies to any Autobase-backed structure (ContextBase,
RoleBase, ScopeBase), not just RoleBase. Multi-peer test/app scenarios always need separate
Corestores with real replication between them.

**Correct usage**:
```js
// Creating a new RoleBase
const roleKeyHex = await graph.createRoleBase()
const owner = graph.key.toString('hex')
await graph.roleBase.init(owner)
await graph.roleBase.append(...)

// Opening an existing RoleBase (from another peer, over its OWN separate Corestore)
await graph.openRoleBase(roleKeyHex)
```

## Corestore Namespacing Is Required for Any New Autobase-Backed Structure

`RoleBase` is the one exception in the whole system that constructs its Autobase directly on
the raw Corestore, with no namespacing. This is not a pattern to copy — it caused a real,
reproduced hang when `ScopeBase` initially mirrored it. See
[Corestore Namespaces](corestore-namespaces.md) for the full story.

## ContextBase KeyPair Handling

**Do NOT pass keyPair to Autobase constructor**. Let Autobase handle local writer creation automatically.

This matches the old hypergraph behavior and avoids "Autobase failed to open" errors. Writers are managed via the `addWriter()` method after the context is ready.

## GraphView Update is Caller-Driven

The application must call `graph.update()` after replication to process new events. GraphView does not automatically update.

## Restarting the Same Peer Requires the App to Persist deviceKeyPair Itself

Confirmed directly: `new Hypergraph(store)` with no explicit `deviceKeyPair` generates a
fresh, random one on every construction — even against the exact same Corestore directory.
Hypergraph does not persist or restore this automatically. See
[Multi-Device Support](multi-device-support.md) for the correct pattern and what's confirmed
to work once an app does this correctly (identity, prior data, and writer status are all
preserved across a restart).

## Windows File Locking

Windows has aggressive file locking that can cause EPERM errors during cleanup when RocksDB handles are still open. Use retry logic with exponential backoff when deleting test directories.

## Checkpoint Management

GraphView maintains checkpoints for both UserCores (last sequence) and ContextBases (a simple
view-length counter, not a linearizer/indexer clock — see
[Autobase Integration](autobase-integration.md)). These are stored in the view's Hyperbee
under the `meta:` prefix.

## Event Ordering

Events are ordered by timestamp within time-sorted indexes (`nt:`, `nc:`, edge indexes).
Timestamps are encoded as 16-digit zero-padded decimal strings to ensure correct sorting. The
default, un-namespaced `n:` index is NOT chronologically ordered across multiple authors —
see [Index Structure](index-structure.md).

## Signature Verification Proves Authorship, Not Ownership

ContextBase verifies cryptographic signatures on relations, moderation actions, and writer
changes (enabled by default, hard-rejecting anything that fails). This proves `event.author`
is genuinely whoever signed the event — it does **not** restrict *what* an authorized writer
can relate. `relate()` deliberately performs no ownership check on `from`/`to` at all (any
authorized writer can create a relation between any two entity ids, regardless of who created
them) — this is required for the normal case of commenting on someone else's post, which
necessarily means relating your own comment to an entity you don't own.

Tags work differently: `tag()` **is** author-restricted — only an entity's own author can tag
it (confirmed directly: hypergraph throws otherwise). If community/moderator-applied labeling
is ever needed, that's a `relate()` or moderation-event use case, not `tag()`.

`moderateAction()` has its own client-side permission pre-check (mirroring `addWriter()`) —
an unauthorized caller gets an immediate, clear error rather than a silent no-op whose
rejection only surfaces later, at the apply layer.

## Backward Compatibility for Growing Event Types

Several event types have grown optional trailing fields over time at the compact-encoding
layer (not just the JSON view layer) — e.g. `relation/create`'s `value`, `content/append`'s
encryption metadata. These need an explicit `state.start < state.end` guard on decode, or
already-persisted events without those bytes will crash with "Out of bounds" the moment
they're replayed — this happened for real once (round 33) before the guard was added. Any new
optional field on an existing event type needs the same treatment.

## See Also

- [Replication Flow](replication-flow.md) - DHT timing and writer authorization
- [Corestore Namespaces](corestore-namespaces.md) - Namespacing rules for Autobase-backed structures
