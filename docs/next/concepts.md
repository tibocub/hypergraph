# Hypergraph's new core: concepts

`require('hypergraph/next')`: the redesigned core (spec 011, `specs/011-spaces-core/`). ALPHA: it grows
story by story; this page covers what exists (story 1). The API is in [api.md](api.md); the worked
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
a query: `space.linked(post, 'comment')`.

## Edits and deletes

Logs are append-only: nothing is changed in place.

- An **edit** is a new record that replaces an earlier one. The record keeps its id; everyone shows the
  latest version. Who may edit is part of the type (its author, by default); anyone else's edit is
  refused by your app and ignored by every member.
- A **delete** is a record that marks one as deleted (a tombstone). Every member stops showing it and
  wipes its copy. A modified app, or a device that was offline and never got the delete, may still keep
  a copy: deleting on a network of peers cannot be stronger than that.

"The latest" is decided by a **stamp** on each record: the later of the device's clock and one more
than the newest record of that person the device has seen (and, for an edit, one more than the version
it replaces). So a change made after seeing an earlier one always wins, even if a clock is wrong.
Exact ties are settled the same way everywhere. A stamp more than 10 minutes ahead of your clock is
flagged (`record.futureStamp`), never reordered.

Types declared `onePerMember` (votes) count each member's latest record only.

## Decisions

What the space must agree on — who is a member, roles, moderation, invites — goes into the space's
**decision log**, one per space, written by the members allowed to decide (the owner, admins) and
applied by every member in the same order. A decision counts only if its author was allowed to make it
at that point of the order. Records are never decisions.

## Readers enforce

Every member checks what it receives **before keeping, indexing or passing it on**: that a log belongs
to a member of the space (a proof signed by the member's device), that each record decodes and fits its
type, that links point at allowed types, that edits come from allowed editors. What fails is never
shown, and a stranger's log is never kept nor passed on, so spam costs members almost nothing.

## Complete answers

Each member answers queries from its own local index of what it holds. Every read is **bounded**: it
answers from what is held, waits (up to `readTimeout`, 5 s by default, or the read's own `timeout`) for
what is known to exist but not held yet, and returns `{ items, complete }`.

`complete: false` means: some record this member knows exists isn't held yet (its log is longer than
what has arrived), or no other member has been reached since the app started. The answer is still
useful — show it, and read again later (or use a live query). A space where you are the only member is
always complete. A member nobody has heard from doesn't make answers incomplete: what nobody here knows
of can't be waited for. Records deleted by their authors leave nothing to wait for either.
