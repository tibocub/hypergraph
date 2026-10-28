# API contract: what spec 012 changes in `hypergraph/next`

Delta against `specs/011-spaces-core/contracts/api.md` (which gets these lines, marked "spec 012", at
implementation). Everything not listed is unchanged.

## Open

```js
const hg = await Hypergraph.open('./data', {
  types, rules,
  // readTimeout: REMOVED (reads answer at once; a read waits only with its own { timeout })
  mnemonic, password, joinCode, joinTimeout, deviceName, bootstrap
})
```

`readTimeout` passed anyway is ignored, like any unknown option.

## Reads (Rule 1)

```js
await forum.query('post').latest(20)                     // at once: { items, complete }
await forum.query('post').latest(20, { timeout: 3000 })  // waits while incomplete, up to 3 s; answers early once complete
await forum.get(id)                                      // at once: { record, complete, deleted }
await forum.linked(post, 'comment', { timeout })         // same for linked, count, sum, tags, edges, getByTag
await forum.decisions({ limit, after })                  // already at once (the decision log is held whole)
forum.query('post').live(({ items, complete }) => {})    // at once, then on change; again while incomplete
```

- Default `timeout` is `0` for every read.
- An at-once read still starts what its answer needs (newest-first reading of a big space, fetching
  dropped content); what arrives fires `change`.
- `complete`: unchanged meaning.

## `get()` (H15)

```js
const { record, complete, deleted } = await forum.get(id)
// record: the record, or null
// deleted: null | { by: 'author', stamp, device } | { by: 'space' }
```

## `change` (Rule 2, H14, H16)

```js
forum.on('change', ({ types, records }) => {})
// types:   ['post', ...]                     distinct types of records (as before)
// records: [{ id, type, deleted }]           every record whose answer changed: put, edit (now included),
//                                            delete, hide/reveal/flag, take-down, cut, write limit,
//                                            content fetched back; on this device and from others
```

## Every read has its event (Rule 2)

| Read | Event |
|---|---|
| `get`, `query`, `linked`, `count`, `sum`, `tags`, `edges`, `getByTag` | `space.on('change', ({ types, records }) => {})` |
| `hg.spaces()`, `space.subspaces()`, `space.name`, `space.parent` | `hg.on('spaces', (spaces) => {})` — now also when a listed space's name or parent changes (H12) |
| `space.members()`, `getRole()`, `roles()` | `space.on('members', () => {})` **new** |
| `space.decisions()`, `redemptions()`, `space.history` | `space.on('decisions', () => {})` **new** |
| `space.status()` | `space.on('status', (status) => {})` — now also when `complete` or the settlers change |
| `space.peers()` | `space.on('peers', (peers) => {})` |
| `space.memberConnections()` | `'member-connection'`, `'member-disconnection'` |
| `hg.devices()` | `hg.on('devices', () => {})` **new** |
| `hg.settings()` | `hg.on('settings', () => {})` **new** |
| `space.inspect()` | `space.on('logs', () => {})` (diagnostics) |

No event: `hg.storage()`, `status().stored` / `share` (estimates: read when needed), `hg.types()` (fixed).

An event passes the read's value when that read is sync (`'spaces'`, `'status'`, `'peers'`); for an
async read (`members()`, `devices()`, `settings()`, `decisions()`) it passes nothing: read again.
An event may come when nothing changed; a change never comes without its event. Listen first, then
read. No events after `close()`.

## `status()`

```js
forum.status()   // { policy, access, held, heldFrom, stored, share, budget, belowPolicy, peers, settlers,
                 //   warnings, complete }   ← complete: new (everything known here is held)
```

## Errors

None new.
