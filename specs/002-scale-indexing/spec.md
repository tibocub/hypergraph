# Feature Specification: Scale Indexing to 1M+ Entries

**Feature Branch**: `002-scale-indexing`

**Created**: 2026-10-04

**Status**: Draft

**Input**: User description: "Scale hypergraph's indexing to 1M+ entries per context. P1 — batched
indexing and a public bulk-write API; P2 — a compact index format with derivable data removed,
rebuilt automatically from the logs on upgrade. Event wire format, Autobase fast-forward,
multi-writer indexer topology, validation hooks and role-carrying invites are out of scope."

## Background: what was measured

Measured with `bench/scale.js` on 2026-10-04, one Windows machine, data shaped like a SwarmFS
file index: per file one entity creation and one content reference in the author's own log, plus
one relation linking the file to its folder in a shared context; folders of 1,000 files.

| files | write | fresh peer joins | list a 1,000-entry folder | disk per peer | retained memory |
|---|---|---|---|---|---|
| 1,000 | 4.9 s | 5.4 s | ~170 ms | ~40 MB | — |
| 10,000 | 49 s | 52 s | ~250 ms | ~111 MB | — |
| 100,000 | 9.2 min | 10.3 min | ~400 ms | ~0.93–1.0 GB | ~400 MB |

Both writing and joining run at a flat ~200 entries/second. Profiling found four causes:

1. Every individual index write is a separate signed, flushed write to disk, about nine per file,
   one after another.
2. Every context write the author makes is replayed by every member as its own step, each with its
   own flush. How finely the *writer* splits its writes therefore sets the cost of replay for every
   member, permanently.
3. A joining peer fetches the author's log one item per network round trip.
4. Indexes are two thirds of stored bytes, and most of that is redundancy: values repeating their
   own key, the content index holding a full copy of every content body, pointer entries holding
   entire copies of other keys, and 32-byte keys written as 64 text characters.

An experiment (branch `perf-experiments`) addressing causes 1–3 without changing any stored
format made writes 7.5× faster and joins 4.6× faster at 100,000 files, and cut retained memory
from ~400 MB to ~88 MB.

A per-structure breakdown at 10,000 files (logical bytes, before storage-engine overhead):

| structure | per file |
|---|---|
| global view indexes | ~1.25 KB |
| context view indexes | ~1.3 KB |
| author's log | ~440 B |
| context log | ~350 B |

## User Scenarios & Testing *(mandatory)*

"User" throughout means the developer consuming `require('hypergraph')`.

### User Story 1 - A new member joins a large context quickly (Priority: P1)

A developer building a file-sharing app (SwarmFS) has a shared space whose context holds 100,000
file entries. A new member's device opens the context and the author's log. The developer needs
that device to reach a complete, queryable index in a small fraction of today's time, without
the device's memory growing in step with the size of the index.

**Why this priority**: Joining cost is paid by every member, every device, and every re-install.
It is the number that decides whether a large shared space is usable at all.

**Independent Test**: With the scale benchmark, a fresh peer replicates and indexes a 100,000-entry
context; measure time to completion, peak and retained memory, and verify every entry and every
folder listing matches the author's.

**Acceptance Scenarios**:

1. **Given** a context with 100,000 entries written by one author, **When** a fresh peer opens the
   context and the author's log and updates, **Then** it reaches a complete index at least 4×
   faster than the 2026-10-04 baseline, with identical query results to the author's.
2. **Given** a fresh peer partway through indexing a large log, **When** the developer queries the
   index, **Then** the entries indexed so far are visible, instead of nothing until the whole pass
   ends.
3. **Given** a fresh peer that is interrupted (crash, kill, power loss) mid-indexing, **When** it
   restarts and updates, **Then** it resumes and ends with exactly the same index as an
   uninterrupted peer: no entry missing, none counted twice.

---

### User Story 2 - Add thousands of entries in one call (Priority: P1)

A developer importing a folder of 10,000 files needs to create the file entities, attach each
one's content reference, and link each to its folder, without making 30,000 separate calls, each
of which today indexes and flushes on its own.

**Why this priority**: Without it, an import of 1M files takes over an hour on the author's machine
alone. Also, because members replay the context in exactly the steps the writer used, a bulk
import done one entry at a time makes the context permanently slower to join for everyone.

**Independent Test**: Import 10,000 files through the bulk call; verify every entity, content
version and relation reads back exactly as if created one at a time, and that a second peer
replays the context in a small number of steps rather than one per relation.

**Acceptance Scenarios**:

1. **Given** an open graph and context, **When** the developer submits 10,000 entity creations,
   10,000 content references and 10,000 relations in one bulk call, **Then** every item reads back
   identically to the same items created by the existing one-at-a-time methods.
2. **Given** a bulk call in which relations point at entities created earlier in the same call,
   **When** the call completes, **Then** the developer receives the ids of the new entities, and
   the relations resolve to them.
3. **Given** a bulk call containing one invalid item (e.g. a malformed content reference, an
   unknown entity, a missing context), **When** it is submitted, **Then** the call is rejected
   before anything is written.
4. **Given** a context written through bulk calls, **When** another peer replays it, **Then** the
   replay takes a number of steps proportional to the number of bulk calls, not the number of
   relations.
5. **Given** a context in open write mode, **When** the bulk call writes to it, **Then** it works
   exactly as single writes do in that mode.

---

### User Story 3 - Indexes take a fraction of today's disk (Priority: P2)

A developer whose app stores 1M entries needs each member's device to hold the index without
gigabytes of redundancy, because a member's phone or laptop pays that cost for every space it
joins.

**Why this priority**: Disk growth is linear in entries for every member. It is the second-largest
cost after join time, and it applies to the next feature too: before indexes can be shared rather
than rebuilt by every member, their format needs to be one worth sharing.

**Independent Test**: Index the same 100,000-entry dataset with the old and new formats; compare
bytes stored for the indexes and per member overall; verify every public query returns identical
results in the same order.

**Acceptance Scenarios**:

1. **Given** the same 100,000-entry dataset, **When** it is indexed with the new format, **Then**
   the index structures take at most one third of the bytes they take today.
2. **Given** any public query (by id, by type, by author, by tag, edges in either direction, edge
   counts, content, chronological listing, moderation lookups), **When** run against the new
   format, **Then** it returns the same results in the same order as against the old format.
3. **Given** a device whose existing local index was built with the old format, **When** it is
   opened by the new version, **Then** the index is rebuilt automatically from the logs, without
   any action by the developer and without losing or altering any data in the logs.
4. **Given** content stored encrypted under a read scope, **When** it is read through the new
   format, **Then** decryption and the "no key" result behave exactly as before.

---

### Edge Cases

- **Concurrent writers**: two writers each make bulk writes to the same context at the same time;
  every peer converges to the same index, and the same duplicate-relation rules apply as for
  single writes.
- **Crash mid-batch**: index entries and the record of how far indexing got are saved together,
  so a crash never leaves an entry indexed but unrecorded (indexed twice later) or recorded but
  unindexed (lost).
- **Interrupted rebuild**: a device killed partway through rebuilding an old-format index resumes
  or restarts the rebuild on next open; it never serves a half-old, half-new index.
- **Older version opening a new-format index** (rollback of the library): it must not misread new
  data as old. Rebuilding from the logs is acceptable; silent misreading is not.
- **Partial replication / late joiner**: when some of the author's log hasn't arrived yet,
  indexing processes what is available and continues later, as today; requesting the missing
  range up front must never block an update waiting on a peer that isn't there.
- **Adversarial peer**: a peer that writes one enormous batch, or a batch containing malformed or
  forged events, must not crash the applying peer or make it hold the whole batch in memory at
  once; forged and malformed events are rejected exactly as they are today.
- **Bulk call failing mid-write**: the author's log and a context are separate logs, so a
  failure between writing them is possible. The developer must be told which part was written,
  so a retry does not silently create duplicate entities.
- **Content read after the author's log was cleared locally**: if the content index points at an
  entry of the author's log rather than copying it, reading content whose log entry is no longer
  held locally must return a clear "not available" result, never wrong content and never a crash.
- **Very large single entries**: an entity with a large content body is not duplicated into the
  index under the new format.

## Requirements *(mandatory)*

### Functional Requirements

**Batched indexing (P1)**

- **FR-001**: Indexing new events from a user's log MUST write index entries in batches, not as
  one separately-flushed write per entry.
- **FR-002**: Applying context events MUST write the context's index entries in batches per
  replay step.
- **FR-003**: Index entries and the record of indexing progress MUST be saved atomically
  together, so an interruption at any point neither loses nor duplicates an entry.
- **FR-004**: During a long indexing pass, progress MUST become queryable in increments, rather
  than only when the whole pass finishes.
- **FR-005**: When a peer is behind on another user's log, it MUST request the whole missing range
  at once rather than one entry per round trip, and MUST NOT block an update waiting for entries
  no connected peer has.
- **FR-006**: The memory a peer holds while indexing MUST be bounded by the batch size, not grow
  with the total number of entries indexed.

**Bulk writes (P1)**

- **FR-007**: The library MUST provide one public call that accepts any mix of entity creations,
  content versions (inline content and content references) and relations (across one or more
  contexts), and writes them as few log writes as possible: one for the author's log, and one
  per context touched.
- **FR-008**: Items in a bulk call MUST be able to refer to entities created earlier in the same
  call, and the call MUST return the ids of every entity it created.
- **FR-009**: A bulk call MUST validate every item before writing anything, and reject the whole
  call if any item is invalid.
- **FR-010**: Everything written by a bulk call MUST be signed, verified, permission-checked and
  stored exactly as the same items written by the existing single-item methods; replaying peers
  MUST NOT be able to tell the difference except by the grouping.
- **FR-011**: A bulk call MUST work in both open and closed context write modes, with the same
  permission rules as single writes.
- **FR-012**: If a bulk call fails after writing the author's log but before writing a context,
  the error MUST tell the developer what was written.
- **FR-013**: The existing single-item methods MUST keep their current signatures and behavior.

**Compact index format (P2)**

- **FR-014**: Index keys MUST be stored in a compact binary form that preserves every ordering the
  current queries rely on.
- **FR-015**: Index values MUST NOT repeat data derivable from their own key, or from the entry
  they point to.
- **FR-016**: The content index MUST locate content in the author's log instead of holding a
  copy of the content body.
- **FR-017**: Index values MUST use a compact binary encoding instead of text.
- **FR-018**: Every public read method MUST return the same shapes, values and ordering as before
  the format change. The one permitted difference: entries tied at the same millisecond may come
  back in a different order (by sequence number instead of by its decimal text); no public method
  promises tie order.
- **FR-019**: The index format MUST carry a version; a device opening an index of a different
  version MUST rebuild it from the logs automatically, and MUST NOT read it.
- **FR-020**: A rebuild MUST NOT modify any log, and MUST be resumable or safely restartable if
  interrupted.

**Compatibility**

- **FR-021**: The format of events in user logs and context logs MUST NOT change; peers running
  this version and the previous version MUST still replicate with each other.
- **FR-022**: The existing test suite, and the test suites of HyperBBS and hyperDNS, MUST pass
  unchanged.
- **FR-023**: The scale benchmark MUST be extended to report the new measurements (bulk vs
  single writes, index bytes per structure), so later work can be compared against this
  feature's results.

### Key Entities

- **Global view index**: per-peer, derived index over every user log the peer follows: entities
  by id, by type over time, over time, and content versions.
- **Context view index**: per-peer, derived index over a context's events: edges by source,
  incoming edges by target, one-active-edge lookup, edge counters, tags, moderation, pending
  writer and moderation changes.
- **Index progress record**: per log, how far indexing has got; saved together with the index
  entries it covers.
- **Index format version**: the version of the layout above, stored with each index so a mismatch
  triggers a rebuild.
- **Bulk write**: one developer call carrying many entity creations, content versions and
  relations, written as one group per log.

## Success Criteria *(mandatory)*

### Measurable Outcomes

All measured with the scale benchmark, on the same class of machine as the 2026-10-04 baseline.

- **SC-001**: A fresh peer reaches a complete index of a 100,000-entry context at least 4× faster
  than the baseline (10.3 min → ≤ 2.6 min).
- **SC-002**: Writing 100,000 entries through the bulk call is at least 6× faster than the
  baseline (9.2 min → ≤ 1.5 min).
- **SC-003**: The memory a fresh peer still holds after indexing 100,000 entries is at least 4×
  lower than the baseline (~400 MB → ≤ 100 MB).
- **SC-004**: With the compact format, index bytes per entry are at most one third of the
  baseline's (~2.5 KB → ≤ 0.85 KB), and total disk per member at 100,000 entries is at least 2×
  lower than the baseline (~0.93 GB → ≤ 0.47 GB).
- **SC-005**: A 1,000,000-entry context completes the benchmark end to end on a 16 GB machine,
  where the baseline was projected not to fit.
- **SC-006**: Every public query returns identical results, in identical order, under the new
  format as under the old, across the whole existing test suite.
- **SC-007**: A peer interrupted at any point during indexing or rebuild ends with an index
  identical to an uninterrupted peer's.
- **SC-008**: HyperBBS and hyperDNS test suites pass with no change to their code.

## Assumptions

- Event formats in user logs and context logs stay as they are. Shrinking them (binary keys
  instead of hex text, dropping fields that must always equal the log's own key) is the next
  largest saving but breaks compatibility between peers and with existing data, so it gets its
  own specification.
- Index rebuild on upgrade is a one-time cost per device, acceptable at alpha stage. Indexes are
  derived data, so rebuilding them loses nothing.
- Folder listings in the benchmark depend on the shape SwarmFS will use (file points at folder).
  SwarmFS's final data model may differ; the benchmark and targets measure the library, not
  SwarmFS.
- Sharing pre-built indexes between members instead of every member building its own (fast-forward)
  is the step needed for joins that stay fast regardless of size. It is deliberately left to a
  later specification, after multi-writer behavior has been measured. This feature's compact
  format is a prerequisite for it, not a replacement.
- Default batch sizes are chosen by measurement during planning; they are not a developer-facing
  setting unless measurement shows one size does not fit.
- The Autobase limitations found in the experiment (batched appends with a custom encoding, and
  with the optimistic flag used in open mode) are worked around inside hypergraph; reporting them
  upstream is a good idea but not a dependency.
