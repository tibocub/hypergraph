# Feature Specification: v2 private channels and invites

**Feature Branch**: `008-v2-private-channels`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "v2 private channels and invites. Basis: the v2 prototype (specs/007-scaling-v2-prototype, docs/v2-prototype.md, require('hypergraph/v2')) and v1's read-permission design (docs/read-permission.md: per-identity encryption key pair derived from the identity seed, symmetric keys per scope in epochs sealed to each member, rotation to cut someone off, invites that never carry the key itself and are completed by any key holder who comes online, the minter must have been able to grant). Build in v2, alongside v1 (v1 untouched): (1) private channels [...] (2) key grants and revocation [...] (3) invite links for v2 communities [...] (4) moderation keeps working on private channels [...]. Success measured, as in spec 007 [...]. Out of scope: HyperBBS (the TUI is being paused for a web interface), MLS-style forward secrecy, hiding metadata, encrypting the control log itself, migrating v1 data. Constraints: Holepunch stack only, no forks of dependencies, benchmarks within the dev machine's load limits, v1 suites and hyperDNS keep passing."

The "user" throughout is a developer building an app on `require('hypergraph/v2')`, and the people
using that app (community members). Hypergraph has no UI of its own.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A private channel only its members can read (Priority: P1)

An admin creates a private channel. Members who were given access read and post in it as in any
channel. Everyone else, including keepers who list who posts and peers who relay the data, sees
that messages exist (who, when, how big) but not what they say, and the app shows them as
unreadable rather than failing.

**Why this priority**: Without it, v2 communities can't have anything private; every other story
builds on it.

**Independent Test**: Create a private channel, give access to one member and not to another,
post from both sides, and read from: the admin, the member with access, the member without, a
keeper, and a newcomer.

**Acceptance Scenarios**:

1. **Given** a private channel and a member with access, **When** they post and read, **Then**
   they see the text as in a public channel.
2. **Given** a member without access, **When** they read the same page, **Then** each message
   comes back marked unreadable with its author and time, and no text.
3. **Given** a keeper without access, **When** members post, **Then** the keeper still lists them,
   so members with access see the posts arrive live.
4. **Given** the bytes of the channel on disk or on the wire, **When** inspected by someone
   without access, **Then** no message text can be recovered from them.

---

### User Story 2 - Giving and taking away access (Priority: P1)

An admin gives a member access by their identity, and later takes it away. Taking it away means
the member can't read anything posted afterwards. What they already had stays readable to them;
the app is told so plainly. Getting one's own access costs a member the same whether 10 or 50,000
others have access too.

**Why this priority**: A private channel nobody can join or leave is not usable.

**Independent Test**: Grant access to three members, revoke one, post, and check each member's
view; measure one member's cost to obtain access with 10 and 50,000 members granted.

**Acceptance Scenarios**:

1. **Given** a member granted access, **When** they open the channel, **Then** they read it,
   including messages from before they were granted (back to the oldest key they were given).
2. **Given** a member whose access was revoked, **When** others post afterwards, **Then** that
   member reads none of the new messages, and still reads what they could read before.
3. **Given** many members with access, **When** one more member obtains their access, **Then**
   they download only what concerns them, not everyone's access.
4. **Given** someone not allowed to grant access, **When** they try, **Then** it is refused on
   their side and ignored by every other peer.

---

### User Story 3 - One link to join (Priority: P2)

A member shares a link. Whoever opens it joins the community, and if the link says so, also gets
a staff role (admin, mod, keeper) and/or access to some private channels. It works even when the
person who made the link is offline, as long as someone able to complete it comes online later.
Links can expire and can be limited to a number of uses.

**Why this priority**: Without links, joining a private space means exchanging keys by hand.

**Independent Test**: Make links with and without a role and channel access, with an expiry and a
use limit; redeem them while the maker is offline and another eligible member is online; redeem
past the limit and after expiry.

**Acceptance Scenarios**:

1. **Given** a link for the community only, **When** someone redeems it, **Then** they can read
   public channels and post.
2. **Given** a link with a role and private channel access, **When** redeemed with the maker
   offline, **Then** the role applies once the redemption is recorded, and the channel access
   arrives once any member able to grant it is online.
3. **Given** a link limited to N uses, **When** N+1 people redeem it, **Then** exactly N get what
   it offers, decided the same way on every peer.
4. **Given** an expired link, **When** redeemed, **Then** it gives nothing beyond joining a public
   community (which needs no link).
5. **Given** a member who couldn't grant a role or a channel's access themselves, **When** they
   try to make a link for it, **Then** it is refused, and a link forged anyway gives nothing.

---

### User Story 4 - Moderation and the rest keep working in private channels (Priority: P2)

Hides, bans and the ban's cut apply in private channels as in public ones. Keepers keep listing
authors without reading messages. Replication modes, offline reading and scrollback behave as in
public channels, for members with access.

**Why this priority**: Private channels that escape moderation or break offline reading would be
a regression from public ones.

**Independent Test**: Repeat spec 007's moderation, replication and offline tests on a private
channel.

**Acceptance Scenarios**:

1. **Given** a private channel, **When** a mod hides a message or bans an author, **Then** members
   with access see it applied as in a public channel; a mod without access can still hide by
   reference and ban.
2. **Given** a member with access who restarts with no peer, **When** they open the channel,
   **Then** what they had shown is readable again.

---

### Edge Cases

- A message posted with a key epoch the reader doesn't have yet (key rotated, grant not arrived):
  shown as unreadable until the grant arrives, then readable without re-downloading the message.
- Two admins rotate the key at the same time: every peer ends up agreeing on one current key, and
  messages posted with either during the race stay readable by members who were granted both.
- A member is granted access while offline: the grant waits for them; nothing needs the granter
  online when the member comes back.
- A peer serves forged or corrupted grants or encrypted messages: they are rejected (not readable),
  never shown as someone else's text.
- A link redeemed twice by the same person counts once.
- A link maker loses the right to grant (demoted, banned) before the link is redeemed: the link
  gives nothing it could no longer give.
- A member revoked and later granted again: reads messages posted after the new grant.
- Partial replication: a member holding only recent segments still decrypts them; a newcomer with
  access decrypts old segments fetched on scrollback.

## Requirements *(mandatory)*

### Functional Requirements

**Private channels**

- **FR-001**: An admin MUST be able to create a channel as private; its privacy can't be removed
  afterwards (making it public again would expose earlier messages that were posted as private).
- **FR-002**: Messages posted in a private channel MUST be stored and transmitted only encrypted
  with the channel's key for the current epoch; their author, time, sequence and size stay visible.
- **FR-003**: A reader with the right key MUST see the text; a reader without it MUST get the
  message marked unreadable (author, time, position kept), never an error.
- **FR-004**: Keepers MUST list authors of private channels without holding the key.
- **FR-005**: Each member MUST have one encryption key pair per identity, the same on all their
  devices, derived from their identity's secret; others address grants to its public part.

**Access**

- **FR-006**: Admins and up MUST be able to grant a private channel's access to a member by their
  identity; a channel MAY also allow members who hold its key to grant it.
- **FR-007**: A grant MUST be readable only by its recipient (sealed to their encryption key), and
  MUST include every epoch the granter decides to share (by default all epochs they hold).
- **FR-008**: Obtaining one's own grant MUST NOT download other members' grants, and its cost MAY
  grow only slowly (logarithmically) with the number of members granted; the community's control
  log MUST NOT carry per-member grants.
- **FR-009**: Revoking a member MUST be followed by a key rotation (one action for the caller): a new
  epoch is created and granted to every current member except the revoked one; new messages use it.
- **FR-010**: A revoked member MUST keep reading what they could read before, and MUST NOT read
  messages encrypted with epochs created after their revocation.
- **FR-011**: Concurrent rotations MUST converge on the same current epoch on every peer.
- **FR-012**: Grants and rotations from someone not allowed MUST be ignored by every peer.

**Invites**

- **FR-013**: A member MUST be able to make an invite link carrying: the community, an optional
  staff role, an optional set of private channels, an optional expiry, and an optional use limit.
- **FR-014**: Making a link for a role or a channel MUST be refused unless the maker could grant it
  themselves at that moment; every peer MUST also check the maker's right when the link is
  redeemed, and give nothing the maker can no longer give.
- **FR-015**: A link MUST NOT contain any channel key, sealed or not.
- **FR-016**: Redeeming MUST NOT require the maker to be online: the role applies once the
  redemption is recorded by the community; channel access arrives when any member able to grant it
  comes online.
- **FR-017**: Use limits and expiry MUST be decided identically on every peer; the same person
  redeeming twice counts once.
- **FR-018**: A link MUST be revocable by its maker or an admin before it is used up.

**Moderation and the rest**

- **FR-019**: Hides, bans and ban cuts MUST apply to private channels as to public ones, and a mod
  MUST be able to ban or hide without holding the channel key.
- **FR-020**: Replication modes, offline reading, scrollback and following MUST work on private
  channels for members with access, at the costs spec 007 measured plus a constant for the key.

### Key Entities

- **Encryption identity**: a member's encryption key pair, derived from their identity; its public
  part is what grants and invite redemptions are addressed to.
- **Channel key epoch**: a symmetric key for a private channel, numbered; a rotation adds one. Every
  private message names the epoch it was encrypted with.
- **Grant**: a channel's epochs sealed to one member, written by someone allowed; looked up by its
  recipient alone.
- **Invite**: a signed statement by its maker: community, optional role, optional channels, expiry,
  use limit, an id. Carried in a link.
- **Redemption**: a newcomer's signed request naming an invite and their identity and encryption
  key; recorded once by the community, then completed (role, grants).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member with access shows a private channel's latest page within 10% of the time and
  bytes of the same public channel, plus at most a fixed amount for obtaining the key the first time.
- **SC-002**: A member's download to obtain their own access never includes other members' grants
  and stays under 32 KB with 50,000 members granted. (First written as "within 10% from 10 to
  50,000"; measured during planning, research R1: any tree index grows with its depth, 1.6 / 8.7 /
  25.7 KB at 10 / 1,000 / 50,000.)
- **SC-003**: Revoking a member of a channel with 1,000 members (rotation and re-grants included)
  completes in under 60 seconds on the dev machine, and members receive the new epoch within 10
  seconds of being online after it.
- **SC-004**: In the tests, members without access and revoked members (for messages after their
  revocation) read 0% of the message texts; every message from a member with access is readable
  by every other member with access.
- **SC-005**: An invite redeemed while its maker is offline completes (role and channel access) in
  100% of the tests once any eligible member is online, and use limits are never exceeded.
- **SC-006**: Every spec 007 test kind (moderation, replication modes, offline, scrollback,
  following) passes on a private channel.
- **SC-007**: The full test suite and hyperDNS pass throughout; v1 is unchanged.

## Assumptions

- Builds on the v2 prototype's model (control log, author logs, segments, keeper rosters) and stays
  a prototype API: unstable, beside v1.
- Membership of a private channel (who holds a grant) is not secret from admins or from peers that
  replicate the grants; only message texts are confidential (hiding metadata is out of scope).
- The epoch design (rotate the whole key to remove someone) is kept from v1; MLS-style forward
  secrecy and post-compromise security are out of scope.
- A whole private community is a community whose channels are all private; there is no separate
  community-level secrecy.
- Staff roles granted by an invite are recorded in the control log like any role change, so a
  member able to write the control log (owner, admin) has to process the redemption; channel access
  needs a key holder able to grant. "Online later" covers both.
- Default expiry for links: none unless the maker sets one; default use limit: none.
- HyperBBS is not migrated (paused); hyperDNS uses v1 and must keep passing.
