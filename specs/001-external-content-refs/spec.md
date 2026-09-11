# Feature Specification: External Content References

**Feature Branch**: `001-external-content-refs`

**Created**: 2026-09-11

**Status**: Draft — open questions resolved

**Input**: User description: "External content references — let a hypergraph entity point at bytes stored outside the graph."

## Why This Exists

`putContent()` stores `body` as a plain string value in the Hyperbee view, and every content
event flows through Autobase apply. Every byte is therefore replicated to, applied by, and
materialized on every participant in the context. That is correct for a forum post and unusable
for a 2 GB video.

There is currently no way for a graph to *reference* content it does not hold. This feature adds
one. It is a **naming and permission layer over content held elsewhere** — hypergraph stores and
resolves references; it never fetches, stores, or verifies the referenced content.

The first backend is SwarmFS, whose defining property is that it serves bytes **directly from
the user's existing filesystem with no copy into any hypercore**. A design requiring ingestion
would defeat its entire purpose, so "hypergraph never touches the bytes" is a hard constraint
here, not a simplification.

## Two Layers — and only one of them is this feature

A reference can appear in two places, and they need different things:

**Document layer.** A hypersite's HyperMD source contains a link or media directive —
`::video[swarmfs://<root>]`, or an ordinary `[text](link)`. That link lives *inside a document
body*. hypergraph stores the document as ordinary small text and never knows a reference exists;
the renderer parses the directive, reads the scheme, and hands the address to whatever can fetch
it.

**Entity layer.** An entity *is* the content — a file in a virtual filesystem, an image attached
to a post. Here a consumer calling for the entity's content must learn "the bytes are elsewhere,
and here is where."

**This specification covers the entity layer only.** The document layer needs no hypergraph
feature: it is a HyperMD directive plus the shared address grammar defined here. That distinction
matters for sequencing — a renderer can implement file links against this grammar without waiting
for any hypergraph change.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reference content without ingesting it (Priority: P1)

An entity's content is a 2 GB video. Instead of the bytes entering the graph, the entity's content
record holds a short address describing where they can be obtained. Every peer replicating the
context receives the address; only peers that actually want the video fetch it.

**Why this priority**: This is the entire feature. Without it, large content cannot exist in a
hypergraph at all.

**Independent Test**: Attach a reference to an entity, replicate to a second peer, and confirm
the second peer reads back an identical, well-formed address — while the context's storage grows
by the size of the address, not the content.

**Acceptance Scenarios**:

1. **Given** an entity in a replicated context, **When** a reference is stored against it,
   **Then** every peer resolves the same address, and the context's on-disk size is unchanged to
   within the size of the reference record.
2. **Given** a stored reference, **When** a consumer reads the entity's content, **Then** it can
   tell the record is a reference rather than inline content, without fetching anything.
3. **Given** a reference whose scheme the consumer does not support, **When** it reads the record,
   **Then** it receives a well-formed record, can report precisely which scheme it lacked, and
   does not throw.
4. **Given** a reference, **When** a consumer decides whether to fetch, **Then** it can read the
   declared size and media type of the content without contacting any backend.

---

### User Story 2 - Address content uniformly regardless of where it lives (Priority: P1)

Small content lives inline in the graph; large content lives in SwarmFS; some content lives in a
hyperdrive, behind a URL, or in another hypergraph entirely. A consumer addresses all of it the
same way and switches on the scheme, rather than each application inventing its own convention.

**Why this priority**: Equal to Story 1. A reference format used by only one application is not
worth specifying — shared addressing across applications is the reason hypergraph exists, and two
consumers (HyperBBS, SwarmFS) must agree before either builds against it.

**Independent Test**: Store references to content in several different backends, including one
held inline in this graph, and confirm a single consumer resolves all of them through one code
path that branches only on scheme.

**Acceptance Scenarios**:

1. **Given** references to content in different backends, **When** a consumer reads them, **Then**
   each is recognizable by scheme and carries what that scheme needs to locate the content.
2. **Given** a reference to content held inline in this graph, **When** a consumer resolves it,
   **Then** it is expressed in the same grammar as external content, so small and large media are
   addressed uniformly.
3. **Given** a reference scheme defined after a consumer was written, **When** that consumer reads
   it, **Then** it degrades cleanly rather than failing, and the grammar needed no change to admit
   the new scheme.

---

### User Story 3 - Keep a stable address while content changes (Priority: P2)

A file's bytes are edited, so its content hash necessarily changes. The entity naming that file
does not, so every relation, tag, and directory entry pointing at it stays valid and now resolves
to the new content.

**Why this priority**: Without it, content-addressing forces every referrer to be rewritten on
every edit, which makes references unusable for anything mutable.

**Independent Test**: Store a reference, replace it with a different one under the same entity,
and confirm reads return the new address while the entity id, relations, and tags are untouched.

**Acceptance Scenarios**:

1. **Given** an entity with a stored reference, **When** a new reference is stored for the same
   entity, **Then** reads return the newest and the entity id is unchanged.
2. **Given** two peers that concurrently store different references for one entity, **When** they
   replicate, **Then** both converge on the same reference, chosen deterministically.
3. **Given** a reference that has been replaced, **When** a peer reads an earlier version,
   **Then** prior versions remain addressable rather than destroyed.

---

### User Story 4 - Restrict who learns where the content is (Priority: P3)

A reference is stored under a read scope, so only scope members learn the address. Non-members see
that content exists but cannot resolve it.

**Why this priority**: Valuable but strictly additive, and it composes with machinery that already
exists rather than introducing new cryptography.

**Independent Test**: Store a reference under a scope; read it as a member and as a non-member.

**Acceptance Scenarios**:

1. **Given** a reference stored under a read scope, **When** a member reads it, **Then** it
   resolves normally.
2. **Given** the same reference, **When** a non-member reads it, **Then** no part of the address
   is recoverable, and the non-member can still tell referenced content exists.
3. **Given** a scope whose key has rotated, **When** a member reads a reference stored under an
   earlier epoch, **Then** behavior matches existing scoped-content behavior exactly.

### Edge Cases

- **Concurrent writes**: Two partitioned peers store different references for one entity. On
  reconnect both MUST converge to the same reference everywhere, by the rule that already governs
  concurrent content versions.
- **Offline / partition**: Storing and reading a reference MUST NOT require network access or any
  contact with the referenced backend. A reference is data, not a live handle.
- **Out-of-order / late join**: A peer joining late MUST resolve the same reference as every other
  peer once caught up, and MUST NOT treat a stale reference as current merely because it arrived
  first.
- **Adversarial input**: A peer MAY write a reference that is malformed, unresolvable, declares a
  false size or type, or names a nonexistent scheme. None may crash a reader, corrupt the view, or
  block apply. A reference is an unverified claim by its author until a consumer obtains the
  content and checks it.
- **Partial replication**: Resolving a reference MUST NOT require any core beyond those already
  needed to read the content record.
- **Unavailable content**: A reference to content nobody currently serves is a normal, expected
  state — not an error, not corruption. Availability is a property of the network at a moment;
  correctness is a property of the record.
- **Reference cycles**: A reference MAY point at content that itself contains references,
  including back to the referring graph. Resolution is single-step and MUST NOT recurse, so a
  cycle is a consumer-side traversal concern, never a hang inside resolution.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow an entity's content to be a reference to content held
  elsewhere, using the existing content mechanism, with no change to how content replicates.
- **FR-002**: A reference MUST be expressed as an address whose scheme identifies how to interpret
  and resolve the rest, so new backends are admitted without changing the grammar or existing
  records.
- **FR-003**: The grammar MUST be able to express, at minimum: SwarmFS content addresses,
  hyperdrive locations, hyperblobs locations, plain web URLs, another hypergraph, and content held
  inline in this graph.
- **FR-004**: The grammar MUST NOT preclude addresses that resolve through a naming service rather
  than naming a location directly, so human-readable names can be introduced later without a
  format change.
- **FR-005**: The system MUST NOT fetch, store, cache, or verify referenced content. Resolution
  yields the reference; obtaining content is entirely the consumer's responsibility.
- **FR-006**: A consumer MUST be able to distinguish a reference from inline content without
  fetching anything and without parsing a body whose shape it does not already trust.
- **FR-007**: A consumer encountering an unrecognized scheme MUST receive a well-formed record it
  can identify as unsupported, MUST be able to report which scheme it lacked, and MUST NOT error.
- **FR-008**: A consumer MUST be able to learn the declared size and media type of referenced
  content without contacting any backend.
- **FR-009**: A reference MUST declare whether its target is immutable (the address itself fixes
  the content) or mutable (the content behind the address may change), because verification and
  caching differ between them.
- **FR-010**: A reference MAY carry a content digest. When present, a consumer MUST verify obtained
  content against it. When absent on a mutable target, the content MUST be treated as explicitly
  unverified rather than assumed sound.
- **FR-011**: Replacing an entity's reference MUST NOT change the entity id, and MUST preserve all
  relations and tags pointing at that entity.
- **FR-012**: Concurrent references stored for one entity by different peers MUST converge
  deterministically to the same value on every peer.

  > **Implementation finding (2026-09-11)**: this scenario turns out to be *impossible by
  > construction*, which is stronger than converging. `src/view.js` enforces that content may only
  > be appended under the entity's own author's core
  > (`if (authorFromEntityId(event.entityId) !== coreKeyHex) return`). Every content version for an
  > entity therefore comes from a single core, which is totally ordered — there is nothing to
  > reconcile. A peer *can* append a competing reference to its own core, but apply ignores it on
  > every peer including its own.
  >
  > The requirement is satisfied, but the interesting property underneath it is a security one:
  > a peer cannot redirect someone else's entity at content it controls. That is what
  > `test/brittle/replication/content-ref-replication.js` actually tests, in place of a
  > convergence race that cannot happen.
- **FR-013**: Superseded references MUST remain addressable rather than being overwritten
  destructively.
- **FR-014**: A reference MUST be storable under a read scope such that only members can recover
  the address, composing with existing scope and epoch behavior without new cryptography.
- **FR-015**: The system MUST reject a malformed reference at write time where the record alone
  makes that possible, and MUST tolerate one arriving from a peer without crashing, corrupting the
  view, or blocking apply.
- **FR-016**: A reference MAY name more than one address for the same content, in preference order,
  so a consumer can fall back when one source is unavailable.
- **FR-017**: Declared metadata MUST be treated by consumers as an unverified claim by the
  reference's author until the content is obtained and checked.

### Key Entities

- **Content Reference**: A short record standing in place of content. Carries one or more
  addresses, the declared size and media type, whether the target is mutable, and optionally a
  digest. Small enough to replicate to every participant without cost.
- **Address**: A scheme plus whatever that scheme needs to locate content. The extension point of
  this feature — hypergraph understands addresses well enough to store, compare, and hand them
  over, never well enough to resolve them into bytes.
- **Referenced Content**: The content itself. Lives outside the graph, is never replicated by it,
  may be unavailable at any moment, and may be held by peers who are not members of the referring
  context.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Storing a reference to content of any size increases the context's on-disk footprint
  by no more than the reference record itself — demonstrably independent of the content's size.
- **SC-002**: Two peers concurrently storing different references for one entity converge to an
  identical reference after reconnecting, with no manual intervention.
- **SC-003**: A consuming developer can attach external content to an entity and read it back
  without writing backend-specific code in hypergraph, and without hypergraph gaining a dependency
  on any storage or transfer library.
- **SC-004**: No malformed, hostile, or unresolvable reference from a peer causes a crash, an
  unhandled rejection, a corrupted view, or a stalled apply.
- **SC-005**: A consumer supporting none of a record's schemes still reads it successfully and
  reports precisely which scheme it lacked.
- **SC-006**: Replacing an entity's referenced content leaves every relation and tag pointing at
  that entity valid and resolving to the new content.
- **SC-007**: A non-member of a read scope cannot recover the address of a reference stored under
  that scope.
- **SC-008**: Two applications that never shared code resolve each other's references, given only
  this grammar and support for the relevant schemes.

## Resolved Decisions

Both questions raised during specification are settled.

**Q1 — How a reference is expressed and distinguished.** *Resolved: as a scheme-qualified address,
in the same grammar already used to address hypersites and names elsewhere in the ecosystem.*
A reference is an address, not a bespoke structured record. This unifies document-layer links
(which a renderer already parses out of HyperMD) with entity-layer content references, so one
grammar serves both and neither application invents its own. The scheme carries the discrimination
that FR-007 needs: an unknown scheme is visibly unknown rather than silently misread. The precise
encoding — and how the record is marked as holding a reference rather than inline content
(FR-006) — is an implementation concern for `/speckit-plan`.

**Q2 — Integrity.** *Resolved: option C. A digest is always optional; consumers MUST verify when
one is present; absence on a mutable target means explicitly unverified.*
The decisive argument is that requiring a digest would forbid the most valuable reference type: a
hypergraph referencing another hypergraph. An evolving multi-writer structure has no stable hash
by definition, so a mandatory digest would make mutable targets unexpressible. This also matches
how trust actually works — a merkle root proves bytes are the *expected* bytes, not that they are
*safe*, exactly as HTTPS proves a server's identity and not a site's honesty. Integrity and
trustworthiness are separate properties and only the first is in scope.

## Assumptions

- **Existing content versioning already provides the stable-address requirement.** Verified
  against the implementation: content records are keyed per entity with a sortable sequence, and
  reads return the most recent version. Storing a new reference is an ordinary new content
  version, so the entity id is already the permanent address — no indirection record is needed at
  this layer.
- **Encrypting the reference rather than the content is the correct model.** It composes with
  existing scope and epoch machinery with no new cryptography, and preserves content-addressed
  deduplication because ciphertext never enters the content-addressed space. Two users who
  independently hold the same file still converge on the same address regardless of who may read
  the reference.
- **hypergraph gains no new runtime dependency.** It does not depend on SwarmFS, hyperdrive, or
  hyperblobs — it stores addresses naming them. Dependency direction stays one-way.
- **Integrity is the consumer's job, at fetch time.** hypergraph cannot verify content it never
  sees.
- **Availability is not correctness.** Nothing here attempts to guarantee, measure, or repair
  availability.
- **The first two consumers are known and both are local.** HyperBBS and SwarmFS's VFS both
  consume hypergraph through symlinks to this working tree, so a format change reaches them
  immediately and must be agreed before either builds against it.

## Out of Scope

Deferred; named so the boundary is explicit.

- **Human-readable naming.** Resolving a name to an address is hyperDNS's job, not hypergraph's.
  It is nonetheless the most likely near-term extension: addresses across this ecosystem are
  overwhelmingly hashes — topics, graph keys, merkle roots — and hashes are markedly less
  memorable than the IP addresses that motivated DNS. FR-004 exists so that layer can arrive
  without a format change.
- **The document layer.** Media directives and links inside HyperMD belong to HyperMD and its
  renderer. They share this grammar; they need nothing else from hypergraph.
- **The multi-writer directory tree and its move-operation semantics**, including concurrent moves
  that would create cycles. Autobase's deterministic linearization does not by itself keep a tree
  valid, and that problem needs its own treatment.
- **Union and merge semantics** for virtual directories presenting entries from multiple peers.
- **The SwarmFS refactor**, its transport/VFS layering, and its protocol work.
- **Fetching, caching, pinning, garbage collection, or availability measurement** of referenced
  content.
