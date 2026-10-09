# Hypergraph's new core: API

`require('hypergraph/next')`, the surface of stories 1 to 5 (spec 011). Concepts: [concepts.md](concepts.md). The
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
  rules,                 // your app's rules (below)
  readTimeout: 5000,     // how long reads wait for known-but-missing data, ms (joining waits 30 s)
  mnemonic: undefined,   // a recovery phrase, to restore an identity in a new folder
  password: undefined    // keeps the recovery phrase sealed by it from the first moment
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
that can read that folder. Better: ask for the password before creating the account and open with
`{ password }` (also with `mnemonic` or `joinCode`): the phrase is then never in the folder in plain
text. This device keeps its identity either way; the phrase is needed to restore the identity on
another computer, and to add or remove a device.

## Devices and the personal space

One person, several devices (a laptop, a phone), one identity. A device already in shows a code; the
new device is opened with it:

```js
// On the laptop:
const { code, added } = await hg.addDevice({ password })   // show `code` as text or a QR code
const device = await added                                   // { publicKey, name }, or null if it expired (10 min)
// On the phone, in an empty folder:
const phone = await Hypergraph.open('./data', { types, rules, joinCode: code, deviceName: 'phone' })

await hg.devices()                      // [{ publicKey, name, current }]
await hg.removeDevice(lost.publicKey, { password })   // or { recoveryPhrase: words }
await hg.setSetting('theme', 'dark')    // any JSON value, the same on every device
await hg.settings()                     // { theme: 'dark' }
hg.personal                             // the personal space
await hg.personal.put('held', { path: '/music/a.mp3', holder: hg.device.publicKey })
```

The new device receives the **recovery phrase** over the pairing connection (encrypted to it): ask the
person to protect it there with that device's own password (`protectRecoveryPhrase`), as after signing
up. Adding a device needs the phrase (`password` if it is protected on this device, `recoveryPhrase` if
it was forgotten here), and so does **removing a lost device**: a removal is signed by the identity
key, never by a device alone, so a stolen device without the password can't remove yours. A removal
applies in every space: what the lost device wrote up to where you hold it stays, nothing after counts,
for everyone, newcomers included. The lost device's own app gets `DEVICE_REMOVED`.

**Decision rights follow devices.** If you are an owner, admin or moderator somewhere, every device of
yours records decisions there with no extra step (each claims its right, and any member able to record
decisions lets it, your other device included), and a removed device loses that right in every space:
whatever it decides after the removal counts for nobody. A device made by another device never counts:
every device proves itself straight from the identity.

Records show the person: `author` is the identity on every device, `device` is the device that wrote
the current version. Every device joins the spaces any of them created or joined, and shares the
settings. The **personal space** is shared by your devices only: nobody else can find it, its blocks
are encrypted, and anything someone else writes into it is ignored. Put your app's own private records
there (declare their types in `types` like any other). It isn't listed in `hg.spaces()`.

The **latest change wins** across devices: a change made on a device after it has seen an earlier one
wins, even if the other device's clock is ahead (see [concepts.md](concepts.md#latest-wins)).

## Types

```js
const types = {
  post: { fields: { title: 'string', text: 'text' } },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } },
  vote: { fields: { value: 'int', on: 'link' }, links: { on: ['post', 'comment'] }, onePerMember: true },
  page: { fields: { title: 'string', body: 'text' }, editable: { permission: 'edit-pages' } },   // a wiki
  note: { fields: { text: 'text' }, editable: 'members' }                                       // any member edits
}
```

Field kinds: `string`, `text`, `int`, `uint`, `float`, `bool`, `bytes`, `ref` (content held elsewhere:
`{ src: [addresses], size, type, digest }`), `link` (a record), `space` (a space). `links` limits what a
link field may point at. `onePerMember`: only each member's latest counts (per its first link field).
`index: [['forum', 'stamp']]` adds a query by field (`where`). `editable` says who may edit a record
besides its author: `'author'` (the default), `'members'` (any member), or `{ permission }` (members whose
role has that permission, e.g. one you define with `defineRole`; see [Shared editing](#shared-editing)). Between app versions you may only add
fields at the end of a type and add types; anything else throws `INCOMPATIBLE_TYPES` at open. Field
names `id`, `type`, `author`, `device`, `stamp`, `edited`, `futureStamp` are taken by the record.

## Spaces and invites

```js
const forum = await hg.createSpace({ name: 'Hypergraph fans' })
const link = await forum.createInvite({ role: 'member', uses: 10, expires: Date.now() + 7 * 864e5 })
const open = await forum.createInvite({ uses: Infinity })   // a public link: an open forum
const joined = await hg.redeemInvite(link)                 // on the newcomer's app: resolves once let in
await forum.revokeInvite(open)                             // no one else gets in with it; members stay
await forum.redemptions(link)                              // [{ identity, at }]: who came in with it
hg.spaces()            // [{ key, name, parent }]
hg.space(forum.key)    // the Space
forum.on('change', ({ types }) => {})   // records of these types changed
```

A link is signed by its maker and holds no key; send it any way you like. One use by default. It works
while its maker is offline, as long as some member able to record decisions (the owner, an admin) is
online. Who may invite to what: a role with `invite` (owner, admins), to a role below theirs, or to
`member` and `guest`; never to owner. `redeemInvite` waits up to 30 s (connecting alone can take a few
seconds on a real network; `{ timeout }` overrides it) and says why when it is refused: `INVITE_EXPIRED`, `INVITE_USED_UP`, `INVITE_REVOKED`,
`NOT_ALLOWED` (its maker may not give that role, or you are banned); `INVITE_INVALID` if nobody able to
let you in answered in time (try again later). The maker or an admin revokes a link. Joining never
lowers a role someone already has. A limit on how much a newcomer of an open space may write comes
later (story 9).

## Roles and moderation

```js
await forum.setRole(someone, 'moderator')   // admin, moderator, member, guest, or your own role
await forum.getRole(someone)                // 'owner', 'member', ... or null if not a member
await forum.removeRole(someone)             // takes them out of the space
await forum.defineRole('editor', ['post', 'edit-pages'])   // your own roles and permissions

await forum.moderateAction('hide', comment, { reason: 'rude' })   // left out of every list
await forum.moderateAction('reveal', comment)                     // shown again
await forum.moderateAction('flag', post, { reason: 'check' })     // record.flagged
await forum.moderateAction('remove', comment)                     // gone for good
await forum.moderateAction('ban', someone, { reason: 'spam' })    // out, and not let back in
await forum.moderateAction('ban', someone, { from: firstSpam })   // and drop that record and all after it
await forum.moderateAction('unban', someone)                      // may be let back in (invite, setRole)
```

Built-in roles: `owner` (everything, your app's permissions included), `admin` (members, roles, invites,
moderation), `moderator` (moderation), `member` and `guest` (writing). Owners and admins give roles below
their own; a role you define can gain permissions later but never lose `post` or one of your app's
permissions such as `edit-pages` (give its members another role instead); it may lose hypergraph's
own `decide`, `moderate`, `invite` and `roles`.
Moderators, admins and the owner moderate. Every call resolves once your app applied the decision; the
others apply it as soon as it reaches them, in the same order, offline members included. A moderator
demoted later: what they decided before stays, what they decide after counts for nobody.

Removing or banning someone keeps what they wrote up to what you held at that moment, for everyone,
including people who join later; anything they write after is ignored everywhere. A ban keeps their
earlier votes too. To drop the spam that led to the ban, ban `from` its first record: that record and
everything they wrote after it (on that device) go too, for everyone, in the same decision. Let in again
(after a removal, or a ban lifted with `unban`), they write again; what they wrote while out never
counts. `unban` is for a moderator at least at the rank of whoever banned.

When a role or moderation call is refused (`NOT_ALLOWED`), the message says why: you are banned, not a
member, your role is too low, their role is at or above yours. Before refusing, your app first catches up
with the connected members who record decisions (within the read bound), so a decision made a moment
ago elsewhere (an unban, a new role for you) is not missed. Writing (`put`, `edit`, `del`) does the same.

**Give a space an admin.** The order of decisions is settled by the owner and the admins (one device
each). With the owner alone, if that device is lost for good, new decisions still apply but are never
settled again. `forum.status()` warns about it: `{ peers, settlers, warnings: [{ code: 'SINGLE_SETTLER',
message }] }` while only one member settles.

A hidden record is left out of `query`, `linked`, `count` and `sum`; `get(id)` still returns it with
`hidden: true`, so you can show "hidden by moderators" and let moderators reveal it.

## App rules

```js
const rules = [
  { id: 'title-length', validate: (record) => record.type !== 'post' || record.title.length <= 300 }
]
const hg = await Hypergraph.open('./data', { types, rules })
```

`validate(record, ctx)` gets the record's fields with `id`, `type`, `author`, `device`, `stamp`, and
`ctx = { space }`; returning `false` or throwing rejects it. Your app refuses to write a record that
breaks a rule (`RULE_REJECTED`, naming the rule), and every member checks it before keeping it: a
record from someone else's app that breaks it is never shown, indexed or passed on. Keep rules
deterministic and about the record alone: every member must reach the same verdict.

## Records

```js
const post = await forum.put('post', { title: 'Hello', text: 'First!' })
// { id, type, author, device, stamp, edited, title, text }
const reply = await forum.put('comment', { on: post, text: 'Welcome' })   // a record or its id
const { record } = await forum.get(post.id)        // null if not held, or deleted
await forum.edit(post.id, { text: 'First! (edited)' })   // other fields kept; NOT_ALLOWED if not yours
await forum.del(post.id)   // yours; a moderator's del() of someone else's record takes it down
```

## Shared editing

A type with `editable: 'members'` or `{ permission: 'edit-pages' }` lets others edit its records (wikis,
shared folders). Every member shows the **latest allowed edit**; an edit by someone the type doesn't
allow is refused by their app and ignored by everyone. **Only the author deletes** a record (and
moderators, whose `del()` takes it down for good): an editor who blanks a page has only made an edit, and
the next edit restores it.

Taking the permission away from an editor (`setRole` to a role without it) works like a ban, for their
edits only: what they edited up to what you held at that moment stays, for everyone, newcomers
included; edits they make after count for nobody, even for members who showed them before the decision
reached them. Given the permission back, they edit again (their app writes in a new log). Relations and
tags on a shared record follow the same rule: anyone who may edit it may relate from it and tag it.

## Queries

```js
const { items, complete } = await forum.query('post').latest(20)
const next = await forum.query('post').latest(20, { after: items.at(-1) })   // the next page
await forum.query('comment').by(someone).latest(20)     // by author
await hg.personal.query('held').fromDevice(phone).latest(20)   // what one device put (its device key)
await forum.query('post').where({ forum: 'news' }).latest(20)   // a declared index
const stop = forum.query('post').live(({ items }) => render(items), { limit: 20 })

await forum.query('comment').on(post).by(someone).latest(20)   // filters combine
await forum.query('post').tag('rust').since(Date.now() - 864e5).latest(20)   // since: inclusive; until: before
await forum.linked(post, 'comment')           // what points at the post, oldest first (no type: not relations or tags)
await forum.count('comment', { on: post })    // { value, complete }
await forum.sum('vote', 'value', { on: post })   // one per member, the latest
```

A live query runs at once, then again only when records of its type change (comments and votes don't
re-run a list of posts). Every read takes `{ timeout }`. Lists are newest first by when a record was
put, and paging with `{ after }` never skips or repeats one, even records put at the same moment.

## Relations and tags

v1's graph vocabulary, with v1's meanings:

```js
await forum.relate(post, other, 'cites', { value: 2, data: 'section 3' })   // value: a number; data: text up to 4 KB
// { id, from, to, type, value, data, author, stamp }
await forum.edges(post, { direction: 'out', type: 'cites' })   // { items, count, complete }; 'in', 'both' (default)
await forum.edges(other, { direction: 'in', order: 'desc', limit: 10 })   // newest first; count is before the limit
await forum.unrelate(post, other, 'cites')    // NOT_FOUND if there is no such relation

await forum.tag(post, 'rust')
await forum.untag(post, 'rust')               // NOT_FOUND if it doesn't have it
await forum.getByTag('rust', { type: 'post', limit: 20, after })   // { items, complete }, newest first
```

A relation goes **from** a record **to** another, with a type. It is said by who may edit the record it
starts from (its author, or an editor of a shared type): you relate from your records to anyone's.
Relating the same pair with the same type again replaces it (one edge, the latest value and data);
`unrelate` takes it away, and relating again brings it back. Tags work the same way: who may edit a
record tags it, and the latest `tag` or `untag` wins. Both are records in your own log (hypergraph's
types `hg/relation` and `hg/tag`), so every member applies them the same way, in any order of arrival.
`getByTag` without a `type` looks at all your types.

