# Specification Quality Checklist: External Content References

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-11
**Updated**: 2026-09-11 (after Q1/Q2 resolution)
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

**All checklist items pass. Ready for `/speckit-plan`.**

Both open questions were resolved by the user and are recorded under "Resolved Decisions" in the
spec, with the reasoning preserved rather than just the verdict:

- **Q1** — a reference is a scheme-qualified address in the grammar already used across the
  ecosystem, not a bespoke structured record. This also revealed a layer split (document vs
  entity) that **reduced** the feature's scope: the document layer needs no hypergraph change.
- **Q2** — option C. A digest is optional; verify when present; absence on a mutable target means
  explicitly unverified. The decisive argument was that a mandatory digest would make
  hypergraph-references-hypergraph unexpressible, since an evolving multi-writer structure has no
  stable hash.

**Scope changed materially between draft and final.** The first draft specified a new content
mechanism. The final specifies an address grammar plus a resolution contract, with much less new
machinery. Two requirements were added as a result (FR-004 naming-service compatibility, FR-009
mutable/immutable declaration) and one user story was added (Story 2, uniform addressing) — while
the mechanism-heavy framing was dropped.

**On "written for non-technical stakeholders"**: interpreted per this project's constitution,
which defines the "user" as the developer consuming the API — hypergraph has no UI and no
end-users of its own. The spec avoids implementation detail (no function signatures, field names,
or encodings) while remaining legible to that audience. The exact address encoding and the FR-006
discrimination mechanism are deliberately deferred to the plan.

**Verified against the implementation rather than assumed**:

- Content is already versioned per entity (`c:<entityId>:<sortableSeq>`, read back newest-first,
  limit 1), which is what makes FR-011's stable-address requirement already satisfied.
- Entity ids are `type/authorHex/seq`; an id with fewer than three segments cannot yield an author
  and is silently dropped on read. This is why FR-003 requires inline-graph content to be
  expressible in the same grammar rather than by informal path-like strings.

**Deferred to `/speckit-plan`**, not gaps in the spec:

- The concrete address encoding and how per-scheme metadata (size, type, digest, fallbacks) is
  carried.
- How a content record is marked as holding a reference (FR-006).
- Which schemes ship first — the grammar admits more than the initial implementation needs.
