# Feature Specification: One engine for many sites

**Feature Branch**: `015-one-engine`

**Created**: 2026-11-01

**Status**: Draft, open questions answered by Tibo 2026-11-02 (see "Decisions"); code waits for
`decisions-in-place` to merge and for the forum trial to end

**Input**: HyperBrowser milestone 0 (`ROADMAP.md`, "The final app: HyperBrowser"; "Now" items 9–10), scale
audit risks #2 and #7 (`specs/research/scale-audit.md`), the storage study (`specs/research/site-storage.md`).
Target: **500 sites held on a phone, one engine**.

Who the "user" is: a developer on `require('hypergraph/next')`: first HyperBrowser's engine (many sites,
one person), and still the single-app builders of today (the forum example, SwarmFS), who must not pay
for it.

## The problem

Today one `Hypergraph` instance (`lib/index.js` `open`/`_open`, `lib/network.js`) is one folder, one
identity, one Hyperswarm and **one fixed set of types for every space**, and it opens and joins every
space it holds at start. Measured:

- ~0.25–0.3 MB of memory and 30–50 ms per open space for hypergraph alone, ~3 MB with SwarmFS and peers:
  500 sites ≈ 1.5 GB and 15–25 s to start (scale audit #7).
- Every log a member holds is an open Hypercore: 18 KB and 0.55 ms each (scale audit #2).
- **Joining Hyperswarm topics hits a wall** (this spec's bench, `research.md` R1): one DHT node sends at
  most 80 requests per 750 ms; announcing a topic costs ~40 requests on a real-sized DHT, a lookup ~20.
  Past ~25 topics at once on a 3-node test DHT (~5 on a 20-node one) the rest wait whole 750 ms ticks.
  500 announced topics ≈ 3 minutes to announce and a third of the node's request budget forever, just to
  stay announced.
- A type change anywhere rebuilds the index of every space (`#reindex`); a site cannot bring its own types.

HyperBrowser needs the opposite: one identity and one swarm for every site, each site with its own types,
most sites closed, and the one being visited fast.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Each space carries its own types (Priority: P1)

A space records the types it uses, in the space itself. An engine with no types of its own opens any
space and reads and writes it with that space's types. A site that adds a field or a type changes only
its space: no other space's index is rebuilt. Breaking changes (a removed type, a moved field) are refused
by every member alike.

**Why this priority**: nothing else in HyperBrowser works without it: a site's JS can't declare types to
an engine that opened before the site existed. It is also the one apply-time change here.

**Independent Test**: one engine, no `types` option; space A created with `{ post }`, space B with
`{ page }`; a second engine joins both and reads both; A's owner adds `comment`: only A's rows are
re-indexed (B's row count and index untouched, timed); a forged incompatible types decision is ignored by
every member.

**Acceptance Scenarios**:

1. **Given** an engine opened without `types`, **When** it creates a space with `{ types }`, **Then** the
   space records them and `space.types()` returns them on every member, newcomers included.
2. **Given** a member whose app never declared a space's types, **When** it joins, **Then** it reads and
   writes with the space's recorded types.
3. **Given** a space's owner or admin with an app version that only adds (types, trailing fields,
   indexes), **When** the app opens the space, **Then** the new version is recorded and every member
   indexes the new parts of that space only.
4. **Given** a decision recording types that remove or change a field, **When** any member applies it,
   **Then** it is refused (no effect) on every member, and the writer's own call throws
   `INCOMPATIBLE_TYPES`.
5. **Given** a space made by today's version (no recorded types), **When** it is opened, **Then** it uses
   the app's declared types as today, until a member who may decide records them.

---

### User Story 2 - Spaces open only while used (Priority: P1)

The engine holds many spaces but opens few: a space is closed until something uses it (a read, a write,
a live view, a call from a site) and closes again when idle. A capped set stays open to seed (the
person's own spaces, pinned ones, recent visits). The single-app case doesn't change: an app holding
fewer spaces than the cap sees every space open, as today.

**Why this priority**: memory and start time are the blockers for 500 sites (1.5 GB, 15–25 s).

**Independent Test**: an engine holding 500 spaces starts in about the time of an empty one, uses about
the memory of its open cap, opens a closed space on first use, and closes it after the idle time; the
forum scenario tests pass unchanged.

**Acceptance Scenarios**:

1. **Given** 500 held spaces, **When** the engine opens, **Then** it opens only the seeded set and is
   ready (other spaces listed by `spaces()`) without opening the rest.
2. **Given** a closed held space, **When** an app calls any space method on it, **Then** the space opens
   first and the call answers as it would on an open space.
3. **Given** an open space not seeded, nothing reading it and no live view, **When** the idle time passes,
   **Then** it closes and its topic is left.
4. **Given** the open count or the memory budget reached, **When** another space must open, **Then** the
   least recently used unseeded space closes first; a space in use (a pending call, a live view, a
   `hold`) is never closed under it.
5. **Given** an app holding fewer spaces than the cap, **When** it runs, **Then** every space is open
   and behaves exactly as before (forum, SwarmFS).

---

### User Story 3 - Topics within the DHT's budget, the visit first (Priority: P1)

A space's topic is joined only while it is open or seeded. Joins are queued by priority: a space being
used now jumps ahead of background seeding, so a visit is never stuck behind 500 announces. The engine
announces at most a capped number of topics; seeded spaces beyond the cap are still served to every peer
met through any other space (one connection per peer already carries every shared space).

**Why this priority**: past ~5 topics at once on a real DHT, every extra join waits 750 ms ticks, and
connecting to a site's peers uses the same request budget: without this, the 500th site makes the
visited one slow.

**Independent Test**: an engine with 500 seeded spaces starts its background joins; a visit to another
space flushes its topic in about the time it takes with no background (local DHT); the announced topic
count never exceeds the cap.

**Acceptance Scenarios**:

1. **Given** 500 seeded spaces and a background queue, **When** a closed space is opened by a call,
   **Then** its topic join is sent before any queued background join.
2. **Given** more seeded spaces than the announce cap, **When** the engine runs, **Then** at most the cap
   are announced (own spaces first, then pinned, then most recent).
3. **Given** a space alone (no peer found), **When** it is not in use, **Then** it is not looked up again
   and again (the re-look timers run only for spaces in use).
4. **Given** a space closed, **When** its topic is left, **Then** the leave also goes through the queue,
   after a grace period (a revisit within it costs nothing).

---

### User Story 4 - Logs open only while used (Priority: P2)

Within an open space, a member's log stays open only while it downloads, is written, or is read beyond
the index; the rest are rows in the index. Peers asking for a closed log are still served. Formats don't
change.

**Why this priority**: the owner of a big forum holds every log (100k logs = 1.8 GB, 1 minute to start);
it's the easy half of scale audit #2.

**Independent Test**: a space with 2,000 logs, everyone-keeps-everything: after catching up, open cores
stay under a small bound; a new record in a closed log reaches this member; a newcomer fetches a closed
log from it.

**Acceptance Scenarios**:

1. **Given** a member holding N logs, all caught up, **When** idle, **Then** at most a bounded number of
   logs are open (its own, the decision log, those downloading).
2. **Given** a closed log whose author writes, **When** the author's activity reaches this member,
   **Then** the log opens, downloads and closes again.
3. **Given** a peer asking for a log closed here, **When** it asks, **Then** the blocks are served.

---

### User Story 5 - A site reaches only its own spaces (Priority: P2)

The engine gives an app (HyperBrowser) a handle limited to one site: that site's spaces and sub-spaces,
reads, writes, live views and events, all async; nothing about the identity's phrase, devices, the
personal space or the other spaces held. HyperBrowser turns web-view messages into calls on that handle;
the sandbox is HyperBrowser's.

By default a site gets **its own key**: derived from the person's identity, not linkable to it or to the
keys other sites get. `site.identity` returns that key, and the site's records are authored by it. The
main identity (its key, name, friends) goes only to a site the person said yes to. The API takes this
shape now; the derivation itself may be built later (until then, only sites given the main identity
work, explicitly).

**Why this priority**: the boundary must exist in the engine before any third-party site code runs.

**Independent Test**: a scoped handle for space A: every space call on A works; asking for B, the
personal space, the phrase or the device list throws `NOT_ALLOWED`; events from B never reach it.

**Acceptance Scenarios**:

1. **Given** a handle scoped to A, **When** it calls a space method on A or its sub-spaces, **Then** it
   behaves as the full engine would.
2. **Given** the same handle, **When** it asks for any other space, the personal space, devices or the
   phrase, **Then** it throws `NOT_ALLOWED` and learns nothing of what else is held.
3. **Given** a handle scoped to a space the engine doesn't hold yet, **When** the site is visited,
   **Then** the handle opens it (join by key or invite) through the same queue.
4. **Given** two sites opened with default handles, **When** each reads `site.identity` and the author of
   its own records, **Then** each sees a different key, neither equal to the main identity's.
5. **Given** a site the person allowed the main identity, **When** its handle is opened with that
   choice, **Then** `site.identity` is the main identity.
6. **Given** another device of the same person, **When** it opens the same site, **Then** it acts under
   the same per-site key (derived from the same identity).
7. **Given** per-site keys not built yet, **When** a default handle is asked for, **Then** it throws
   `NOT_SUPPORTED` saying so, never falls back to the main identity silently.

---

### User Story 6 - Today's apps and folders move without loss (Priority: P2)

`Hypergraph.open(dir, { types, rules })` keeps working: its types become the defaults of the spaces the
app creates and the version it records in spaces it may decide for. SwarmFS and the forum example run
on it unchanged, or share one engine. A folder from today's version opens without rebuilding.

**Independent Test**: the forum scenario tests and SwarmFS's suite pass unchanged; a folder written by
master opens with this version, every space readable, no re-index; SwarmFS and a forum share one engine
(one identity, one swarm).

**Acceptance Scenarios**:

1. **Given** a folder from today's version, **When** opened, **Then** each space takes the folder's
   stored types as its own local declaration, nothing is re-indexed, and the next decider records them.
2. **Given** SwarmFS and the forum on one engine, **When** both declare types, **Then** each space uses
   its own; two apps declaring one type name differently in the personal space are refused clearly.

---

### User Story 7 - A phone: short runs, small memory (Priority: P3)

On Bare on a phone the app runs in short bursts (foreground, or seconds after a push). The engine
suspends (connections and topics paused, idle spaces closed) and resumes (the space in use first, then
the seeded set, staggered) on the app's call, within a memory budget the app sets.

**Independent Test**: on Bare, `suspend()` then `resume()` with 500 held spaces: the visited space is
online first; memory stays under the budget.

### Edge Cases

- A space closed while a peer is mid-download from it: Corestore serves held logs on demand; the space's
  own channel (directory, activity) waits for the next open.
- A decision arriving for a closed space: nothing reacts until it opens (it is applied then); a seeded
  space stays open, so its members' joins are handled.
- Two decisions recording types concurrently (owner and admin): applied in the decision log's order; the
  second must be compatible with the first or it is refused, on every member alike.
- An app with a newer types version than the space, without the right to decide: works with the space's
  version; its own extra types or fields are refused at write (`INCOMPATIBLE_TYPES`, "this space doesn't
  have …"), never silently dropped.
- An app with an older version than the space: reads records of types it doesn't know as today (kept,
  not decoded).
- A forged or malformed types decision from a modified peer: refused by every reader (readers enforce).
- Closing a space with pending writes: writes finish before close; a call during close reopens it after.
- Suspend while a call is pending: the call fails with `CLOSED`-like `SUSPENDED`, never hangs.
- The visited space is one of the 500 seeded: it moves to the front of the queue.
- A site handle given a sub-space key of another site: `NOT_ALLOWED` (scope is by top space).

## Requirements *(mandatory)*

### Functional Requirements

**One engine, types per space**

- **FR-001**: One engine MUST hold one identity, one Corestore, one swarm, and any number of spaces for
  any number of apps in one process.
- **FR-002**: A space MUST record its types (fields, links, one-per-member, editable, put, indexes) in its
  decision log; every member MUST use the space's recorded types to validate, decode, index and enforce
  rules in that space. **Apply-time.**
- **FR-003**: A types decision MUST be applied only if it is compatible with the space's current types
  (adds types, appends fields, adds indexes; same rule as today's `checkCompatible`), and only from a
  member who may decide; otherwise it MUST have no effect on any member. **Apply-time.**
- **FR-004**: `createSpace({ types })` MUST record the given types (default: the engine's declared
  types); an engine MAY be opened with no types.
- **FR-005**: When an app's declared types are a compatible superset of a space's and the app may decide,
  opening the space MUST record the new version (visitors always run a site's latest version). This is the
  only way types change after creation: no explicit call, and members' apps never record types.
- **FR-008**: Each recorded types version MUST carry its version number and be kept as its own entry (not
  overwritten), so a later spec can let older app versions keep working against newer types.
- **FR-006**: A types change in one space MUST re-index only that space's records.
- **FR-007**: A space with no recorded types (made by today's version) MUST use the app's declared types
  as today.

**Lazy spaces**

- **FR-010**: The engine MUST open at start only the seeded spaces; every other held space stays closed
  but listed (`spaces()`), with its name.
- **FR-011**: Any space call MUST open a closed held space first, transparently.
- **FR-012**: An unseeded open space with no call pending, no live view, no `hold`, MUST close after an
  idle time (default 2 minutes).
- **FR-013**: The engine MUST keep at most `maxOpen` spaces open and within a memory budget, closing the
  least recently used unseeded space first; a space in use MUST NOT be closed.
- **FR-014**: The seeded set MUST be: this identity's own spaces (created) and pinned spaces first, then
  recent visits, up to the seeding cap; the app MUST be able to pin and unpin.
- **FR-015**: With fewer held spaces than the caps, every space MUST stay open (today's behavior).

**Topics**

- **FR-020**: A space's topic MUST be joined only while the space is open or seeded, and left after a
  grace period once neither.
- **FR-021**: Topic joins and leaves MUST go through one queue per engine, by priority: in use now, own,
  pinned, recent, re-looks; background joins MUST be paced so they never fill the DHT node's request
  window.
- **FR-022**: At most `maxAnnounced` topics MUST be announced; seeded spaces beyond it stay open to
  peers met through other spaces and helpers.
- **FR-023**: Re-looks (looking again while alone) MUST run only for spaces in use.

**Logs**

- **FR-030**: Within an open space, a log MUST be open only while it is written, downloading, or read
  beyond the index; its blocks MUST still be served to peers asking. **No format change.**
- **FR-031**: A new record in a closed log MUST still reach a member who keeps it (the author's activity
  or a peer's heads open it).

**Boundary**

- **FR-040**: The engine MUST give a handle scoped to one top space (and its sub-spaces) exposing every
  space call, live views and events of that scope, all async, and nothing else.
- **FR-041**: Any call outside the scope MUST throw `NOT_ALLOWED` without revealing what else is held.
- **FR-042**: A scoped handle MUST act under a per-site key by default (derived from the identity,
  deterministic across the person's devices, not linkable to the identity or other sites' keys), and
  under the main identity only when the app opens it so (the person said yes). `site.identity` MUST
  return the key the handle acts under.
- **FR-043**: A held space MUST be held under one identity (main or its site key) on this engine; until
  per-site keys are built, asking for one MUST throw `NOT_SUPPORTED`.

**Phone**

- **FR-050**: The engine MUST run on Bare and offer `suspend()` / `resume()`; resume MUST bring the space
  in use online before the seeded set.
- **FR-051**: The app MUST be able to set the caps and the memory budget at open.

**Migration**

- **FR-060**: A folder from today's version MUST open without re-indexing: the folder's stored types
  become each space's local declaration.
- **FR-061**: `Hypergraph.open(dir, { types, rules })` MUST keep working for single-app use.
- **FR-062**: The personal space has one set of type names for every app on the engine: two apps
  declaring the same name differently MUST get `INCOMPATIBLE_TYPES` naming the type. Apps prefix their
  personal-space types (`swarmfs/held`).

**Perf**

- **FR-070**: `npm run perf` MUST gain an engine scenario (500 held spaces: start, memory, open-on-visit,
  topics) and a topic-queue scenario.

### Key Entities

- **Engine**: one identity, one Corestore, one swarm, one local index, the held spaces, the caps.
- **Held space**: a space this device keeps (row in the index); closed, open or seeded.
- **Space types**: the types a space records in its decision log; versioned, append-only.
- **Topic queue**: the engine's ordered joins and leaves, with the announced set.
- **Scoped handle**: a view of the engine limited to one top space.

## Success Criteria *(mandatory)*

### Measurable Outcomes

(Local DHT, this dev machine, Node and Bare; "phone" figures re-measured on a phone in milestone 3.)

- **SC-001**: An engine holding 500 spaces is ready in under 1 s (today: 15–25 s).
- **SC-002**: Its memory with 500 held spaces and the default open cap is under the empty engine's + 50 MB
  (hypergraph alone; today ~150 MB for hypergraph, ~1.5 GB with SwarmFS).
- **SC-003**: Opening a closed held space and answering its first `latest(20)` takes under 100 ms.
- **SC-004**: With 500 seeded spaces queued, the visited space's topic is flushed within 50 ms of the
  same join on an idle engine.
- **SC-005**: Announced topics never exceed the cap; no background burst makes a join wait a 750 ms tick
  (checked by the bench).
- **SC-006**: A member caught up on 2,000 logs keeps at most ~20 open, and a new record in a closed log
  still arrives.
- **SC-007**: A types change in one of 50 spaces re-indexes that space only (others' rows untouched).
- **SC-008**: The forum scenario tests and SwarmFS's suite pass with no change other than those listed in
  the plan; a folder from master opens with no re-index.
- **SC-009**: A scoped handle can't reach any space outside its scope (every call tested), and two
  default handles expose two different keys, neither the main identity's.

## Out of scope (later)

- The paged log list exchange and "no log before a first record" (scale audit #2, the wire half): the
  "open spaces at scale" spec.
- Building the per-site key derivation (the API and its `NOT_SUPPORTED` refusal are in scope; how a key
  is derived and proven, with its own device proofs, is a follow-up spec before HyperBrowser lets
  third-party sites write).
- Older app versions working against newer space types (future direction below).
- The sandbox, `site.json` permissions and prompts (HyperBrowser's repo).
- Push wake-ups and their helper (availability plan).
- SwarmFS's own per-space memory (~3 MB: its tree in memory): SwarmFS's scale spec.

## Assumptions

- "500 sites on a phone" means 500 **held**, a few open at once (a person visits one at a time).
- The DHT request window (80 per 750 ms) is upstream's congestion control: we design under it, we don't
  raise it on real networks.
- Corestore keeps serving held logs to peers who ask while they are closed here (verified in its code:
  `_attachMaybe`).
- Rules (`rules`) stay app-declared per space as today (`setRules`): only types move into spaces.

## Decisions (Tibo, 2026-11-02)

1. **Tracking across sites**: each site gets its own key by default, derived from the identity and not
   linkable to it; the main identity (name, friends) goes only to a site the person says yes to.
   `site.identity` returns the site's key. The API is right now; the derivation may come later (FR-042,
   FR-043).
2. **Who records types**: only automatically, when a decider's updated app opens the space (FR-005).
   Members' apps never add types. A forum member who updates before an admin waits for the admin's open.
3. **Caps**: desktop `maxOpen` 64 / `maxAnnounced` 32, phone 16 / 8; defaults, re-measured on a real
   network in milestone 1. The memory budget is the app's choice.
4. **Personal space**: one set of type names, a clash refused, apps prefix (FR-062).

## Future direction (not in this spec)

Once there are users, older apps may keep using a space whose types moved on, the way HyperDB keeps
several versions of one schema: each record read with the version it was written for. A change made for
a serious reason (a security hole) could still refuse old versions. Not built here, but the format leaves
room: every `types/set` carries a version number and each version stays stored on its own (FR-008), so
old type versions can be kept side by side later.
