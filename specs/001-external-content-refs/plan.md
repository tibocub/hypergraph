# Implementation Plan: External Content References

**Branch**: `001-external-content-refs` | **Date**: 2026-09-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-external-content-refs/spec.md`

**Scope note**: This plan covers the **hypergraph side only**. SwarmFS's internal transport/VFS
layering is unsettled and explicitly out of scope — nothing here depends on SwarmFS's internal
shape, only on the address grammar defined below.

## Summary

An entity's content can be an **address** pointing at content held elsewhere, instead of the bytes
themselves. hypergraph stores, validates the envelope of, and hands back addresses; it resolves
none of them and gains no dependency on any backend.

The central finding of Phase 0 research: **this needs no wire-format change and no apply-path
change.** A reference is an ordinary `content/append` event whose `contentType` is a reserved
value and whose `body` is a small JSON address payload. `contentType` and `body` are already
encoded as strings, already replicate, already version per entity, and already encrypt under a
scope. Every hard property the spec asks for — deterministic convergence under concurrent writes
(FR-012), stable entity id across updates (FR-011), superseded versions remaining addressable
(FR-013), scoped encryption with no new cryptography (FR-014) — is therefore **inherited from
existing content behavior rather than newly built**.

What is actually built: a reserved content type, an address payload format, a parse/format pair,
write-time envelope validation, read-time tolerance for malformed payloads, and a thin API pair
that keeps callers from hand-building JSON.

## Technical Context

**Language/Version**: Node.js, CommonJS (`require`), matching existing `src/`.

**Primary Dependencies**: autobase, corestore, hyperbee, hypercore-crypto, keet-identity-key,
compact-encoding, sodium-universal, b4a, codecs, protomux. **No new dependency is added by this
feature** — address parsing uses the Node standard library (`URL`), and the payload is JSON.

**Storage**: Hyperbee view materialized over Autobase; events appended to the author's UserCore.
Content records are keyed `c:<entityId>:<sortableSeq>` and read back newest-first. Unchanged.

**Testing**: `brittle`, under `test/brittle/{core,networking,replication}/`. Content behavior lives
in `test/brittle/core/` (`content-encryption.js`, `event-encoding.js`, `view.js`).

**Target Platform**: Node.js; consumed as a library. No UI, no end-users — the "user" is the
developer calling `require('hypergraph')`.

**Project Type**: Library (single project, `src/` + `test/brittle/`).

**Performance Goals**: A reference record's stored size is proportional to the address payload
(hundreds of bytes), strictly independent of the referenced content's size — this is the feature's
entire point (SC-001).

**Constraints**:
- No new runtime dependency (Principle III).
- Additive only: existing inline content must keep working byte-for-byte, because HyperBBS and
  hyperDNS are symlinked to this working tree and receive changes instantly (Principle V).
- The Autobase apply path must not gain a new rejection branch (Principle I — see Constitution
  Check).

**Scale/Scope**: ~1 new source module, small additions to two existing methods, 4 new test files.
No migration: existing records are untouched and remain valid.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

### I. Correctness Under Concurrency & Partition (NON-NEGOTIABLE) — PASS

The design deliberately adds **no new merge logic and no new apply branch**. A reference is a
`content/append` event, so it converges by exactly the mechanism that already governs concurrent
content versions: events linearize through Autobase, records are written at
`c:<entityId>:<sortableSeq>`, and reads take the newest. Concurrent references for one entity
therefore converge deterministically (FR-012) with zero new code, and partial replication, late
joiners, and out-of-order delivery inherit existing, already-tested behavior.

Malformed and adversarial payloads (FR-015) are handled by **not validating semantics in apply at
all**. Apply stores the record as it stores any content record; a malformed payload is caught at
parse time on read and surfaced as an invalid-but-well-formed record. Apply can therefore never be
blocked, never diverge, and never throw on a hostile peer's payload. This is the strongest
available answer to Principle I: the risky path is not made safe, it is not entered.

*Post-design re-check*: confirmed. `data-model.md` places all validation in the parse/format
module and in `putContentRef()` (local writes only). `src/view.js` and the apply path are
untouched.

### II. Test-First for Replication & CRDT Behavior (NON-NEGOTIABLE) — PASS, with a note

Strictly read, this tier covers changes to merge logic, `src/networking.js`, and `src/encodings/`.
**This feature changes none of them** — the wire encoding is unchanged, which is precisely why the
tier is not triggered. Claiming otherwise would be theatre.

The **project-wide** regression rule in Principle II does apply in full, and is honoured: every
behavior change below ships with a test that fails before and passes after. Tests are written
first. Coverage is deliberately extended into replication territory anyway — a reference that
survives `putContentRef` locally but not a round trip through encryption and replication is exactly
the class of bug this project has repeatedly re-discovered.

*Post-design re-check*: confirmed. Test plan in `quickstart.md` includes a two-peer replication
scenario and a malformed-payload-from-peer scenario, neither of which is strictly required by the
non-negotiable tier.

### III. Thin, Consistent Composition Over Holepunch Primitives — PASS

No new dependency. No parallel mechanism. The feature is a **convention over the existing content
primitive**, not a new primitive: reserved `contentType` + JSON body + the standard `URL` parser.
hypergraph validates that an address is a well-formed URI with a scheme, and deliberately does
**not** understand any scheme's semantics — that knowledge belongs to whichever consumer resolves
it. This keeps the surface minimal and means new backends need no hypergraph change (FR-002).

### IV. One Coherent API Surface (NON-NEGOTIABLE) — PASS

The rule is that a feature must remove the manual wiring it replaces, not sit alongside it. Two
consequences taken:

1. `putContentRef()` owns payload construction and validation, so no caller ever hand-builds the
   JSON envelope. Shipping only "call `putContent` with a magic contentType and a string you
   assembled yourself" would be exactly the partial abstraction `API_PROBLEMS.md` warns about.
2. Reading does **not** get a separate parallel method. `getContent()` gains a parsed `reference`
   field when the record is one. A caller that ignores it is unaffected; a caller that wants it
   need not know a second method exists.

Naming follows the existing `putContent`/`getContent` convention.

### V. Alpha Versioning & Explicit Breaking Changes — PASS (no break)

Purely additive. No existing record changes meaning, no existing call signature changes, no
migration. A CHANGELOG entry is still required because the capability is consumer-visible, but it
announces a feature rather than a break. The reserved `contentType` value is chosen so it cannot
collide with a real media type (see `research.md` R2).

### Documentation & Specification Hygiene — PLANNED

Doc-sync-on-change requires these to land in the *same* change:
- `docs/storage-model.md` — content may now hold an address instead of bytes.
- `docs/contributors/index-structure.md` — content keys are unchanged; note that references are
  ordinary content records so no new index exists.
- `docs/contributors/event-encoding.md` — record that no encoding change was required, and why
  (the reserved-contentType decision). Valuable precisely because a future reader will expect a
  new event type and should learn why there isn't one.

## Project Structure

### Documentation (this feature)

```text
specs/001-external-content-refs/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── address-grammar.md   # The cross-project contract — the part SwarmFS/HyperBBS must agree to
│   └── api.md               # hypergraph's public surface for this feature
├── checklists/
│   └── requirements.md  # From /speckit-specify
└── tasks.md             # NOT created by /speckit-plan — /speckit-tasks produces it
```

### Source Code (repository root)

```text
src/
├── content-ref.js        # NEW — the only new module. Format, parse, validate. Pure; no I/O,
│                         #   no crypto, no graph access. Exports the reserved contentType.
├── hypergraph.js         # MODIFIED — add putContentRef(); getContent() surfaces `reference`
├── view.js               # UNCHANGED — apply path deliberately untouched
├── encodings/event.js    # UNCHANGED — no wire-format change
└── utils.js              # UNCHANGED

test/brittle/core/
├── content-ref-format.js      # NEW — parse/format round-trip, validation, malformed tolerance
├── content-ref-api.js         # NEW — putContentRef/getContent, unknown scheme degradation
└── content-encryption.js      # MODIFIED — add a scoped-reference case

test/brittle/replication/
└── content-ref-replication.js # NEW — two peers, convergence, malformed payload from a peer

docs/
├── storage-model.md                  # MODIFIED (doc-sync)
└── contributors/
    ├── index-structure.md            # MODIFIED (doc-sync)
    └── event-encoding.md             # MODIFIED (doc-sync)

CHANGELOG.md                          # MODIFIED — additive feature entry (Principle V)
```

**Structure Decision**: Single-project library layout, matching the existing repo. One new source
module (`src/content-ref.js`) holds all format knowledge so that parsing, validation, and the
reserved constant have exactly one home — and so the pure logic is unit-testable without standing
up a graph. Everything else is a small additive change to `src/hypergraph.js`.

## Phase Outputs

- **Phase 0** — [research.md](./research.md): five decisions, each with rationale and rejected
  alternatives. The load-bearing ones are R1 (piggyback on `contentType`, no wire change) and R4
  (hypergraph validates the envelope, never a scheme's semantics).
- **Phase 1** — [data-model.md](./data-model.md), [contracts/address-grammar.md](./contracts/address-grammar.md),
  [contracts/api.md](./contracts/api.md), [quickstart.md](./quickstart.md).

`contracts/address-grammar.md` is the artifact that matters beyond this repo: it is what HyperBBS
and SwarmFS must agree to, and it is deliberately written so it can be read without knowing
anything about hypergraph's internals.

## Complexity Tracking

No constitutional violations. No entries.

The design's notable property is *negative* complexity: by reusing the content primitive rather
than adding an event type, the feature avoids touching the encoding layer, the apply path, and the
index structure — the three places where this project's historical bugs have concentrated.
