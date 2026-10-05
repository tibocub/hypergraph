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

`moderateAction()` is always signature-verified and permission-checked against whichever
RoleBase is attached, regardless of write mode — this is thoroughly tested (see
`test/brittle/networking/writer-authorization.js`, `test/brittle/core/moderation.js`,
`test/brittle/core/contexts.js`), including cross-peer scenarios and the race between a
RoleBase and a context replicating concurrently.

Writer-change events (`roles/addWriter`/`roles/removeWriter` at the context level) are
different: they're only signature-verified and permission-checked in **closed** mode. In
**open** mode they're applied with no check at all — this is intentional, not an oversight:
author-forgery protection has nothing to protect in a mode where anyone can already add
themselves as a writer.

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

Both options also accept `rules` (see [App Rules](#app-rules)) and `fastForward` (see
[Joining a Context](#joining-a-context-fast-forward)).

### Who Confirms a Context (Indexers)

Every context has **writers** (who may append) and **indexers** (whose devices confirm the order
of everyone's writes and sign the result). Until confirmed, recent writes are already applied
everywhere but their order can still change; confirmed history never changes.

| context | roles come from | indexers | writers added later |
|---|---|---|---|
| `createContext()` (version 3, default) | the context's own role table | the owner, plus members whose role allows indexing (admins by default) | index iff their member's role allows it |
| `createContext({ roles: 'rolebase' })` (version 2) | the attached RoleBase, shared across contexts | the creator only | write, don't index |
| created before spec 003 (version 1) | the attached RoleBase | every writer | index too |

Indexers acknowledge new history about once a second, so a context is confirmed within seconds
of activity while enough indexers are online (a majority of them). If they aren't, writers keep
writing and see each other's writes; confirmation resumes when enough indexers are back. Keep the
indexer set small and reliable. With several indexers, `confirmedLength` trails `length` by the
few newest acknowledgements; what matters is that what was written gets confirmed (measured:
with the owner offline, two admins confirmed everything 4.9 s after it was applied).

### Roles Inside the Context (version 3)

A version 3 context keeps its own role table, changed only by signed role events in the context,
so every permission decision — adding writers in closed mode, moderation, role changes, who
indexes — is made from the context's own history and is the same on every peer. (A RoleBase is a
separate log that reaches each peer at its own pace; decisions taken from it could differ between
peers, which several indexers cannot tolerate.)

```js
const ctx = await graph.createContext()            // you are the owner
const context = await graph.openContext(ctx)
const keyPair = graph.identity.deviceKeyPair

// Add a member's device as a writer, linked to that member...
await context.addWriter(theirWriterKey, { keyPair, member: theirPubkeyHex })
// ...and make them an admin: their device(s) start indexing.
await context.setRole(theirPubkeyHex, 'admin', { keyPair })
await context.removeRole(theirPubkeyHex, { keyPair }) // back to a plain writer

await context.roles() // { roles: { owner: ['*'], admin: [...], ... }, members: { pubkey: role } }
```

Who may change roles: the owner any role (but not give up its own ownership); members holding
`mod.add` / `mod.remove` (admins by default) the `mod` and `member` roles; nobody a role above
their own. A writer added with `member` indexes iff that member's role has `context.index` (owner
via `*`, admin by default), and is promoted or demoted when the role changes; a later device of the
same member inherits it. An indexer change takes effect once the current indexers have confirmed
it. Default roles and permissions are the role registry's (see [Role Registry](#role-registry)),
plus `context.index` for admins.

In version 3, the RoleBase is not consulted for anything in the context (it still serves read
scopes and `graph.can()`). Apps that want one RoleBase shared by many contexts create them with
`{ roles: 'rolebase' }` (version 2).

**Converting an older context**: its creator calls `await context.upgrade({ keyPair })`. From that
point it is version 3 with the creator as owner, and every indexer except the creator's device
keeps writing without indexing.

The version is recorded in the context itself (a `context/init` event the creator writes first),
so every peer applies the context the same way. **All peers of one context must run a hypergraph
version that understands that record**: an older version would make every writer an indexer and
build a different index. A peer that finds a version it doesn't know stops applying the context
and reports `unsupported context version N` (from `context.status().interrupted`, the
`'interrupt'` event, and any later `append()`).

`await context.status()` returns `{ version, rules, indexers, isIndexer, writable, length,
confirmedLength, fastForwards, interrupted }`.

### Joining a Context (Fast-Forward)

A peer that opens a context it is far behind on (at least 16 Autobase nodes) **fast-forwards**:
it adopts the state the indexers signed instead of replaying every event, and fetches index
pieces from peers only when it reads them. Measured: a 100,000-entry context is listable in under
a second, with ~325 MB peak memory, where replaying took over two minutes and ~3 GB. A peer
slightly behind just replays the few missing events.

Pass `fastForward: false` to `openContext()` to always replay and check every event on this peer.

### Trust Model

What a peer trusts depends on how it joined:

- **Replaying** (`fastForward: false`, or only slightly behind): it checks every event itself —
  signatures, ownership of `from`, role permissions, app rules — and builds its own index.
- **Fast-forwarding**: it accepts the index the context's indexers signed (a majority of them),
  without re-running those checks on the history: the creator in version 2, the owner and the
  members whose role allows indexing in version 3. After joining, it checks new events itself like
  any peer.

What this protects against: a writer cannot get an event into the confirmed index that the
indexers' checks reject, and cannot change confirmed history. What it does not: indexers signing a
bad index (a hostile majority of indexers), and a writer appending junk to its own log — rejected
events are never indexed, but peers that replay still download their bytes; peers that
fast-forward don't.

### App Rules

An app can attach its own deterministic rules to a context. They run in apply, after the built-in
checks, on every app data event (`relation/create`, `relation/delete`, `tag/add`, `tag/remove`,
`message`), and a rejected event is never indexed:

```js
const rules = {
  id: 'swarmfs/v1', // recorded in the context: every peer must use the same rules
  async validate (event, reader) {
    if (event.type !== 'relation/create' || event.relationType !== 'in') return true
    // A file lives in one folder only.
    const placed = await reader.edges(event.from, { direction: 'out', type: 'in' })
    return placed.length === 0
  }
}
const ctxKey = await graph.createContext({ rules })
await graph.openContext(ctxKey, { rules })
```

- Return `true` to accept. Anything else, a throw, or a rejected promise rejects the event; apply
  carries on.
- Relation events carry their `data` (spec 004), and edges from `reader.edges()` include theirs,
  so rules can check listing data (formats, names unique in a folder).
- `reader` is read-only and sees the index as it was just before the event, including earlier
  events of the same batch: `hasEdge(from, type, to)`, `edges(entityId, { direction, type,
  limit })`, `countIn(entityId, type)`, `countOut(entityId, type)`, `hasTag(entityId, tag)`.
- Rules must be **deterministic**: same event and index, same answer, on every peer. No clock,
  randomness, network, or state outside `event` and `reader`.
- The rules `id` is fixed when the context is created. Opening it with a different id (or none)
  is refused with `Context rules mismatch: …` — from `openContext()` if the context's record is
  already local, otherwise via `status().interrupted` once it arrives.

Contract: `specs/003-fast-forward-contexts/contracts/api.md`.

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
