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

## Corestore Namespacing Is Required for Any Autobase-Backed Structure

Every Autobase-backed structure (`ContextBase`, `RoleBase`, `ScopeBase`) namespaces its own
Corestore session — no exceptions. `RoleBase` didn't originally, which caused two real,
confirmed bugs: a hang when `ScopeBase` was built by mirroring that (un-namespaced) pattern,
and — more seriously — closing a `RoleBase` alone taking down the entire shared Corestore
session for every other consumer of it, since the un-namespaced session it held was the exact
same object everything else was also holding a reference to. Fixed by namespacing `RoleBase`
too. See [Corestore Namespaces](corestore-namespaces.md) for the full story and the mechanism.

## ContextBase KeyPair Handling

**Do NOT pass keyPair to Autobase constructor**. Let Autobase handle local writer creation automatically.

This matches the old hypergraph behavior and avoids "Autobase failed to open" errors. Writers are managed via the `addWriter()` method after the context is ready.

## GraphView Update is Caller-Driven

The application must call `graph.update()` after replication to process new events. GraphView
does not automatically update. (Your own writes index themselves, and `openUserCore()` starts
downloading the other user's log in the background — but indexing what arrived still waits for
`update()`.)

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
is genuinely whoever signed the event. On top of that, apply **rejects a `relation/create`
whose `from` the signer does not own** (the author segment embedded in the `from` id must equal
the event's `author`), identically on every peer. `to` is unrestricted, which is what the normal
case needs: commenting on someone else's post means relating your own comment (`from`, yours)
to an entity you don't own (`to`). `relation/delete` deliberately has no such check — any
authorized writer can remove a relation. See [Storage Model](../storage-model.md).

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

## Every Peer of a Context Must Apply It the Same Way

Since spec 003 a context records how it is applied (`context/init`: topology version, app rules
id). An older hypergraph version doesn't understand that record and would make every writer an
indexer, so **mixed versions in one context are unsupported**; a peer that finds a version it
doesn't know, or rules other than the recorded ones, stops applying the context with a clear reason
(`status().interrupted`) instead of building a different index. App rules must be deterministic for
the same reason. Older peers also reject relations carrying `data` (spec 004).

In version 1 and 2 contexts, permission checks in apply consult the attached RoleBase, a separate
log that reaches each peer at its own pace, so two peers can decide the same event differently —
harmless with one indexer, which is why version 2 contexts keep the creator as their only indexer.
Version 3 contexts (the default since spec 005) take every decision from their own role table,
which is what lets several indexers agree.

## Joining Peers Fast-Forward

A peer ≥ 16 Autobase nodes behind adopts the indexers' signed state instead of replaying, and
trusts it: built-in checks and app rules are not re-run on history. Bulk writes produce few
Autobase nodes, so a small context written in a couple of bulk calls is usually replayed (which is
cheap) rather than fast-forwarded. `fastForward: false` makes a peer always replay.

## See Also

- [Replication Flow](replication-flow.md) - DHT timing and writer authorization
- [Corestore Namespaces](corestore-namespaces.md) - Namespacing rules for Autobase-backed structures
