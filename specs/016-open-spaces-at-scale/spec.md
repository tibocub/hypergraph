# Feature Specification: Open spaces at scale

**Feature Branch**: `016-open-spaces-at-scale`

**Created**: 2026-11-03

**Status**: Draft, every question answered by Tibo 2026-11-03 (see "Decisions"); ready for the plan

**Input**: scale audit risks #1, #2 and #4 (`specs/research/scale-audit.md`), `ROADMAP.md` "Now" item 10(a),
spec 015's deferred US4 (logs open only while used). Targets: **a forum of 1M accounts ever, a chat of
100k members**.

Who the "user" is: a developer on `require('hypergraph/next')`, building a forum, a chat or a site (the
forum example, SwarmFS, HyperBrowser's sites). Their users must be able to join a big open community
without an admin online, and the community must not slow down for everyone as accounts pile up.

## The problem

Today every join is a decision. A newcomer sends a signed redemption of an invite; a member allowed to
decide, online at that moment, writes `invite/redeem` into the decision log (`lib/space.js` `#redeem`,
`_redeem`; `lib/index.js` `redeemInvite`, "No member able to let you in answered"). Then, measured:

- **The join waits for a decider.** Nobody with decision rights online: the newcomer can't get in.
- **Every account costs every member, forever** (scale audit, "what a silent member costs"): `member:`,
  `redeemed:`, `uses:`, a decision-list line (~2.1 KB disk each), a log made and announced at join even if
  it never posts (18 KB of memory and 0.55 ms at start on every full member, 32 B in every log-list swap).
- **A newcomer to a big forum downloads the whole member list first**: ~0.9 KB per member ever, ~1 GB at
  1M accounts.
- **Helpers' logs are listed in the decision log** (`listed:` per log, spec 013), re-read with the rest.
- **A full member keeps every log open** and sends every key on any difference in the log list (1M logs:
  ~18 GB of memory, ~9 min to start, 32 MB per list swap).

The first step (decisions applied in place, 2026-11-02) removed the re-read cost of each decision; what is
left grows with accounts ever, not with people active. That is what this spec removes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Join an open space with no one online to let you in (Priority: P1)

An owner or admin makes a space public, once, with one decision. From then the space has one public
link, the same for everyone (made from the space's key: anyone can show it, nobody "owns" it), like a
public Discord server's link. Anyone joins with it with no decision: the newcomer's own log carries its
ordinary header is the join: its device proof already says "this identity writes in this space", and in a
public space that is all a reader needs to check (no new field: research R1). The
newcomer is a member as soon as it holds the space's decision log; no decider needs to be online, and
nothing is added to the decision log. A public space stays public: the door can't be closed (Decision 6);
bans and the write limit deal with floods.

**Why this priority**: it is the whole cost of a silent account, and the forum's first user flow (sign
up and post) stops depending on an admin's device being awake.

**Independent Test**: an open space whose owner is offline; a newcomer joins with the public link, posts;
a third member sees the post and lists the newcomer in `members()`; the decision log's length is
unchanged. The same with a one-use invite still goes through a decider (unchanged).

**Acceptance Scenarios**:

1. **Given** an open space whose deciders are all offline, **When** a newcomer redeems its public link
   while any member (or helper) is reachable, **Then** the join succeeds, and its records are accepted by
   every member who reads them.
2. **Given** a newcomer joined through the public link, **When** the space's decision log is read
   anywhere, **Then** it holds no entry for that newcomer.
3. **Given** a log whose header carries a join that doesn't verify (wrong space, forged signature, or a
   space that was never made public), **When** a member meets it, **Then** its records count for
   nothing, as with a forged device proof today.
4. **Given** a banned identity, **When** it joins again through the public link with a new log, **Then**
   its records still count for nothing (a ban is a decision, checked for every log).
5. **Given** any invite made with `createInvite` (one-use, counted, unlimited, any role), **When** it is
   redeemed, **Then** a decider records it as today, and revoking it works as today. Only the space's
   public link skips the decision.
6. **Given** a space made before this change, **When** it opens on the new version, **Then** every member
   recorded by a decision stays a member; it has no public link until an owner or admin makes it public.
7. **Given** a public space, **When** an owner or admin tries to make it not public, **Then** it is
   refused with a clear reason (the door can't be closed; ban, set a write limit, or move to a new space).

---

### User Story 2 - Known members, with devices (Priority: P1)

`members()` lists the people this member knows of: those recorded in the decision log (roles above
member, counted invites, bans, removals) and those whose logs it has met. Each keeps its `devices`, so
apps keep mapping a device to a person (SwarmFS's `lib/drive.js` and `lib/members.js` do), and the
`members` event fires when a new person is met. There is no exact member count: two members may list
different people until they meet the same logs.

**Why this priority**: the forum's member list, SwarmFS's "who owns this device" and the chat's roster
all read it; it must stay correct for what it can know.

**Independent Test**: three members, one newcomer through the public link who posts once; each member who
read the post lists the newcomer with its device; one that never read it does not, until it does; the
`members` event fires once.

**Acceptance Scenarios**:

1. **Given** a newcomer joined through the public link who has written a record, **When** a member has
   read that record's log, **Then** `members()` lists the newcomer with role `member` and its device.
2. **Given** a newcomer who joined and never wrote, **When** others call `members()`, **Then** it is
   not listed (no log was made for it, Story 3), and it costs them nothing.
3. **Given** a person promoted to a role above member, banned or removed, **When** anyone lists members,
   **Then** that person is listed from the decision log, as today.

---

### User Story 3 - A silent member costs nothing (Priority: P1)

No log is made or announced for a member until its first record. Until then, nothing about it reaches
any other member. Joining a big space downloads no member list: the decision log holds only exceptions.

**Why this priority**: most accounts in a forum never post; they must not cost anyone.

**Independent Test**: a space with 1,000 then 10,000 silent public-link joiners (scripted): a newcomer's
download before its first `latest(20)`, and every member's memory and start time, are the same at both
sizes (within noise); the first record of a silent member reaches the others.

**Acceptance Scenarios**:

1. **Given** a member that joined and never wrote, **When** others sync the log list, **Then** they never
   receive a key for it.
2. **Given** that member writes its first record, **When** it does, **Then** its log is made, announced
   and its record arrives like any other.
3. **Given** a space with N silent members, **When** a newcomer joins, **Then** what it downloads before
   reading the first page doesn't grow with N.

---

### User Story 4 - Logs open only while used (Priority: P2)

(Moved from spec 015's US4.) A member's copy of another author's log stays open only while it downloads,
is written or is read beyond the index; the rest are rows in the index. Peers asking for a log closed here
are still served.

**Why this priority**: the owner of a big forum holds every log (100k logs = 1.8 GB, 1 minute to start);
it's the easy half of scale audit #2.

**Independent Test**: a space with 2,000 logs, everyone keeps everything: after catching up, open logs
stay under a small bound; a new record in a closed log reaches this member; a newcomer fetches a closed
log from it.

**Acceptance Scenarios**:

1. **Given** a member holding N logs, all caught up, **When** idle, **Then** at most a bounded number are
   open (its own, the decision log, those downloading).
2. **Given** a closed log whose author writes, **When** the author's activity reaches this member,
   **Then** the log opens, downloads and closes again.
3. **Given** a peer asking for a log closed here, **When** it asks, **Then** its blocks are served.

---

### User Story 5 - A new log costs one key, not the whole list (Priority: P2)

Members settle a difference in their log lists by exchanging only what the other lacks, page by page,
instead of sending every key. A new log costs each peer about one key.

**Why this priority**: at 1M logs, a list swap is 32 MB per full peer at every new log (scale audit #2).

**Independent Test**: two members holding 10,000 logs, one gets a new log: the bytes exchanged to settle
are about one key plus a small summary, and the same at 1,000 logs.

**Acceptance Scenarios**:

1. **Given** two peers whose lists differ by k logs, **When** they settle, **Then** the bytes sent grow
   with k, not with the list's size.
2. **Given** a peer on the previous version, **When** it connects, **Then** it is refused cleanly (one
   version for everyone, Decision 5), not silently half-synced.

---

### User Story 6 - Helpers' logs off the decision log (Priority: P3) — moved out (research R8)

**Moved to the helpers follow-up (2026-11-03, plan)**: helpers are blind peers and can't serve a log list
themselves, so `listed:` needs a replacement a blind peer can hold, a design of its own. With Story 3 it
now grows with posters, not accounts. Kept below as the follow-up's starting point.

Helpers (spec 013) learn and serve the list of logs from members and from activity, as other peers do;
the decision log stops recording one `listed:` entry per log.

**Why this priority**: same curve as Story 1 in spaces with helpers (scale audit #4), but fewer spaces
have helpers.

**Independent Test**: a space with a helper and 1,000 logs: a newcomer with only the helper online gets
the first page and every log it asks for; the decision log holds no `listed:` entry.

**Acceptance Scenarios**:

1. **Given** a space whose members are all offline but its helper, **When** a newcomer reads, **Then**
   it reaches the logs the helper holds.
2. **Given** a space made before this change, **When** it opens, **Then** its old `listed:` entries are
   still honored and no new ones are written.

---

### Edge Cases

- **Closing the door**: not possible (Decision 6). No peer can tell whether a header was written before or
  after a "close" decision, so any close would either end every past join too, or leave members seeing
  different people. Going public is one-way, so it has no such problem: a header join counts once the
  decision log says the space is public, whenever the header was written.
- **No expiry on the public link**, for the same reason.
- **Stopping members from inviting** (Tibo's Discord comparison): works as today for `createInvite` links
  (taking the `invite` permission away is a decision), but has no effect on the public link, which nobody
  makes.
- **Who invited whom**: not known for public joins (nobody did). Known as today for `createInvite` links.
- **A newcomer joins while only a helper is reachable**: the join succeeds (Story 1 needs no decider);
  a private space's key still needs a key holder (below).
- **A private space with a public link**: a newcomer joins, but reads nothing until a member holding the
  key sees its redemption and grants it the key. Any key holder may do it, not only a decider. Until
  then, its join is "waiting for a key" (a status the app can show).
- **One person, several devices**: each device's log carries the redemption (or its device proof
  points to one that does); they all count as one person.
- **A member removed (not banned)** who joins again through the public link: allowed, as today with an
  unlimited link. A ban is what keeps someone out.
- **Floods of fake accounts**: silent ones cost nothing (Story 3); ones that post are rate-limited by the
  space's write limit (story 9) and banned by moderators. No other gate in this spec.
- **A newcomer reaches no peer at all**: the join fails with a clear "no one reachable" error, as today.
- **Old versions**: one version for everyone (Decision 5); an old peer is refused on connect.

## Requirements *(mandatory)*

### Functional Requirements

**Joining without a decision (Stories 1-3)**

- **FR-001**: An owner or admin MUST be able to make a space public with one decision (role given to
  public joiners: `member`). Making it public MUST be one-way: undoing it MUST be refused with a reason.
- **FR-002**: A public space MUST have one public link, the same on every member, derived from the
  space's key (for a sub-space, with its top space), readable by any member.
- **FR-003**: A newcomer joining with the public link MUST be let in with no decision: in a public space,
  the device proof every log header already carries MUST be enough (no header format change).
- **FR-003a**: Every reader MUST verify a header join before counting a log's records: the space is
  public in the decision log, the join is for this space, its signature holds, and the joiner is not
  banned. A failing check MUST make the log count for nothing.
- **FR-003b**: Every `createInvite` link (any uses, any role) MUST keep going through a decider and stay
  revocable, as today.
- **FR-004**: A join through the public link MUST NOT write anything to the decision log and MUST NOT
  need a decider online; it needs one reachable peer holding the space's decision log.
- **FR-005**: No log MUST be made, announced or listed for a member before its first record; joining
  MUST still give the newcomer everything it needs to read.
- **FR-006**: A newcomer's download before its first read MUST NOT grow with the number of members who
  joined through the public link.
- **FR-007**: Bans, cuts, removals, roles and moderation MUST work on header members as on recorded ones
  (a ban or role change is a decision naming the identity).
- **FR-008**: Members recorded by decisions before this change MUST stay members; their entries MUST stay
  readable and valid.

**Known members (Story 2)**

- **FR-010**: `members()` MUST list recorded people and every person whose log this member met, with
  role, `devices` (device and log), `you`, `banned`, `removed`, in today's order.
- **FR-011**: The `members` event MUST fire when a new person is met, as when one is recorded.
- **FR-012**: The API docs MUST say members are "known members", may differ between peers, and that no
  exact count exists.
- **FR-013**: `redemptions(link)` MUST keep listing a `createInvite` link's redemptions; for the public
  link it MUST list the public joiners this member knows of.

**Private spaces**

- **FR-020**: In a private space, any member holding the current key MUST be able to grant it to a
  newcomer whose header redemption it verified; the newcomer's join MUST report "waiting for a key" until
  then. (Grants per device stay as today: their cost is the private-spaces revision's, scale audit #3.)

**Logs open only while used (Story 4)**

- **FR-030**: Another author's log MUST stay open only while it downloads, is written, or is read beyond
  the index, up to a bound; closed logs MUST still be served to peers who ask.
- **FR-031**: A record written in a log closed here MUST still reach this member.

**Log lists (Story 5)**

- **FR-040**: Peers MUST settle a log-list difference with an exchange whose size grows with the
  difference, not with the list.
- **FR-041**: (moved out with Story 6, research R8.)

**Versions and tests**

- **FR-050**: The rule and wire change MUST bump the space's format version; peers on another version
  MUST be refused on connect with a clear error. Everyone updates together, SwarmFS included.
- **FR-051**: The forum scenario tests (rule 3) MUST cover: make the forum public, sign up through its
  link with every decider offline, post, appear in members, ban a public joiner, closing the door
  refused, a one-use invite unchanged. The forum's `openLink`/`revokeLink` helpers and the test "a public
  link lets many in; revoked, it lets no one else in" (`test/next/forum/invites.js`) change to match.
- **FR-052**: `perf/scenarios/` MUST record, as `flat`: a join's cost to every other member, a newcomer's
  download before its first page, and a member's memory and start time, at growing numbers of silent
  members.

### Key Entities

- **Public space**: a space an owner or admin made public, for good.
- **Public link**: a public space's one link, the same for everyone, from its key. The one way in without
  a decision.
- **Header join**: the newcomer's signed join through the public link, in its log's header; proof of
  membership checked by every reader.
- **Invite link** (`createInvite`): unchanged: decided, counted, revocable, any role.
- **Known member**: a person this member knows of, from the decision log or from a log it met.
- **Decision log (after)**: only exceptions: roles above member, bans and cuts, removals, revocations,
  counted invites and their redemptions, settings, types.

## Success Criteria *(mandatory)*

### Measurable Outcomes

(Local DHT, this dev machine, Node and Bare; perf scenarios at 1k / 10k members, extrapolated to the
targets.)

- **SC-001**: A newcomer joins an open space and posts with every decider offline, in the same time as a
  join with a decider online today (or faster).
- **SC-002**: A join through the public link costs every other member nothing measurable: their CPU and
  memory are flat from 1k to 10k silent members (today: 28 ms → 259 ms per join).
- **SC-003**: A newcomer's download before its first page is flat from 1k to 10k members (today ~0.9 KB
  per member ever).
- **SC-004**: A member caught up on 2,000 logs keeps at most ~20 open; its start time is flat from 1k to
  10k logs.
- **SC-005**: Settling a one-log difference between peers holding 10k logs sends under 3 KB, flat up to 1M logs (today 320 KB; 32 MB at 1M).
- **SC-006**: The forum scenario tests, SwarmFS's suite and the perf scenarios pass; existing folders open
  with every recorded member kept.

## Out of scope (later)

- Grants per member instead of per device, and key changes that cost active members only (scale audit #3:
  the private-spaces revision, with the chat spec).
- A spam gate (proof of work, a vouching member, rate limits on joins): only if floods are measured.
- Invite-less public spaces (no link at all): the public link covers the forum; later if HyperBrowser
  needs it.
- Older app versions working against a newer format (spec 015's future direction).
- An exact member count.

## Assumptions

- Public joiners are always `member`; higher roles come from invite links or a role decision.
- Peers open only the logs of authors they meet in activity lists or reads, so a log nobody reads costs
  only the peers that fetch it.
- Bans stay rare enough to live in the decision log (one entry per banned person).
- The space's write limit (story 9) is enough rate-limiting for posting newcomers until measured
  otherwise.

## Decisions (Tibo, 2026-11-03)

1. A plain member joining an open space is not a decision; its log's header (already signed) is the join.
2. Invite links (`createInvite`, one-use included) stay decisions, revocable as today.
3. `members()` means known members; no exact count. A member who never posted isn't listed (it has no
   log, Story 3); an app wanting a "new members" list has newcomers post a `profile` record.
4. No spam gate yet.
5. Apply-time and wire change: everyone updates together; old spaces keep their recorded members.
6. **A public space works like a public Discord server**: one link, the same for everyone. Making a space
   public is one-way; the door can't be closed. (Chosen over "a revoke ends every join made with the link,
   then an admin's app lets back in the people it knows of", which costs something per member at each
   revoke and needs a decider online. That stays possible later, as "close the door", if an app needs it.)
7. One spec: log lists (Story 5) stay here, so there is one version bump instead of two. (Story 6, helpers,
   left at planning: research R8.)
