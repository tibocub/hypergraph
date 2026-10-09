# Hypergraph's new core: concepts

`require('hypergraph/next')`: the redesigned core (spec 011, `specs/011-spaces-core/`). ALPHA: it grows
story by story; this page covers what exists (stories 1 to 3). The API is in [api.md](api.md); the worked
example is the forum in `test/next/forum/forum.js`.

## Spaces

A **space** is a community or a shared place: a forum, a chat, a folder tree, a wiki. It has members,
their roles, its rules and its content. (v1 called it a *context*.) One `Hypergraph` instance holds one
person's identity and any number of spaces, in one folder, over one set of connections.

You create a space with `hg.createSpace({ name })` and let people in with an invite link
(`space.createInvite()` → `hg.redeemInvite(link)`). You never write networking code:
`hg.connectToSwarm()` finds the other members of every space, now and later.

## Records

Everything people write is a **record** of a type your app declares (`post`, `comment`, `vote`…). Each
device writes its own records to its own log in the space; nobody else can write there, and nothing
needs anyone else's agreement, so writing is instant and works offline.

Records show the person, not the device: `record.author` is the identity (the person, with a recovery
phrase), `record.device` the device that wrote the current version.

Records can **link** to other records (a comment's `on` field points at a post). "What points at X" is
a query: `space.linked(post, 'comment')`. A link field can be limited to some types (`links: { on:
['post', 'comment'] }`); a record whose link points at another type (written by a modified app) is still
kept, but that link counts for nothing: the field shows `null` and the record isn't "on" its target. Each
member judges it when reading, from the target's type, so all agree whatever arrived first. Besides link fields, v1's graph vocabulary is there:
**relations** (`relate(a, b, 'cites')`, a type, a number and small data, seen in `edges()` out of one
and into the other) and **tags**. Both are records too, said by whoever may edit the record they start
from (its author, by default); the latest relate or unrelate, tag or untag wins.

## App versions

Members never all update an app at once. A record's fields are numbered in the order its type declares
them, and a reader skips numbers it doesn't know, so as long as a new version only adds fields at the
end and adds types, members on both versions read each other's records: the old app doesn't see the new
fields (its edits keep them), the new one sees them empty on old records. A record of a type the app
doesn't know yet is kept (it may be another version's) and shown once an update declares the type: at
that first start the app indexes what it holds again, like a member that always had the new version.
The same holds for hypergraph's own record types: one added by a newer hypergraph is kept and counted by
type by older ones.
Other changes would make two versions read the same bytes differently, so they are refused at open.

## Edits and deletes

Logs are append-only: nothing is changed in place.

- An **edit** is a new record that replaces an earlier one. The record keeps its id; everyone shows the
  latest version. Who may edit is part of the type: its author (the default), any member, or members
  whose role has a permission (a wiki's editors). Anyone else's edit is refused by your app and ignored
  by every member.
- A **delete** is a record that marks one as deleted (a tombstone), and only the author's counts: on a
  shared page, an editor who doesn't like it edits it (the next edit can restore it), and moderators
  take records down by decision. Every member stops showing it and wipes its copy. A modified app, or a device that was offline and never got the delete, may still keep
  a copy: deleting on a network of peers cannot be stronger than that.

Types declared `onePerMember` (votes) count each member's latest record only.

Losing the right to edit works like a ban, for edits only: the decision taking the permission away
records how far the decider held the editor's logs (a **cut**). Edits below it stay valid for everyone;
edits past it count for no one — members who had shown them take them back, newcomers never show them.
That is the only way members who saw things at different times agree: records aren't ordered against
decisions, so "did they still have the permission?" can't be answered by the clock.

## Latest wins

A person may write from several devices (a laptop and a phone), and clocks are often wrong. "The
latest" version of a record, or a person's latest vote, is decided by a **stamp** on each record: the
later of the device's clock and one more than the newest record of that person the device has seen —
on any of their devices, in any space, after a restart too — and, for an edit, one more than the
version it replaces. So a change made after seeing an earlier one always wins, even when the other
device's clock is an hour ahead. Two changes made at the same moment on two offline devices: one wins,
the same one everywhere (exact ties go to the same device everywhere). A stamp more than 10 minutes
ahead of your clock is flagged (`record.futureStamp`), never reordered.

## Devices and the personal space

A person has one **identity** (from the recovery phrase) and one or more **devices**. Each device
writes its own log in each space, with a proof that it belongs to the identity; records show the
person. A new device joins with a code shown by one already in, and receives the recovery phrase.

Every identity has a **personal space**, shared by its devices only: the list of devices, the spaces
the person is in (each device joins them all), their settings, how far each device has written in each
space ("heads"), and your app's own private records. Its key comes from the recovery phrase, so a
device restored from the phrase alone finds it; its content is encrypted, and nobody else's records
count in it.

**Removing a lost device needs the recovery phrase** (typed, or unlocked by its password on another
device): the removal is signed by the identity itself, written in every space, and cuts the lost
device's logs where your device holds them (or further, if its last heads say so). What it wrote
before stays for everyone; what it writes after counts for nobody. A thief with your phone but not its
password can't remove your laptop. Every device proves itself straight from the identity: a device
can't make other devices (a stolen one minting new ones that no removal names).

**Decision rights follow devices.** Where your role lets you decide or moderate, each of your devices
records decisions; a removed device loses that right in every space, the same for everyone.

## Decisions

What the space must agree on — who is a member, roles, moderation, invites — goes into the space's
**decision log**, one per space, written by the devices of members allowed to decide or moderate (the
owner, admins, moderators) and applied by every member in the same order. A decision counts only if its
author was allowed to make it at that point of the order. Records are never decisions.

Decisions apply as soon as they arrive; their order is then **settled** by the owner and the admins,
one device each: once most of them have seen a decision, its place in the order is final. So a space
outlives its owner: with the owner gone for good and two admins online, decisions keep settling.
Settling needs most of the settlers online at once; a space whose only settler is lost for good still
applies new decisions, but never settles them again (the unsettled part keeps growing), so **give a
space an admin** or two. `space.status()` warns while only one member settles (`SINGLE_SETTLER`).

## Roles and moderation

Each member has a **role**: `owner`, `admin`, `moderator`, `member`, `guest`, or one your app defines
with its own permissions. Roles say who may write, invite, give roles and moderate. Moderators
**flag**, **hide** and **reveal** records, **remove** them for good, **ban** people and lift a ban
(**unban**: what they wrote while banned never counts). These are
decisions: every member applies them in the same order, and one made by someone who wasn't allowed at
that point is ignored by everyone (a demoted moderator's earlier decisions stay).

## Readers enforce

Every member checks what it receives **before keeping, indexing or passing it on**: that a log belongs
to a member of the space (a proof signed by the member's device), that each record decodes and fits its
type, that edits come from allowed editors (links to types a field doesn't allow are judged when read,
see [Records](#records)). What fails is never
shown, and a stranger's log is never kept nor passed on, so spam costs members almost nothing.

Your app's **rules** (`rules: [{ id, validate }]`) are checked the same way: a record that breaks one
is never kept, indexed or passed on by any member.

When someone loses the right to write (removed, banned, or given a role without `post`), the decision
records a **cut**: how much of each of their device logs the decider held. What they wrote below the cut stays, for everyone
and for good; anything past it is ignored by everyone, even by members who had already shown it.

## Complete answers

Each member answers queries from its own local index of what it holds. Every read is **bounded**: it
answers from what is held, waits (up to `readTimeout`, 5 s by default, or the read's own `timeout`) for
what is known to exist but not held yet, and returns `{ items, complete }`.

`complete: false` means: some record this member knows exists isn't held yet (its log is longer than
what has arrived), or no other member has been reached since the app started. The answer is still
useful — show it, and read again later (or use a live query). A space where you are the only member,
on your only device, is always complete. A member nobody has heard from doesn't make answers incomplete: what nobody here knows
of can't be waited for. Records deleted by their authors leave nothing to wait for either.

## Holding part of a space

Each device keeps its spaces within its **storage budget**: one for the whole app (5 GB by default, less on
a nearly full disk), out of which a space can be given its own. A small space is simply held entirely by
every member — nobody chooses anything. A space bigger than its share keeps its newest part plus what was
read: **content is dropped oldest first**, and content fetched back by a read goes last.

Dropping content never changes what a member shows. A dropped record keeps its place in the local index
(its type, author, time, links, tags, votes and edits), so lists, counts and scores stay the same. A read
that needs its content fetches it from whoever holds it (its author always does), within the read's
bound, and keeps it; if nobody holding it answers in time, the record is left out and the answer says
`complete: false`. Dropped content is never fetched again unless read — except in a space whose creator
asked members to **keep everything** (`policy: 'everything'`): there a device that had to drop some gets
it back once it fits, and until then `status().belowPolicy` is true and a `status` event says so.

Never dropped: your own records (from any of your devices), decision logs, the personal space, small
records (votes, tags: under 256 bytes) and hypergraph's own records. The list of records itself (about
0.5 KB per record) is kept too; a space whose list alone is bigger than its share is reported
(`OVER_BUDGET`) — split very big archives into sub-spaces. Disk space freed by dropping comes back when the
database compacts, which hypergraph asks for after dropping a tenth of its budget (at most every 10
minutes). Budgets cover hypergraph's data, not files an app moves itself.

Today a newcomer to a space bigger than its share still downloads it once before dropping the oldest
part; fetching only the newest part comes with big spaces (story 9).

## Rebuilding the index

The local index is never replicated and can always be rebuilt from the logs the device holds. If it is
deleted or can't be read (it is then kept aside as `index.broken-<time>`, never deleted), the next start
rebuilds it: the device shows the same spaces and records as before, even offline. What the index can't
be rebuilt from is also kept in two small files next to it: `instance.json` (the identity's proof, the
personal space's keys, the spaces held, types, budgets) and `logs` (every log accepted in a space).
Content this device had dropped is fetched again once, then dropped again. After a crash, only the
records after the last saved batch are indexed again.
