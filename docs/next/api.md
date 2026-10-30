# Hypergraph's new core: API

`require('hypergraph/next')`, the surface of stories 1 to 9 (spec 011). Concepts: [concepts.md](concepts.md); "deleted" and "incomplete" for your users: [deleting-and-incomplete.md](deleting-and-incomplete.md). The
full planned surface, with what is built marked ✓: `specs/011-spaces-core/contracts/api.md`. The forum
in `test/next/forum/forum.js` uses all of it.

Every key the API gives out (record ids, space keys, identity and device keys) is a short string.
Reads return `{ items, complete }`, `{ record, complete }` or `{ value, complete }` (see
[concepts.md](concepts.md#complete-answers)). Errors are `HypergraphError` with a `code`.

Two rules (spec 012): **reads answer at once** from what this device holds, `complete` saying whether
something it knows of is still on its way (a read waits only when you give it `{ timeout }`); and
**everything a read returns has an event** that says when to read again
([Knowing when to read again](#knowing-when-to-read-again)).

## Open, identity, network

```js
const { Hypergraph } = require('hypergraph/next')

const hg = await Hypergraph.open('./data', {
  types,                 // your record types (below)
  rules,                 // your app's rules (below)
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
that can read that folder. On Linux and macOS the file is readable by its owner only (mode 0600) and a new
instance folder is its owner's only (0700); on Windows the folder's own permissions apply (a user's profile
folder is private to that user by default). Better: ask for the password before creating the account and open with
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

await hg.devices()                      // [{ publicKey, name, current }]; hg.on('devices', () => {}) when it changes
await hg.removeDevice(lost.publicKey, { password })   // or { recoveryPhrase: words }
await hg.setSetting('theme', 'dark')    // any JSON value, the same on every device
await hg.settings()                     // { theme: 'dark' }; hg.on('settings', () => {}) when one changes
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
  note: { fields: { text: 'text' }, editable: 'members' },                                      // any member edits
  theme: { fields: { css: 'text' }, put: { permission: 'decide' } }                              // owner and admins put
}
```

Field kinds: `string`, `text`, `int`, `uint`, `float`, `bool`, `bytes`, `ref` (content held elsewhere:
`{ src: [addresses], size, type, digest }`), `link` (a record), `space` (a space). `links` limits what a
link field may point at: your app refuses to write anything else (`INVALID_RECORD`), and a record from a
modified app pointing elsewhere is kept with that link ignored (the field reads `null`, the record isn't in
`linked()`, `count()`, `sum()` or `query().on()` of its target). `onePerMember`: only each member's latest counts (per its first link field).
`index: [['forum', 'stamp']]` adds a query by field (`where`; records with no value in those fields aren't in it). `editable` says who may edit a record
besides its author: `'author'` (the default), `'members'` (any member), or `{ permission }` (members whose
role has that permission, e.g. one you define with `defineRole`; see [Shared editing](#shared-editing)).
`put` says who may write one: `'members'` (the default: anyone who may write) or `{ permission }`, your
app's or hypergraph's own (`'decide'`: the owner and admins; `'moderate'`: moderators up). Anyone else's
`put` throws `NOT_ALLOWED`; one from a modified app is in no list, count or sum, and `get` gives
`record: null`. Losing the permission works like losing an edit permission: what they put up to the cut
stays. Taking `decide`, `moderate`, `invite` or `roles` from a role you defined has no cut: its members'
records of such types stop counting (give them another role instead). Field
names `id`, `type`, `author`, `device`, `stamp`, `edited`, `futureStamp` are taken by the record.

**App versions.** Members never all update at once, so between versions you may only add fields at the
end of a type (a link field with its `links`), add types and add indexes; anything else (reordering,
removing or retyping a field, removing a type, changing `editable`, `put`, `onePerMember` or a link field's
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
hg.on('spaces', (spaces) => {})   // the list changed: a space joined (here or on your other device), left,
                                  // or a listed space's name or parent arrived or changed
hg.space(forum.key)    // the Space
await hg.leaveSpace(forum.key)   // drops it, and its sub-spaces, from this device
forum.on('change', ({ types, records }) => {})   // records changed: records [{ id, type, deleted }]
```

**Leaving** (`leaveSpace`) closes the space on this device and deletes what this device holds of it (its
logs, its records in the index), its sub-spaces held here included. It changes nobody's membership: the
other members keep everything, your posts included, and your other devices keep the space. This device
doesn't open it again (though your personal space still lists it) until you join it again with an invite.
`NOT_FOUND` if it isn't held here.

**Who can read a space**: only peers that know its key (its members, and whoever holds an invite link, which
carries it). Members meet on a topic derived from the key, which DHT nodes see; a peer knowing only the topic
can't open the space's channel, so it gets no log key and reads nothing.

A link is signed by its maker and holds no key; send it any way you like. One use by default. It works
while its maker is offline, as long as some member able to record decisions (the owner, an admin) is
online. Who may invite to what: a role with `invite` (owner, admins), to a role below theirs, or to
`member` and `guest`; never to owner. A role your app defines with `invite` may also invite to **itself**
when it has no power over others (no `moderate`, `roles` or `decide`): friends invite friends, who invite
theirs, and nobody can mint a moderator or an admin. Leave `invite` out of every role but admin's for
admins-only invites. `redeemInvite` waits up to 30 s (connecting alone can take a few
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
forum.subspaces()        // [{ key, name, private }], sync: the sub-spaces right inside it; one you are in
                         // is listed once hg.space(key) opens it ('spaces' fires then)
news.parent              // the forum's key; null for a top space
staff.private            // true
await staff.setRole(someone, 'member')   // let a forum member into the private room
await staff.removeRole(someone)          // and out: the key changes, they can't read what comes next
const club = await hg.createSpace({ name: 'Club', private: true })   // a private top space
await club.setHistory('hidden')   // newcomers read from their join on ('visible', the default: everything)
club.history                      // 'visible' | 'hidden'
await forum.put('shortcut', { title: 'See News', to: news })          // a 'space' field: a link to a space
hg.space(record.to)      // follow it: the Space if you're in it, NOT_FOUND otherwise (an invite lets you in)
```

A **sub-space** is a space inside another (a sub-forum, a folder with its own rules). Members of the
parent have it at once, without joining (`hg.spaces()` lists it with its `parent`); it has the parent's
members and roles, then its own: roles given in it (`setRole`, `createInvite` on the sub-space), guests
who exist only there. It can be stricter: `writeRoles` (only those roles post; the owner and admins
always may). Its storage policy is the parent's until it sets its own (`setPolicy` on the sub-space). A ban or a removal in the parent always applies in every sub-space below it, whatever
arrives first. Only who may decide creates one (`NOT_ALLOWED` otherwise); nothing splits by itself.
Sub-spaces nest. Its decisions are kept in the parent's decision log, so it needs no settling of its own.

**Closed or private?** A space that isn't private is *closed* for writing (only members' records count) but
not for reading: anyone holding its key reads everything in it, and every member's device holds the key — so
a member you remove (or ban) can go on reading what is written afterwards, from any member who still serves
the space to them. Only a **private** space stops removed members from reading what comes after their
removal. Choose private for anything a removed member must not keep seeing (a staff room, a club's
discussions); closed is enough for a public forum where only writing is restricted.

A **private** space or sub-space is read only by its members: for a private sub-space, the people given
a role in it plus the parent's owner and admins (plain members of the parent see that it exists, not
what is in it). Whoever relays or stores its data without being let in can't read it. Content is
sealed with a key every member's device receives from another member who holds it, so a newcomer reads
once such a member is online. When someone loses access (removed, banned there or in the parent, a
device removed), a member who may decide or moderate changes the key before writing again, and those
who left can't read what is written after; what came before stays readable to them. Each new key unlocks
the ones before it, so a newcomer reads the whole history; with `setHistory('hidden')` (who may decide;
private spaces only, `NOT_ALLOWED` otherwise) a newcomer's arrival changes the key and it reads from its
join on, Signal-style, and what came before doesn't count as missing for it (its reads are complete).
A member's new device is a newcomer too. A member that
can't read (no key) answers `complete: false`. One that may not read it any more (removed, or only
relaying it) is told at once: `status().access` is `'none'` and reads answer immediately with
`{ items, complete: false, access: 'none' }` instead of waiting for keys that will never come; a member
whose key hasn't arrived yet is `'waiting'` (reads answer at once, incomplete; `status` fires when it
turns `'full'`). A record someone wrote in the clear in a private space is
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
await forum.moderateAction('ban', someone, { drop: 'all' })       // and drop everything they wrote
await forum.moderateAction('unban', someone)                      // may be let back in (invite, setRole)

await forum.query('post').moderated('hidden').latest(20)          // what moderators hid, however old
await forum.query('post').moderated('flagged').latest(20)         // what they flagged

await forum.report(post, { reason: 'spam' })                      // any member who may write
const { items } = await forum.reports()                           // moderators: [{ on, count, reports:
                                                                  //   [{ id, by, reason, stamp }] }]
await forum.moderateAction('remove', items[0].reports[0])         // dismiss a report
```

Built-in roles: `owner` (everything, your app's permissions included), `admin` (members, roles, invites,
moderation), `moderator` (moderation), `member` and `guest` (writing). Owners and admins give roles below
their own; a role you define can gain permissions later but never lose `post` or one of your app's
permissions such as `edit-pages` (give its members another role instead); it may lose hypergraph's
own `decide`, `moderate`, `invite` and `roles`.
Moderators, admins and the owner moderate. Every call resolves once your app applied the decision; the
others apply it as soon as it reaches them, in the same order, offline members included. A moderator
demoted later: what they decided before stays, what they decide after counts for nobody.

`drop: 'all'` drops everything the person wrote instead: on every device, in the space and every
sub-space below, for everyone, newcomers included, in one decision. It also works on someone banned
already (ban first, decide later). Lifted (`unban`) and let back in, they write again; what was dropped
stays dropped. Every member must run a hypergraph with spec 014 (2026-10-30): an older one keeps what
newer ones drop.

**Moderated lists.** `query(type).moderated('hidden' | 'flagged')` lists the records moderators hid or
flagged, however old, newest first, paged with `{ after }`, with the other filters (`by`, `on`...). A
revealed record leaves the hidden list; a removed one is in none.

**Reports.** `report(record, { reason })` (anyone who may write; a reason up to 1,000 characters) tells
the moderators privately: what was reported and why are sealed to the devices of the owner, admins and
moderators of that moment; the other members only see that its author wrote a report. `reports()`
(moderators; others `NOT_ALLOWED`) lists those this device opens, grouped by reported record, one per
member (their latest), the most recently reported first; `moderateAction('remove', report)` dismisses
one. A moderator appointed later, or a device of theirs that joined after, doesn't read earlier reports.

Removing or banning someone keeps what they wrote up to what you held at that moment, for everyone,
including people who join later; anything they write after is ignored everywhere. A ban keeps their
earlier votes too. To drop the spam that led to the ban, ban `from` its first record: that record and
everything they wrote after it (on that device) go too, for everyone, in the same decision. Let in again
(after a removal, or a ban lifted with `unban`), they write again; what they wrote while out never
counts. `unban` is for a moderator at least at the rank of whoever banned.

When a role or moderation call is refused (`NOT_ALLOWED`), the message says why: you are banned, not a
member, your role is too low, their role is at or above yours. Before refusing, your app first catches up
with the connected members who record decisions (within 5 s), so a decision made a moment
ago elsewhere (an unban, a new role for you) is not missed. Writing (`put`, `edit`, `del`) does the same.
These waits are the writes' own: reads never wait unless asked.

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
const { record, deleted } = await forum.get(post.id)   // record null if not held, or deleted;
// deleted: null (held, or nothing here says), { by: 'author', stamp, device } (its author deleted it:
// the delete's stamp and device), or { by: 'space' } (taken down by a moderator)
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

Taking the permission away from an editor (`setRole` to a role without it, a removal or a ban) works like a ban, for their
edits only: what they edited up to what you held at that moment stays, for everyone, newcomers
included; edits they make after count for nobody, even for members who showed them before the decision
reached them. Given the permission back, they edit again (their app writes in a new log). Relations and
tags on a shared record follow the same rule: anyone who may edit it may relate from it and tag it.

## Queries

```js
const { items, complete } = await forum.query('post').latest(20)
const next = await forum.query('post').latest(20, { after: items.at(-1) })   // the next page
await forum.query('comment').by(someone).latest(20)     // by author
await hg.personal.query('held').fromDevice(phone).latest(20)   // what one device put (its device key); this
                                                                // device's own: complete once its logs are indexed
await forum.query('post').where({ forum: 'news' }).latest(20)   // a declared index
const stop = forum.query('post').live(({ items }) => render(items), { limit: 20 })   // called again only
                                                // when items or complete changed, not for other types

await forum.query('comment').on(post).by(someone).latest(20)   // filters combine
await forum.query('post').tag('rust').since(Date.now() - 864e5).latest(20)   // since: inclusive; until: before
await forum.linked(post, 'comment')           // what points at the post, oldest first (no type: not relations or tags)
await forum.count('comment', { on: post })    // { value, complete }
await forum.sum('vote', 'value', { on: post })   // one per member, the latest
```

A live query runs at once, then again only when records of its type change (comments and votes don't
re-run a list of posts), and, while its last answer was incomplete, when it may have become complete.
Every read answers at once; `{ timeout: ms }` makes it wait while incomplete, up to `ms`, answering as soon
as it is complete (a one-shot script that wants the other members' records). A read answering at once
still starts what it needs (an older part of a big space, content dropped here), and `change` names the
records when they arrive. Lists are newest first by when a record was
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
                                        //   belowPolicy, peers, settlers, warnings, complete }
forum.on('status', (s) => {})           // policy, access, held, belowPolicy, budget, warnings, settlers or complete
                                        // changed (complete: everything this device knows of here is held)
```

The default budget is 5 GB, or what the app holds plus half the free disk if that is smaller. Spaces with
their own budget get it; the others share the rest in proportion to what each holds. See
[concepts.md](concepts.md#holding-part-of-a-space). `heldFrom` (ms) is set while this device reads a big space
from a point in time on (newest first, [concepts.md](concepts.md#big-spaces)); `held` is then `'part'`. Warnings: `BELOW_POLICY` (the space asks to keep
everything and this device can't: give it more room), `OVER_BUDGET` (what this device may not drop —
its own records, the decisions, the list of records — is already more than its share).

## Helpers: keeping a space available while everyone is offline

```js
await forum.setHelpers(['9cxr385dhs…'])   // the owner: keys of blind-peer servers (z32 or hex; [] clears)
forum.helpers                            // ['9cxr385dhs…'] on every member: show "kept by: …"
forum.on('decisions', () => {})          // the list may have changed
```

A **helper** is an always-on server running Holepunch's `blind-peer-cli`, unchanged (e.g. a small VPS):
it keeps the cores it is handed, follows them live, and serves them back by plain replication; it can't
read a private space's content. Once online (`connectToSwarm`), every member's app connects to the
space's helpers in the background and hands them the space's decisions and every log it holds, so a
member coming online later reads what was posted while nobody else was online. A member who records
decisions (owner, admins, moderators) also lists the logs it holds in the decisions, so a member finds
the posts of people it never met on the helper.

Never required: with no helper, or with all of them down or a key that is wrong, opening, writing and
reading work exactly as without, and nothing waits for a helper. Owner only for now (`NOT_ALLOWED`
otherwise); a sub-space uses its top space's helpers. At most 8; each core goes to 2 of them. A helper is
a cache, not an archive: a full one drops whole old cores and never fetches them again
(`specs/research/availability.md`). Joining still needs a member online (invites are answered by members).

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
forum.on('members', () => {})      // members(), getRole(), roles() may have changed: read again
forum.on('decisions', () => {})    // decisions(), redemptions(), history may have changed: read again
forum.on('logs', () => {})         // a member's log arrived or grew (at most every 100 ms)
```

`decisions()` is a moderation log your app can show ("bob hid this: off topic"): every member lists the
same, in the order every member applies them. A decision whose author wasn't allowed to make it at that
point is listed with `counted: false` and changed nothing. `peers()` is proven: a peer sends its device
proof, checked against the key of the connection.

## Knowing when to read again

Every read has an event that fires when its answer may differ. Listen first, then read: what changes
after you started listening has its event. An event may come when nothing you show changed; a change
never comes without its event. No events after `close()`. Events of sync reads carry the new value; for
async reads, read again.

| Read | Event |
|---|---|
| `get`, `query`, `linked`, `count`, `sum`, `tags`, `edges`, `getByTag` | `space.on('change', ({ types, records }) => {})` |
| `hg.spaces()`, `space.subspaces()`, `space.name`, `space.parent` | `hg.on('spaces', (spaces) => {})` |
| `space.members()`, `getRole()`, `roles()` | `space.on('members', () => {})` |
| `space.decisions()`, `redemptions()`, `space.history`, `space.helpers` | `space.on('decisions', () => {})` |
| `space.status()` | `space.on('status', (status) => {})` |
| `space.peers()` | `space.on('peers', (peers) => {})` |
| `space.memberConnections()` | `'member-connection'`, `'member-disconnection'` |
| `hg.devices()` | `hg.on('devices', () => {})` |
| `hg.settings()` | `hg.on('settings', () => {})` |
| `space.inspect()` | `space.on('logs', () => {})` |

Not covered: `hg.storage()` and `status().stored` / `share` (estimates: read them when you need them),
`hg.types()` (fixed at open).

`change` lists every record whose answer changed, on this device and from others: `records: [{ id, type,
deleted }]` for a put, an **edit**, a delete, a hide, reveal or flag, a take-down, records dropped by a ban
`from` them or a write limit, and content fetched back. `deleted` is `null`, `{ by: 'author', stamp, device }`
(its author's delete: compare `stamp` with an edit's to decide which came later) or `{ by: 'space' }` (a
moderator's take-down, a ban, a write limit). `types` is the distinct types of `records`. An app keeping
something in step (a folder, a cache) re-reads only those records; after a restart it reads once, then
follows `change`.

## App protocols

```js
forum.addProtocol('swarmfs/transfer', {
  messages: [{ encoding, onmessage (msg, peer) {} }],   // compact-encoding codecs
  onopen (peer) { peer.send(0, msg) },                  // peer: { identity, device (z32), send (i, msg) }
  onclose (peer) {}
})
```

Your app's own protocol on the space's connections, next to hypergraph's: a Protomux channel opened with
every peer of the space (once it proved it knows the space's key), also on later connections and when the
other side adds it later. `peer.identity` is null until the peer said who it is (an instant after opening).
One protocol per name per space (`NOT_ALLOWED`). SwarmFS's file transfers use it.

### Members' connections, for your own transfer library

```js
forum.on('member-connection', (stream, peer) => {})   // peer: { identity, device } (z32)
forum.on('member-disconnection', (stream, peer) => {}) // no longer a member here, or gone
forum.memberConnections()                             // [{ stream, identity, device }]: connected now
```

If your app brings a library with its own wire protocol (swarmwire, for files), it needs the connections, not a few
messages. These are the connection streams of the space's **members** only: a peer that proved who it is and may read
here. Strangers and readers of an open space who aren't members never appear. `Protomux.from(stream)` gives the muxer
hypergraph already uses: open your library's channel on it. Each stream comes once per space, when the peer connects
or when it is let in later; the same stream comes from every space two devices share. When that peer stops being a
member here (removed, banned, its device removed) or disconnects, `member-disconnection` comes once and it leaves
`memberConnections()`; let back in, `member-connection` comes again. The stream itself stays open (other spaces may
use it): stop serving it yourself, unless it is still a member of another space you serve.

```js
// swarmwire takes any object with join() and a 'connection' event (with { publicKey }: one id per peer;
// swarmwire after 0.7.0, which accepts a channel the other side opened before it was handed the stream)
const net = new EventEmitter()
net.join = () => ({ destroy () {} })
const hand = (stream) => net.emit('connection', stream, { publicKey: stream.remotePublicKey })
for (const m of forum.memberConnections()) queueMicrotask(() => hand(m.stream))
forum.on('member-connection', hand)
// stop serving a peer that left: close swarmwire's channel on its stream
forum.on('member-disconnection', (stream) => {
  for (const ch of Protomux.from(stream)) if (ch.protocol === 'swarmwire/0') ch.close()
})
```

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
