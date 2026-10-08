# Feature Specification: Spaces — hypergraph's redesigned core

**Feature Branch**: `011-spaces-core`

**Created**: 2026-10-08

**Status**: Draft

**Supersedes**: spec 010 (graph on v2, branch `010-graph-on-v2`), whose approach the design brief replaced.
Spec 009 (resilience) is to be retargeted onto this core later.

**Input**: User description: "Hypergraph's redesigned core ("spaces"), per specs/research/design-brief.md
(all decisions and measurements there). Goal: the easiest kit to build server-less, decentralized
social apps [...] judged by the reddit clone, which is built alongside with automated tests of its main
flows [...]. Data model: a graph of typed records owned by their authors [...]. Spaces (renamed from
v1's contexts) [...] one small ordered decision log per space holds only decisions [...]. Readers
enforce the rules [...]. Each member indexes what it holds locally [...]. Queries [...] answer from what
is held, fetch what is missing within a bound, and say when a result is incomplete [...]. Finding
authors [...] activity lists [...]. Several devices: latest wins [...]. Deleting [...]. Storage policy
per space: auto by default [...]. Names: keep v1's names [...]. Identity [...]. Private spaces/areas
and invites: carry over spec 008's designs [...]. Networking: one call [...]. Layout: same repo, new
core as a fresh separate tree [...]. Out of scope: helpers/blind peers and availability reports [...],
removing v1, migrating HyperBBS or hyperDNS, SwarmFS. Success: every reddit-clone flow has a passing
automated test; a newcomer's first page in a space of 10k / 1M records stays within the brief's
measured budgets; many authors write without a single indexer; measurements of the brief reproduced
on the real core."

Who the "user" is: a developer building an app on hypergraph, and the people using that app.
Hypergraph has no UI of its own. **The reddit clone** (a forum app shipped in this repo) stands in for
that developer: every story below is proven by the clone and its automated tests, built in the same
change as the feature (CLAUDE.md rule 3). Background, measurements and reasons for each choice:
[`specs/research/design-brief.md`](../research/design-brief.md).

Words used below:
- **Space**: a whole community (a forum, a chat, a wiki): its members, roles, rules and content.
  Replaces v1's "context".
- **Record**: one thing a member writes (a post, a comment, a vote, a profile, a page), of a type the
  app declares. It belongs to its author; only its author can change or delete it.
- **Decision**: something the space agrees on (who is a member, roles, moderation, invites, keys).
  Decisions are ordered the same way for every member. Records are not decisions.
- **Member**: a person in a space, with one identity and possibly several devices.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A forum in a few lines (Priority: P1)

A developer declares the forum's record types (post, comment, vote) and writes the app: a person
creates an account (with a recovery phrase), creates a forum, invites nobody yet, posts, comments,
replies to comments, votes; other members see the same posts, comments and scores, and the list of
posts updates live. The developer writes no networking, replication or cryptography code.

**Why this priority**: This is the product. If this isn't easy, nothing else matters.

**Independent Test**: The reddit clone's tests for sign up, create a forum, post, comment, reply, vote
and live list, run with three members on a real network (local), pass; the clone's data code uses only
the public API.

**Acceptance Scenarios**:

1. **Given** an app that declared `post`, `comment` (links to a post or a comment) and `vote` (a value,
   links to a post or a comment, one per member), **When** a member creates a space and writes a post,
   **Then** the member and every other member of the space see it in "latest posts".
2. **Given** a post, **When** members comment on it and reply to comments, **Then** every member gets the
   same comments for the post and the same replies for each comment ("what points at X").
3. **Given** a post, **When** three members vote and one of them changes their vote, **Then** every member
   computes the same score, counting one vote per member, the latest.
4. **Given** a live list of the latest posts, **When** any member posts, **Then** the list updates without
   the app asking again; **When** members only comment or vote, **Then** the list of posts is not
   recomputed.
5. **Given** a member's own post, **When** they edit it, **Then** every member sees the latest version;
   **When** they delete it, **Then** every member stops showing it.
6. **Given** a record, **When** someone other than its author tries to change or delete it, **Then** it is
   refused locally and ignored by every member.
7. **Given** a new app user, **When** they create an account, **Then** they get a recovery phrase that
   restores the same identity on another computer.

---

### User Story 2 - Community rules that hold (Priority: P1)

The forum's creator gives roles (admin, moderator, custom roles with permission lists), and moderators
flag, hide, remove, reveal and ban. Every member applies these decisions the same way, including
members who were offline when they were made; a banned member's earlier contributions can stay
(votes, comments before the ban) while everything after is ignored. Members only keep and pass on what
the space allows, so spam from strangers costs them almost nothing.

**Why this priority**: A forum without moderation dies to spam; a community needs its rules to hold
without a server.

**Independent Test**: The reddit clone's moderation tests (assign a moderator, hide, reveal, remove,
ban with earlier votes kept, a non-member's writes ignored, a demoted moderator's later decisions
ignored) pass with three members, one of them offline during the decision.

**Acceptance Scenarios**:

1. **Given** a moderator, **When** they hide a comment, **Then** every member stops showing it, and
   **When** they reveal it, every member shows it again.
2. **Given** a member who posted, voted, then spammed, **When** a moderator bans them, **Then** every
   member keeps what they wrote up to what the moderator held at that moment and ignores everything
   after, including what they write later; the moderator never deals with lengths or positions.
3. **Given** a member who was offline during moderation, **When** they reconnect, **Then** they apply the
   same decisions in the same order and show the same content as everyone else.
4. **Given** two admins making conflicting decisions at the same time (one bans, one gives a role to
   the same member), **When** both reach everyone, **Then** every member ends with the same result.
5. **Given** someone who is not a member, **When** they write records "into" the space, **Then** no member
   keeps, indexes, shows or passes them on.
6. **Given** a moderator whose role is removed, **When** they make moderation decisions afterwards,
   **Then** those decisions are ignored; their earlier decisions stay valid.
7. **Given** the v1 role model (built-in roles, custom roles, permission lists, app rules that reject
   writes), **When** an app uses `setRole`, `getRole`, `removeRole` and `moderateAction`, **Then** they mean
   what they meant in v1, without passing key pairs (the member's identity signs).

---

### User Story 3 - Invites and joining (Priority: P2)

A member creates an invite link (for a role, limited uses, an expiry, optionally access to private
areas) and sends it any way they like; whoever opens it joins the space, even when the inviter is
offline, as long as some member who can record decisions is online. An "open" forum is a public invite
link with unlimited uses that admins can revoke.

**Why this priority**: Spaces grow by invitation; the clone's "invite" flow depends on it.

**Independent Test**: The reddit clone's invite tests (invite, join while the inviter is offline,
expired or used-up or revoked link refused, open forum via a public link, revoking it stops new joins)
pass.

**Acceptance Scenarios**:

1. **Given** an invite link for the member role, **When** someone redeems it while the inviter is offline
   and another admin is online, **Then** they become a member with that role and can post.
2. **Given** an expired, used-up or revoked link, **When** someone tries to redeem it, **Then** it is
   refused with a clear reason.
3. **Given** a public invite link, **When** many people join, **Then** each becomes a member; **When** an
   admin revokes the link, **Then** no one else can join with it and existing members stay.
4. **Given** an invite made by a member whose role doesn't allow giving that role, **When** it is
   redeemed, **Then** it is refused.

---

### User Story 4 - Hypergraph's graph vocabulary (Priority: P2)

Developers who know v1 find its vocabulary: relations between records (`relate`, `unrelate`, with a
type, an optional number and small data), `edges` in and out with counts, tags (`tag`, `untag`,
`getByTag`), and the fluent query style (by type, author, tag, link, time, with ordering, paging and
live results). Under the hood these are records owned by their authors.

**Why this priority**: Hypergraph is "a simple graph store"; v1's vocabulary is what its users liked.

**Independent Test**: The meanings of v1's graph tests (relations, edges, counts, tags, queries,
paging) pass on the new core, rewritten where only names of setup calls differ.

**Acceptance Scenarios**:

1. **Given** two records, **When** a member relates them with a type, a number and data up to 4 KB,
   **Then** every member sees the relation in the outgoing edges of one and the incoming edges of the
   other, with the right counts; **When** the member unrelates them, it disappears for everyone.
2. **Given** tagged records, **When** a member asks for a tag, **Then** they get the records with that tag,
   newest first, page by page.
3. **Given** a query by type, author, tag or link with a limit, **When** results exceed the limit,
   **Then** the member can page through them in order without gaps or repeats.

---

### User Story 5 - One person, several devices (Priority: P2)

A person uses the forum from a phone and a laptop with one identity. Records show the person, not the
device. A change made after seeing an earlier one always wins, even when a device's clock is wrong;
one vote per person counts. A lost phone can be removed so that nothing written with it afterwards
counts.

**Why this priority**: People have several devices; getting this wrong forks identities or loses
edits.

**Independent Test**: The reddit clone's devices tests (add a second device, vote from both, edit from
both with one clock an hour ahead, remove a lost device) pass.

**Acceptance Scenarios**:

1. **Given** a member with two devices, **When** they post from each, **Then** every member sees both
   posts by the same person.
2. **Given** a member who votes +1 on the laptop, **When** they later vote -1 on the phone after it has
   seen the laptop's vote, **Then** the -1 counts everywhere, even if the laptop's clock is an hour ahead.
3. **Given** truly simultaneous edits from two offline devices, **When** both reach everyone, **Then**
   every member settles on the same version.
4. **Given** a lost device, **When** the member removes it from another device (or with the recovery
   phrase), **Then** every member ignores what that device writes afterwards and keeps what it wrote
   before.

---

### User Story 6 - Holding part of a space, honestly (Priority: P2)

Each member's app keeps as much of a space as its storage policy allows: by default "auto", which keeps
everything while the space fits a generous budget and, beyond it, the newest part plus what was read.
A space's creator can require "everyone keeps everything"; a member on a full device can still lower
it and is told it's below the space's policy. Every read returns within a bound, from what is held
plus what can be fetched in time, and says when the answer is incomplete. Nothing waits forever.

**Why this priority**: A small forum must survive members going offline (everyone holds everything); a
big one must not fill disks; and an app must never hang.

**Independent Test**: Tests for policies (default auto keeps a small space entirely; required
keep-everything; a member below policy is told), bounded reads (author offline → answer within the
bound, marked incomplete; author back → complete), and the reddit clone showing "some posts unavailable"
instead of hanging.

**Acceptance Scenarios**:

1. **Given** a new small space with default settings, **When** members write, **Then** every member keeps
   all of it without anyone choosing a policy.
2. **Given** a space bigger than a member's budget, **When** the member reads, **Then** it keeps the newest
   part plus what it read, and stays within the budget.
3. **Given** a read whose data is held only by offline members, **When** the app asks, **Then** it gets an
   answer within the bound marked incomplete, never a hang; **When** the data becomes reachable, the same
   read is complete.
4. **Given** a space whose creator required keep-everything, **When** a member lowers it, **Then** the
   member's app is told it is below the space's policy.
5. **Given** a member's local index is lost or damaged, **When** the app restarts, **Then** the index is
   rebuilt from what the member holds, and after a crash only the unfinished part is redone.

---

### User Story 7 - Big spaces (Priority: P3)

A space with many members, of whom only some write in a given period, stays fast to read for a
newcomer: the latest posts appear without opening every member's history. Members find who wrote
recently through activity lists that every member keeps and passes on; the cost of joining and of
reading the first page does not grow with the space's total size.

**Why this priority**: Small spaces come first; big ones must not hit a wall later.

**Independent Test**: A benchmark with spaces of 10,000 and 1,000,000 records (and thousands of
members) measures a newcomer's first page time and download, and the traffic of activity lists per
member per period; spam with thousands of throwaway keys doesn't enter members' lists.

**Acceptance Scenarios**:

1. **Given** spaces of 10,000 and 1,000,000 records, **When** a newcomer reads the latest 20 posts,
   **Then** time and download stay within the success criteria and nearly the same at both sizes.
2. **Given** an author who writes for the first time in a period, **When** members are connected, **Then**
   every member learns it quickly and passes on a short notice rather than the whole entry.
3. **Given** false or spam activity entries, **When** a member receives them, **Then** it drops them
   (author not allowed to write, or the log doesn't confirm them) and doesn't pass them on.

---

### User Story 8 - Private spaces and private areas (Priority: P3)

A space, or an area inside it (a private sub-forum), can be readable only by granted members: content
is encrypted, grants follow invites and roles, removing someone's access means they can't read what
is written afterwards. Spec 008's designs carry over.

**Why this priority**: Needed for closed communities, but a public forum works without it.

**Independent Test**: Spec 008's private-channel tests, ported to private areas (grant, read, revoke,
no access to new content after revocation, invite with access), pass; the reddit clone has a private
sub-forum test.

**Acceptance Scenarios**:

1. **Given** a private area, **When** a granted member posts, **Then** granted members read it and others
   (including whoever relays or stores it) can't.
2. **Given** a member whose access is removed, **When** others post afterwards, **Then** that member can't
   read the new posts.
3. **Given** an invite that includes access to a private area, **When** it is redeemed, **Then** the new
   member reads the area.

---

### User Story 9 - The app changes, old and new versions keep talking (Priority: P2)

The developer ships an update that adds a field to a type (say, "edited" on comments). Members on the
old version and members on the new one share the same space: the old app reads new records (ignoring
the field it doesn't know), the new app reads old records (the field is empty).

**Why this priority**: Apps update constantly and members never all update at once.

**Independent Test**: A test runs two versions of the clone's types in one space and checks both read
everything; adding a field anywhere but at the end, or changing a field's kind, is refused with a clear
message at startup.

**Acceptance Scenarios**:

1. **Given** members on two versions of an app, **When** each writes, **Then** each reads the other's
   records.
2. **Given** a type change other than adding fields at the end, **When** the app starts, **Then** it gets a
   clear error naming the type and field.

### Edge Cases

- **Concurrent writes**: two members comment on the same post at once (both appear, in a stable order
  for everyone); two devices of one member edit the same record at once (one wins, the same everywhere);
  two admins decide conflicting things at once (same final state everywhere).
- **Out of order**: a vote arrives before the post it points at (counted once the post arrives); a ban
  arrives after the banned member's later records were shown (they disappear); a hide arrives before the
  hidden record (it never shows).
- **Offline and partition**: a member offline during decisions catches up to the same state; two halves
  of a space split and rejoin, converging without manual action.
- **Late joiner with partial history**: a newcomer reads the first page before holding everything, and
  is told what's incomplete.
- **Peers starting together**: members who come online at the same moment still find each other
  (re-look after a random delay).
- **Adversarial input**: malformed records, records over the size limit, unknown types, links to
  nothing, forged activity entries, non-members' logs, throwaway-key spam, a banned member continuing to
  write, a lost device continuing to write, a device clock far in the future: none crash a member, none
  show up where the rules say they shouldn't.
- **Partial replication**: a member holding only part of a space answers from what it holds and fetches
  the rest within the bound.
- **Deletion**: a deleted record is hidden and wiped by every well-behaved member; a modified or offline
  peer may keep a copy, and the docs say so.
- **Storage full**: a member at its budget keeps working (oldest unread content dropped first), never
  drops its own records or the decision log.

## Requirements *(mandatory)*

### Functional Requirements

**Records and types**

- **FR-001**: Apps MUST declare record types at runtime (fields with kinds, links with allowed target
  types, "one per member" where it applies), without any build step.
- **FR-002**: Members MUST be able to write, read, edit and delete their own records (`put`, `get`,
  `del`); edits and deletes by anyone else MUST be refused locally and ignored by every member.
- **FR-003**: Records MUST be readable across app versions where types only gained fields at the end;
  other type changes MUST be refused at startup with an error naming the type and field.
- **FR-004**: Each record MUST be owned by its author's identity and written by one of the author's
  devices; records MUST show the person, not the device.
- **FR-005**: Content MUST be a field of a record (no separate content calls); large or external content
  MUST be referable from a field.

**Graph and queries**

- **FR-006**: Members MUST be able to ask for "what points at X" (records linking to a record),
  optionally by type, with counts.
- **FR-007**: The API MUST keep v1's graph vocabulary with v1's meanings where they still apply:
  `relate`, `unrelate`, `edges`, `tag`, `untag`, `getByTag`, `query` (by type, author, tag, link, time;
  ordering, limit, paging, live).
- **FR-008**: The API MUST offer sums and counts over linked records (a post's score), applying "one
  per member, latest counts" for types declared that way.
- **FR-009**: Live queries MUST update when records of their types change and MUST NOT be recomputed for
  changes that cannot affect them.
- **FR-010**: Every read MUST return within a bound (default stated in the docs, overridable per call)
  with the results it has and whether they are complete.
- **FR-011**: Each member MUST answer queries from its own local index of what it holds; the index MUST
  never be replicated and MUST be rebuildable from what the member holds, redoing only the unfinished
  part after a crash.

**Spaces, decisions and rules**

- **FR-012**: A space MUST be created with one call and joined with an invite link; the word "space"
  replaces v1's "context" in the API and docs.
- **FR-013**: Each space MUST have one ordered decision log holding only decisions: membership, roles
  and permissions, moderation, invites, private areas and their keys, and the space's settings (storage
  policy). Ordinary records MUST NOT require any agreement.
- **FR-014**: Every member MUST apply decisions in the same order and reach the same state, including
  after being offline and with concurrent decisions.
- **FR-015**: Roles MUST work as in v1: built-in roles, custom roles with permission lists, app rules that
  reject writes; `setRole`, `getRole`, `removeRole` keep their names and meanings.
- **FR-016**: Moderation MUST offer flag, hide, remove, reveal and ban through `moderateAction` (no key
  pair argument). A ban MUST keep the banned member's records up to what the moderator held when deciding
  and ignore everything after; the moderator MUST NOT have to give a length or position.
- **FR-017**: Readers MUST enforce the rules: every member ignores records the decisions don't allow
  (non-members, banned beyond the cut, hidden, removed), and MUST check that an author may write in the
  space before keeping, indexing or passing on anything of theirs.
- **FR-018**: A decision made by someone without the permission at that point in the order MUST be
  ignored by every member; decisions made before losing a role stay valid.

**Invites**

- **FR-019**: Members with permission MUST be able to create invite links (role, uses, expiry, private
  areas), revoke them, and see who redeemed them; spec 008's invite design carries over.
- **FR-020**: Redeeming MUST work while the inviter is offline, as long as a member able to record
  decisions is online; refusals (expired, used up, revoked, inviter not allowed) MUST state the reason.
- **FR-021**: An open space MUST be expressible as a public invite link with unlimited uses that admins
  can revoke, plus an optional per-period limit on how much a new member may write.

**Identity and devices**

- **FR-022**: Accounts MUST use an identity with a recovery phrase (as v1), restorable on another
  computer.
- **FR-023**: A member MUST be able to add devices; each device writes its own log with a proof that it
  belongs to the member, checked once per device by readers.
- **FR-024**: When versions of a member's record (or votes on one target) conflict, the latest MUST win,
  where "latest" is stamped as the later of the device's clock and one more than the newest record of
  that member the device has seen; exact ties MUST be settled the same way for everyone.
- **FR-025**: A member MUST be able to remove a lost device (from another device or with the recovery
  phrase); every member then ignores what that device wrote after the point the removing device held.

**Finding authors and holding data**

- **FR-026**: In spaces where the member list is small enough, members MUST find authors from the member
  list; in bigger spaces, from per-period activity lists that every member keeps and passes on (short
  notices, entries checked against the authors' logs, no separate signatures), so that a reader opens
  only the authors active in the periods it reads.
- **FR-027**: Each space MUST have a storage policy: "auto" by default (keep everything within a
  generous budget, then the newest part plus what was read), "keep everything" if the creator requires
  it; a member MUST be able to lower it and MUST be told when below the space's policy. A member MUST
  never drop its own records or the decision log.
- **FR-028**: Deleting MUST write a deletion that every member honours by hiding the record and wiping
  its copy; the docs and the reddit clone MUST say plainly that modified or offline peers may keep copies.

**Private spaces and areas**

- **FR-029**: A space or an area of it MUST be able to be private: content readable only by granted
  members, grants following invites and roles, and removed members unable to read what is written after
  their removal; spec 008's design carries over.

**Networking and developer experience**

- **FR-030**: Joining the network MUST be one call (`connectToSwarm`); members who come online at the
  same moment MUST still find each other.
- **FR-031**: The reddit clone MUST be built alongside, in this repo, with automated tests of sign up,
  create a forum, post, comment, reply, vote, live list, moderate, invite, devices and private
  sub-forum; every change to the public API or its behaviour MUST update the clone and its tests in the
  same change. Anything awkward to write in the clone MUST be fixed in the API, not worked around.
- **FR-032**: The new core MUST live beside v1 in this repo as a separate tree; v1 MUST stay unchanged
  and working (its suite and hyperDNS's keep passing) until hyperDNS moves.
- **FR-033**: Docs MUST cover the new API for developers, including what "deleted" and "incomplete"
  mean, with the clone as the worked example.
- **FR-034**: The new core MUST run on both Node and Bare (the runtime of Pear, used later for desktop
  and mobile apps), and its tests MUST run on both from the first story; it MUST NOT use Node's
  built-in modules directly. (Checked 2026-10-08: every Holepunch dependency loads in Bare 1.27; Node's
  `path`, `fs`, `os` don't.)

### Key Entities

- **Identity / member**: a person; a recovery phrase; one or more devices proven to belong to it.
- **Device log**: everything one device of one member wrote in a space, in order, signed.
- **Record**: typed fields written by a member; links to other records; edit and delete by its author.
- **Type**: declared by the app; fields (kinds, added only at the end), links (allowed targets), "one
  per member".
- **Space**: a community; its decision log, members, roles, policy, private areas.
- **Decision**: an ordered entry of the decision log (membership, role, moderation, invite, key,
  setting), valid only if its author had the permission at that point.
- **Invite**: a link carrying role, uses, expiry and private areas; redeemed into a membership decision.
- **Activity entry**: "this log has records in this period, from this position", kept and passed on by
  members in big spaces.
- **Local index**: each member's own index of what it holds; rebuildable; never shared.
- **Storage policy**: auto (budget), keep everything, or lower by member choice.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every reddit-clone flow (sign up, create a forum, post, comment, reply, vote, live list,
  moderate, invite, devices, private sub-forum) has an automated test that passes with three members on
  a local network; on that network every member agrees on a write within 1 second.
- **SC-002**: The clone's data layer (everything it does with hypergraph) uses only the public API, has
  no networking, replication or cryptography code, and stays under 400 lines.
- **SC-003**: Concurrent writes and decisions converge: in tests of concurrent edits, votes, comments and
  conflicting decisions, including a partition healed after both sides wrote, every member ends with the
  same visible state.
- **SC-004**: A newcomer's first page (latest 20 posts) in spaces of 10,000 and 1,000,000 records arrives
  within 2 seconds and 1 MB on a local network, and the 1,000,000 figure is at most 1.5 times the 10,000
  one.
- **SC-005**: A record is visible to connected members without any other member confirming it; with 50
  authors writing at once, every member sees every author's records within 2 seconds of each write
  (local network).
- **SC-006**: Nothing a peer sends (malformed records, oversized records, forged activity entries,
  non-members' logs, records past a ban or a device removal, a clock far in the future) crashes a member
  or appears where the rules say it shouldn't; 10,000 throwaway-key spam entries add nothing to a
  member's activity lists or index.
- **SC-007**: No read waits longer than its bound; with the data's only holders offline, the read returns
  within the bound marked incomplete, in every test.
- **SC-008**: A lost index of 100,000 records is rebuilt within 30 seconds; after a crash, only the part
  written since the last save is redone.
- **SC-009**: A change made on a device after it has seen an earlier one wins on every member even when
  the other device's clock is an hour ahead.
- **SC-010**: The design brief's measurements (activity-list size and spread, index speed, device-proof
  cost, encoding sizes) are re-run on the real core and recorded, with any difference over 25% explained.
- **SC-011**: v1's test suite and hyperDNS's suite still pass at every commit of this feature.
- **SC-012**: The core's whole test suite, including the reddit clone's tests, passes on Bare as well
  as on Node at every commit of this feature.

## Assumptions

- The people using apps have intermittent, ordinary home connections; "local network" figures in the
  success criteria are measured on a local test network and real-network figures are reported alongside
  where measured, not used as pass/fail.
- "Small space" means one whose whole content fits members' default budget (in the order of 1 GB); the
  exact default budget and the point where activity lists start being used are set during planning from
  measurements.
- The default read bound is in the order of seconds (to be fixed in planning); apps can choose their own
  per call.
- Open spaces use a public invite plus an optional per-period write limit; other anti-spam rules (proof
  of work, vouching) are left for later.
- The decision log is shared by the members able to record decisions (admins and those with the right
  permission); others only read it.
- Large files (images, video) are referenced from records, not stored in them; storing and serving them
  belongs to SwarmFS and is out of scope.
- Helpers (always-on members, blind peers), availability reports, and aggregates kept by helpers for very
  big spaces are out of scope (spec 009, later); in big spaces without helpers, sums and counts cover what
  a member holds and fetches within the bound, and say so.
- HyperBBS and hyperDNS are not migrated here; v1 is not removed here.
- Dependencies: the Holepunch stack already used (Hypercore, Corestore, Autobase, Hyperswarm,
  keet-identity-key) plus HyperDB for local indexes (experiment 2); no forks.
- About a third of `src/` (identity, crypto, invites, the decision log, replication and networking
  lessons) is carried over, adapted, into the new tree; the rest of v1 stays where it is.
