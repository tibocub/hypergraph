# Feature Specification: Honest reads and change signals

**Feature Branch**: `012-honest-reads`

**Created**: 2026-10-29

**Status**: Draft (waiting for the lead's review)

**Input**: User description: "Honest reads and change signals for hypergraph/next: reads answer at once
from what is held (with complete), waiting is opt-in per read; every read has a change event (spaces incl.
name H12, members, devices, settings, status incl. complete); change carries which records changed with
deleted + stamp (H14, H15, H16); get() tells deleted from not held. Breaking change of the new core;
SwarmFS and forum scenario tests migrate."

Who the "user" is: a developer building an app on `require('hypergraph/next')` (spec 011), and the people
using that app. Two consumers prove it: SwarmFS (`E:\Code\P2P\SwarmFS`, its requests file
`specs/requests-to-hypergraph.md`) and the forum scenario tests (`test/next/forum/`, CLAUDE.md rule 3).
HyperBBS and hyperDNS use v1 (`src/`) and are not affected.

## The problem: one root, patched five times

State arrives later than the app asks for it, and two things go wrong:

1. **Reads wait.** Every read waits up to `readTimeout` (5 s by default) while it knows of something it
   doesn't hold yet. With one member offline, *every* read is incomplete, so every read waits the whole
   5 s. `docs/next/deleting-and-incomplete.md` tells apps "show the answer, don't block", but the default
   blocks.
2. **Nothing tells the app when the rest arrives**, or the signal is too vague to act on.

Each case got its own patch, and more are open:

| Request | What happened | Patch / status |
|---|---|---|
| H2 | a space joined on another device appeared with no event | `hg.on('spaces')` added |
| H10 | reads of this device's own records waited 5 s | own-device reads special-cased |
| H11 | (docs) swarmwire example | fixed in docs |
| H12 | `'spaces'` fires while a joined space's name is `''`, never again when the name arrives | open: the CLI waits 15 s |
| H14 | `change` names types, not records: SwarmFS re-reads 10,000 entries (~3.8 s) per change | open |
| H15 | `get()` returns `record: null` for "deleted" and "not here yet" alike; no delete stamp | open |
| H16 | no `change` on the other device for an edit (rename, move, new content) | open: SwarmFS listens to `'logs'` |

SwarmFS works around them with `{ timeout: 200 }` on its reads (`LOCAL` in `lib/holdings.js`,
`lib/sync.js`), a `'logs'` listener (`lib/swarmfs.js`), and a 15 s wait for a name (`bin/swarmfs.js`).
The forum scenario tests drop `complete` everywhere (`test/next/forum/forum.js` returns `.items`), so the
"honest" UI path has never been tested there.

This spec fixes the root as two rules, once:

- **Rule 1 — reads answer at once** from what this device holds, with `complete` saying whether
  something known is missing. Waiting is something a read asks for.
- **Rule 2 — everything a read returns has a change signal.** When the answer of a read may differ, an
  event says so; `change` says which records.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reads answer at once (Priority: P1)

A developer shows a forum's latest posts, or SwarmFS lists a folder, while another member (or the
person's other device) is offline. The read answers immediately with what this device holds and
`complete: false`; the app shows it with a quiet "still syncing" hint. A script or one-shot CLI command
that wants to wait asks for it on that read (`{ timeout: ms }`): the read then answers as soon as it is
complete, or when the time is up.

**Why this priority**: it is the default behaviour of every read; every app hits it on its first screen
with a peer offline. It removes H10's special case and SwarmFS's `{ timeout: 200 }`.

**Independent Test**: open a forum whose only other member is offline; every read (query, get, linked,
count, sum, tags, edges, getByTag) answers in under 50 ms with `complete: false`; the same read
with `{ timeout: 2000 }` waits about 2 s, and answers early once the member comes back and the answer is
complete.

**Acceptance Scenarios**:

1. **Given** a member whose peer holding newer posts is offline, **When** it reads `query('post').latest(20)`,
   **Then** the answer comes at once with the posts it holds and `complete: false`.
2. **Given** the same member, **When** it reads with `{ timeout: 3000 }` and the peer connects after 1 s,
   **Then** the read answers once the missing posts are held (about 1 s), complete.
3. **Given** a newcomer to a big space (newest-first reading, spec 011 story 9), **When** it reads the
   first page at once, **Then** it gets what it holds now (possibly nothing) with `complete: false`, and
   the reading of that page goes on in the background; the records arriving fire `change`.
4. **Given** a record whose content was dropped here for the budget (spec 011 story 6), **When** it is
   read at once, **Then** it is left out (`complete: false`), its content is fetched in the background,
   and `change` names it once it is back.
5. **Given** a member writing (`put`, `edit`, `del`, a role or moderation call) that is refused,
   **When** a decision allowing it was made a moment ago elsewhere, **Then** the write still first catches
   up with the connected decision recorders (as today) before refusing: writes keep their own bound.

---

### User Story 2 - `change` says which records changed, edits included (Priority: P1)

SwarmFS keeps a linked folder in step with its space. A file renamed, moved or rewritten on the PC
reaches the phone; the phone's `change` event names that record (its id and type), so SwarmFS re-reads
one entry instead of 10,000. A forum's live thread learns which comment was edited or deleted.

**Why this priority**: H16 is a bug (an edit is a change but no event comes) and H14 is the cost of
re-reading everything; both block SwarmFS spec 002 ("always on") from being cheap and correct.

**Independent Test**: two devices; on the PC put, edit, then delete a record; on the phone each step
fires one or more `change` events whose `records` contain that id, with `deleted` set only for the delete.

**Acceptance Scenarios**:

1. **Given** two devices sharing a space, **When** the PC edits a record, **Then** the phone's `change`
   lists `{ id, type, deleted: null }` for it once the phone shows the edit (H16).
2. **Given** the same, **When** the PC deletes the record, **Then** the phone's `change` lists it with
   `deleted: { by: 'author', stamp, device }` (the delete's stamp and the device that wrote it).
3. **Given** a moderator takes a record down (or bans an author `from` a record), **When** the decision
   applies, **Then** `change` lists each record that went with `deleted: { by: 'space' }`.
4. **Given** a moderator hides or reveals a record, **When** it applies, **Then** `change` lists it
   (`deleted: null`; `get()` shows `hidden`).
5. **Given** an edit or delete made on this same device, **Then** this device's `change` lists it too.
6. **Given** an edit by someone not allowed to edit (ignored by every member), **Then** no `change`
   lists it.

---

### User Story 3 - Deleted, or not here yet (Priority: P2)

SwarmFS must not take "not here yet" as "deleted" (an offline device's files would vanish), and must
settle "edited on one device, deleted on the other": keep the edit if it is newer than the delete. A
forum shows "this post was deleted" instead of an empty page.

**Why this priority**: H15; it changes SwarmFS's correctness in a rare case and a forum's wording. Not on
the first screen, so after stories 1 and 2.

**Independent Test**: on a member holding a record's delete, `get(id)` returns `record: null` with
`deleted: { by: 'author', stamp, device }`; for an id it never heard of, `deleted: null`.

**Acceptance Scenarios**:

1. **Given** a record deleted by its author, **When** a member holding the delete calls `get(id)`,
   **Then** it gets `{ record: null, deleted: { by: 'author', stamp, device }, complete }`.
2. **Given** a record taken down by a moderator, **Then** `get(id)` gives `deleted: { by: 'space' }`.
3. **Given** an id this member doesn't hold and holds no delete for, **Then** `get(id)` gives
   `{ record: null, deleted: null, complete }` — `complete: false` if something known is missing.
4. **Given** a "delete" written by someone who isn't the record's author (a modified app), **Then** it
   is not reported as `deleted`.
5. **Given** a held record, **Then** `get(id)` gives `deleted: null` with the record.

---

### User Story 4 - Every other read has its event (Priority: P2)

On a newly paired phone, SwarmFS's CLI finds a space by name right after `join`; today `'spaces'` fires
with `name: ''` and never again (H12). An app's members page, devices page, settings and "still syncing"
hint all need to know when to re-read.

**Why this priority**: H12 costs the CLI 15 s; the rest is the same rule applied to every read, so no app
meets the next H12.

**Independent Test**: for each row of the read → event table (FR-010), change the thing on another
device and see the event fire on this one.

**Acceptance Scenarios**:

1. **Given** a phone paired after a space was named, **When** the space's name arrives on the phone,
   **Then** `'spaces'` fires again with the name (H12 repro: no 15 s wait).
2. **Given** a space renamed, or a sub-space created, **Then** `'spaces'` fires on every member.
3. **Given** a role given, a member removed or banned, or a member's new device log arriving, **Then**
   that space's `'members'` fires.
4. **Given** a new decision of any kind applied, **Then** `'decisions'` fires.
5. **Given** a device added or removed on the account, **Then** `'devices'` fires on every device; a
   setting changed on one device fires `'settings'` on the others.
6. **Given** a space whose answers were incomplete, **When** everything known becomes held (a member
   came back, a key arrived), **Then** `'status'` fires with `complete: true` (and `access` when it
   changes), and a live query whose last answer was incomplete runs again.

---

### User Story 5 - The forum tests use the honest path (Priority: P2)

CLAUDE.md rule 3: the forum scenario tests prove the API is easy. Its lists show `complete` and follow
live updates, so "show the answer, then update it" is written and tested the way an app would write it.

**Why this priority**: required in the same change as the API change; also the check that Rules 1 and 2
are pleasant to write against.

**Independent Test**: a newcomer joins a forum; its latest-posts list renders at once (`complete: false`),
then updates by itself to the full page with `complete: true`, with no polling and no `eventually` in the
app code (only in the test's assertion).

**Acceptance Scenarios**:

1. **Given** the forum helpers (`test/next/forum/forum.js`), **Then** each list helper returns what the
   app needs to show the hint (`complete`), and the live helpers cover posts, a thread, members, forums.
2. **Given** a newcomer, **When** it opens the forum, **Then** its live list first shows what it holds
   with `complete: false`, then the full page with `complete: true`.
3. **Given** a member with the other members offline, **Then** its lists answer at once, incomplete, and
   say so.
4. **Given** a post edited or deleted elsewhere, **Then** a live thread updates without re-reading by hand.

---

### Edge Cases

- **Restart**: events aren't kept while the app is closed. The app reads once after opening (as it does
  today) and follows events from then on; listen first, then read, so nothing falls between. A changes
  feed that survives restarts is out of scope (see Decisions).
- **Events during a read**: a record indexed while a read runs fires `change` after it; the read may or
  may not include it. An app re-reading on `change` always ends on the latest answer.
- **More events than changes**: an event may fire when the answer didn't actually change (e.g.
  `'members'` on a decision that changed no member). Never the opposite: a change without its event is a
  bug.
- **Large batches**: a sync of thousands of records gives `change` events listing thousands of ids
  (one event per indexing batch, as today); apps handle a long list.
- **Offline partition**: reads on each side answer at once with what each holds; once healed, `change`
  lists what came in; `'status'` turns `complete` back to true.
- **Concurrent edit and delete**: the delete still wins (spec 011's rule, unchanged); `deleted.stamp`
  lets an app like SwarmFS decide to re-add its newer edit as a new record. Hypergraph doesn't resurrect.
- **Adversarial peers**: a delete or edit that doesn't count (wrong author, not allowed) is never listed
  in `change` nor reported by `get().deleted`. A peer can't make another member's app see a deletion.
- **Private space, key not here yet** (`access: 'waiting'`): reads answer at once with
  `complete: false`; `'status'` fires when `access` turns `'full'`; then `change` lists the records
  opened. Today these reads wait 5 s each.
- **Not for me** (`access: 'none'`): unchanged, reads answer at once with `access: 'none'`.
- **Own records** (H10): no special case left; reads of own records answer at once like every read and
  are `complete` once this device's own logs are indexed (unchanged meaning).
- **Closed app**: a read after `close()` still throws `CLOSED`; no events after `close()`.

## Requirements *(mandatory)*

### Functional Requirements

**Rule 1 — reads answer at once**

- **FR-001**: Every read (`get`, `query(...).latest`, `linked`, `count`, `sum`, `tags`, `edges`,
  `getByTag`, and the personal space's reads) MUST answer from what this device holds without waiting,
  unless the read is given `{ timeout: ms }`. (`decisions()` already answers at once: the decision log
  is held whole.)
- **FR-002**: A read given `{ timeout: ms }` MUST wait while its answer is incomplete, up to `ms`, and
  answer as soon as it is complete (today's behaviour, now opt-in).
- **FR-003**: A read answering at once MUST still start the work its answer needs (fetch dropped content,
  widen a big space's reading, look at another member's list of logs), and what that work brings MUST
  fire the events of Rule 2.
- **FR-004**: The open option `readTimeout` MUST be removed. Writes, refusals and other internal waits
  that used it (catching up with decision recorders before refusing, waiting for a private space's key
  before writing, refilling dropped content) MUST keep a fixed internal bound of 5 s (today's default).
- **FR-005**: Live queries MUST run at once with what is held, run again when records of their type
  change, and run again when their last answer was incomplete and it may have become complete.
- **FR-006**: `complete` keeps spec 011's meaning, unchanged.

**Rule 2 — change signals**

- **FR-007**: `space.on('change', ({ types, records }))` MUST list every record whose answer changed:
  `records: [{ id, type, deleted }]`, where `deleted` is `null`, `{ by: 'author', stamp, device }`
  (deleted by its author: the delete's stamp and the device that wrote it), or `{ by: 'space' }` (gone
  by the space's decisions or rules: a moderator's take-down, a ban `from` it, a cut, a write limit). `types` stays (the distinct types of `records`).
- **FR-008**: An edit that becomes a record's latest version MUST fire `change` listing it, on every
  member, for edits made on this device and on others (H16).
- **FR-009**: A record restored after its content was fetched back, a record hidden, revealed or
  flagged, a record taken down, a record of a member cut by a ban `from`, and a record refused or
  brought back by a write limit change MUST be listed in `change`.
- **FR-010**: Every read of the public API MUST have an event that fires when its answer may differ, as
  this table, documented in `docs/next/api.md`:

  | Read | Event |
  |---|---|
  | records: `get`, `query`, `linked`, `count`, `sum`, `tags`, `edges`, `getByTag` | `space 'change'` |
  | `hg.spaces()`, `space.subspaces()`, `space.name`, `space.parent` | `hg 'spaces'` |
  | `space.members()`, `getRole()`, `roles()` | `space 'members'` (new) |
  | `space.decisions()`, `redemptions()`, `space.history` | `space 'decisions'` (new) |
  | `space.status()` (policy, access, held, heldFrom, belowPolicy, budget, warnings, settlers, `complete`) | `space 'status'` |
  | `space.peers()` | `space 'peers'` |
  | `space.memberConnections()` | `'member-connection'` / `'member-disconnection'` |
  | `hg.devices()` | `hg 'devices'` (new) |
  | `hg.settings()` | `hg 'settings'` (new) |
  | `space.inspect()` | `space 'logs'` (diagnostics) |

  An event passes the read's value when that read is sync (`'spaces'`, `'status'`, `'peers'`, as today);
  for async reads (`members()`, `devices()`, `settings()`, `decisions()`) it passes nothing: read again.
  Not covered, said so in the docs: `hg.storage()` and `status().stored` / `share` (estimates, read when
  needed), `hg.types()` (fixed at open).
- **FR-011**: `'spaces'` MUST fire again when anything `spaces()` returns changes for a listed space
  (its name arriving, H12), not only when a space is added or left.
- **FR-012**: `status()` MUST include `complete` (everything this device knows of in the space is held),
  and `'status'` MUST fire when it or `settlers` changes.
- **FR-013**: An event MAY fire when nothing a read returns changed; a change without its event is a bug.
- **FR-014**: No event fires after `close()`.

**Deleted, or not here**

- **FR-015**: `get(id)` MUST return `{ record, complete, deleted }` with `deleted` as in FR-007 when
  this device holds a delete that counts for `id` (`by: 'author'`) or it was taken down (`by: 'space'`),
  and `null` otherwise (H15). A record left out by a write limit is `null` in `get()` (nothing kept says
  why), though `change` reported it with `by: 'space'` when it went.
- **FR-016**: A delete that doesn't count (not its author, or of a record whose log isn't known here so
  its author can't be checked) MUST NOT be reported as `deleted`.

**Consumers and docs**

- **FR-017**: `docs/next/api.md`, `docs/next/concepts.md` ("Complete answers"),
  `docs/next/deleting-and-incomplete.md` and `specs/011-spaces-core/contracts/api.md` MUST say Rules 1
  and 2 and the table of FR-010, in the same change.
- **FR-018**: The forum scenario tests MUST show `complete` in their list helpers and follow live updates
  for posts, a thread, members and forums; a test MUST play a newcomer's honest path (User Story 5).
- **FR-019**: `CHANGELOG.md` MUST have one dated entry: what breaks for `hypergraph/next` users and the
  migration, linking here.
- **FR-020**: SwarmFS's requests file MUST be answered (H12, H14, H15, H16: done, with what to change),
  listing the shortcuts SwarmFS can delete (see "What changes for each consumer").

### Key Entities

- **Change entry**: `{ id, type, deleted }` — one record whose answer changed; `deleted` null, or how it
  went (`by: 'author'` with stamp and device, or `by: 'space'`).
- **Read → event table**: the public contract of FR-010; every new read added later adds a row.

## What changes for each consumer

**SwarmFS** (`E:\Code\P2P\SwarmFS`, depends on this working tree):

- `lib/holdings.js` `LOCAL = { timeout: 200 }` and `lib/sync.js` `LOCAL = { timeout: 200 }`: delete
  them and their uses; reads answer at once. With `LOCAL` kept, reads would wait up to 200 ms each again
  while a device is offline.
- `lib/swarmfs.js` `_listen`: delete `space.on('logs', changed)` and its `shortcut:` comment (H16 fixed).
- `lib/swarmfs.js` / `lib/sync.js`: on `change`, re-read only the entries in `records` (the H14 win);
  the full read stays at open and after a linked folder is resumed.
- `lib/sync.js`: use `get(id).deleted.stamp` for "edited here, deleted there" (H15) if SwarmFS wants
  to keep a newer edit; otherwise unchanged.
- `bin/swarmfs.js` `drive()`: unchanged code, but `until(sfs, 'spaces', find)` now resolves when the
  name arrives (H12: about 0.2 s instead of 15 s).
- `bin/swarmfs.js` one-shot `ls` (and any one-shot read after `online()`): pass `{ timeout: WAIT }` if
  it should wait for the other device's records; without it, it prints what is held and its
  "(incomplete…)" line at once.
- `SwarmFS.open(..., { readTimeout })`: the option no longer does anything; remove it.
- The `requests-to-hypergraph.md` entries H12, H14, H15, H16 become done.

**Forum scenario tests** (`test/next/forum/`): list helpers return `complete`; live helpers added;
tests that relied on a read's implicit 5 s wait for another member's record use `eventually` or
`{ timeout }`; `test/next/helpers.js` stops passing `readTimeout`; a newcomer honest-path test added.

**Other `test/next/` tests, `bench/next/`, `tools/inspector`**: drop `readTimeout`; reads that need to
wait pass `{ timeout }`; the inspector already reads with `timeout: 0` (now the default).

**HyperBBS, hyperDNS**: v1 (`src/`), not affected. **HyperBrowser**: not started; gets this API.

## Decisions taken here (for the lead's review)

- **Keep the per-read option name `timeout`, default 0** — not rename it `wait`. Same meaning as today
  ("wait at most this long for a complete answer"), no churn for SwarmFS or the inspector, and passing
  `timeout` already reads as opt-in. Rejected: `{ wait }` (a rename for every caller, no new meaning).
- **Remove `readTimeout`**, don't keep it as an app-wide default: one way to wait (per read) keeps
  Rule 1 a rule; an app-wide wait would bring back blocking first screens. Internal write bounds keep
  5 s as a constant (FR-004).
- **Record ids in the `change` event, not a changes feed with a cursor.** Serves both consumers: a
  forum's live list and SwarmFS's running sync. A feed would need a new index table written on every
  change and kept or pruned; its only gain is surviving restarts, and both consumers already do a full
  read at open. Revisit if a consumer measures the open read as too slow.
- **`deleted` is `{ by: 'author', stamp, device }` or `{ by: 'space' }`**, the same shape in `change`
  and `get()`: an app drops the record from its lists either way; only an author's delete has a stamp
  to compare with an edit.
  Delete-wins stays (no merge rule changes; Principle I).
- **`'spaces'` fires on any change to what it lists**, rather than "list a space only once its name is
  known" (H12's second option): hiding a space we hold would be its own surprise.
- **Two new space events, `'members'` and `'decisions'`, and two new hg events, `'devices'` and
  `'settings'`**, rather than one catch-all: an app re-reads only the page it shows. Extra events are
  allowed (FR-013), so each can fire coarsely (e.g. on every decision applied).
- **`status().complete`** gives a whole-space "all here" signal (SwarmFS acts on removals only when
  complete) without polling; page-level completeness stays on the read.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With every other member offline, a read of a 1,000-record space answers in under 50 ms
  (today: 5 s), with `complete: false`.
- **SC-002**: For a put, an edit and a delete on one device, the other device's `change` names the record
  in every case (3 of 3; today 2 of 3), within 1 s of the other device showing it.
- **SC-003**: The H12 repro shows `'spaces'` with the space's name within 1 s of the name arriving (today:
  never; the CLI waits 15 s).
- **SC-004**: Every row of the FR-010 table has a test that changes the thing on one device and sees the
  event on the other (or on the same device, for local-only reads).
- **SC-005**: A forum newcomer's live latest-posts list goes from its first answer to a complete page with
  no app-side polling, in the forum scenario tests.
- **SC-006**: No test in `test/next/` passes `readTimeout`; the next suite's wall time doesn't grow
  (reads that waited 5 s for nothing now don't).
- **SC-007**: After migrating, SwarmFS follows one remote rename in a 10,000-file linked folder by
  re-reading one entry (today: ~3.8 s for 200 pages), measured in SwarmFS's own test (SwarmFS's session
  owns this; this repo hands it over through the requests file).

## Assumptions

- SwarmFS and the forum tests are the only users of `hypergraph/next` (v1 consumers untouched);
  HyperBrowser hasn't started. A breaking change is fine (Principle V) with a CHANGELOG entry.
- Another worker is fixing H17 in `lib/` right now; this spec's implementation starts after that lands
  (both touch `lib/space.js`).
- Apps already re-read once at open; events are for while the app runs.
- 5 s stays a fine bound for writes' internal catch-up (no request says otherwise).
