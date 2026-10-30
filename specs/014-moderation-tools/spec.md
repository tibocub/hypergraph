# Feature Specification: Moderation tools (forum requests F10–F13)

**Feature Branch**: `014-moderation-tools`

**Created**: 2026-10-30

**Status**: Draft

**Input**: the forum example's requests F10–F13
(`E:\Code\P2P\hypergraph-forum-example\specs\requests-to-hypergraph.md`, "Found while building the third
round of to-dos"). The forum works around each in `public/lists.js`. F8 (sort by sums) and F9 (text
search) are out of scope.

Who the "user" is: a developer building a social app on `require('hypergraph/next')` (first: the forum),
and the people moderating and using it.

## The problem

A forum's moderators need four things the core doesn't give, so the forum does them by hand, slowly or
not safely:

- **F13** Only the owner and admins should set the forum's theme, but any member can write a `theme`
  record: the page filters by author's role and reads only the last 50.
- **F12** A member can't report a post to the moderators: flagging is a moderator's action, and a
  `report` record the app adds is readable by every member, so everyone sees who reported whom.
- **F10** Hidden and flagged records are left out of every list, and nothing lists them: the admin panel
  reads the last 200 decisions and checks each.
- **F11** Banning a spammer can drop what they wrote from one record on, on one device, in one space.
  The rest (other devices, the boards) takes one `remove` decision per record.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Only some roles may write a type (Priority: P1) — F13

A type says who may put it: `theme: { fields: {...}, put: { permission: 'decide' } }` (owner and admins)
or an app permission given by a role the app defines. A member without it gets `NOT_ALLOWED` when
putting one; a record of that type from a modified app by someone without it is shown by nobody.

**Independent Test**: a forum with `theme` restricted to `decide`: the owner and an admin put themes; a
member's `put('theme')` throws `NOT_ALLOWED`; a theme forged into the member's log (bypassing the check)
is in no list, count or `get` on any member.

**Acceptance Scenarios**:

1. **Given** a type with `put: { permission: 'decide' }`, **When** a plain member puts one, **Then** it
   throws `NOT_ALLOWED` naming the permission.
2. **Given** a member who writes one anyway (a modified app), **When** others read, **Then** it is in no
   `query`, `linked`, `count`, `sum` and `get` returns `record: null`.
3. **Given** an admin who put a theme, **When** the owner makes them a member, **Then** the themes they
   put before (up to what the owner held) stay, on every member, newcomers too; themes they put after
   count for nobody.
4. **Given** an app version that adds or changes `put` on an existing type, **When** it opens a folder
   of the older version, **Then** `INCOMPATIBLE_TYPES` (members must agree on who may write).

### User Story 2 - Members report to the moderators, privately (Priority: P1) — F12

Any member who may write reports a record: `forum.report(post, { reason: 'spam' })`. Only the moderators
(the owner, admins, moderators at that moment, on their devices that record decisions) can read what
was reported and why. Other members see that the reporter wrote something, never about what. A moderator
lists reports grouped by record, one per member (their latest), and dismisses one with
`moderateAction('remove', report)`.

**Chosen over a public per-member flag** (the request's other option): a flag counted per member must
name who flagged, and every member reads every record's author, so it can't be private. Sealed reports
keep the reporter and the reason away from other members; the cost is that a moderator appointed later
doesn't read the reports made before (they were sealed to the moderators of the moment).

**Independent Test**: owner, moderator, two members; member A reports a post twice and member B once;
the moderator's `reports()` gives that post with count 2 and A's latest reason; member B's `reports()`
throws `NOT_ALLOWED`; B reading A's report record gets nothing about the post or the reason.

**Acceptance Scenarios**:

1. **Given** a member, **When** they report a record, **Then** each moderator's `reports()` lists it with
   the reporter, the reason and the time, grouped by the reported record with a per-member count.
2. **Given** a member who isn't a moderator, **When** they call `reports()`, **Then** `NOT_ALLOWED`; and
   the report record's content is unreadable to them.
3. **Given** a moderator who dismisses a report (`moderateAction('remove', report)`), **Then** it is in no
   moderator's `reports()` any more.
4. **Given** a guest or a banned member, **When** they report, **Then** `NOT_ALLOWED` (only who may write).

### User Story 3 - List hidden or flagged records however old (Priority: P1) — F10

`forum.query('post').moderated('hidden').latest(20)` lists the hidden posts, newest first, paged with
`{ after }`, however old; `'flagged'` the flagged ones. Other filters combine (`by`, `on`).

**Independent Test**: 300 posts, the 5 oldest hidden and 3 flagged, one hidden then revealed; the lists
give exactly those, newest first, the revealed one not in `hidden`.

**Acceptance Scenarios**:

1. **Given** hidden records of a type, **When** a member lists `moderated('hidden')`, **Then** all of
   them, however old, newest first, with `hidden: true`.
2. **Given** a record revealed again, **Then** it isn't in the hidden list. A removed record is in none.
3. **Given** a sub-space (board), **Then** its own moderation is listed in it.

### User Story 4 - Ban and drop everything they wrote (Priority: P1) — F11

`forum.moderateAction('ban', spammer, { drop: 'all' })`: one decision; everything the spammer wrote,
on every device, in the forum and every board (sub-space), counts for nobody, newcomers included. It
also works on someone already banned (the forum banned first, then decides to drop).

**Independent Test**: a member with two devices posts, comments and votes in the forum and in a board;
the owner bans with `drop: 'all'`; every list, count and sum on the other members and on a newcomer no
longer includes any of it; one decision in `decisions()`.

**Acceptance Scenarios**:

1. **Given** a member's records on two devices, in the space and a sub-space, **When** banned with
   `drop: 'all'`, **Then** none of them shows on any member, nor on a member joining later.
2. **Given** someone banned before, **When** a moderator bans again with `drop: 'all'`, **Then** their
   kept records go too.
3. **Given** a ban `drop: 'all'` lifted (`unban`) and the person let back in, **Then** they write again
   (a new log); what was dropped stays dropped.

### Edge Cases

- Reports when the space has no moderator device known yet but the owner's: sealed to the owner.
- A report of a record of another space, or of nothing: `NOT_FOUND`-free (the id is only sealed); a
  moderator sees it with whatever `get` gives.
- `put: { permission }` in a sub-space: roles there count (their parent's, or their own).
- A demoted admin's themes: kept up to the cut, like shared edits. A removed or banned editor's earlier
  edits and themes: kept up to the cut too (today they vanish, a bug this fixes), unless `drop: 'all'`.
- `moderated()` with a value other than `'hidden'`/`'flagged'`: `TypeError`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001** A type declaration accepts `put: { permission: name }`; default: anyone who may write.
  Hypergraph's own permissions are accepted (`'decide'`: owner and admins, `'moderate'`: moderators up).
- **FR-002** `put` of a restricted type by someone whose role lacks the permission throws `NOT_ALLOWED`
  (after the usual catch-up with decision writers).
- **FR-003** Every read (`query`, `linked`, `count`, `sum`, `get`) leaves out a restricted record whose
  author lacked the permission, judged like shared edits: below the cut recorded when they lost it,
  everything while they hold it.
- **FR-004** Losing a permission by a role change, a removal or a ban records the cut of every
  permission lost, hypergraph's own included (shared edits and restricted puts keep what was held).
- **FR-005** Changing `put` between app versions throws `INCOMPATIBLE_TYPES`.
- **FR-006** `space.report(record, { reason })` (who may write; not the personal space) writes a record
  whose target and reason only the moderators' devices of the moment can open.
- **FR-007** `space.reports()` (who may moderate) returns the reports this device opens, grouped by
  reported record: `[{ on, count, reports: [{ id, by, reason, stamp }] }]`, one per member per record
  (their latest), groups newest first; others: `NOT_ALLOWED`.
- **FR-008** A report removed by a moderator (`moderateAction('remove', report)`) leaves `reports()`.
- **FR-009** `query(type).moderated('hidden' | 'flagged')` lists the records of that type in that state,
  however old, newest first, paged by `{ after }`, combining with the other filters.
- **FR-010** `moderateAction('ban', someone, { drop: 'all' })` makes everything they wrote count for
  nobody, every device, the space and the sub-spaces below, in one decision, also if already banned.
- **FR-011** All of the above work on Node and Bare.

### Apply-time and wire changes (every peer updates together)

- `drop: 'all'` is a new trailing field of the `moderate` decision. An older peer reads the ban but not
  the drop: it keeps records the new peers drop. **Every member updates together.**
- Cuts of lost permissions on removal and ban (FR-004) change what counts: an older peer drops what a
  newer one keeps. **Every member updates together.**
- `put: { permission }` is the app's type declaration: all members of an app run the same types (FR-005).
- `hg/report` is a new built-in type: an older peer keeps it as an unknown type, shown nowhere. Safe.
- `moderated()` and `reports()` are reads: no wire change.

### Key Entities

- **Report**: who reported (its author), the reported record, a reason, when; readable by the
  moderators' devices of the moment only.
- **Moderation state of a record**: hidden, flagged, removed (decision state, unchanged).
- **Permission cut**: per person and permission, how much of each of their logs keeps counting.

## Success Criteria *(mandatory)*

- **SC-001** The forum drops its four workarounds (`public/lists.js` shortcut comments F10–F13) and uses
  one call for each.
- **SC-002** A ban with `drop: 'all'` is one decision whatever the person wrote (measured: 1 entry in
  `decisions()` for a member with records in 2 spaces on 2 devices).
- **SC-003** The hidden list of a 300-record type returns all hidden records, whatever their age.
- **SC-004** No member who isn't a moderator can learn a report's target or reason from what they hold.
- **SC-005** The forum scenario tests cover each of the four flows through the public API.

## Assumptions

- Moderators' devices are the decision-log writer devices of members who may moderate (they claim a
  writer key); a moderator's device that hasn't claimed one yet doesn't read reports sealed meanwhile.
- A report's reason is short (up to 1,000 characters).
- Reports are not deduplicated across devices of one member beyond "their latest per record".
