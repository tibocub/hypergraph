# Critical Implementation Details

## RoleBase: createRoleBase vs openRoleBase

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

## ContextBase KeyPair Handling

**Do NOT pass keyPair to Autobase constructor**. Let Autobase handle local writer creation automatically.

This matches the old hypergraph behavior and avoids "Autobase failed to open" errors. Writers are managed via the `addWriter()` method after the context is ready.

## GraphView Update is Caller-Driven

The application must call `graph.update()` after replication to process new events. GraphView does not automatically update.

## Windows File Locking

Windows has aggressive file locking that can cause EPERM errors during cleanup when RocksDB handles are still open. Use retry logic with exponential backoff when deleting test directories.

## Checkpoint Management

GraphView maintains checkpoints for both UserCores (last sequence) and ContextBases (Autobase checkpoints). These are stored in the view's Hyperbee under the `meta:` prefix.

## Event Ordering

Events are ordered by timestamp within indexes. Timestamps are encoded as 16-digit zero-padded decimal strings to ensure correct sorting.

## Signature Verification

ContextBase can verify cryptographic signatures on relations (enabled by default). This ensures that only the entity's author can create relations involving that entity.

## See Also

- [Replication Flow](replication-flow.md) - DHT timing and writer authorization
