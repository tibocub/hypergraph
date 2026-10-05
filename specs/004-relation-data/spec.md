# Feature Specification: Data on Relations

**Feature Branch**: `004-relation-data`

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Sparse logs: a peer joining a large space should not have to
download and index every author's whole log just to list folders." Chosen approach: let a
relation carry a small piece of signed data, so what a listing needs lives in the context, which
already fast-forwards and fetches only what is read (spec 003).

## Background

Measured at 1,000,000 files (`bench/README.md`, spec 003): a new member can list a folder's
entries after 10 s, but showing each file's name, hash and size needs the file's content, which
lives in its author's own log. Getting there means downloading and indexing that whole log
(2 million entries, 11.4 min, 2.6 GB on the new member's disk) — for data a listing reads a few
hundred bytes of per file.

A context already holds the relation "this file is in this folder". If that relation can carry the
file's listing data, a folder listing becomes a context read only: fast-forwarded, fetched on
demand, checked by the context's app rules — and authors' logs are never needed to browse.

## User Scenarios & Testing *(mandatory)*

"User" means the developer consuming `require('hypergraph')`.

### User Story 1 - List a large folder without anyone's whole log (Priority: P1)

A SwarmFS developer stores each file's name, content address and size on the relation that puts
the file in its folder. A new member of a million-file archive opens only the archive's context
and lists folders — names, addresses, sizes — without opening or downloading any author's log.

**Why this priority**: It removes the dominant remaining cost of joining a large space.

**Independent Test**: With the scale benchmark in edge-data mode, a fresh peer that opens only the
context lists folders with every entry's data, and holds no author-log blocks.

**Acceptance Scenarios**:

1. **Given** relations written with data, **When** any peer lists the edges into a folder, **Then**
   each edge comes with exactly the data it was written with.
2. **Given** a fresh peer that opened only the context, **When** it lists a folder of a
   1,000,000-entry archive, **Then** it gets every entry's data and stores none of the authors'
   logs.
3. **Given** a relation written without data, **When** listed, **Then** it looks exactly as today.

---

### User Story 2 - The data is trustworthy and checkable (Priority: P1)

The developer needs the data to be as trustworthy as the relation itself, and checkable by the
context's app rules ("names unique in a folder", "a valid content address", "size is a number").

**Why this priority**: Listing data from the context replaces data that was signed by the
author in their own log; it must not be easier to forge.

**Independent Test**: Tamper with a relation's data after signing; it is rejected. Attach a rule
checking the data; violating relations are rejected.

**Acceptance Scenarios**:

1. **Given** a relation whose data was changed after it was signed, **When** applied, **Then** it
   is rejected like any forged relation.
2. **Given** an app rule, **When** it runs, **Then** it sees the event's data, and the data of
   existing edges through the reader.
3. **Given** data larger than the limit, **When** written, **Then** the write is refused; **When**
   such a relation arrives from another peer anyway, **Then** it is rejected at apply.

---

### User Story 3 - Changing an entry's data (Priority: P2)

A file is renamed. The developer needs the folder listing to show the new name.

**Why this priority**: Common, but expressible with existing operations.

**Acceptance Scenarios**:

1. **Given** an edge with data, **When** the developer removes it and relates the same pair again
   with new data (in one bulk call or two calls), **Then** listings show only the new data.

---

### Edge Cases

- **Older peers**: an older peer verifies a relation's signature without the data and would
  reject relations that carry data. Mixed versions in one context are already unsupported for
  version 2 contexts (spec 003); version 1 contexts with older peers must not use data — stated in
  the changelog.
- **Concurrent writers**: two writers relate different files with data into one folder at once;
  every peer converges on the same edges and data.
- **Hostile writer**: oversized data, invalid encoding, data on a forged relation — rejected at
  apply, never crashing it.
- **Deleting**: removing a relation removes its data from listings.
- **Fast-forward**: a fast-forwarding peer gets edges' data from the signed state on demand.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A relation MUST be able to carry an optional piece of data, a string chosen by the
  app, written with the relation in single and bulk writes.
- **FR-002**: The data MUST be covered by the relation's signature; a relation whose data does not
  match its signature MUST be rejected at apply on every peer.
- **FR-003**: Relations without data MUST keep their current signatures, bytes and behavior.
- **FR-004**: Listing edges (in either direction) MUST return each edge's data.
- **FR-005**: The data MUST be limited in size (4 KB of UTF-8); larger data MUST be refused when
  written and rejected when applied.
- **FR-006**: App rules MUST see the data of the event being checked and of existing edges.
- **FR-007**: A peer MUST be able to list edges with their data having opened only the context —
  no user core opened or downloaded.
- **FR-008**: The scale benchmark MUST gain a mode measuring a join that lists through edge data
  only, so the gain is recorded.

### Key Entities

- **Relation data**: an app-chosen string (typically JSON), at most 4 KB, signed with the
  relation, stored with the edge in the context's index, returned with the edge.

## Success Criteria *(mandatory)*

- **SC-001**: A fresh peer opening only the context of a 1,000,000-file archive lists a folder of
  1,000 entries with every entry's name, address and size within 30 s of joining, holding no
  author-log blocks.
- **SC-002**: That peer's disk use is under 5% of a full joiner's (2.58 GB at 1M today).
- **SC-003**: Every forged, oversized or rule-breaking data case in the tests is rejected on every
  peer.
- **SC-004**: Existing relations (no data) are byte-identical, and the full suite, HyperBBS and
  hyperDNS pass.

## Assumptions

- The data is opaque to hypergraph: apps choose its format (JSON recommended) and validate it with
  app rules. Hypergraph only bounds its size.
- The 4 KB bound keeps contexts light (every member may fetch it); bigger payloads belong in
  content or behind a content reference.
- Opening authors' logs lazily (fetching single entities on demand) is not needed for listings once
  data lives on relations; it is left for later if another use needs it.
- Updating data in place is not provided; unrelate + relate expresses it.
