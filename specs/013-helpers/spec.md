# Feature Specification: Helpers (optional blind peers)

**Feature Branch**: `013-helpers`

**Created**: 2026-10-29

**Status**: Draft (waiting for the lead's review)

**Input**: "Optional helpers (Holepunch blind peers) that keep a space's data available while members are
offline. The owner lists helper keys in the space's settings; every member's app connects to them in the
background and hands over the space's data. Never required. Helpers run blind-peer unchanged. The API
exposes the helper list. Private spaces: helpers hold data they can't read. Node and Bare."
Decided in ROADMAP.md, Decisions "2026-10-29 (forum web app…)".

Who the "user" is: a developer building an app on `require('hypergraph/next')` (first: the forum web app,
`E:\Code\P2P\hypergraph-forum-example`), and the people using it.

## The problem

A post spreads only while its author and another member are online together. In a forum of 5–20 friends
that is often not the case: Ann posts at night, closes her laptop, and Bob sees nothing until they overlap.

`specs/research/availability.md` measured the fix: a **blind peer** (Holepunch's `blind-peer`, a server
someone runs, e.g. Tibo's small VPS) keeps the cores it is handed and serves them by plain replication,
without being able to read encrypted ones. What is missing is everything around it: members must know
the space's helpers, connect to them without anyone wiring it, hand over what they write, and a member
coming back must find the logs written while it was away.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Posts reach members who were never online with the author (Priority: P1)

The owner adds the forum's helper (the VPS's key) once. Ann posts and leaves. Bob comes online later,
with only the helper online, and reads Ann's posts. Dan joined while Ann was online, posted, and left;
Bob also reads Dan's posts, though Bob has never met Dan.

**Independent Test**: one helper (a real `blind-peer`) on a local DHT; author posts, sets the helper,
leaves; a member that was away reads everything through the helper alone.

**Acceptance Scenarios**:

1. **Given** a space whose owner set a helper, **When** the owner posts and closes, **Then** a member
   opening later, with only the helper online, reads every post.
2. **Given** a member who joined and posted while the owner was online, then left with the owner,
   **When** another member who never met them opens, **Then** it reads their posts too.

### User Story 2 - Never required (Priority: P1)

A space with no helper, or whose helpers are all down (or whose key is wrong), works exactly as today:
opening, posting and reading never wait for a helper and never fail because of one.

**Acceptance Scenarios**:

1. **Given** a space whose helper key points at nothing, **When** a member opens it, posts and reads,
   **Then** each step takes as long as without a helper (well under a second here) and succeeds.

### User Story 3 - Only the owner lists helpers (Priority: P1)

**Acceptance Scenarios**:

1. **Given** an admin, **When** it sets the helpers, **Then** it is refused (`NOT_ALLOWED`), and a
   decision it writes by hand changes nothing for any member.
2. **Given** the owner, **When** it sets or clears the helpers, **Then** every member sees the new list
   (`space.helpers`) and a `decisions` event.

### User Story 4 - Private spaces stay private (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a private space with a helper, **When** a member posts, **Then** the helper holds the post's
   blocks but they don't contain its text, and a member away at the time still reads it through the helper.

### Edge Cases

- Helpers changed while members are online: members drop the old ones and hand over to the new ones.
- No network (`connectToSwarm` never called): no helper is contacted.
- A helper that is full (blind-peer's `maxBytes`) drops whole old cores: members still holding them
  serve them as today; nothing in hypergraph waits on it.
- Sub-spaces: they use their top space's helpers.
- Bogus keys (not 32 bytes) are refused by `setHelpers`; malformed lists in a decision are ignored.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `space.setHelpers(keys)` records the space's helper list (z32 or hex keys, or bytes; `[]`
  clears it). Owner only for now; the check sits in one place so it can be loosened later.
- **FR-002**: `space.helpers` lists the helpers' keys (z32), on every member; changes fire `decisions`.
- **FR-003**: Every member's app, once online, connects to the space's helpers in the background and
  hands them the space's decision log and every log it holds (its own included), and new ones as they come.
- **FR-004**: Nothing in open/get/query/post/setHelpers waits on a helper; a down or bogus helper causes no
  error.
- **FR-005**: A member coming back finds logs written while it was away: in a space with helpers, members
  who record decisions also record the keys of the logs they hold; members read them from the decision log
  and fetch those logs (through the helper when nobody else is online), checked as any other log.
- **FR-006**: Helpers are plain `blind-peer` servers (`blind-peer-cli`), unchanged.
- **FR-007**: Works on Node and Bare.

### Key Entities

- **Helper**: a blind peer's public key, listed in a space's settings.
- **Listed log**: a log key (with its space) recorded in the decision log, so members can find it without
  meeting its author.

## Success Criteria *(mandatory)*

- **SC-001**: A member who was away reads every post of an author it never met, with only the helper
  online (test, local DHT).
- **SC-002**: With a dead helper listed, open + post + read take under 1 s on the test machine, as without.
- **SC-003**: Non-owners can't change the list (API and hand-written decision).
- **SC-004**: The helper's copy of a private space's post has no plaintext.
- **SC-005**: `npm run test:next` and `test:next:bare` pass; v1 `npm test` unchanged; SwarmFS unaffected
  (no API it uses changes).

## Assumptions

- Helpers are run by someone the owner trusts to stay up; they are a cache, not an archive (they evict
  whole old cores when full and never re-fetch them: `availability.md`).
- Each core goes to 2 of the listed helpers (blind-peering's default `pick`); every member picks the same.
- Joining still needs a member online (invites are answered by members); helpers keep content available,
  not admission.
- Listing logs adds one small decision per batch of new logs, only in spaces with helpers.
