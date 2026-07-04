# Contexts and Roles

Contexts provide collaborative workspaces for relations, tags, and moderation. Roles provide access control for contexts.

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

The role registry is stored in an Autobase and includes:

```js
{
  roles: {
    owner: ['*'],                    // All permissions
    admin: ['content.delete', 'user.ban', 'mod.add'],
    mod: ['content.delete', 'user.ban'],
    member: ['content.create', 'content.reply']
  },
  members: {
    '<pubkey>': 'owner'
  }
}
```

### Authorization Checks

Before performing privileged actions, Hypergraph checks:

```js
if (!can(registry, author, requiredPermission)) {
  throw new Error('Not authorized')
}
```

### Moderation

Moderation actions are signed by the author's keypair:

```js
await graph.moderateAction({
  context: moderationContext,
  action: 'content.flag',
  target: 'post/1',
  reason: 'spam'
})
```

Peers validate signatures against the role registry before applying actions.

### Supported Moderation Actions

- `content.flag` - Mark as problematic
- `content.hide` - Hide from view
- `content.remove` - Delete
- `content.reveal` - Unhide

### Creating vs Opening RoleBase

`createRoleBase()` creates a new RoleBase and automatically attaches it to the graph instance. Do NOT call `openRoleBase()` immediately after `createRoleBase()` - this will cause "Autobase failed to open" errors.

Use `openRoleBase(key)` only when opening an existing RoleBase from another peer after replication.

**Correct usage:**
```js
// Creating a new RoleBase
const roleKeyHex = await graph.createRoleBase()
const owner = graph.key.toString('hex')
await graph.roleBase.init(owner)
await graph.roleBase.append(...)

// Opening an existing RoleBase (from another peer)
await graph.openRoleBase(roleKeyHex)
```

## See Also

- [Glossary](glossary.md) - Context and role terminology
- [Storage Model](storage-model.md) - How context and role data is stored
