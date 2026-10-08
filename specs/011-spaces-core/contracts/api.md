# Contract: the public API of `hypergraph/next`

What a developer writes. Names follow v1 where meanings hold (spec FR-008, FR-016, FR-017); every
method is async unless marked otherwise. Reads return `{ items, complete }` (lists) or
`{ record, complete }` (one record): `complete: false` means some data the answer needs was not
reachable within the read's bound (R13). Errors are `HypergraphError` with a stable `code`.
The forum scenario tests (`test/next/forum/`) are the executable form of this contract; when they and
this file disagree, fix one of them in the same change.

**Keys are strings.** Every key the API gives out — record ids, space keys, identity and device keys — is
a z32 string, so apps can keep them in JSON and URLs; methods also accept the record or space object
itself where a key is expected (`forum.put('comment', { on: post })`).

**Built so far**: story 1 (marked ✓ below). The rest is the plan for later stories.

## Opening, identity, network

```js
const { Hypergraph } = require('hypergraph/next')

const hg = await Hypergraph.open('./data', {
  types: { /* see Types */ },
  rules: [{ id: 'title-length', validate (record, ctx) { return record.type !== 'post' || record.title.length <= 300 } }],
  budget: 5e9,          // bytes for the whole app (default 5 GB)
  readTimeout: 5000,    // default bound for reads, ms
  mnemonic: undefined,  // restore an identity from its recovery phrase
  bootstrap: undefined  // DHT nodes (tests use a local DHT)
})

// ✓ story 1: types, readTimeout, mnemonic, bootstrap. Opening a folder that already holds another
//   identity with a different mnemonic throws NOT_ALLOWED; changed types throw INCOMPATIBLE_TYPES.
hg.identity            // ✓ sync: { publicKey } — the person
hg.device              // ✓ sync: { publicKey } — this device
await hg.recoveryPhrase(password)  // ✓ the 24 words, for the user to write down; null once forgotten here (or on a
                                   //   device added by another: story 3); NOT_ALLOWED without the right password once protected
await hg.protectRecoveryPhrase(password)   // ✓ keep it on this device, sealed by a password
await hg.forgetRecoveryPhrase()            // ✓ erase it from this device; the identity keeps working here
// ✓ Until the person chooses, the phrase stays on the device as is: apps ask right after showing it.
await hg.connectToSwarm()          // ✓ one call: all spaces, now and later
hg.on('connection', (peer) => {})  // ✓ peer: { publicKey }
await hg.close()                   // ✓ safe to call twice
```

## Devices and the personal space

```js
// On a device already in:
const { code, added } = await hg.addDevice()   // code: short text (also shown as QR); added: Promise<{ publicKey }>
// On the new device:
const hg2 = await Hypergraph.open('./data2', { types, joinCode: code })
await hg.devices()                 // [{ publicKey, name, current }]
await hg.removeDevice(publicKey)   // cut where this device holds it, in every space
hg.personal                        // sync: the personal Space (only this identity's devices)
await hg.personal.put('swarmfs/held', { root, path })   // any app record, private to the identity
```

## Spaces

```js
const forum = await hg.createSpace({ name: 'My forum', policy: 'auto' /* or 'everything' */, private: false })  // ✓ name (policy kept, applied in story 6; private: story 8)
const joined = await hg.redeemInvite(link, { timeout: 60000 })  // ✓ joins (connecting if needed); resolves to the Space once a
                                                // member who records decisions let us in; INVITE_INVALID after timeout
hg.spaces()                                     // ✓ sync: [{ key, name, parent }]
hg.space(key)                                   // ✓ sync: the Space; NOT_FOUND if not held here
await hg.leaveSpace(key)                        // drops its data from this device

forum.key; forum.name; forum.parent             // ✓ sync
forum.status()                                  // sync: { policy, held, budget, belowPolicy, peers }
forum.setBudget(1e9)                            // or null: share the app budget
forum.on('change', ({ types }) => {})           // ✓ records of these types changed
forum.on('status', (status) => {})
```

## Types

```js
types: {
  post:    { fields: { title: 'string', text: 'text', forum: 'string' }, index: [['forum', 'stamp']] },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } },
  vote:    { fields: { value: 'int', on: 'link' }, links: { on: ['post', 'comment'] }, onePerMember: true },
  page:    { fields: { title: 'string', body: 'text' }, editable: { permission: 'edit-pages' } },
  file:    { fields: { name: 'string', size: 'uint', content: 'ref', folder: 'link' } }
}
// field kinds: string, text, int, uint, float, bool, bytes, ref (spec 001 envelope), link (a record), space (a space key)
// editable: 'author' (default) | 'members' | { permission: name }
// Only appending fields or adding types is allowed between app versions; anything else throws INCOMPATIBLE_TYPES.
// ✓ story 1: all kinds, links, onePerMember (one per member per its first link field), editable 'author';
//   bad declarations throw INVALID_TYPE naming type and field. Field names id, type, author, device,
//   stamp, edited, futureStamp are taken by the record itself.
```

## Records

```js
const post = await forum.put('post', { title: 'Hello', text: 'First!' })   // ✓ NOT_ALLOWED for non-members
// ✓ post: { id, type, author, device, stamp, edited, title, text } — id stable across edits; author is the
//   identity, device the one that wrote the current version; futureStamp: true if stamped > 10 min ahead
const { record, complete } = await forum.get(post.id)   // ✓ record null if not held (or deleted)
await forum.edit(post.id, { text: 'First! (edited)' })   // ✓ changes these fields, keeps the others; resolves to the
                                                         //   new version; NOT_ALLOWED unless the type lets this member edit
await forum.del(post.id)                                 // ✓ every member stops showing it and clears its blocks
```

## Queries and the graph

```js
const { items, complete } = await forum.query('post').latest(20)   // ✓ newest first (by when it was put)
await forum.query('post').where({ forum: 'news' }).latest(20)      // ✓ app-declared index (INVALID_TYPE if not declared)
await forum.query('comment').by(someone).latest(20)                // ✓ by author (identity key)
await forum.query('post').tag('rust').latest(20)
await forum.query('post').latest(20, { after: items.at(-1), timeout: 2000 })   // ✓ paging: after the last record of
                                                                   //   the previous page; own bound
const stop = forum.query('post').live(({ items, complete }) => render(items), { limit: 20 })   // ✓ sync; returns stop();
                                                                   //   re-run only when records of its type change

await forum.linked(post, 'comment', { timeout })   // ✓ { items, complete } — what points at it, oldest first
await forum.count('comment', { on: post })         // ✓ { value, complete }
await forum.sum('vote', 'value', { on: post })     // ✓ { value, complete } — one per member, latest

await forum.relate(a, b, 'cites', { value: 1, data })   // data ≤ 4 KB
await forum.unrelate(a, b, 'cites')
await forum.edges(a, { direction: 'out', type: 'cites' })   // { items, complete }, items carry count
await forum.tag(post, 'rust'); await forum.untag(post, 'rust')
await forum.getByTag('rust', { limit: 20 })        // { items, complete }
```

## Roles and moderation

```js
await forum.defineRole('editor', ['post', 'comment', 'edit-pages'])
await forum.setRole(someone, 'moderator')
await forum.getRole(someone)          // 'member' | 'moderator' | ... | null
await forum.removeRole(someone)
await forum.moderateAction('hide', post.id, { reason: 'spam' })   // flag | hide | remove | reveal
await forum.moderateAction('ban', someone, { reason: 'spam' })    // cut where this moderator holds them
```

## Invites

```js
const link = await forum.createInvite({ role: 'member', uses: 10, expires: Date.now() + 7 * 864e5, subspaces: [] })
// ✓ story 1: a string 'hg:…'; uses default 1; recorded by a member who records decisions (owner, admins)
//   while online; NOT_ALLOWED if this member's role can't invite
await forum.revokeInvite(link)
await forum.redemptions(link)         // [{ identity, at }]
await forum.setWriteLimit({ records: 50, periodMs: 3600e3 })   // open spaces
```

## Sub-spaces

```js
const news = await forum.createSubspace({ name: 'News', writeRoles: ['moderator'] })
const staff = await forum.createSubspace({ name: 'Staff', private: true })
await staff.createInvite({ role: 'guest' })      // a guest of the sub-space only
forum.subspaces()                                // sync: [{ key, name, private }]
await forum.put('post', { title: 'See', space: news.key })   // a record linking to a space
```

## App protocols

```js
forum.addProtocol('swarmfs/transfer', {
  messages: [{ encoding, onmessage (msg, peer) {} }],
  onopen (peer) {}, onclose (peer) {}
})   // sync; opened on every connection of this space, next to hypergraph's own
```

## Error codes

`NOT_ALLOWED`, `NOT_FOUND`, `INVALID_RECORD`, `INVALID_TYPE`, `INCOMPATIBLE_TYPES`, `RULE_REJECTED`,
`INVITE_INVALID`, `INVITE_EXPIRED`, `INVITE_USED_UP`, `INVITE_REVOKED`, `DEVICE_REMOVED`, `CLOSED`.

Story 1 uses: `NOT_ALLOWED` (not a member; editing someone else's record; inviting without the role),
`NOT_FOUND` (an id or a space key that isn't one, or isn't held here), `INVALID_RECORD` (a field of the
wrong kind, an unknown field, a link to a type the type doesn't allow, over 64 KB), `INVALID_TYPE`,
`INCOMPATIBLE_TYPES`, `INVITE_INVALID` (not a link, bad signature, or nobody let us in in time),
`INVITE_EXPIRED` (checked locally before asking), `CLOSED`.
