# Hypergraph's new core: API

`require('hypergraph/next')`, the surface of stories 1 to 9 (spec 011). Concepts: [concepts.md](concepts.md); "deleted" and "incomplete" for your users: [deleting-and-incomplete.md](deleting-and-incomplete.md). The
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
link field may point at: your app refuses to write anything else (`INVALID_RECORD`), and a record from a
modified app pointing elsewhere is kept with that link ignored (the field reads `null`, the record isn't in
`linked()`, `count()`, `sum()` or `query().on()` of its target). `onePerMember`: only each member's latest counts (per its first link field).
`index: [['forum', 'stamp']]` adds a query by field (`where`; records with no value in those fields aren't in it). `editable` says who may edit a record
besides its author: `'author'` (the default), `'members'` (any member), or `{ permission }` (members whose
role has that permission, e.g. one you define with `defineRole`; see [Shared editing](#shared-editing)). Field
names `id`, `type`, `author`, `device`, `stamp`, `edited`, `futureStamp` are taken by the record.

**App versions.** Members never all update at once, so between versions you may only add fields at the
end of a type (a link field with its `links`), add types and add indexes; anything else (reordering,
removing or retyping a field, removing a type, changing `editable`, `onePerMember` or a link field's
targets, or opening a folder with an older version than last time) throws `INCOMPATIBLE_TYPES` at open,
naming the type and the field. Members on two versions share a space: the old app doesn't see the new
fields (and its edits keep them), the new one sees them `null` on old records. Records of a type the app
doesn't know yet are kept; once an update declares it, the app rebuilds its local index at the first
start (seconds for a big space; reads say `complete: false` meanwhile) and shows them like everyone else.
App `rules` are code: a newer version refusing what an older one accepted makes members disagree, so make
new rules accept what earlier versions wrote (see [App rules](#app-rules): mismatches are detected).

## Spaces and invites

```js
const forum = await hg.createSpace({ name: 'Hypergraph fans' })
const link = await forum.createInvite({ role: 'member', uses: 10, expires: Date.now() + 7 * 864e5 })
const open = await forum.createInvite({ uses: Infinity })   // a public link: an open forum
await forum.setWriteLimit({ records: 20, periodMs: 3600e3 })   // each device posts at most 20 records an hour
const both = await forum.createInvite({ subspaces: [staff] })  // also gives the role in the private sub-space
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
lowers a role someone already has.

An invite can list sub-spaces of the space (`subspaces`: Space objects or keys): the newcomer gets the
same role in each, a private one included, so one link lets someone into the forum and its private room.
Its maker must be able to invite to that role there (`NOT_ALLOWED` otherwise, with the reason); a sub-space
not inside this space is `NOT_FOUND`.

**Write limits** (open spaces): `setWriteLimit({ records, periodMs })` (who may decide; `null` lifts it)
lets each device's log count at most `records` records within any `periodMs`. Every member judges it the
same way, so a record beyond it counts for nobody (a member who was there and a newcomer agree); your app's
`put()`, `edit()` and graph calls refuse it first (`NOT_ALLOWED`, saying when the device may write
again). Deleting is always allowed and never frees room. Raising or lifting the limit brings refused
records back (their authors hold them). The limit is judged on records' stamps: a modified app can only
get past it by stamping its records ever further in the future, where every member sees them as
`futureStamp`.

## Sub-spaces and private spaces

```js
const news = await forum.createSubspace({ name: 'News', writeRoles: ['moderator'] })  // only moderators post
const staff = await forum.createSubspace({ name: 'Staff', private: true })            // read by who is let in
const guests = await forum.createSubspace({ name: 'Guests' })
const link = await guests.createInvite({ role: 'guest' })   // a guest of the sub-space only
forum.subspaces()        // [{ key, name, private }], sync: the sub-spaces right inside it
news.parent              // the forum's key; null for a top space
staff.private            // true
await staff.setRole(someone, 'member')   // let a forum member into the private room
await staff.removeRole(someone)          // and out: the key changes, they can't read what comes next
const club = await hg.createSpace({ name: 'Club', private: true })   // a private top space
await forum.put('shortcut', { title: 'See News', to: news })          // a 'space' field: a link to a space
hg.space(record.to)      // follow it: the Space if you're in it, NOT_FOUND otherwise (an invite lets you in)
```

A **sub-space** is a space inside another (a sub-forum, a folder with its own rules). Members of the
parent have it at once, without joining (`hg.spaces()` lists it with its `parent`); it has the parent's
members and roles, then its own: roles given in it (`setRole`, `createInvite` on the sub-space), guests
who exist only there. It can be stricter: `writeRoles` (only those roles post; the owner and admins
always may). A ban or a removal in the parent always applies in every sub-space below it, whatever
arrives first. Only who may decide creates one (`NOT_ALLOWED` otherwise); nothing splits by itself.
Sub-spaces nest. Its decisions are kept in the parent's decision log, so it needs no settling of its own.

A **private** space or sub-space is read only by its members: for a private sub-space, the people given
a role in it plus the parent's owner and admins (plain members of the parent see that it exists, not
what is in it). Whoever relays or stores its data without being let in can't read it. Content is
sealed with a key every member's device receives from another member who holds it, so a newcomer reads
once such a member is online. When someone loses access (removed, banned there or in the parent, a
device removed), a member who may decide or moderate changes the key before writing again, and those
who left can't read what is written after; what came before stays readable to them. A member that
can't read (no key) answers `complete: false`. One that may not read it any more (removed, or only
relaying it) is told at once: `status().access` is `'none'` and reads answer immediately with
`{ items, complete: false, access: 'none' }` instead of waiting for keys that will never come; a member
whose key hasn't arrived yet is `'waiting'` (reads wait, as usual). A record someone wrote in the clear in a private space is
listed as `unreadable: true`, never with its content. Keys are never shown: not by `inspect()`,
`status()`, errors or the inspector.

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

**Rules are code, so members can run different ones** (an app not updated yet, a modified app), and then
they disagree on which records exist. Hypergraph can't prevent that, only show it: a space records the ids
of the rules it runs (`createSpace` records the creator's; `await forum.setRules()` records this app's,
for who may decide), and `status()` warns `RULES_DIFFER` (with a `status` event) on a member whose app
runs other ids, naming them. So give a rule a new id whenever you change what it accepts, make new rules
accept what earlier versions wrote, and record the new set when you ship it.

## Records

```js
const post = await forum.put('post', { title: 'Hello', text: 'First!' })
// { id, type, author, device, stamp, edited, title, text }
const reply = await forum.put('comment', { on: post, text: 'Welcome' })   // a record or its id
const { record } = await forum.get(post.id)        // null if not held, or deleted
await forum.edit(post.id, { text: 'First! (edited)' })   // other fields kept; NOT_ALLOWED if not yours
await forum.del(post.id)   // yours; a moderator's del() of someone else's record takes it down
```

A field passed as `undefined` counts as absent, in `put` and `edit` (where it leaves the field as it was),
even if the type doesn't have it: helpers written for an older or a newer version of your types keep
working. A field the type doesn't have, with a value (`null` included), is a typo: `INVALID_RECORD`.

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


## Storage: budgets and policies

```js
await hg.setBudget(3e9)                 // bytes the app may use on this device (null: the default)
await hg.storage()                      // { budget, used, free } — used is an estimate, free the disk's free bytes
await forum.setBudget(1e9)              // this forum's own share, out of the app's (null: share the app's)
await forum.setPolicy('everything')     // owner/admins: every member is asked to keep it all ('auto' is the default)
await hg.createSpace({ name, policy: 'everything' })
forum.status()                          // { policy, access, held: 'all' | 'part', heldFrom, stored, share, budget,
                                        //   belowPolicy, peers, settlers, warnings }
forum.on('status', (s) => {})           // policy, held, belowPolicy, budget or warnings changed
```

The default budget is 5 GB, or what the app holds plus half the free disk if that is smaller. Spaces with
their own budget get it; the others share the rest in proportion to what each holds. See
[concepts.md](concepts.md#holding-part-of-a-space). `heldFrom` (ms) is set while this device reads a big space
from a point in time on (newest first, [concepts.md](concepts.md#big-spaces)); `held` is then `'part'`. Warnings: `BELOW_POLICY` (the space asks to keep
everything and this device can't: give it more room), `OVER_BUDGET` (what this device may not drop —
its own records, the decisions, the list of records — is already more than its share).

## Roles, listed

```js
await forum.roles()   // [{ name, permissions, custom }]: owner, admin, moderator, member, guest, then the space's own
```

## Who, what, who is online

```js
await forum.members()       // [{ identity, role, you, banned, removed, devices: [{ device, log }] }]: members
                            // highest role first, then people banned or removed (role null)
await forum.decisions({ limit: 50, after })   // { items, complete }: newest first, what was decided —
                            // { seq, type, by, device, at, counted, ...what }: who (identity and device), when
                            // (their clock), what (identity, role, action, target, reason, name, permissions,
                            // policy, rules), and whether it counted. `after`: the last item of the previous page
await forum.tags(post)      // { items: ['rust', ...], complete }: a record's tags, sorted
forum.peers()               // [{ identity, device }]: connected right now (identity null for a moment)
hg.types()                  // { post: { fields: { title: 'string', ... }, links, onePerMember, editable, index,
                            //   builtin } }: the declared types, hypergraph's own marked builtin
forum.on('peers', (peers) => {})   // someone connected or left
forum.on('logs', () => {})         // a member's log arrived or grew (at most every 100 ms)
```

`decisions()` is a moderation log your app can show ("bob hid this: off topic"): every member lists the
same, in the order every member applies them. A decision whose author wasn't allowed to make it at that
point is listed with `counted: false` and changed nothing. `peers()` is proven: a peer sends its device
proof, checked against the key of the connection.

## Diagnostics

```js
await forum.inspect()   // read-only snapshot: logs (length, held, indexed, cut, dropped, refused, waiting),
                        // the decision log (length, settled, settlers, writers), records by type, storage, peers,
                        // complete, warnings
await forum.inspect({ records: { type: 'post', limit: 25, after } })   // + rows: { items, next }: every row of the
                        // type, hidden, superseded and dropped ones included, each with `state`
await forum.inspect({ record: id })   // + record: its versions (the put, every edit: who, when, counts) and
                        // deletes, also for a record deleted or taken down
```

For debugging and for the inspector tool. It writes nothing and fetches nothing, but counts every record
of the space: don't call it on every render. The shape is in `specs/011-spaces-core/contracts/api.md`
("Diagnostics").

**The inspector** shows all of this as a web page, from inside your app (Node only):
`const { url } = await require('hypergraph/tools/inspector').serveInspector(hg, { port: 4400 })`. Read-only.
`node tools/inspector/demo.js` plays a forum between three people with an inspector each. See
[tools/inspector/README.md](../../tools/inspector/README.md).
