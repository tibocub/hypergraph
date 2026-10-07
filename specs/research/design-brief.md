# Design brief: hypergraph, rethought

2026-10-07. Status: draft for discussion (Tibo + Claude). Not a spec yet: it states the goal, the
choices we lean towards and the questions to settle by experiment before writing one.

## The goal

The easiest kit to build server-less, decentralized social apps (forums, chats, wikis, websites in
HyperMarkdown, file catalogs) without knowing replication, cryptography or networking. Bring back the
indie web: anyone can run a community or a dynamic site as easily as, or more easily than, on today's
web.

**The test of every decision**: does it make the reddit clone (below) easier to write and more reliable
to run? If a feature doesn't serve that, it waits.

## What a developer should only have to do

1. Describe their data (posts, comments, votes, pages, profiles).
2. Write and read it, including "everything that points at X".
3. Get, for free: accounts (recovery phrase, several devices); community rules (members, roles,
   moderation, private areas, invites); "it stays online" (policy, helpers, clear "unavailable now"
   answers, never a hang); networking (one call).

## What we lean towards (and why)

1. **A graph of records, not a graph database.** Everything an author writes is a typed record in the
   author's own signed log; records point at other records (a comment points at a post, a vote at a
   comment). Apps ask "give me X" and "give me what points at X", one or two hops. This is what worked
   at scale elsewhere (Bluesky's AT Protocol, Nostr, Scuttlebutt), and it removes v1's split of
   entity / content / relation / tag stored in different places with different rules.
2. **Agreement only where it is needed.** Who is a member, roles and permissions, moderation decisions,
   keys, invites: one small ordered decision log per space (Autobase). Posts, replies, votes, follows,
   tags, edits: each belongs to its author, so no agreement — v1 paid for agreement on all relations
   (one indexer per context, ~300 writes/s, newcomers joining everyone's history).
3. **Readers enforce the rules.** Anyone can write in their own log; every reader ignores what the
   space's decisions don't allow (non-members in a closed space, banned authors, hidden content). Simpler
   than enforcing inside shared logs, and how open networks that scaled work.
4. **Indexes are local and derived.** Each member indexes what it holds (by type, author, link target,
   tag, time, fields the app declares), can delete and rebuild them, never replicates them. Queries
   answer from what a member holds, fetch what's missing within a bound, and say when a result is
   incomplete. (No shared index: no "newcomer replays everything", no offline bug.)
5. **Finding who wrote what, without a special role: every member is a keeper.** For each time period, a
   list of the authors active in it (one entry per author, signed by the author). An author announces
   its entry to whoever is connected; every member keeps the lists of the periods it reads and passes
   them on; a newcomer gets them from any member and checks the signatures. Readers then open only the
   authors active in the period they read. (v2 had dedicated keepers: a single point of failure. The
   first draft of this brief put the lists in the space's decision log; spec 007 already measured that
   and rejected it: ~162 KB of memory per member on every peer confirming the log — research R2.)
6. **Schemas.** The app declares record types and their fields and links; records are validated and
   compactly encoded; most of v1's "app rules" become schema rules.
7. **Proven dependencies first.** Hypercore, Corestore, Autobase, Hyperswarm, keet-identity-key, and
   HyperDB for local indexes if it fits (experiment 2); blind-peer as one kind of helper. We write only
   what doesn't exist.
8. **Nothing waits forever; partial holding is normal.** Policy (everyone keeps everything / auto / what
   you read), per-member cache, helpers, availability reports (specs 009, research/availability.md).
9. **The example app is part of the product.** The reddit clone is built alongside, from the first
   commit, with automated tests of its main flows; every API change updates it in the same change.
   (The previous forum examples died because nothing forced that: `p2p-reddit-clone`, `forum-web`,
   `chat-web` untouched since early October or July, untested.)

## What the reddit clone's code should look like (sketch to argue about)

```js
const { Hypergraph } = require('hypergraph')

const app = await Hypergraph.open('./data', {
  types: {
    post:    { fields: { title: 'string', text: 'text' } },
    comment: { fields: { text: 'text' }, links: { on: ['post', 'comment'] } },
    vote:    { fields: { value: 'int' }, links: { on: ['post', 'comment'] }, onePerAuthor: true }
  }
})

const forum = await app.create({ name: 'My forum', policy: 'everyone-keeps-everything' }) // or app.join(link)
const post = await forum.put('post', { title: 'Hello', text: 'First!' })
await forum.put('comment', { text: 'Welcome', on: post })
await forum.put('vote', { value: 1, on: post })

const { items, complete } = await forum.query('post').latest(20)
const comments = await forum.linked(post, 'comment')           // what points at the post
const score = await forum.sum('vote', 'value', { on: post })
forum.query('post').live(render)

await forum.roles.set(someone, 'mod')
await forum.moderation.hide(post, { reason: 'spam' })
const link = await forum.invite({ role: 'member' })
```

No contexts to create, no separate content call, no ids to assemble by hand, no networking code.

## What we keep, change, drop

- **Keep**: identity (keet-identity-key, recovery, devices); roles, permissions and moderation
  meanings (flag, hide, remove, reveal, ban); invites and private areas (spec 008's designs); the
  fluent query style and live queries; v2's control log, author logs, time periods, bounded waits,
  partial holding, efficient reads (research/v2-prototype-lessons.md); the tests as a behavior
  checklist where meanings carry over.
- **Change**: relations, tags and content become fields and links of author records; write rules
  enforced by readers; one decision log per space instead of one Autobase per context.
- **Drop**: v1's context Autobases with indexers and its replicated views (GraphView); v2's keepers and
  rosters; the separate v1 RoleBase/ScopeBase logs (folded into the space's decision log).
- **v1 stays** as it is until hyperDNS moves; the new core lives beside it, cleanly separated.

## Open questions → experiments before a spec

1. **Activity lists passed between members** (point 5): how big is a period's list, how costly to check,
   and how fast does a newcomer get it from a few members? **Answered** (experiment 1 below).
2. **HyperDB for local indexes**: speed and size for 1M records; can app-declared indexes work without a
   build step for app developers (one generic index collection filled by our code)? **Answered: yes**
   (experiment 2 below, including rebuild and live queries).
3. **Aggregates across many authors**: how fast are "latest posts across 10,000 authors" and "vote count
   of a post" from what a member holds and fetches? When do they need helpers that keep indexes (as
   Bluesky's servers do)? **Answered from existing measurements** (below).
4. **Several devices per member**: one log per device, attested to the identity, merged by readers? How
   do "edit from two devices at once" and "one vote per member" resolve? **Proposal and cost below; the
   meaning of "latest" is Tibo's call.**

## Decided (2026-10-07)

- **Names: keep v1's where they still mean the same thing** — `put`, `get`, `del`, `relate`, `unrelate`,
  `edges`, `tag`, `untag`, `getByTag`, `query` (with `.type()`, `.author()`, `.tag()`, `.live()`...),
  `setRole`, `getRole`, `removeRole`, `moderateAction`, `createInvite`, `redeemInvite`,
  `connectToSwarm`. `relate` and `tag` become author records under the hood. Proposed changes (to
  confirm): **`context` → `space`**, because the meaning changes (a v1 context is a place for relations
  inside a graph; a space is the whole community: members, roles, decisions); reusing the old word for a
  different thing would mislead v1 users. **`putContent` / `getContent` go away**: content is a field of
  the record. **No `keyPair` argument** to `moderateAction`: the member's identity signs.
- **Layout: same repo.** About a third of `src/` carries over (adapted), plus all the tooling, research
  and history; and HyperBBS and hyperDNS are linked to this working tree. The new core is written as a
  fresh, separate tree (not grafted onto v1's files), with only reused modules copied in; v1 stays frozen
  beside it until hyperDNS moves, then goes.

## The default policy for new spaces (to discuss)

When someone creates a space, every member's app must decide how much of it to keep on disk:

- **everyone keeps everything**: the most reliable (any one member can serve it all), but each member
  stores the whole space — fine for a 100-person forum (tens of MB), not for a 50 GB archive;
- **keep only what you read**: the lightest, but data held only by offline members is unavailable
  (volatile in small spaces);
- **auto**: keep everything while the whole space fits the member's budget for it (e.g. 1 GB, or a share
  of free disk), and beyond that the newest part plus what was read.

Proposal: **auto by default**, with a generous default budget, so a small space behaves as "everyone
keeps everything" without anyone choosing it, and a big one degrades gracefully; a space's creator can
require "everyone keeps everything", and a member can still lower it on a full device (and is told it's
below the space's policy).

## Experiment 3, from measurements we already have

- **Latest posts across a whole big space without lists of who was active**: opening one log costs ~0.7 ms
  and ~660 B (spec 007, R1): 10,000 authors ≈ 7 s and 6.6 MB per page. Too slow; per-period activity
  lists (point 5) are needed: the prototype's latest page read only the authors active in the newest
  period (0.25 s, ~70–140 KB at 10M messages).
- **Aggregates such as "vote count of a post"**: from a member's local index, ~1 ms if it holds the votes
  (experiment 2) — true in small spaces (everyone keeps everything). In a big space a member doesn't hold
  every voter's records, and fetching thousands of logs for one count is the same 7 s problem. Big spaces
  need **helpers that keep aggregates** (a signed "this post has N votes as of period P", which anyone
  holding the votes can check), as Bluesky's servers do. Small spaces need nothing.
- **Activity lists, size and checking** (measured, one process): ~135 B per entry (author, log,
  start, signature). One period with 1,000 / 10,000 / 50,000 active authors: 135 KB / 1.36 MB / 6.8 MB,
  and 56 ms / 0.64 s / 2.8 s to check every signature. More than a page (~70 KB), so: **periods shrink in
  busy spaces** (e.g. a few minutes when thousands post per hour, so a period's list stays at a few
  hundred entries), and **signatures are checked on use** (only the authors whose records are shown).
- The gossip itself: measured on a real network, see experiment 1 below.


## Experiment results

### 2. HyperDB for local indexes (2026-10-07, `bench/experiments/hyperdb/`)

One definition built once by hypergraph (`build.js`): a `records` collection (id, type, author, time,
links, app index keys, encoded body) and four indexes — by type and time, by author and time, by link
target (a `map` over the record's links), and by **app-declared keys** (a `map` over keys our code
computes when a record is written, e.g. `post|forum=abc|<time>`). App developers run no build step.

A forum-shaped dataset (10% posts, 60% comments on posts, 30% votes; 1,000 authors, 20 forums),
RocksDB engine, one process:

| | 100k records | 1M records |
|---|---|---|
| writing (batches of 10k) | 14,500 records/s | 13,500 records/s |
| disk (records + 4 indexes) | 32 MB | 302 MB (~300 B per record, ~80 B of it the body) |
| latest 50 posts | 0.98 ms | 1.06 ms |
| comments on a post (what points at it) | 0.36 ms | 1.1 ms |
| latest 50 posts in a forum (app-declared index) | 0.68 ms | 0.78 ms |
| an author's latest 50 | 0.60 ms | 1.4 ms |
| one record by id | 0.06 ms | 0.08 ms |

**Verdict: HyperDB does the job.** Queries stay around a millisecond from 100k to 1M; app-declared indexes
work without a build step for apps. Cost: the index roughly doubles what a member stores for what it
holds (members index only what they hold). Not measured yet: rebuilding indexes from logs after a crash,
and live updates (re-running a query on new records).

### 1. Activity lists between members (2026-10-07, `bench/experiments/activity/gossip.js`)

Real Hyperswarm connections on a local DHT (127.0.0.1, so bytes matter more than times: on a home
connection at ~1 MB/s, 1.3 MB is ~1.3 s).

**A newcomer gets a period's list** (members hold N entries; the newcomer asks one member at a time and
compares again with the others after each answer):

| entries | from 1 member | from 3 members | received |
|---|---|---|---|
| 1,000 | 37 ms | 72 ms | 131 KB |
| 10,000 | 129 ms | 102 ms | 1.32 MB |
| 50,000 | 292 ms | 238 ms | 6.6 MB |

No duplicates with several members (asking one at a time works). Checking every signature on arrival
adds ~0.55 s at 10,000 (656 ms instead of 107 ms), hence "check on use".

**New entries spread** (50 members, each with 3 to 17 connections, at most 3 hops apart; 20 authors
announce):

| members pass on | every member has it (median) | received per member per entry |
|---|---|---|
| the entry (~135 B) | 10 ms | 4.75 copies, 615 B |
| a short notice (~40 B); who lacks it asks | 13 ms | 1 entry + notices, 290 B |

Passing on full entries costs each member one copy per connection. **Notices halve it**: at 10,000
active authors per period, ~2.9 MB per member per period instead of ~6.1 MB. (Scuttlebutt's epidemic
broadcast trees and Plumtree do this, plus a tree that cuts the notices further; worth it only if
needed.)

**Found on the way**: members who come online at the same moment don't find each other. Each looks
before the others have announced, and Hyperswarm looks again only every 10 minutes. v1's networking
already looks again after a random delay (`src/networking.js`); the new core must keep that.

**Found by reading prior art: spam in the lists.** Anyone can make keys, so in an open space a spammer
could fill a period's list with thousands of fake authors (13.5 MB for 100,000). Members must check
**"may this author write here?" before keeping or passing on an entry**, not only when showing
records: in a closed space, membership from the decision log (a local lookup); in an open space, a rule
the space chooses (e.g. an invite, a proof of work, a member vouching, or a rate per period).

### 2 (gaps). Rebuilding the index, live queries (2026-10-07, `bench/experiments/hyperdb/rebuild.js`)

100,000 records in 1,000 author logs, on disk:

- **Rebuild from the logs** (crash, lost index, schema change): reopen 0.7 s, read 5.5 s (18,000
  records/s), index 7.8 s (12,800 records/s): **~14 s per 100,000 records**, so 2-3 minutes for a
  million. Rare, and can be made incremental: the index remembers how far it got in each log, so after a
  crash only the unflushed tail is redone.
- **Live queries**: HyperDB's `watch()` fires after each flush; insert a record, flush, re-run "latest 20
  posts": **0.6 ms median, 3.9 ms worst**. Our code knows which types were written, so it re-runs only the
  queries that can change.

### 4. Several devices per member (2026-10-07, `bench/experiments/devices/attest.js`)

Proposal: **one log per device**, as Scuttlebutt learned the hard way (one key on two devices forks the
log, and others reject the fork; Hypercore behaves the same). The device's proof that it belongs to the
member (keet-identity-key, as v1) goes in the log's first block; a reader checks it once per log.

- Cost: proof **139 B** (first device) / **235 B** (device added by another device); checking **0.07 /
  0.13 ms**. Cheap, so devices are invisible to apps: records show the member, not the device.
- **"Latest wins" without trusting clocks**: a device stamps a record with *the later of its clock and
  one more than the newest record of its member it has seen*. A member's devices read each other's logs,
  so a change made after seeing an earlier one always wins, even when one device's clock is an hour
  ahead. Only truly simultaneous edits (both offline) are settled arbitrarily but identically for
  everyone (by device key). Votes: one per member per target, the latest counts.
- **A lost device** is removed by a record from another device (or the identity) that says "trust its
  log up to block n": the same cut-by-length as v2's bans, because a thief could backdate times but
  not rewrite blocks others already hold.

### 6. Schemas without a build step (2026-10-07, `bench/experiments/schema/encoding.js`)

Hyperschema versions encodings well, but by generating code, which every app would have to run. The
app's declared types need a **runtime** encoding that survives app updates (old and new versions of an
app run side by side in one space). Tested: each present field is written as its number (declaration
order, so apps may only add fields at the end, as Hyperschema requires), its length, its value;
readers skip numbers they don't know and leave missing fields empty (protobuf's rule).

| record | JSON | tagged |
|---|---|---|
| post (title, text) | 129 B | 113 B |
| comment (text, link) | 179 B | 116 B |
| vote (value, link) | 103 B | 40 B |

Both directions work (an old app reads a newer record, a newer app reads an old one); ~1.6 µs to encode,
~0.5 µs to decode. Hypercore's own ~130 B per block then dominates small records like votes, so batching
a few small records per block is a later option, not a need.

### Deleting, said plainly

Logs are append-only and other members hold copies. `del` writes a "deleted" record: every app built on
hypergraph then hides the record and wipes its bytes from its own disk (Hypercore can clear blocks
locally). Nobody can force a modified or offline peer to wipe its copy, which is true of every P2P
system and of email. The docs and the reddit clone should say so where users delete.

### Activity entries need no signature of their own (reasoned, follows from the above)

An entry says "log L has records in period P, from block S". Everything in it can be checked against
the log itself, which its author already signs: block S is in P and block S-1 is before it (two block
reads a reader does anyway when it opens the log). A false entry costs a reader one wasted lookup; an
entry for a log that may not write here is dropped by the "may write" check. So the entry shrinks from
~135 B (with a 64 B signature and the author key) to **~40 B** (log key, period, start): **10,000 active
authors = ~400 KB per period instead of 1.36 MB, and nothing to verify**. Not measured beyond that
arithmetic; the next real test of the lists should use this form.

### The pieces together: a spike (2026-10-07, `bench/experiments/spike/`)

A throwaway prototype, not the core: the creator's decision log (a plain Hypercore, one admin), one
log per member, HyperDB index per member, readers enforcing the decisions, and the sketch's API (`put`,
`query().latest`, `live`, `linked`, `sum`, `hide`, `ban`). `run.js` plays the reddit clone with three
members on a local DHT: create, join, post, comment, reply, vote (one per member, latest counts; a
changed vote), live list, hide, ban cut by length (spam gone, the earlier vote still counts, posts
after the ban never indexed), a non-member's log never opened.

- **It fits**: 220 lines for the space, all flows pass, three runs stable. Every member agrees within
  **15–42 ms** of a write (local network); creating and joining ~300 ms.
- **The app code reads like the sketch.** What was awkward, so API bugs to fix in the spec (rule 3):
  - `ban(member, { keepUpTo })`: a moderator doesn't know log lengths. The API should be `ban(member)`,
    cutting at the length the moderator holds when deciding (v2 did this); `keepUpTo` stays internal.
  - "One vote per member" lived in `sum()`; it belongs in the type (`onePerAuthor`, as the sketch had),
    so `linked()` and every query agree.
  - `live()` re-ran 15 times for a handful of changes, on comments and votes too: re-run only queries
    whose types changed (as planned in experiment 2).
- **Found**: HyperDB refuses to commit while another insert is running. With logs arriving from many
  authors at once, the core needs **one write queue per index** (the spike's `#exclusive`).
- Not covered by the spike, on purpose: invites, devices, private spaces, activity lists (a small
  space's member list is its author list; the lists matter only when members far outnumber the authors
  active in a period), schemas, bounded waits, partial holding.

## Prior art read on the way (2026-10-07)

- **Nostr has both models.** NIP-72 (communities where moderators approve each post and readers show
  only approved ones) is now marked "unrecommended" in favour of NIP-29 (a relay enforces membership and
  moderation). NIP-72's stated problems: moderators must approve every post, and when the moderators
  change, past approvals are lost unless re-signed. **Our model avoids both**: the decision log says who
  may write and who is banned (no per-post approval), and decisions stay valid when roles change. What
  NIP-29 buys with a server (closed groups, private reading) we get from the ordered decision log and
  encryption (spec 008). What it costs, we don't pay: a group lasts only as long as its relay.
- **Scuttlebutt**: one feed per device; multi-device ("fusion identity") came late and stayed awkward.
  Their replication (epidemic broadcast trees) is the model for passing activity on cheaply.
- **Bluesky**: counts and feeds come from big servers (AppViews) that index everything; that is the
  "helpers that keep aggregates" of experiment 3, only needed for big spaces.

