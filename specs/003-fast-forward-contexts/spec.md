# Feature Specification: Fast-Forward Joins, Indexer Topology and App Validation Rules

**Feature Branch**: `003-fast-forward-contexts`

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Fast-forward joins, indexer topology, and app validation rules for
contexts" — contexts reach a signed state with a small set of indexers; joining peers download
that state instead of replaying everything; apps can reject events at apply time with their own
deterministic rules. Basis: `specs/002-scale-indexing/research.md` R10–R13 and
`specs/research/scaling-study.md`.

## Background: what was measured

- **Joining a large context does not scale.** A joining peer replays every event of a context,
  then the replayed index is committed in one step. At 1,000,000 entries that step exhausted an
  8 GB memory limit and the join failed.
- **Joining by downloading the agreed state works.** Letting a joining peer adopt the index the
  context's indexers agreed on and signed, and fetch index pieces only when it reads them, took a
  20,000-entry join from 17.2 s and 826 MB to 1.2 s and 288 MB.
- **Shared contexts never reach an agreed state today.** Every writer is made an indexer and the
  periodic acknowledgements indexers use to agree are turned off. Measured with three writers:
  none of 24,013 index entries was ever confirmed. There is nothing for a newcomer to download.
- **Apps cannot enforce their own rules.** A context accepts any well-formed, signed event its
  built-in checks allow; app-level rules ("a file name is unique in its folder", "only the
  folder's owner may add to it") can only be applied when reading, so a hostile member's junk is
  indexed and kept by every peer.

## User Scenarios & Testing *(mandatory)*

"User" means the developer consuming `require('hypergraph')`.

### User Story 1 - Shared contexts reach an agreed, signed state (Priority: P1)

A developer building a forum (HyperBBS) creates a context that hundreds of members write to. They
need the context's history to become agreed and signed by a small set of trusted members — the
indexers — within seconds of activity, so that the state can be shared with newcomers and old
history can no longer be reordered.

**Why this priority**: Without an agreed state, nothing else in this feature can work, and every
shared context today carries an ever-growing unconfirmed history.

**Independent Test**: Several writers write concurrently to one context; within a bounded time
after they stop, every peer reports the whole context as confirmed, and the indexers are exactly
the members chosen as indexers.

**Acceptance Scenarios**:

1. **Given** a new context, **When** it is created, **Then** its creator is its only indexer.
2. **Given** a context and a member granted the right to index, **When** that member is added as a
   writer, **Then** they become an indexer; **When** any other member is added as a writer,
   **Then** they can write but do not index.
3. **Given** five writers who each write 1,000 events concurrently and then stop, **When** a few
   seconds pass, **Then** every peer reports all events confirmed and identical indexes.
4. **Given** a context whose only indexer is offline, **When** other writers keep writing, **Then**
   their writes are accepted and visible locally as today, and become confirmed once an indexer
   is back.

---

### User Story 2 - Joining a large context is fast and bounded (Priority: P1)

A developer building a community archive (SwarmFS) has a context with a million entries. A new
member's device must be able to join it, read folder listings, and keep up with new writes,
without replaying the whole history and without memory growing with the context's size.

**Why this priority**: It is the measured blocker for archive-scale use (the 1M join fails today).

**Independent Test**: With the scale benchmark, a fresh peer joins a 1,000,000-entry context;
measure time to first listing, memory, and disk; verify listings match the writer's.

**Acceptance Scenarios**:

1. **Given** a context whose history is agreed and signed, **When** a fresh peer joins, **Then** it
   adopts the signed state instead of replaying the history, and its first folder listing returns
   the same entries as the writer's.
2. **Given** that fresh peer, **When** it reads only some folders, **Then** it stores only what it
   read (plus what it needs to verify it), not the whole index.
3. **Given** that fresh peer, **When** new events are written after it joined, **Then** it applies
   them and stays consistent with everyone else.
4. **Given** a context with no signed state yet (e.g. created by an older version), **When** a
   fresh peer joins, **Then** it falls back to replaying, exactly as today.

---

### User Story 3 - Apps reject events with their own rules (Priority: P2)

A developer building SwarmFS attaches rules to a context — e.g. "a file entry needs a valid
content address", "only a folder's owner can add files to it" — and events breaking them are
rejected when applied, so they are never indexed by anyone who applies them and never become
part of the agreed state.

**Why this priority**: It closes the gap that lets a hostile member pollute everyone's index. It
depends on US1, because the agreed state is what makes indexers' enforcement count for everyone.

**Independent Test**: Attach a rule to a context; a writer appends events that break it, both
through the API and by writing raw events; no peer's index contains them, and a peer that joins
by downloading the signed state doesn't either.

**Acceptance Scenarios**:

1. **Given** a context with an app rule, **When** an event breaking the rule is appended by any
   writer, **Then** it is not indexed on any peer that applies it, and is not in the signed state.
2. **Given** an app rule that needs to look at the current index (e.g. "name not already taken in
   this folder"), **When** it runs, **Then** it can read the index as it stood before the event,
   and its decision is the same on every peer.
3. **Given** two peers that attach different rules to the same context, **When** they apply
   events, **Then** the mismatch is detected and reported instead of silently producing different
   indexes.
4. **Given** a rule that throws, **When** it runs, **Then** the event is rejected and applying
   carries on; it never crashes apply.
5. **Given** a context with no app rules, **When** used, **Then** behavior is exactly as today.

---

### User Story 4 - Existing contexts keep working and can move over (Priority: P3)

A developer with existing contexts (every writer an indexer, never confirmed) upgrades hypergraph.
Their contexts must keep working, and the context's owner must be able to move them to the new
topology.

**Why this priority**: Existing data must not break, but new contexts get the benefit without it.

**Independent Test**: Open a context created with the previous version; it works unchanged; the
owner converts it; afterwards it behaves like a new context.

**Acceptance Scenarios**:

1. **Given** a context created by the previous version, **When** opened by this version, **Then**
   reads and writes work as before.
2. **Given** such a context, **When** its owner converts it, **Then** only members with the right
   to index remain indexers, the context reaches an agreed state, and newcomers can fast-forward.

---

### Edge Cases

- **Permission decisions must be the same on every peer.** Today apply consults the role
  registry, a separate log that reaches each peer at its own pace, so two peers can decide the
  same event differently. Each peer builds its own index today, so the difference stays local;
  once indexers must agree on one signed index, such a difference stops agreement. Decisions that
  depend on roles must be made the same way on every peer.
- **Indexers disagree** (different code, different rules): they cannot sign the same state; this
  must be detected and reported, not left as a silent stall.
- **The only indexer leaves for good**: the context can no longer be confirmed; an owner must be
  able to appoint a new indexer, and this must be possible without the old one.
- **A majority of indexers is hostile**: they can sign any state; this is the trust model, stated
  plainly to developers, not something the library can prevent.
- **Peers on an older version in the same context**: they make every writer an indexer, which
  would give them a different view of who indexes. Must be detected and refused rather than
  silently splitting the context.
- **Partition**: two sides keep writing; only the side with a majority of indexers can confirm;
  the other side's writes are confirmed after the partition heals.
- **A fast-forwarding peer reads a part of the index nobody online holds**: the read waits or
  times out with a clear result; it never returns wrong data.
- **Storage left by rejected events**: a rejected event is not indexed, but its bytes stay in its
  writer's log on peers that downloaded it. Peers that join by downloading the signed state never
  need those logs' history.
- **Ack traffic**: acknowledgements are extra small writes by indexers; their volume must stay
  bounded when idle.

## Requirements *(mandatory)*

### Functional Requirements

**Agreed state (US1)**

- **FR-001**: A context MUST have an explicit set of indexers, separate from its set of writers.
- **FR-002**: A new context's creator MUST be its only initial indexer.
- **FR-003**: A member MUST become an indexer only when added by someone holding a dedicated
  "may appoint indexers" permission; every other added writer MUST be a non-indexing writer.
- **FR-004**: Indexers MUST acknowledge new history automatically, so that a context's history
  becomes confirmed within a bounded time after activity, without application action.
- **FR-005**: The library MUST expose, per context, whether this peer is an indexer, who the
  indexers are, and how much of the history is confirmed.
- **FR-006**: An indexer MUST be removable, and a new one appointable, by an authorized member,
  including when the current indexers are offline for good, provided the remaining or new
  indexers can still form the required majority.

**Fast-forward (US2)**

- **FR-007**: A peer opening a context with a confirmed, signed state MUST be able to adopt that
  state instead of replaying the history, by default.
- **FR-008**: A fast-forwarded peer MUST fetch index pieces on demand when reading, and MUST NOT
  need to download or replay the full history to read, write, or stay consistent.
- **FR-009**: A context with no signed state MUST fall back to replaying, as today.
- **FR-010**: The memory a joining peer uses MUST NOT grow with the size of the context's history.
- **FR-011**: A developer MUST be able to opt a peer out of fast-forward (replay and verify
  everything itself).

**App rules (US3)**

- **FR-012**: A developer MUST be able to attach validation rules to a context, which run on
  every event a peer applies after the built-in checks, and can reject the event.
- **FR-013**: A rejected event MUST NOT be indexed, and MUST NOT affect any other event's outcome.
- **FR-014**: A rule MUST be able to read the context's index as it stood before the event, and
  MUST receive everything it needs to decide deterministically; the library MUST NOT give it
  anything that differs between peers (local time, randomness, unsynchronized state).
- **FR-015**: A rule that throws or returns something invalid MUST reject the event, never crash
  apply.
- **FR-016**: The identity of a context's rules (a name and version chosen by the app) MUST be
  recorded with the context, and a peer whose rules don't match MUST detect it and report it
  instead of applying with different rules.

**Determinism and compatibility**

- **FR-017**: Every decision apply makes — built-in permission checks, indexer appointments, app
  rules — MUST be the same on every peer given the same history.
- **FR-018**: A context MUST record which topology it uses, and peers MUST refuse to apply a
  context whose topology they don't support, rather than silently diverging.
- **FR-019**: Contexts created by the previous version MUST keep working unchanged, and their
  owner MUST be able to convert them to the new topology.
- **FR-020**: The full test suite, HyperBBS's and hyperDNS's suites MUST pass, changing their code
  only where this spec explicitly requires (and saying so in the changelog).
- **FR-021**: The trust model — what a fast-forwarding member trusts, what indexers can and
  cannot do, what app rules protect against — MUST be documented for developers.

### Key Entities

- **Indexer**: a member whose device helps confirm a context's history and signs its agreed state.
- **Non-indexing writer**: a member who can write but whose device does not take part in
  confirming.
- **Confirmed (signed) state**: the context's history up to the point a majority of indexers
  agreed on, which can no longer be reordered and which newcomers can adopt.
- **App rules**: a named, versioned set of deterministic checks attached to a context.
- **Context topology record**: what a context declares about itself (topology version, rules
  identity), so every peer applies it the same way.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fresh peer joins a 1,000,000-entry context on a 16 GB machine and shows its first
  folder listing within 30 seconds (today: fails after ~21 minutes).
- **SC-002**: A fresh peer's peak memory while joining a 100,000-entry context is under 500 MB,
  and stays within 20% of that at 1,000,000 entries.
- **SC-003**: After five writers stop writing, every peer reports the whole context confirmed
  within 10 seconds.
- **SC-004**: No event breaking an app rule appears in any peer's index or in the signed state,
  across the test suite's hostile-writer scenarios.
- **SC-005**: Two peers with mismatched rules or topology report the mismatch in 100% of tested
  cases; none silently diverges.
- **SC-006**: A fresh peer that reads 10 folders of 1,000 entries from a 1,000,000-entry context
  stores under 5% of what a full replica stores.
- **SC-007**: HyperBBS and hyperDNS test suites pass.

## Assumptions

- **Who indexes** (proposed 2026-10-05, not objected to): the context creator, plus members added
  by someone holding a new `context.index` permission (owners have it through `*`; admins could
  be given it by default). Everyone else writes without indexing. To be confirmed with the user
  before implementation, since it is the trust model.
- Acknowledgements use the underlying library's built-in mechanism with an interval of about one
  second, tuned by measurement.
- Fast-forward relies on the underlying library's built-in support; no dependency is modified.
- Peers in one context are expected to run compatible hypergraph versions; mixing versions in one
  context is detected and refused (FR-018), not supported. HyperBBS and hyperDNS are linked to
  this tree and upgrade together.
- Invite links that carry a role are a separate specification; this one only defines who can
  appoint indexers.
- Storage taken by rejected events in their writers' logs is not reclaimed by this feature;
  newcomers that fast-forward simply never fetch it.
