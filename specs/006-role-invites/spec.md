# Feature Specification: Invite Links That Carry a Role

**Feature Branch**: `006-role-invites`

**Created**: 2026-10-05

**Status**: Draft

**Input**: The user's ask #3 from the SwarmFS planning: "minting a link that grants 'reader' or
'writer' when used, rather than joining first and being granted a role afterwards. This came out
of SwarmFS's UX but belongs in hypergraph, alongside the private-context work." Builds on spec 005
(roles recorded inside the context).

## Background

Today a newcomer joins in two steps that need someone online at the right moment: they connect,
then an existing member must add their device as a writer and grant them a role. For a space
owner who wants to hand out a link ("join my archive as an editor"), that is awkward: the link
holder can't do anything until someone acts on their behalf.

Verified with bare Autobase (2026-10-05): a peer that is not yet a writer can append a block that
every peer's apply inspects and may accept, making that peer a writer — no member needs to act at
redemption time, as long as peers replicate. This only works when replication streams carry
Autobase's writer-discovery protocol, which hypergraph's own replication does not set up today.

## User Scenarios & Testing *(mandatory)*

"User" means the developer consuming `require('hypergraph')`.

### User Story 1 - Mint a link, redeem it, have the role (Priority: P1)

A SwarmFS owner creates an invite link that grants "writer with the admin role" in their archive's
context and sends it to a friend. The friend's app redeems it: their device becomes a writer with
that role, without the owner doing anything at that moment.

**Why this priority**: It is the ask.

**Independent Test**: Peer A mints an invite; peer B, holding only the link, redeems it while A only
replicates; B can write, holds the role on every peer, and indexes if the role says so.

**Acceptance Scenarios**:

1. **Given** a member allowed to grant a role, **When** they mint an invite for it, **Then** they get
   a link that carries everything needed to redeem it.
2. **Given** a peer holding the link, **When** it redeems it, **Then** on every peer it becomes a
   writer of the context with the invite's role, linked to the redeeming member.
3. **Given** an invite granting a role that indexes (admin), **When** redeemed, **Then** the device
   becomes an indexer.
4. **Given** an invite for the plain member role, **When** redeemed, **Then** the device writes but
   doesn't index.

---

### User Story 2 - Invites can't be abused (Priority: P1)

**Why this priority**: A link is a bearer secret; whoever holds it gets the role, so its limits must
hold on every peer.

**Acceptance Scenarios**:

1. **Given** a member not allowed to grant a role, **When** they mint an invite for it, **Then** the
   invite is ignored everywhere, and redeeming it grants nothing.
2. **Given** a single-use invite already redeemed, **When** someone redeems it again, **Then** nothing
   is granted.
3. **Given** an invite the minter revoked, **When** redeemed, **Then** nothing is granted.
4. **Given** a redemption with a wrong secret, or any other block from a non-writer, **When** applied,
   **Then** it is ignored and changes nothing.
5. **Given** two peers redeeming the last use of an invite at the same time, **When** they converge,
   **Then** exactly one of them got it, the same one on every peer.

---

### User Story 3 - Invites into private content (Priority: P2)

A private archive encrypts its content under a read scope. An invite marked as granting read access
also gets the redeemer the scope's key, from an online member who holds it.

**Why this priority**: Requested ("grants 'reader'"), but needs a key holder online to seal the key,
unlike roles.

**Acceptance Scenarios**:

1. **Given** an invite granting read access to a scope, **When** redeemed and a member holding the
   scope key is online, **Then** the redeemer receives the key and can read the scoped content.

---

### Edge Cases

- **Nobody online but the joiner**: the redemption waits in the joiner's own log and takes effect
  when any peer replicating the context sees it.
- **Minter loses the right to grant later**: an invite minted while they had the right stays valid
  until revoked (decided at minting, from the context's history at that point).
- **Leaked link**: anyone holding it can redeem it up to its use limit; the minter revokes it.
- **Time limits**: event times are claimed by their authors, so an expiry can't be enforced against
  someone who holds the secret; use limits and revocation are the enforceable controls.
- **Contexts without their own role table** (version 1 and 2): invites need roles inside the
  context; minting is refused there.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: An authorized member MUST be able to mint an invite for a role in a version 3 context,
  with a use limit (default 1), and receive a link.
- **FR-002**: The link MUST be self-contained: context and invite secret, in a URL-safe text form that
  can be parsed back.
- **FR-003**: Minting MUST be accepted only if the minter may grant that role at that point of the
  context's history (spec 005 rules).
- **FR-004**: A peer holding a link MUST be able to redeem it without being a writer, and without any
  member acting at redemption time.
- **FR-005**: A redemption MUST be accepted only with the invite's secret, while uses remain and the
  invite isn't revoked; it then makes the redeeming device a writer, linked to the redeeming member,
  with the invite's role (and indexing as that role implies).
- **FR-006**: Every peer MUST reach the same decision for every redemption, including competing ones.
- **FR-007**: Blocks from non-writers other than valid redemptions MUST be ignored.
- **FR-008**: The minter (or anyone allowed to grant that role) MUST be able to revoke an invite.
- **FR-009**: Replication set up by hypergraph (`graph.replicate()`, the networking helper) MUST carry
  what is needed for peers to discover a redeemer's log.
- **FR-010** (P2): An invite MAY grant read access to a read scope; a member holding the scope key
  then grants it to the redeemer automatically.
- **FR-011**: Full suite, HyperBBS and hyperDNS MUST pass.

### Key Entities

- **Invite**: role, use limit, uses so far, revoked flag, minter — recorded in the context.
- **Invite link**: the context key and the invite's secret, as text.
- **Redemption**: proof of the secret, the redeeming member and their device's writer key.

## Success Criteria *(mandatory)*

- **SC-001**: A link holder becomes a writer with the invite's role on every peer within 5 seconds of
  redeeming, with the minter only replicating.
- **SC-002**: Every abuse case in the tests (unauthorized minting, reuse beyond the limit, revoked,
  wrong secret, stray blocks, competing redemptions) is decided identically and safely on every peer.
- **SC-003**: Full suite, HyperBBS and hyperDNS pass.

## Assumptions

- Peers replicate with `graph.replicate()` or the networking helper; apps calling the corestore's
  `replicate()` directly must switch to get invites (documented).
- "Writer" is a capability, not a role: every invite makes its redeemer a writer; the role decides
  everything else (indexing, moderation, granting).
- The read-scope part (US3) can ship after the role part.
