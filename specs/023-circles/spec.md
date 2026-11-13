# Spec 023: circles, people keeping each other's places online

**Created**: 2026-11-13 · **Asked by**: HyperBrowser 018, later HyperDNS and SwarmFS (grilled with Tibo, 2026-11-13;
ROADMAP decisions 2026-11-11 and 2026-11-13) · **Status**: draft

Two phones are almost never online at once, so a private conversation dies when its people are offline. A circle is a
group of people (about 50, invited) whose devices keep each other's places: they hold a copy and serve it to anyone
in those places, encrypted for private ones (spec 022), so holders never read it. One mechanism for every app:
HyperBrowser now; an HyperDNS authority kept online by a circle later; SwarmFS later. "User" here: a developer
calling the API.

## Requirements

**A circle**

- **FR-001** `hg.createCircle({ name })` makes a circle: a private space (spec 022: encrypted on disk) marked as a
  circle when created, never after. `space.circle` is `true` for it.
- **FR-002** Only the owner and admins invite and remove (existing invites and `setRole`); others get `NOT_ALLOWED`.
  At most 50 members: a 51st redemption is refused with `CIRCLE_FULL`. Leaving is `hg.leaveSpace` as for any space;
  the owner may leave like a forum's owner.
- **FR-003** A person may be in several circles. Each circle holds everything of each member (FR-005).

**Holding** (per device)

- **FR-004** `hg.setHolding({ on, bytes })`: whether this device holds for its circles, and how much. Off until set;
  `bytes` defaults to 1 GB, one share for all of this device's circles together (not per circle). Each of a
  person's devices where it's on holds, with its own share. `hg.holding()` returns `{ on, bytes, used }`.
- **FR-005** What a member hands to holders: every space in their personal space's list (joined or created, sub-spaces
  included), private ones first, then the rest. Closed spaces too (spec 017 closes unused ones): handing must not
  need the space open. Grown logs are handed again, as helpers do (spec 013).
- **FR-006** Each holder keeps at most 200 MB per member. Past the device's share, or a member's 200 MB, the data with
  the oldest activity goes first.
- **FR-007** Holders are found by anyone in a held place, circle member or not (an outsider in a member's
  conversation reads it while all its members are offline), without changing that place's settings or helpers
  list. Known and accepted: anyone knowing a held place's key sees that some IP holds it (as for its members).
- **FR-008** A holder never has the disk key or content keys of a private place it holds (spec 022, FR-008).

**Leaving and removal**

- **FR-009** When I leave a circle, or am removed, my devices delete at once what they held for it, except what
  another of my circles still covers (a member of both).
- **FR-010** When a member leaves or is removed, every holder deletes that member's data at once, under the same
  exception. The removed member's devices stop handing to that circle.

**What apps show** (HyperBrowser 018)

- **FR-011** `circle.status()` returns `{ members, holders, keptBy }`: member count, how many members have a device
  holding, and how many of them hold my latest data (for "kept by N of M members").

## Not covered (decided)

Federation (trusting another HyperDNS authority's names) stays separate. Helper machines joining a circle like a
person: the helper spec, next. Smarter spreading than "everyone holds everything up to their cap": once measured.
SwarmFS files: their own spec (stored files aren't encrypted yet). Background holding and phones on Wi-Fi only:
HyperBrowser's settings, calling `setHolding`. The 200 MB per member is enforced by the sender (shortcut, FR-006):
circle members are invited, so a device ignoring it is out of scope until helpers serve strangers.

## Tests

`test/next/net/circles.js`: create, invite by owner and admin only, 51st refused; A and B in a circle with holding on,
C an outsider in a private conversation with A; A and B offline, C reads A's latest messages from B's device; a
closed space is handed; per-member and share caps drop oldest first; leave and removal delete at once, kept when
another circle covers it; `status()`. `test/next/unit/circles.js` for the order and caps logic. Forum scenario: a
private board kept while its members are offline. `perf/scenarios/`: handing 20 spaces, and a holder's start time
with 1 GB held.
