# Hypergraph's new core: API

`require('hypergraph/next')`, story 1's surface (spec 011). Concepts: [concepts.md](concepts.md). The
full planned surface, with what is built marked ✓: `specs/011-spaces-core/contracts/api.md`. The forum
in `test/next/forum/forum.js` uses all of it.

Every key the API gives out (record ids, space keys, identity and device keys) is a short string.
Reads return `{ items, complete }`, `{ record, complete }` or `{ value, complete }` (see
[concepts.md](concepts.md#complete-answers)). Errors are `HypergraphError` with a `code`.

## Open, identity, network

```js
const { Hypergraph } = require('hypergraph/next')

const hg = await Hypergraph.open('./data', {
  types,                 // your record types (below)
  readTimeout: 5000,     // how long reads wait for known-but-missing data, ms
  mnemonic: undefined    // a recovery phrase, to restore an identity in a new folder
})
hg.identity.publicKey            // the person
hg.device.publicKey              // this device
await hg.recoveryPhrase()        // 24 words to write down
await hg.protectRecoveryPhrase(password)   // keep them here behind a password: recoveryPhrase(password)
await hg.forgetRecoveryPhrase()            // or erase them from this device
await hg.connectToSwarm()        // find the members of every space, now and later
await hg.close()
```

Right after showing the recovery phrase, ask the person what to do with it: keep it on this device
behind a password (`protectRecoveryPhrase`), or forget it here because it is written down
(`forgetRecoveryPhrase`). Until they choose, it stays in the instance folder as is, readable by anything
that can read that folder. This device keeps its identity either way; the phrase is only needed to
restore the identity on another computer.

## Types

```js
const types = {
  post: { fields: { title: 'string', text: 'text' } },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } },
  vote: { fields: { value: 'int', on: 'link' }, links: { on: ['post', 'comment'] }, onePerMember: true }
}
```

Field kinds: `string`, `text`, `int`, `uint`, `float`, `bool`, `bytes`, `ref` (content held elsewhere:
`{ src: [addresses], size, type, digest }`), `link` (a record), `space` (a space). `links` limits what a
link field may point at. `onePerMember`: only each member's latest counts (per its first link field).
`index: [['forum', 'stamp']]` adds a query by field (`where`). Between app versions you may only add
fields at the end of a type and add types; anything else throws `INCOMPATIBLE_TYPES` at open. Field
names `id`, `type`, `author`, `device`, `stamp`, `edited`, `futureStamp` are taken by the record.

## Spaces and invites

```js
const forum = await hg.createSpace({ name: 'Hypergraph fans' })
const link = await forum.createInvite({ role: 'member' })   // one use by default; send it any way
const joined = await hg.redeemInvite(link)                 // on the newcomer's app: resolves once let in
hg.spaces()            // [{ key, name, parent }]
hg.space(forum.key)    // the Space
forum.on('change', ({ types }) => {})   // records of these types changed
```

In story 1 an invite is recorded by a member who records decisions (the owner) while online. Offline
inviters, expiry, revocation and public links come with story 4.

## Records

```js
const post = await forum.put('post', { title: 'Hello', text: 'First!' })
// { id, type, author, device, stamp, edited, title, text }
const reply = await forum.put('comment', { on: post, text: 'Welcome' })   // a record or its id
const { record } = await forum.get(post.id)        // null if not held, or deleted
await forum.edit(post.id, { text: 'First! (edited)' })   // other fields kept; NOT_ALLOWED if not yours
await forum.del(post.id)
```

## Queries

```js
const { items, complete } = await forum.query('post').latest(20)
const next = await forum.query('post').latest(20, { after: items.at(-1) })   // the next page
await forum.query('comment').by(someone).latest(20)     // by author
await forum.query('post').where({ forum: 'news' }).latest(20)   // a declared index
const stop = forum.query('post').live(({ items }) => render(items), { limit: 20 })

await forum.linked(post, 'comment')           // what points at the post, oldest first
await forum.count('comment', { on: post })    // { value, complete }
await forum.sum('vote', 'value', { on: post })   // one per member, the latest
```

A live query runs at once, then again only when records of its type change (comments and votes don't
re-run a list of posts). Every read takes `{ timeout }`.
