# Feature Specification: Spaces — hypergraph's redesigned core

**Feature Branch**: `011-spaces-core`

**Created**: 2026-10-08 (revised the same day after the SwarmFS / HyperBrowser grilling: sub-spaces,
personal space, edits by others, app budgets, app protocols, forum scenario tests, story order)

**Status**: Draft

**Supersedes**: spec 010 (graph on v2, branch `010-graph-on-v2`), whose approach the design brief replaced.
Spec 009 (resilience) is to be retargeted onto this core later.

**Input**: User description: "Hypergraph's redesigned core ("spaces"), per specs/research/design-brief.md
(all decisions and measurements there). Goal: the easiest kit to build server-less, decentralized
social apps [...]. Data model: a graph of typed records owned by their authors [...]. Spaces (renamed
from v1's contexts) [...] one small ordered decision log per space holds only decisions [...]. Readers
enforce the rules [...]. Each member indexes what it holds locally [...]. Queries [...] answer from what
is held, fetch what is missing within a bound, and say when a result is incomplete [...]. Several
devices: latest wins [...]. Storage policy per space: auto by default [...]. Names: keep v1's names
[...]. Out of scope: helpers/blind peers and availability reports [...], removing v1, migrating
HyperBBS or hyperDNS, SwarmFS." Revised with decisions recorded in [`ROADMAP.md`](../../ROADMAP.md)
(2026-10-08).

Who the "user" is: a developer building an app on hypergraph, and the people using that app.
Hypergraph has no UI of its own. Three consumers prove it, and their needs shaped this spec:

- **Forum scenario tests** (in this repo, no UI): the forum's flows played through the public API,
  updated in the same change as any API change (CLAUDE.md rule 3). They replace the reddit-clone app.
- **SwarmFS** (its own repo): a filesystem whose folders and files are records in spaces, and whose
  file bytes move through swarmwire. Its first version is "two devices, one identity".
- **HyperBrowser** (codename; its own repo): HyperBBS's vision in a web UI — a browser for spaces, with
  built-in views and HyperMD sites. A forum site in it is the real-world proof.

Background, measurements and reasons: [`specs/research/design-brief.md`](../research/design-brief.md).

Words used below:
- **Space**: a community or a shared place (a forum, a chat, a folder tree, a wiki): its members, roles,
  rules and content. Replaces v1's "context". A personal sync folder is a space with only you in it.
- **Sub-space**: a space shown inside another (a sub-forum, a folder with its own rules). Under the hood
  a separate space linked from its parent, inheriting the parent's members and roles by default.
- **Personal space**: a private space every identity has, shared only by its own devices.
- **Record**: one entry a member's device appends to its own log: a post, a comment, a vote, a file, a
  page. Logs are append-only: nothing is changed in place. An **edit** is a new record that replaces an
  earlier one; a **delete** is a record that marks one as deleted (a tombstone).
- **Decision**: something the space agrees on (members, roles, moderation, invites, keys, settings),
  ordered the same way for every member. Records are not decisions.
- **Member**: a person in a space, with one identity and possibly several devices.

## User Scenarios & Testing *(mandatory)*

Stories are listed in the order they are built. SwarmFS can start after story 3.

### User Story 1 - A forum in a few lines (Priority: P1)

A developer declares the forum's record types (post, comment, vote) and writes the app: a person
creates an account (with a recovery phrase), creates a forum, posts, comments, replies to comments,
votes; other members see the same posts, comments and scores, and the list of posts updates live. The
developer writes no networking, replication or cryptography code.

**Why this priority**: This is the product. If this isn't easy, nothing else matters.

**Independent Test**: The forum scenario tests for sign up, create a forum, post, comment, reply, vote,
edit, delete and live list pass with three members on a real network (local), using only the public
API, on Node and on Bare.

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
6. **Given** a type that only its authors may edit, **When** someone else writes an edit or a delete of a
   record of it, **Then** it is refused locally and ignored by every member.
7. **Given** a new app user, **When** they create an account, **Then** they get a recovery phrase that
   restores the same identity on another computer.

---

### User Story 2 - Community rules that hold (Priority: P1)

The forum's creator gives roles (admin, moderator, custom roles with permission lists), and moderators
flag, hide, remove, reveal and ban. Every member applies these decisions the same way, including
members who were offline when they were made; a banned member's earlier contributions can stay while
everything after is ignored. App rules reject bad data. Members only keep and pass on what the space
allows, so spam from strangers costs them almost nothing.

**Why this priority**: A community needs its rules to hold without a server.

**Independent Test**: The forum scenario tests for moderation (assign a moderator, hide, reveal, remove,
ban with earlier votes kept, a non-member's writes ignored, a demoted moderator's later decisions
ignored, an app rule rejecting a record) pass with three members, one offline during the decision.

**Acceptance Scenarios**:

1. **Given** a moderator, **When** they hide a comment, **Then** every member stops showing it, and
   **When** they reveal it, every member shows it again.
2. **Given** a member who posted, voted, then spammed, **When** a moderator bans them, **Then** every
   member keeps what they wrote up to what the moderator held at that moment and ignores everything
   after, including what they write later; the moderator never deals with lengths or positions.
3. **Given** a member who was offline during moderation, **When** they reconnect, **Then** they apply the
   same decisions in the same order and show the same content as everyone else.
4. **Given** two admins making conflicting decisions at the same time, **When** both reach everyone,
   **Then** every member ends with the same result.
5. **Given** someone who is not a member, **When** they write records "into" the space, **Then** no member
   keeps, indexes, shows or passes them on.
6. **Given** a moderator whose role is removed, **When** they make moderation decisions afterwards,
   **Then** those decisions are ignored; their earlier decisions stay valid.
7. **Given** an app rule (e.g. "a title is at most 300 characters"), **When** a member's record breaks it,
   **Then** no member keeps, indexes or passes it on.
8. **Given** the v1 role model, **When** an app uses `setRole`, `getRole`, `removeRole` and
   `moderateAction`, **Then** they mean what they meant in v1, without passing key pairs.

---

### User Story 3 - One person, several devices, a personal space (Priority: P1)

A person uses apps from a phone and a laptop with one identity. A new device joins by scanning a code
shown by a device already in. Every identity has a personal space shared only by its own devices: the
device list, the spaces it belongs to, settings, and what each device holds — so the phone sees what's
on the PC. Records show the person, not the device. A change made after seeing an earlier one always
wins, even when a device's clock is wrong. A lost device can be removed.

**Why this priority**: SwarmFS's first version is exactly this ("two devices, one identity"), and every
app needs it.

**Independent Test**: Scenario tests: add a second device by code, see the same spaces and settings on
both, see from one device what the other declared it holds, vote and edit from both with one clock an
hour ahead, remove a lost device.

**Acceptance Scenarios**:

1. **Given** a device showing a join code, **When** a second device uses it, **Then** it becomes a device
   of the same identity and gets the personal space (spaces list, settings) without retyping anything.
2. **Given** an app storing "this device holds X" in the personal space, **When** another device of the
   same identity reads it, **Then** it sees it; **When** anyone else tries, **Then** they can't.
3. **Given** a member with two devices, **When** they post from each, **Then** every member sees both posts
   by the same person.
4. **Given** a member who votes +1 on the laptop, **When** they later vote -1 on the phone after it has
   seen the laptop's vote, **Then** the -1 counts everywhere, even if the laptop's clock is an hour ahead.
5. **Given** truly simultaneous edits from two offline devices, **When** both reach everyone, **Then**
   every member settles on the same version.
6. **Given** a lost device, **When** the member removes it from another device (or with the recovery
   phrase), **Then** every member ignores what that device writes afterwards and keeps what it wrote
   before.

---

### User Story 4 - Invites and joining (Priority: P2)

A member creates an invite link (role, uses, expiry, sub-spaces) and sends it any way they like;
whoever opens it joins, even when the inviter is offline, as long as some member able to record
decisions is online. An "open" space is a public invite link with unlimited uses that admins can revoke.

**Why this priority**: Spaces grow by invitation.

**Independent Test**: Scenario tests: invite, join while the inviter is offline, expired / used-up /
revoked link refused, open space via a public link, revoking it stops new joins.

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

### User Story 5 - Hypergraph's graph vocabulary, shared editing (Priority: P2)

Developers who know v1 find its vocabulary: relations between records (`relate`, `unrelate`, with a
type, an optional number and small data), `edges` in and out with counts, tags (`tag`, `untag`,
`getByTag`), the fluent query style. And a type can let others edit its records — members with a
permission, or any member — for wikis and shared folders.

**Why this priority**: Hypergraph is "a simple graph store"; v1's vocabulary is what its users liked;
wikis and shared folders need shared editing.

**Independent Test**: The meanings of v1's graph tests (relations, edges, counts, tags, queries, paging)
pass on the new core; a wiki-page scenario test (three members edit one page, latest allowed edit wins,
an edit by someone without the permission ignored) passes.

**Acceptance Scenarios**:

1. **Given** two records, **When** a member relates them with a type, a number and data up to 4 KB,
   **Then** every member sees the relation in the outgoing edges of one and the incoming edges of the
   other, with the right counts; **When** the member unrelates them, it disappears for everyone.
2. **Given** tagged records, **When** a member asks for a tag, **Then** they get the records with that tag,
   newest first, page by page.
3. **Given** a query by type, author, tag or link with a limit, **When** results exceed the limit,
   **Then** the member can page through them in order without gaps or repeats.
4. **Given** a page type editable by "members with permission edit-pages", **When** several such members
   edit the same page, **Then** every member shows the latest edit; **When** a member without the
   permission edits it, **Then** the edit is ignored.

---

### User Story 6 - Holding part of a space, honestly (Priority: P2)

Each member's app keeps spaces within its storage budget: one budget for the whole app (e.g. 10 GB),
from which the user can give a specific space its own budget (e.g. 1 GB), the rest being shared by all
other spaces. Each space keeps everything that fits ("auto", the default) and beyond that the newest
part plus what was read; a space's creator can require "keep everything", and a member below it is
told. Every read returns within a bound, says when its answer is incomplete, and never hangs.

**Why this priority**: Small spaces must survive members going offline (everyone holds everything);
big ones must not fill disks; an app must never hang.

**Independent Test**: Scenario tests for budgets (app budget shared by spaces; a space with its own
budget; never dropping own records, decision logs or the personal space), policies (a small space held
entirely by default; required keep-everything; below-policy notice), bounded reads (author offline →
incomplete within the bound; back online → complete), and index rebuild.

**Acceptance Scenarios**:

1. **Given** a new small space with default settings, **When** members write, **Then** every member keeps
   all of it without anyone choosing a policy.
2. **Given** an app budget of 10 GB and one space given 1 GB, **When** spaces grow, **Then** that space
   stays within 1 GB and all the others share the remaining 9 GB.
3. **Given** a space bigger than its share, **When** the member reads, **Then** it keeps the newest part
   plus what it read and stays within its share.
4. **Given** a read whose data is held only by offline members, **When** the app asks, **Then** it gets an
   answer within the bound marked incomplete; **When** the data becomes reachable, the same read is
   complete.
5. **Given** a space whose creator required keep-everything, **When** a member lowers it (or the space
   doesn't fit), **Then** the member's app is told it is below the space's policy.
6. **Given** a member's local index is lost or damaged, **When** the app restarts, **Then** the index is
   rebuilt from what the member holds, and after a crash only the unfinished part is redone.

---

### User Story 7 - The app changes, old and new versions keep talking (Priority: P2)

The developer ships an update that adds a field to a type. Members on the old version and on the new
one share the same space: the old app reads new records (ignoring the field it doesn't know), the new
app reads old records (the field is empty).

**Why this priority**: Apps update constantly and members never all update at once.

**Independent Test**: A test runs two versions of the forum's types in one space and checks both read
everything; a type change other than adding fields at the end is refused with a clear message.

**Acceptance Scenarios**:

1. **Given** members on two versions of an app, **When** each writes, **Then** each reads the other's
   records.
2. **Given** a type change other than adding fields at the end, **When** the app starts, **Then** it gets a
   clear error naming the type and field.

---

### User Story 8 - Sub-spaces, private ones included (Priority: P3)

A space contains sub-spaces (a sub-forum, a folder with its own rules, a private room). By default a
sub-space has its parent's members and roles; it can be stricter (only some roles write; private,
readable only by granted members) and can invite extra people of its own (a guest folder). A ban in the
parent always applies in its sub-spaces. Admins split a big archive by making folders sub-spaces.
Records can also link to any other space, like a shortcut.

**Why this priority**: Different rules for part of a community, private rooms, and sharding big
archives — with one building block.

**Independent Test**: Scenario tests: a sub-forum seen inside its parent; a write-restricted sub-space
(only moderators post); a private sub-space (spec 008's grant, read, revoke, no access to new content
after revocation, invite with access); a guest invited only to a sub-space; a parent ban applying in
the sub-space; a record linking to another space.

**Acceptance Scenarios**:

1. **Given** a forum with a sub-forum, **When** a parent member posts in the sub-forum, **Then** every
   member sees it there, without any separate join.
2. **Given** a private sub-space, **When** a granted member posts, **Then** granted members read it and
   others (including whoever relays or stores it) can't; **When** someone's access is removed, **Then**
   they can't read what is posted afterwards.
3. **Given** a member banned in the parent, **When** they write in a sub-space, **Then** it is ignored
   there too, even if the sub-space had invited them itself.
4. **Given** a guest invited only to a sub-space, **When** they join, **Then** they read and write there
   and nowhere else in the parent.
5. **Given** a record linking to another space, **When** a member follows it, **Then** they reach that
   space (and join it if they're allowed).

---

### User Story 9 - Big spaces (Priority: P3)

A space with many members, of whom only some write in a given period, stays fast to read for a
newcomer: the latest posts appear without opening every member's history. Members find who wrote
recently through activity lists that every member keeps and passes on; the cost of joining and of
reading the first page does not grow with the space's total size.

**Why this priority**: Small spaces come first; big ones must not hit a wall later.

**Independent Test**: A benchmark with spaces of 10,000 and 1,000,000 records (and thousands of
members) measures a newcomer's first page time and download, and the activity-list traffic per member
per period; spam with thousands of throwaway keys doesn't enter members' lists.

**Acceptance Scenarios**:

1. **Given** spaces of 10,000 and 1,000,000 records, **When** a newcomer reads the latest 20 posts,
   **Then** time and download stay within the success criteria and nearly the same at both sizes.
2. **Given** an author who writes for the first time in a period, **When** members are connected, **Then**
   every member learns it quickly and passes on a short notice rather than the whole entry.
3. **Given** false or spam activity entries, **When** a member receives them, **Then** it drops them
   (author not allowed to write, or the log doesn't confirm them) and doesn't pass them on.

### Edge Cases

- **Concurrent writes**: two members comment on the same post at once (both appear, in a stable order
  for everyone); two devices of one member, or two allowed editors, edit the same record at once (one
  wins, the same everywhere); two admins decide conflicting things at once (same final state).
- **Out of order**: a vote arrives before its post (counted once the post arrives); a ban arrives after
  the banned member's later records were shown (they disappear); a hide arrives before the hidden record
  (it never shows); a parent ban arrives after a sub-space accepted the member's records (they
  disappear there too).
- **Offline and partition**: a member offline during decisions catches up to the same state; two halves
  of a space split and rejoin, converging without manual action.
- **Late joiner with partial history**: a newcomer reads the first page before holding everything, and
  is told what's incomplete; a full copy of a big list downloads in the background.
- **Peers starting together**: members who come online at the same moment still find each other.
- **Adversarial input**: malformed records, records over the size limit, unknown types, links to
  nothing, forged activity entries, non-members' logs, throwaway-key spam, a banned member or a lost
  device continuing to write, a device clock far in the future, someone else's device writing into a
  personal space: none crash a member, none show up where the rules say they shouldn't.
- **Partial replication**: a member holding only part of a space answers from what it holds and fetches
  the rest within the bound.
- **Deletion**: a deleted record is hidden and wiped by every well-behaved member; a modified or offline
  peer may keep a copy, and the docs say so.
- **Storage full**: a member at its budget keeps working (oldest unread content dropped first), never
  drops its own records, decision logs or its personal space; a space's own budget is never taken by
  other spaces.

## Requirements *(mandatory)*

### Functional Requirements

**Records and types**

- **FR-001**: Apps MUST declare record types at runtime (fields with kinds, links with allowed target
  types, "one per member" where it applies, who may edit), without any build step.
- **FR-002**: Logs MUST be append-only: writing, editing and deleting (`put`, `get`, `del`) append
  records; an edit replaces an earlier record, a delete marks it deleted.
- **FR-003**: A type MUST declare who may edit or delete its records: the author (default), members with
  a given permission, or any member. Edits and deletes by anyone else MUST be refused locally and ignored
  by every member; among allowed edits, the latest wins (FR-024).
- **FR-004**: Records MUST be readable across app versions where types only gained fields at the end;
  other type changes MUST be refused at startup with an error naming the type and field.
- **FR-005**: Each record MUST be owned by its author's identity and written by one of the author's
  devices; records MUST show the person, not the device.
- **FR-006**: Content MUST be a field of a record (no separate content calls); content held elsewhere
  MUST be referable with spec 001's reference format (an address such as `swarmwire://<root>` plus its
  fingerprint), and records MUST be able to link to another space.

**Graph and queries**

- **FR-007**: Members MUST be able to ask for "what points at X" (records linking to a record),
  optionally by type, with counts.
- **FR-008**: The API MUST keep v1's graph vocabulary with v1's meanings where they still apply:
  `relate`, `unrelate`, `edges`, `tag`, `untag`, `getByTag`, `query` (by type, author, tag, link, time;
  ordering, limit, paging, live).
- **FR-009**: The API MUST offer sums and counts over linked records (a post's score), applying "one
  per member, latest counts" for types declared that way.
- **FR-010**: Live queries MUST update when records of their types change and MUST NOT be recomputed for
  changes that cannot affect them.
- **FR-011**: Every read MUST return within a bound (default stated in the docs, overridable per call)
  with the results it has and whether they are complete.
- **FR-012**: Each member MUST answer queries from its own local index of what it holds; the index MUST
  never be replicated and MUST be rebuildable from what the member holds, redoing only the unfinished
  part after a crash.

**Spaces, decisions and rules**

- **FR-013**: One hypergraph instance MUST hold one identity and any number of spaces, in one storage
  folder, over one set of connections. A space MUST be created with one call and joined with an invite
  link; "space" replaces v1's "context" in the API and docs.
- **FR-014**: Each space MUST have one ordered decision log holding only decisions: membership, roles
  and permissions, moderation, invites, keys, sub-spaces and settings. Records MUST NOT require any
  agreement.
- **FR-015**: Every member MUST apply decisions in the same order and reach the same state, including
  after being offline and with concurrent decisions.
- **FR-016**: Roles MUST work as in v1: built-in roles, custom roles with permission lists;
  `setRole`, `getRole`, `removeRole` keep their names and meanings.
- **FR-017**: Moderation MUST offer flag, hide, remove, reveal and ban through `moderateAction` (no key
  pair argument). A ban MUST keep the banned member's records up to what the moderator held when deciding
  and ignore everything after; the moderator MUST NOT give a length or position.
- **FR-018**: Readers MUST enforce the rules: a member MUST check that an author may write in the space,
  and that the record passes the space's type rules and the app's rules, **before keeping, indexing or
  passing on** anything of theirs; it MUST ignore what the decisions don't allow (non-members, banned
  beyond the cut, hidden, removed).
- **FR-019**: A decision made by someone without the permission at that point in the order MUST be
  ignored by every member; decisions made before losing a role stay valid.

**Sub-spaces**

- **FR-020**: The API MUST offer sub-spaces (`createSubspace` or similar), implemented as separate spaces
  linked from their parent. By default a sub-space MUST apply its parent's members and roles; it MAY be
  stricter (who writes; private) and MAY invite members of its own; a ban in the parent MUST apply in
  every sub-space below it.
- **FR-021**: A space or sub-space MUST be able to be private: content readable only by granted members,
  grants following invites and roles, and removed members unable to read what is written after their
  removal; spec 008's design carries over.
- **FR-022**: Splitting a space into sub-spaces MUST be explicit (by admins); nothing splits on its own.

**Invites**

- **FR-023**: Members with permission MUST be able to create invite links (role, uses, expiry,
  sub-spaces), revoke them, and see who redeemed them; spec 008's design carries over. Redeeming MUST
  work while the inviter is offline as long as a member able to record decisions is online; refusals
  MUST state the reason. An open space MUST be expressible as a public invite link with unlimited uses,
  revocable, plus an optional per-period limit on how much a new member may write.

**Identity, devices and the personal space**

- **FR-024**: Accounts MUST use an identity with a recovery phrase (as v1). Each device MUST write its own
  logs with a proof that it belongs to the identity, checked once per device by readers. Conflicting
  versions MUST resolve to the latest, stamped as the later of the device's clock and one more than the
  newest record of that member the device has seen; exact ties MUST be settled the same way everywhere.
- **FR-025**: A device MUST be able to add another device with a short code (shown as text or QR) and
  remove a lost one (from another device or with the recovery phrase); every member then ignores what
  the removed device wrote after the point the removing device held.
- **FR-026**: Every identity MUST have a personal space, readable and writable only by its own devices,
  holding its device list, the spaces it belongs to, its settings, and app records such as "this device
  holds X".

**Storage**

- **FR-027**: The app MUST have one storage budget (with a sensible default), and the user MUST be able to
  give any space its own budget out of it; spaces without one share the rest in proportion to use. Each
  space MUST follow its policy: "auto" by default (keep everything that fits, then the newest part plus
  what was read), "keep everything" if its creator requires it; a member below the policy MUST be told.
  Own records, decision logs and the personal space MUST never be dropped. Budgets cover records and
  hypergraph's own data, not files an app moves itself (e.g. swarmwire's bytes).
- **FR-028**: Deleting MUST be honoured by every member by hiding the record and wiping its copy; the docs
  MUST say plainly that modified or offline peers may keep copies.

**Big spaces**

- **FR-029**: In spaces where the member list is small enough, members MUST find authors from the member
  list; in bigger spaces, from per-period activity lists that every member keeps and passes on (short
  notices, entries checked against the authors' logs, no separate signatures), so that a reader opens
  only the authors active in the periods it reads.

**Networking**

- **FR-030**: Joining the network MUST be one call (`connectToSwarm`); members who come online at the
  same moment MUST still find each other.
- **FR-031**: An app MUST be able to add its own protocol to the connections of a space (SwarmFS's file
  transfers), next to hypergraph's own, which stays on by default; hypergraph's defaults MUST work
  without any tuning, and its settings (budgets, bounds, policies) MUST be adjustable.

**Proof, docs, runtimes, layout**

- **FR-032**: Forum scenario tests (no UI) MUST play sign up, create a forum, post, comment, reply, vote,
  edit, delete, live list, moderate, invite, devices and sub-forums through the public API only; every
  change to the public API or its behaviour MUST update them in the same change, and anything awkward to
  write in them MUST be fixed in the API.
- **FR-033**: Docs MUST cover the API for developers, including what "edited", "deleted", "incomplete"
  and "sub-space" mean, with the forum scenario as the worked example.
- **FR-034**: The core MUST run on both Node and Bare (Pear's runtime, for desktop and mobile later), and
  its tests MUST run on both from the first story; it MUST NOT use Node's built-in modules directly.
  (Checked 2026-10-08: every Holepunch dependency loads in Bare 1.27; Node's `path`, `fs`, `os` don't.)
- **FR-035**: The new core MUST live beside v1 in this repo as a separate tree; v1 MUST stay unchanged and
  working (its suite and hyperDNS's keep passing) until hyperDNS moves.

### Key Entities

- **Identity / member**: a person; a recovery phrase; one or more devices proven to belong to it.
- **Device log**: everything one device of one member wrote in a space, in order, signed.
- **Record**: typed fields appended by a member's device; links to records or spaces; edits and deletes
  are records too.
- **Type**: declared by the app; fields (added only at the end), links, "one per member", who may edit.
- **Space**: a community or shared place; its decision log, members, roles, policy; possibly a sub-space
  of another, possibly private.
- **Personal space**: an identity's own space across its devices.
- **Decision**: an ordered entry of a decision log, valid only if its author had the permission at that
  point.
- **Invite**: a link carrying role, uses, expiry and sub-spaces; redeemed into a membership decision.
- **Activity entry**: "this log has records in this period, from this position" (big spaces).
- **Local index**: each member's own index of what it holds; rebuildable; never shared.
- **Storage budget**: the app's total and per-space shares; each space's policy.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every forum scenario (sign up, create a forum, post, comment, reply, vote, edit, delete,
  live list, moderate, invite, devices, sub-forum) has an automated test passing with three members on a
  local network; every member agrees on a write within 1 second.
- **SC-002**: The forum scenario's data code (what it does with hypergraph) uses only the public API, has
  no networking, replication or cryptography code, and stays under 400 lines.
- **SC-003**: Concurrent writes, edits and decisions converge: in tests including a partition healed after
  both sides wrote, every member ends with the same visible state.
- **SC-004**: A newcomer's first page (latest 20 posts) in spaces of 10,000 and 1,000,000 records arrives
  within 2 seconds and 1 MB on a local network, and the 1,000,000 figure is at most 1.5 times the 10,000
  one.
- **SC-005**: A record is visible to connected members without any other member confirming it; with 50
  authors writing at once, every member sees every author's records within 2 seconds (local network).
- **SC-006**: Nothing a peer sends (malformed or oversized records, records breaking app rules, forged
  activity entries, non-members' logs, records past a ban or a device removal, a clock far in the future)
  crashes a member or appears where the rules say it shouldn't; 10,000 throwaway-key spam entries add
  nothing to a member's activity lists or index.
- **SC-007**: No read waits longer than its bound; with the data's only holders offline, the read returns
  within the bound marked incomplete, in every test.
- **SC-008**: A lost index of 100,000 records is rebuilt within 30 seconds; after a crash only the part
  since the last save is redone.
- **SC-009**: A change made on a device after it has seen an earlier one wins on every member even when
  the other device's clock is an hour ahead.
- **SC-010**: A second device joins with a code and shows the first device's spaces and settings within
  10 seconds (local network).
- **SC-011**: With an app budget and one space given its own share, measured disk use stays within each
  limit (allowing 10% for bookkeeping) while spaces grow past them.
- **SC-012**: The design brief's measurements are re-run on the real core and recorded, with any
  difference over 25% explained.
- **SC-013**: v1's test suite and hyperDNS's suite still pass at every commit of this feature.
- **SC-014**: The core's whole test suite, forum scenarios included, passes on Bare as well as on Node at
  every commit of this feature.

## Assumptions

- The people using apps have intermittent, ordinary home connections; "local network" figures are
  measured on a local test network, and real-network figures are reported alongside, not pass/fail.
- The default app budget (in the order of 5 GB, or a share of free disk if smaller), the default read
  bound (in the order of seconds) and the point where activity lists start being used are fixed during
  planning from measurements.
- Open spaces use a public invite plus an optional per-period write limit; other anti-spam rules (proof
  of work, vouching) are left for later.
- The decision log is shared by the members able to record decisions; others only read it.
- File bytes (images, video, archives) are not stored in records: SwarmFS moves them with swarmwire and
  records hold references. Local paths, finding bytes locally before asking peers, and swarmwire's role
  are SwarmFS's spec.
- HyperBrowser's own concerns (sandboxing HyperMD scripts, what a site's script may read or write, its
  UI) are HyperBrowser's spec.
- Helpers (always-on members, blind peers), availability reports and aggregates kept by helpers for very
  big spaces are out of scope (spec 009, later); in big spaces without helpers, sums and counts cover what
  a member holds and fetches within the bound, and say so.
- HyperBBS (terminal) and hyperDNS are not migrated here; v1 is not removed here.
- Dependencies: the Holepunch stack (Hypercore, Corestore, Autobase, Hyperswarm, keet-identity-key,
  Protomux) plus HyperDB for local indexes (experiment 2); no forks.
- About a third of `src/` (identity, crypto, invites, the decision log, replication and networking
  lessons) is carried over, adapted, into the new tree.
