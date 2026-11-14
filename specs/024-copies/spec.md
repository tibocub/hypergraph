# Spec 024: a fixed number of copies, rarest first, and online numbers

**Created**: 2026-11-14 · **Asked by**: lead review of 023, grilled with Tibo (2026-11-14) · **Status**: built (branch 024-copies)

Spec 023 hands every space of a member to every holding device of their circles: in a full circle 49 copies, the
sender uploads each one, and every holder drops the same oldest spaces together when its share is full. 024 keeps a
fixed number of copies, spread by a hash so all devices agree with no coordination, hands the rarest first, and
starts tracking who is online, for a later algorithm that picks the holders online most (Tibo: something that works
well with no configuration, fine-tuned by hand if wanted). "User" here: a developer calling the API.

## Requirements

**How many copies, where**

- **FR-001** Each space a member hands is kept in **5 copies in total**, split as evenly as possible across the
  member's circles, at least 1 per circle (1 circle: 5; 2: 3+2; 3: 2+2+1; 5 or more: 1 each). Which circle gets the
  larger part: a hash of the space and circle keys, so it changes from space to space. A circle with fewer holders than
  its part (or whose people are already holders through another circle): the rest go to the member's other
  circles, their next ranked holders (same order, one device per person), up to 5 in all (one per circle past 5).
- **FR-002** The holders of a space in a circle: its holding devices ranked by a hash of (space key, device key)
  (rendezvous hashing), the top ones, at most one device per person. Whole spaces, never part of one (023 drops whole
  spaces).
- **FR-003** Leaving a circle, or a holder leaving or being removed: the next ranked holders take over at once, in
  that circle and, for FR-001's split, in the others.

**Rarest first**

- **FR-004** Each device tracks, for every space it hands, how many of its copies are online now, and hands (and
  replaces) the spaces with the fewest first.
- **FR-005** A space with **0 copies online** while its member is online gets one extra copy at once, on the next
  ranked online holder; it is dropped from there once 2 of the regular copies are online again.
- **FR-006** A holder unseen for **7 days** is replaced by the next ranked one. When it is seen again it is told to
  delete what it held for that member (blind-peer's `delete-core`), unless it is a regular holder again by then.

**Online numbers** (recorded only; nothing picks holders by them yet)

- **FR-007** Observed: each device records, per holder device of its circles, the hours it saw it online over the
  last 30 days. Kept on the device only, deleted with the circle.
- **FR-008** Self-reported: each holding device writes its own online share (percent of hours over 30 days, whole
  numbers) in its `hg/holder` record, at most once a day.

**What apps show**

- **FR-009** `hg.copiesOf(spaceKey)` → `{ wanted, kept, online }` for a space of this person's: copies wanted
  (FR-001), holders that have its latest data, how many of those are online now. HyperBrowser 018 shows "kept by N of
  5 copies" and warns under 2 online. A circle's `status()` keeps `members` and `holders`; `keptBy` goes.
- **FR-010** Docs (and HyperBrowser 018's join notice): holders can't read private spaces but see how many a member
  hands, their sizes and when they change.

## Not covered (decided)

Picking holders by how often they are online (FR-007/008 feed it later), checking self-reported numbers against the
observed ones, manual fine-tuning: a later spec once measured. 5 is fixed, not a setting.

## Tests

`test/next/unit/copies.js`: the split (FR-001 table), ranking stable and one device per person (FR-002), rarest order,
7-day replacement with a fake clock. `test/next/net/copies.js`: a circle of 8 with holding on, each space lands on
exactly 5 holders; 2 circles split 3+2; a holder leaves, the next takes over; all copies offline, one extra copy, then
dropped; a replaced holder deletes when seen again; `copiesOf()`. Forum scenario: a private board in a circle of 8 has
5 copies. `perf/scenarios/circles.mjs`: bytes uploaded by the sender for one space, circle of 8 (about 5× its size,
was 7×), and a holder's share use.
