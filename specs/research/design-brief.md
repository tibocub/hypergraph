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
5. **Finding who wrote what, without a special role.** The space's decision log also records which
   authors were active in each time period (one small entry per author per period); readers open only
   those authors for the period they read. (v2 used keepers for this: a single point of failure.)
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

## Not decided yet (Tibo)

- How close the API stays to v1's names (`put`, `relate`, `tag`, `query`) versus the sketch above.
- Default policy for new spaces.
- The project's name and package layout (same repo beside v1, or a new package).
