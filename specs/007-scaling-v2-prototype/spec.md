# Feature Specification: Scaling v2 Prototype

**Feature Branch**: `007-scaling-v2-prototype`

**Created**: 2026-10-06

**Status**: Draft

**Input**: User description: "Scaling v2 prototype. Basis: specs/research/scaling-v2.md and the
benchmarks bench/chat.js, channels.js, members.js, many-cores.js. Build, alongside the current API
(not replacing it), a prototype community data model where cost follows what a peer holds and
reads, not the community's size or age, and measure it against v1 with the same scenarios."
(Full description: the shape to validate — control log, messages in authors' own logs, time
segments, local indexes, replication `all | sparse | auto`, moderation on partial data, offline
reads — success measures, scope and constraints are carried into the sections below.)

## Background

Measured on v1 (`specs/research/scaling-v2.md`): reading the latest messages of a channel is
already cheap when the text sits on the relation (1.5 s and 0.74 MB for a newcomer at 1M
messages), but everything else grows with the community: a peer that holds a channel pays ~2.4 KB
of disk per message forever, every member who applies a channel holds ~70 KB of memory per
member, one indexer caps a channel at ~300 messages/s, and a context is one history that never
shrinks. A first experiment for this prototype (`bench/many-cores.js`) measured the alternative
it rests on: a reader following 1,000 authors' own logs opens them and reads every latest entry
in 0.7 s, downloading ~660 bytes per log, with ~120 KB of memory per open log and new entries
arriving in ~2 ms.

"User" means the developer building a community app on hypergraph, and through them the people
using that app.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A huge, old channel opens as fast as a new one (Priority: P1)

A member opens a chat channel that has existed for years and holds tens of millions of messages.
The latest messages appear as fast, and cost as little memory and download, as in a channel with
a few thousand messages. Scrolling back fetches only the part scrolled to.

**Why this priority**: It is the promise the redesign exists for; without it, hypergraph cannot
host a long-lived chat or forum.

**Independent Test**: Build channels of 10k, 1M and 10M messages with the prototype; a fresh peer
opens each and shows the latest page; time, memory and bytes downloaded are compared across sizes
and against v1 at the sizes v1 reaches.

**Acceptance Scenarios**:

1. **Given** channels of 10k, 1M and 10M messages, **When** a fresh member opens each, **Then**
   the latest page appears within the same time budget, memory and download for all three.
2. **Given** a member viewing the latest page, **When** they scroll back a month, **Then** only
   that stretch is fetched, and the time to show it does not depend on the channel's total size.
3. **Given** a member who has shown a page, **When** they restart with no peer reachable,
   **Then** that page shows again.

---

### User Story 2 - Many people write at once without a bottleneck (Priority: P1)

Hundreds of members post in the same channel during an event. Everyone's messages appear for
everyone within about the time of a network round trip, and the channel keeps up no matter how
many people write, because no single member has to process everyone's messages for the channel
to move forward.

**Why this priority**: Measured in v1, one indexer applies ~300 messages/s while serving others;
a busy public channel exceeds that.

**Independent Test**: 10, 100 and 300 writers (as separate processes, within the machine's load
limits) post concurrently; total accepted throughput and arrival time between members are measured.

**Acceptance Scenarios**:

1. **Given** many writers posting concurrently, **When** throughput is measured, **Then** it grows
   with the number of writers instead of stopping at what one member can process.
2. **Given** a live channel, **When** a member posts, **Then** other connected members see it
   within the arrival budget.

---

### User Story 3 - Moderation holds even on partial data (Priority: P1)

A moderator hides a message or bans a member. Every member applies it, including members who hold
only today's messages or who joined after the decision, and a banned member's new messages are
not shown.

**Why this priority**: Self-moderated communities are hypergraph's purpose; partial replication
must not create a way around moderation.

**Independent Test**: A moderator hides a message and bans a member; a newcomer holding only the
latest segment, and a member offline at the time, both apply both decisions.

**Acceptance Scenarios**:

1. **Given** a hidden message, **When** any member shows its page, **Then** it is not shown as a
   normal message, whatever part of the channel that member holds.
2. **Given** a banned member, **When** they keep posting, **Then** other members do not show their
   posts made after the ban.
3. **Given** a moderation decision, **When** a member who held nothing before joins, **Then** they
   know the decision before showing any content.

---

### User Story 4 - Each member chooses how much they keep (Priority: P2)

Small communities want everyone to keep everything, so the community survives even if most
members go offline. Huge communities can't ask that. A member's app keeps everything while the
community fits its disk budget, and switches to keeping only what it reads plus a recent window
when it doesn't. Communities can run always-on helpers that keep more.

**Why this priority**: Requested by the user; availability for small communities depends on it.

**Independent Test**: With `auto`, a member of a small community holds everything; a member of a
large one holds only what fits; changing the setting to `all` or `sparse` is honored.

**Acceptance Scenarios**:

1. **Given** the default setting, **When** the community's content fits the member's budget,
   **Then** the member keeps all of it.
2. **Given** the default setting, **When** it doesn't fit, **Then** the member keeps what it read
   plus the most recent content that fits, and says so.
3. **Given** a helper set to keep everything, **When** members ask for old content, **Then** the
   helper serves it.

---

### User Story 5 - The cost of the rest of the community stays out of the way (Priority: P2)

A member belongs to a community with many channels and many members. Their device's idle work,
memory and startup time depend on the channels they have open and the members active there, not
on the community's total channels or member count.

**Why this priority**: Measured in v1: ~70 KB of memory per member on every applying peer (3.5 GB
at 50,000 members) and ~1.7 MB per open channel.

**Independent Test**: Communities with 1,000 and 50,000 members and 10 and 500 channels; a
member with 5 channels open measures memory, idle work and startup.

**Acceptance Scenarios**:

1. **Given** communities that differ only in member count, **When** a member opens the same
   channels, **Then** memory and idle work are within the same budget.
2. **Given** communities that differ only in channel count, **When** a member opens the same 5
   channels, **Then** memory and startup are within the same budget.

---

### Edge Cases

- **An author whose log is unreachable**: their messages are missing from the page until someone
  who holds them is online; the page says content may be incomplete rather than hiding the gap.
- **Clock skew**: authors claim their own times; messages are ordered by claimed time within a
  segment, and a message claiming a time far in the future is not shown ahead of real ones.
- **A ban racing a post**: a post made before the ban by the clock of the control log stays; a
  post that the control log orders after the ban is hidden.
- **Segment boundaries**: a message written right at a boundary lands in exactly one segment for
  every reader.
- **Compaction by an archiver**: a compacted segment must contain exactly the authors' signed
  messages; a reader can check each message's signature without trusting the archiver, but must
  trust the archiver for completeness (stated).
- **Disk budget lower than the control log**: the control log is always kept; content is what
  gets dropped.
- **A member in thousands of channels**: idle cost follows open channels only.

## Requirements *(mandatory)*

### Functional Requirements

**Community control log**
- **FR-001**: A community MUST have one control log holding members, roles, moderation decisions,
  the list of channels and, per channel, its time segments; every member MUST keep it in full.
- **FR-002**: Membership, role and moderation decisions MUST be taken from the control log alone,
  identically on every member, whatever content the member holds.
- **FR-003**: The control log's size MUST grow with decisions (membership, roles, moderation,
  segments), not with the number of messages.

**Messages**
- **FR-004**: A member MUST be able to post a message to a channel without any other member
  processing it first, and without waiting for any agreement on order.
- **FR-005**: Messages MUST be signed by their author; a reader MUST reject any message whose
  signature or author does not check out.
- **FR-006**: Reading a channel's latest page MUST need only the current segment's active authors'
  recent entries and the control log, not the channel's history.

**Segments**
- **FR-007**: Each channel MUST be divided into time segments recorded in the control log; a
  segment's set of active authors MUST be knowable from the control log.
- **FR-008**: Scrolling back MUST fetch only the segments reached.
- **FR-009**: A member MUST be able to drop old segments it holds without affecting others.
- **FR-010**: A member with an archiver role MAY compact a closed segment into a single unit others
  can fetch; each message in it MUST keep its author's signature.

**Local data**
- **FR-011**: A member's private indexes MUST be kept in local storage that can be deleted and
  compacted, not in a replicated signed log.
- **FR-012**: A page a member has shown MUST be readable again offline after a restart.

**Replication**
- **FR-013**: A member MUST be able to choose `all`, `sparse` or `auto` per community; `auto` MUST
  be the default.
- **FR-014**: With `auto`, a member MUST keep everything while the community's content fits its
  disk budget, and otherwise keep what it read plus the most recent content that fits.
- **FR-015**: A helper set to `all` MUST serve old content to members that ask for it.

**Moderation**
- **FR-016**: A hidden message MUST not be shown as a normal message by any member, whatever part
  of the channel the member holds.
- **FR-017**: Posts a banned member makes after the ban MUST not be shown by other members.

**Measurement**
- **FR-018**: The prototype MUST be measured with the scenarios of the existing benchmarks (chat
  channel, many channels, many members, many authors) at sizes from 10k to at least 10M messages,
  and compared with v1 at the sizes v1 reaches.
- **FR-019**: Measurements MUST respect the development machine's load limits (no long runs at
  full load on every core).

**Coexistence**
- **FR-020**: The prototype MUST live alongside the current API without changing its behavior;
  HyperBBS and hyperDNS MUST keep passing.

### Key Entities

- **Community**: a group with one control log; owns channels and members.
- **Control log**: the community's ordered record of decisions: members, roles, moderation,
  channels, segments.
- **Channel**: a named stream of messages within a community.
- **Segment**: a time slice of a channel; open (being written) or closed; has a set of active
  authors; may be compacted.
- **Message**: an author-signed entry in a channel, with the author's claimed time.
- **Author log**: where an author's messages for a channel live.
- **Archiver**: a member role allowed to compact closed segments.
- **Helper**: an always-on member keeping more than members do (replication `all`).
- **Disk budget**: how much a member is willing to keep per community.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A newcomer shows the latest page of channels holding 10k, 1M and 10M messages within
  the same 2-second budget, using within 10% of the same memory and download at every size.
- **SC-002**: The newcomer's download to show the latest page is proportional to the page (under
  2 MB for 50 messages with 50 active authors), not to the channel.
- **SC-003**: A channel's accepted message throughput with 100 concurrent writers is at least 5×
  what one v1 indexer handled in the same setup (~300 messages/s measured).
- **SC-004**: A message appears to other connected members in under 100 ms at the median and
  under 500 ms at the 95th percentile, at every channel size.
- **SC-005**: A member's memory and idle work with 5 channels open differ by under 10% between
  communities of 1,000 and 50,000 members, and between communities of 10 and 500 channels.
- **SC-006**: Hide and ban decisions are applied by 100% of members in the tests, including
  members holding only the latest segment and members who joined after the decision.
- **SC-007**: A page shown before an offline restart shows again in under 1 second.
- **SC-008**: With `auto`, a member's stored content never exceeds its disk budget (control log
  aside), and a member of a community under the budget holds 100% of it.
- **SC-009**: The full test suite, HyperBBS and hyperDNS pass throughout.

## Assumptions

- This is a prototype to validate the shape with measurements; its API can change freely, and it
  is not yet wired into `graph.put`/`relate`/`query`.
- Messages are short (chat-sized). Large content keeps using content references (spec 001).
- Authors' claimed times are trusted only for ordering within a segment; moderation order comes
  from the control log.
- Reading old segments needs someone online who holds them (a member, a helper, or an archiver's
  compacted copy); with nobody online, older content is simply not available.
- A newcomer must be a member (or the community public) to read; private channels and encryption
  are out of scope here and reuse spec 006/read scopes later.
- Sizes above 10M are reached by generating histories without running every writer live, so the
  machine's load limits hold; live behavior is measured at smaller writer counts.
- Out of scope: replacing or migrating v1, encrypted scopes, invite links, the full query API.
