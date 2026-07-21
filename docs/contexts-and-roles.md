# Contexts and Roles

Contexts provide collaborative workspaces for relations, tags, and moderation. Roles provide
write-access control for contexts. (For read-access — controlling who can decrypt content,
a separate concern — see [Read Permission](read-permission.md).)

## Contexts

### What is a Context?

A context is a collaborative workspace for relations, tags, and moderation events. Each context is an isolated Autobase instance.

### Write Modes

Contexts support two write modes:

**Open Mode (default)**
- No role/privilege checks
- Writers can be added freely via `context.addWriter(coreKey)`
- Suitable for public contexts

**Closed Mode**
- Writers must be explicitly authorized
- Requires an attached RoleBase
- Author must have `context.write` privilege
- Suitable for private or moderated contexts

Regardless of write mode, `moderateAction()` and writer-change events are always
signature-verified and permission-checked against whichever RoleBase is attached — this is
thoroughly tested (see `test/brittle/networking/writer-authorization.js`,
`test/brittle/core/moderation.js`, `test/brittle/core/contexts.js`), including cross-peer
scenarios and the race between a RoleBase and a context replicating concurrently.

### Context Isolation

Contexts are isolated at two levels:

1. **Logical isolation**: Different Autobase bootstrap keys create separate contexts
2. **Physical isolation**: Corestore namespaces prevent core conflicts

### Creating Contexts

```js
// Create an open context
const ctxKey = await graph.createContext({ writeMode: 'open' })
const ctx = await graph.openContext(ctxKey, { writeMode: 'open' })

// Create a closed context (requires RoleBase)
const ctxKey = await graph.createContext({ writeMode: 'closed' })
const ctx = await graph.openContext(ctxKey, { writeMode: 'closed' })
```

## Roles

### Role Registry

The role registry is stored in an Autobase. This is `initRegistry()`'s actual, real default
(see `src/roles-registry.js`) — permission strings beyond these are free-form; an app can
grant any role any subset via `roles/setRolePermissions`:

```js
{
  version: 1,
  roles: {
    owner: ['*'],                                                                    // All permissions
    admin: ['mod.add', 'mod.remove', 'content.remove', 'content.hide', 'content.reveal', 'context.write'],
    mod: ['content.hide', 'content.remove', 'content.flag'],
    member: []
  },
  members: {
    '<pubkey>': 'owner'
  }
}
```

A pubkey not explicitly listed in `members` falls back to the `member` role if one exists.

### Authorization Checks

Before performing privileged actions, Hypergraph checks:

```js
if (!can(registry, author, requiredPermission)) {
  throw new Error('Not authorized')
}
```

This happens both client-side (a fast, clear error for the caller — `addWriter()` and
`moderateAction()` both check this before appending) and at the apply layer on every peer
that replicates the event (the actual, enforced boundary — signature verified first, then
permission-checked; an unauthorized action is hard-rejected and never indexed at all,
confirmed directly via both filtered and unfiltered queries).

### Moderation

Moderation actions are signed by the author's keypair — `keyPair` is required:

```js
await graph.moderateAction({
  context: moderationContext,
  action: 'content.flag',
  target: 'post/1',
  reason: 'spam',
  keyPair: myKeyPair
})
```

Peers validate signatures against the role registry before applying actions. An unauthorized
attempt throws immediately, client-side, rather than silently never taking effect.

### Supported Moderation Actions

- `content.flag` - Mark as problematic
- `content.hide` - Hide from view
- `content.remove` - Delete
- `content.reveal` - Unhide

Hypergraph only records these as signed, permission-gated facts — interpreting them (e.g.
"hide after 3 flags") is entirely application-level policy, not hypergraph's job.

### Writer Changes

Writers can be added or removed from a context, both signed and permission-gated in closed
mode:

```js
await context.addWriter(newWriterKey, { keyPair: myKeyPair })
await context.removeWriter(writerKeyToRemove, { keyPair: myKeyPair })
```

### Creating vs Opening RoleBase

`createRoleBase()` creates a new RoleBase and automatically attaches it to the graph instance. Do NOT call `openRoleBase()` immediately after `createRoleBase()` - this will cause "Autobase failed to open" errors.

Use `openRoleBase(key)` only when opening an existing RoleBase from another peer, over its own
separate Corestore, after replication. More generally: two separate object instances of the
same Autobase key can never share one Corestore at all — this applies to any Autobase-backed
structure, not just RoleBase.

**Correct usage:**
```js
// Creating a new RoleBase
const roleKeyHex = await graph.createRoleBase()
const owner = graph.key.toString('hex')
await graph.roleBase.init(owner)
await graph.roleBase.append(...)

// Opening an existing RoleBase (from another peer, over its own Corestore)
await graph.openRoleBase(roleKeyHex)
```

## See Also

- [Read Permission](read-permission.md) - Read-access model: scopes, sealed key grants, content encryption
- [Glossary](glossary.md) - Context and role terminology
- [Storage Model](storage-model.md) - How context and role data is stored
