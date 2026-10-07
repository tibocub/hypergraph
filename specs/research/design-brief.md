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

1. **Activity list in the decision log**: does one entry per author per period hold up with thousands
   of active authors per period (decision log size, newcomer join cost, write rate)?
2. **HyperDB for local indexes**: speed and size for 1M records; can app-declared indexes work without a
   build step for app developers (one generic index collection filled by our code)?
3. **Aggregates across many authors**: how fast are "latest posts across 10,000 authors" and "vote count
   of a post" from what a member holds and fetches? When do they need helpers that keep indexes (as
   Bluesky's servers do)?
4. **Several devices per member**: one log per device, attested to the identity, merged by readers? How
   do "edit from two devices at once" and "one vote per member" resolve?

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
- **Still to measure**: the activity-list gossip (point 5) — how fast a newcomer gets a period's list from
  a few members, its size with 10,000 active authors, and the cost of checking signatures.


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
