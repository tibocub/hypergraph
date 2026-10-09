# Contract: the public API of `hypergraph/next`

What a developer writes. Names follow v1 where meanings hold (spec FR-008, FR-016, FR-017); every
method is async unless marked otherwise. Reads return `{ items, complete }` (lists) or
`{ record, complete }` (one record): `complete: false` means some record this member knows exists was
not held within the read's bound, or no other member was reached since opening (R13, amended in
research.md A4). Errors are `HypergraphError` with a stable `code`.
The forum scenario tests (`test/next/forum/`) are the executable form of this contract; when they and
this file disagree, fix one of them in the same change.

**Keys are strings.** Every key the API gives out — record ids, space keys, identity and device keys — is
a z32 string, so apps can keep them in JSON and URLs; methods also accept the record or space object
itself where a key is expected (`forum.put('comment', { on: post })`).

**Built so far**: stories 1, 2, 3 and 4 (marked ✓ below). The rest is the plan for later stories.

## Opening, identity, network

```js
const { Hypergraph } = require('hypergraph/next')

const hg = await Hypergraph.open('./data', {
  types: { /* see Types */ },
  rules: [{ id: 'title-length', validate (record, ctx) { return record.type !== 'post' || record.title.length <= 300 } }],
  budget: 5e9,          // bytes for the whole app (default 5 GB)
  readTimeout: 5000,    // default bound for reads, ms
  mnemonic: undefined,  // restore an identity from its recovery phrase
  password: undefined,  // ✓ story 4: the recovery phrase is sealed by it from the first moment (new account,
                        //   mnemonic or joinCode); on a folder whose phrase is still in plain text, protects it
  bootstrap: undefined  // DHT nodes (tests use a local DHT)
})

// ✓ story 1: types, readTimeout, mnemonic, bootstrap. Opening a folder that already holds another
//   identity with a different mnemonic throws NOT_ALLOWED; changed types throw INCOMPATIBLE_TYPES.
// ✓ story 2: rules. validate(record, ctx) gets the record's fields plus id, type, author, device, stamp,
//   and ctx = { space }; returning false or throwing rejects it. It must be deterministic and look only
//   at the record: every member runs it before keeping a record, and the writer's app first
//   (RULE_REJECTED). A member's own records are never dropped, so others fetch, check and drop them.
hg.identity            // ✓ sync: { publicKey } — the person
hg.device              // ✓ sync: { publicKey } — this device
await hg.recoveryPhrase(password)  // ✓ the 24 words, for the user to write down; null once forgotten here;
                                   //   NOT_ALLOWED without the right password once protected. A device added by code
                                   //   holds them too (story 3): the app asks for that device's own password
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
const { code, added } = await hg.addDevice({ password })   // ✓ code: text (~106 characters; show it as a QR too);
                                   //   added: Promise<{ publicKey, name } | null> (null: expired unused, `timeout`,
                                   //   default 10 min). The new device receives the recovery phrase, so this needs
                                   //   it: `password` if protected here, `recoveryPhrase` if forgotten here
                                   //   (NOT_ALLOWED otherwise). One use.
// On the new device (an empty folder; NOT_ALLOWED if it holds an account):
const hg2 = await Hypergraph.open('./data2', { types, joinCode: code, deviceName: 'phone' })   // ✓ connected;
                                   //   INVITE_INVALID for a wrong code, or no answer within `joinTimeout` (60 s)
await hg.devices()                 // ✓ [{ publicKey, name, current }], removed devices left out
await hg.removeDevice(publicKey, { password })   // ✓ or { recoveryPhrase }: needs the phrase (research.md A7);
                                   //   in every space, what it wrote up to where this device holds it (or its own
                                   //   last heads say) stays, nothing after counts; its app gets DEVICE_REMOVED;
                                   //   NOT_FOUND for a key that isn't one of this account's devices
// ✓ story 4 (research.md A8): decision rights follow devices. Where this identity may decide or moderate, every
//   device of it records decisions with no extra step (it claims its writer key; any member who records
//   decisions lets it); removeDevice also takes a device's decision rights away in every space. Device proofs
//   must come straight from the identity key (a device attesting another one is refused).
hg.personal                        // ✓ sync: the personal Space (only this identity's devices; encrypted; not in spaces())
await hg.personal.put('held', { path, holder })   // ✓ any app record (types from open()), private to the identity
await hg.setSetting('theme', 'dark')   // ✓ any JSON value; the latest set on any device wins
await hg.settings()                // ✓ { theme: 'dark' }
// ✓ Every device joins the spaces any of them created or joined. Opening a folder with `deviceName` names this
//   device in devices(). Restoring from the phrase (`mnemonic`) finds the same personal space.
```

## Spaces

```js
const forum = await hg.createSpace({ name: 'My forum', policy: 'auto' /* or 'everything' */, private: false })  // ✓ name (policy kept, applied in story 6; private: story 8)
const joined = await hg.redeemInvite(link, { timeout })  // ✓ joins (connecting if needed); resolves to the Space once a
                                                // member who records decisions let us in. ✓ story 4: waits up to
                                                // readTimeout by default; refused: INVITE_EXPIRED, INVITE_USED_UP,
                                                // INVITE_REVOKED, NOT_ALLOWED; nobody answered: INVITE_INVALID
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
//   identity, device the one that wrote the current version; futureStamp: true if stamped > 10 min ahead;
//   ✓ hidden: true (hidden by a moderator: only get() returns it), flagged: true (flagged by a moderator)
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
await hg.personal.query('held').fromDevice(device).latest(20)      // ✓ story 4: what one device put (device key)
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
await forum.defineRole('editor', ['post', 'edit-pages'])   // ✓ owner/admins; hypergraph's own permissions (post,
                                      //   moderate, invite, roles, decide) and the app's; a role may gain
                                      //   permissions, never lose 'post'
await forum.setRole(someone, 'moderator')   // ✓ built-in (admin, moderator, member, guest) or defined; adds
                                      //   non-members (v1); NOT_ALLOWED at or above your rank, NOT_FOUND for an
                                      //   unknown role; a role without 'post' cuts like a removal
await forum.getRole(someone)          // ✓ 'member' | 'moderator' | ... | null (not a member)
await forum.removeRole(someone)       // ✓ takes them out of the space (v1's meaning); what they wrote up to where
                                      //   this member holds them stays for everyone, nothing after counts
await forum.moderateAction('hide', post.id, { reason: 'spam' })   // ✓ flag | hide | reveal | remove (for good)
await forum.moderateAction('ban', someone, { reason: 'spam' })    // ✓ out: kept up to where this moderator
                                      //   holds them, ignored after; not let back in until unbanned
await forum.moderateAction('unban', someone)   // ✓ story 4: may be let back in (invite, setRole); writes in a
                                      //   new log; what they wrote while banned never counts. NOT_FOUND if not
                                      //   banned; NOT_ALLOWED below the rank of who banned
await forum.moderateAction('ban', someone, { from: spam })        // ✓ the same, and that record and everything
                                      //   after it in its log go too, for everyone (NOT_ALLOWED if not theirs)
// ✓ moderators, admins, owner (NOT_ALLOWED otherwise); a demoted moderator's later decisions are ignored
//   by every member, earlier ones stay. Each call resolves once this member applied the decision.
```

## Invites

```js
const link = await forum.createInvite({ role: 'member', uses: 10, expires: Date.now() + 7 * 864e5, subspaces: [] })
// ✓ a string 'hg:…'; uses default 1 (Infinity: a public link, until revoked); recorded by any member who
//   records decisions, the maker online or not. Who may invite to what: a role with `invite`, to a role below
//   theirs or to member / guest, never owner, with no permission they lack (NOT_ALLOWED; NOT_FOUND for an
//   unknown role); a redemption never lowers a role
await forum.revokeInvite(link)        // ✓ its maker or who may decide; members who came in stay
await forum.redemptions(link)         // ✓ [{ identity, at }], oldest first
await forum.setWriteLimit({ records: 50, periodMs: 3600e3 })   // open spaces: story 9 (research.md A8)
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

Story 4 uses: `INVITE_EXPIRED`, `INVITE_USED_UP`, `INVITE_REVOKED`, `NOT_ALLOWED` (refused redemptions, with
their reason, within the read bound), `INVITE_INVALID` (nobody able to let us in answered in time),
`NOT_ALLOWED` / `NOT_FOUND` for `createInvite`, `revokeInvite` and `unban`.

Story 3 adds: `DEVICE_REMOVED` (writing from a device removed from the account), `NOT_ALLOWED` for
adding or removing a device without the recovery phrase, `INVITE_INVALID` for a device code.

Story 2 adds: `RULE_REJECTED` (an app rule refused the record, named in the message), `NOT_ALLOWED`
for roles and moderation beyond one's rank or permissions, `NOT_FOUND` for an unknown role.

Story 1 uses: `NOT_ALLOWED` (not a member; editing someone else's record; inviting without the role),
`NOT_FOUND` (an id or a space key that isn't one, or isn't held here), `INVALID_RECORD` (a field of the
wrong kind, an unknown field, a link to a type the type doesn't allow, over 64 KB), `INVALID_TYPE`,
`INCOMPATIBLE_TYPES`, `INVITE_INVALID` (not a link, bad signature, or nobody let us in in time),
`INVITE_EXPIRED` (checked locally before asking), `CLOSED`.
