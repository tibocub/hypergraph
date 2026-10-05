# Feature Specification: Roles Inside the Context, and Several Indexers

**Feature Branch**: `005-context-roles`

**Created**: 2026-10-05

**Status**: Draft

**Input**: Phase 2 of spec 003: let several trusted members confirm (index) a context, and convert
older contexts. Decision from the user (2026-10-05): permission decisions become identical on
every peer by recording **role grants inside the context itself**; the shared RoleBase stays for
older contexts and read scopes.

## Background

Since spec 003, a context is confirmed by its creator's device alone. If that device is offline
for long, or gone for good, nothing new is confirmed, and newcomers to a large context can no
longer fast-forward past recent history. Several indexers fix that — but indexers only agree on
one signed state if every decision apply makes is identical on each of them.

Today, whether a member may add a writer or moderate is looked up in the RoleBase: a separate log
that reaches each peer at its own pace. Two indexers can therefore decide the same event
differently and never sign the same state (spec 003 research R4). Recording a context's roles in
the context's own log makes every decision follow from one ordered history.

Measured (bare Autobase, 2026-10-05): a writer can be promoted to indexer and demoted back while
remaining a writer; three indexers with acknowledgements confirm history; a newcomer still
fast-forwards a multi-indexer context.

## User Scenarios & Testing *(mandatory)*

"User" means the developer consuming `require('hypergraph')`.

### User Story 1 - Appoint trusted indexers (Priority: P1)

The owner of a community archive appoints two admins. Their devices then help confirm the
archive, so it keeps being confirmed while the owner's device is offline.

**Why this priority**: It removes the single point of failure of spec 003.

**Independent Test**: An owner appoints two admins; with the owner offline, the two admins' devices
confirm new writes; a newcomer fast-forwards.

**Acceptance Scenarios**:

1. **Given** a new context, **When** the owner grants a member the admin role, **Then** that
   member's writing devices become indexers on every peer.
2. **Given** an owner and two admin indexers, **When** the owner goes offline and members keep
   writing, **Then** the writes are confirmed by the two admins.
3. **Given** an admin, **When** the owner revokes the role, **Then** the member's devices stop
   indexing but can still write.
4. **Given** a member granted a role, **When** they add another device as a writer later, **Then**
   that device gets the indexing status the role implies.

---

### User Story 2 - Every permission decision is the same everywhere (Priority: P1)

The developer needs adding writers, moderation, and role changes in a context to be decided from
the context's own history, so all peers — and above all all indexers — reach the same result.

**Why this priority**: It is what makes several indexers possible at all.

**Independent Test**: Peers that receive the same events in different delivery orders, some before
and some after any other log they might consult, end with identical indexes and identical role
tables.

**Acceptance Scenarios**:

1. **Given** a closed context, **When** a member without the right to add writers adds one,
   **Then** every peer refuses it; **When** an admin does, every peer accepts it.
2. **Given** a moderation action, **When** applied, **Then** the decision depends only on the
   author's role in this context at that point of its history.
3. **Given** a member who tries to grant themselves or others a role above their own, **When**
   applied, **Then** every peer refuses it.
4. **Given** events delivered to peers in different orders, **When** they converge, **Then** role
   tables and indexes are identical.

---

### User Story 3 - Convert an existing context (Priority: P2)

The creator of a context made before this feature (every writer an indexer, or creator-only from
spec 003) converts it so it gets roles and a chosen set of indexers.

**Why this priority**: Existing data must be able to benefit, but new contexts get it by default.

**Acceptance Scenarios**:

1. **Given** a context created before this feature, **When** its creator converts it, **Then** from
   that point only the creator and members whose role allows indexing are indexers, and every
   other writer keeps writing without indexing.
2. **Given** a context nobody converts, **When** used, **Then** it behaves exactly as before.

---

### Edge Cases

- **Last indexer**: the last indexer cannot be demoted or removed; the request is refused rather
  than leaving the context unconfirmable.
- **Majority offline**: with several indexers, confirmation needs a majority of them; if a majority
  is offline, writes still apply locally and are confirmed when enough are back. Developers are
  told to keep the indexer set small and reliable.
- **Concurrent role changes**: an owner revokes an admin while that admin, concurrently, adds a
  writer; both orders are possible, every peer resolves the same one (the context's order).
- **A member with several devices**: role applies to the member (identity of the signing device
  key); each device that writes is a separate writer and gets the role's indexing status.
- **Forged role grants**: a grant not signed by someone allowed to grant that role is ignored.
- **Older peers**: peers that don't understand the new events would decide differently; as with
  spec 003, mixed versions in one context are refused, not supported.

## Requirements *(mandatory)*

### Functional Requirements

**Roles in the context**

- **FR-001**: Contexts created from now on MUST keep their own role table, changed only by role
  events recorded in the context.
- **FR-002**: The creator MUST start as the context's owner.
- **FR-003**: A role event MUST take effect only if its author may grant or remove that role at
  that point of the context's history: the owner any role; members with the right to manage
  moderators the moderator and member roles; nobody a role above their own.
- **FR-004**: Every permission decision apply makes in such a context — adding/removing writers in
  closed mode, moderation, role changes, indexer status — MUST use the context's own role table
  as of that point of its history, and nothing outside the context's log.
- **FR-005**: The library MUST expose a context's role table and let an authorized member grant and
  remove roles in it.

**Several indexers**

- **FR-006**: A writer MUST be an indexer exactly when its member's role allows indexing
  (owner and admin by default), and MUST be promoted or demoted when that role changes.
- **FR-007**: Writers MUST be linked to the member they belong to when they are added, so their
  indexing status follows the member's role.
- **FR-008**: Removing or demoting the last indexer MUST be refused.

**Conversion and compatibility**

- **FR-009**: The creator of an existing context MUST be able to convert it; conversion takes
  effect at that point of the context's history.
- **FR-010**: Unconverted existing contexts MUST behave exactly as before.
- **FR-011**: The shared RoleBase MUST keep working for unconverted contexts and for read scopes.
- **FR-012**: Full suite, HyperBBS and hyperDNS MUST pass; changes required in consumers, if any,
  are listed in the changelog.

### Key Entities

- **Context role table**: member (device public key) → role, plus role → permissions, held in the
  context's index and changed only by role events.
- **Role event**: a signed grant or removal of a role for one member in one context.
- **Writer link**: which member a writer (device log) belongs to.

## Success Criteria *(mandatory)*

- **SC-001**: With the owner offline and two admin indexers online, new writes are confirmed within
  10 seconds of being applied.
- **SC-002**: In every reordering scenario tested, all peers end with identical role tables and
  indexes.
- **SC-003**: Every unauthorized role, writer and moderation attempt in the tests is refused on every
  peer.
- **SC-004**: A newcomer still joins a large multi-indexer context by fast-forward.
- **SC-005**: Full suite, HyperBBS and hyperDNS pass.

## Assumptions

- Default roles and permissions are the ones hypergraph's role registry already defines (owner:
  everything; admin: moderation, writers, managing moderators), plus indexing for owner and admin.
  Custom per-context permissions are left for later.
- The creator's identity for ownership is its device key; multi-device owners are handled by the
  owner granting roles to their other devices.
- Invite links that grant a role (the user's ask #3) will be built on these role events in a
  separate specification.
