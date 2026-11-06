# Feature Specification: Logs open only while used

**Feature Branch**: `017-logs-open-while-used`

**Created**: 2026-11-06

**Status**: Draft. Both design questions were answered by Tibo on 2026-11-06 (see "Decisions"). Ready for the plan.

**Input**: spec 016's US4 (T025-T028), which wasn't built. See `specs/016-open-spaces-at-scale/tasks.md`, the sections
"T024 inventory" and "Not built", and 016's SC-004.

Who the "user" is: a developer on `require('hypergraph/next')` who builds a forum, a chat or a site. Their users
open a big community, one with thousands of authors. Opening it, and keeping it open, must not cost more for
every author who ever wrote.

## The problem

A member keeps every log it holds open: one core per author. Measured in spec 016 and the scale audit, 100k logs
come to 1.8 GB of memory and a minute to start. Two things stand in the way of closing logs:

- **"Complete" needs peers' lengths.** `isComplete()`, `missing()` and the activity "covered from" rely on
  `unheard(log)`. That function reads each peer's length from the open core. Close the core, and this member
  can't tell whether a peer has more of that log. Spec 012 says reads never claim "complete" while records
  are missing.
- **Helpers get one open core per held log.** `Helpers.hold(log.core)` hands the core to blind-peering.

Everything else about closing a log is routine work: about 45 uses of `log.core` in 8 files
(016's T024 inventory).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A big space keeps few logs open (Priority: P1)

A member that has caught up on a space with thousands of logs keeps open only its own log and identity, the
decision log, the logs it is downloading, and the logs read in the last little while. Every other log is a
row in the index. Opening the space opens no held log. A log opens when it's needed, and closes again after
about 30 s unused.

**Why this priority**: it's the cost that grows with every author ever, for every full member: the forum
owner first.

**Independent Test**: a space with 2,000 logs (scripted), where everyone keeps everything. After catching up,
at most ~20 cores are open. After the space is reopened, still none of the held logs is open. A read of a
closed log's records returns them.

**Acceptance Scenarios**:

1. **Given** a member holding 2,000 logs, all caught up, **When** it sits idle for longer than the close delay, **Then**
   at most ~20 cores are open: its own log, its identity, the decision log and any downloads.
2. **Given** that member reopens the space, **When** it has opened, **Then** none of the held logs' cores is open, and
   `latest()`, `get()` and the forum's pages return the same records as before.
3. **Given** an app reads a closed log's record (content, an edit's history, a wiped entry), **When** it reads, **Then**
   the log opens for the read, and closes again after the delay.

---

### User Story 2 - "Complete" stays honest for closed logs (Priority: P1)

Peers already send each other a short summary of their log list (every 10 s, and when it changes). The summary
now covers each log's length as well as its key. When two summaries differ, the key-range exchange that settles
the log list also shows "this peer has more of log X". This member then opens that log, downloads and closes it
again. A closed log counts as heard only once a peer's summary agrees with this member's for that log. `isComplete()`,
`missing()` and "covered from" never answer "complete" while a peer it reached has blocks this member lacks.

**Why this priority**: "complete" that lies loses records silently (spec 012 FR-004). Closing logs must not bring
that back.

**Independent Test**: two members with 2,000 logs each, all closed. The author of one of them writes a record
while the reader is connected. The reader's `isComplete()` is false until the record has arrived, and true after.
The log is closed again after the delay. The same test holds when the record is written while the reader is
offline and they meet later.

**Acceptance Scenarios**:

1. **Given** a reader whose logs are all closed, **When** a peer has more blocks of one of them, **Then** the reader
   learns it within one summary period plus the range exchange, opens that log and downloads the blocks.
2. **Given** that difference isn't settled yet, **When** the app asks `isComplete()` or reads with `complete`,
   **Then** the answer is "not complete".
3. **Given** every peer's summary agrees with the reader's, **When** the app asks, **Then** the answer is "complete",
   with every log closed.
4. **Given** a peer on the older protocol, **When** they meet, **Then** they don't pair, and the space's status
   says a peer runs another version (as with /1 and /2 today).

---

### User Story 3 - Closed logs are still served and helped (Priority: P1)

A peer that asks for a log closed here still gets its blocks: a newcomer, another member, or a helper. A held
log is given to the space's helpers (spec 013) with the log open only for the hand-off. When it grows, it is
handed off again.

**Why this priority**: closing logs must not make a member useless to others, or make helpers stop mirroring.

**Independent Test**: a member holding a closed log, and a newcomer that needs it: the newcomer gets the blocks
from this member alone. A helper is set up, and the member holds 100 logs, all closed. The helper ends up mirroring
all 100. One of them grows, and the helper gets the new blocks.

**Acceptance Scenarios**:

1. **Given** a log closed here, **When** a peer asks for its blocks, **Then** they are served.
2. **Given** a space with a helper, **When** a held log is closed, **Then** the helper was asked to mirror it before
   the log closed. A test checks that the request was sent, not only that it was queued.
3. **Given** a held log that grows, **When** this member gets the new blocks, **Then** the helper is asked for the new
   length.

---

### Edge Cases

- A peer's summary claims a longer log than anyone can serve (a bug, or a lie). The log opens, and the length
  that counts is the one the opened log verifies. A claim that nobody serves within a time limit doesn't keep
  the reader "not complete" forever. Instead, the status tells the app which peer and which log.
- Many authors write at once. The summary then changes all the time. The range exchange must cost about what
  the differences are worth, not the whole list. Logs being written stay open, because they're in use.
- A log over its write limit or cut by a decision. The length in the summary is the length that counts for
  readers, so two members with the same decisions agree on it.
- A log whose fork changed (a truncation). The summary differs, the log opens, and the indexer handles it as today.
- The app closes the space while logs are opening or closing. Nothing is left open, and no read fails half-way.
- A budget pass (the app's storage share) needs sizes. They come from cached sizes, without opening every log.
- A member alone (a single device, nobody reached). "Complete" follows today's rule for a lone member.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A member MUST keep each held log's last known length and size without its core open. Status,
  inspection, budget passes and summaries MUST use these.
- **FR-002**: Opening a space MUST NOT open any held log's core except the member's own logs and the decision log.
- **FR-003**: A held log MUST open when one of these happens: a read needs its blocks, a peer's summary shows it
  behind, an activity entry shows new records, or a budget pass must cut it. It MUST close again after it has
  been unused for about 30 s.
- **FR-004**: The directory summary MUST cover each log's length as well as its key. The range exchange MUST
  report the logs a peer has more of.
- **FR-005**: A closed log MUST count as heard only when a reached peer's summary agrees with this member's on
  that log. `isComplete()`, `missing()` and "covered from" MUST NOT report complete while a reached peer has blocks
  this member lacks.
- **FR-006**: The space protocol's version MUST change. Peers of another version don't pair, and the status says so.
- **FR-007**: Blocks of a log closed here MUST be served to any peer allowed to read it.
- **FR-008**: Holding a log for helpers MUST send the mirror request before the log closes. It MUST send it again
  when the log grows.
- **FR-009**: Closing a space MUST close every log it opened, including ones mid-open.
- **FR-010**: No public API changes. The forum scenario tests MUST pass unchanged, or with changes only where a
  test inspected open cores.

### Key Entities

- **Held log entry**: a log this member keeps. Its key, its last known length and size, what it has indexed, and
  whether its core is open right now.
- **Summary**: what a member tells its peers about its log list. It now covers each log's length as well as
  its key.

## Success Criteria *(mandatory)*

### Measurable Outcomes

(Local DHT, this dev machine, Node and Bare.)

- **SC-001**: A member caught up on 2,000 logs keeps at most ~20 cores open when idle.
- **SC-002**: The time to open a space where this member holds every log is flat from 1k to 10k logs (perf `logs.held-start`, recorded
  `flat`).
- **SC-003**: A record written in a log closed at the reader arrives within a summary period (10 s) plus
  20 s while both are connected. The reader is never "complete" before it arrives.
- **SC-004**: Settling a one-log length difference between peers holding 10k logs costs about what settling a
  one-log list difference costs today (under 3 KB, spec 016 SC-005).
- **SC-005**: The forum scenario tests, the next suites (Node and Bare), SwarmFS's suite and the perf scenarios
  all pass.

## Out of scope (later)

- Making the indexer's own data structures smaller. This spec closes cores; it doesn't shrink rows.
- Keeping logs on disk only at helpers (cold storage).
- Old and new versions working together.

## Assumptions

- Corestore opens a core that is closed here when a peer asks for it, and serves it. That's `_attachMaybe`
  on discovery key, read in corestore's code on 2026-11-06, not tested yet.
- blind-peering's `addCore` sends the key and length once. Its "close" only forgets the core locally, and the
  helper keeps mirroring. Read in blind-peering's code on 2026-11-06, not tested yet.
- A closed log's length can change only through its author. Others learn of the change through summaries
  or activity entries.

## Decisions (Tibo, 2026-11-06)

1. **How "complete" is known for closed logs**: lengths go in the directory summary, and the existing range exchange
   finds the differences (FR-004, FR-005). Rejected: counting "complete" over open logs only, because it lies.
   Also rejected: using activity entries alone, because they carry where an hour starts in a log, not its length.
2. **Helpers**: open the log, hand it off, close it. Do it again when the log grows (FR-008). No change to blind-peering.
