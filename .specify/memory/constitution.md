<!--
Sync Impact Report
Version change: 1.0.0 → 1.1.0
Rationale: MINOR — three additive governance rules, no principle removed or redefined
  incompatibly: (1) doc-sync-on-change (Documentation & Specification Hygiene), (2) division
  of labor between CHANGELOG.md and specs/ for where change *rationale* lives (Documentation
  & Specification Hygiene), (3) regression-test-on-change broadened project-wide, not just the
  CRDT/replication non-negotiable tier (Principle II).
Modified principles: II (added project-wide regression-test paragraph; NON-NEGOTIABLE tier
  itself unchanged)
Added sections: none (extended Documentation & Specification Hygiene; no new top-level section)
Removed sections: none
Context: this amendment follows a codebase/docs audit prompted by the realization that
  API_PROBLEMS.md, TODO.md, and the docs/ tree were a hand-rolled pre-spec-kit attempt at
  tracking exactly this kind of thing, done before spec-kit was adopted, without any
  enforcement mechanism keeping them in sync with the code as it changed. This amendment is
  the enforcement mechanism going forward.
Templates requiring follow-up:
  ✅ plan-template.md — Constitution Check gate reads this file at runtime, no edit needed
  ✅ spec-template.md — reframed inline examples toward library/API-appropriate success
     criteria and P2P-specific edge cases (offline peers, partition, out-of-order delivery,
     late joiners, concurrent writers) instead of generic web-app boilerplate
  ✅ tasks-template.md / speckit-tasks SKILL.md — "tests are optional by default" contradicted
     Principle II and the new regression-test rule; changed default to test-tasks-included
  ⚠ TODO: none outstanding — all placeholders resolved from repo evidence
    (README.md, docs/architecture.md, docs/storage-model.md, docs/networking.md,
    docs/contexts-and-roles.md, docs/contributors/critical-implementation-details.md,
    test/brittle/**, API_PROBLEMS.md)
-->

# Hypergraph Constitution

## Core Principles

### I. Correctness Under Concurrency & Partition (NON-NEGOTIABLE)

Hypergraph exists to give other Holepunch-ecosystem projects a foundation they can trust
for data, replication, and identity/permissions. Every behavior that touches multi-writer
state (contexts, roles, relations, moderation) MUST remain correct when writes are
concurrent, peers are offline/partitioned, messages arrive out of order, or a peer joins
late with a partial history. "Correct" means: convergence to the same state on all peers,
no silent data loss, and no crash on malformed or adversarial input from a peer.
Rationale: this is the one property downstream projects (HyperDNS, SwarmFS, HyperBBS,
vaporOS tooling, etc.) cannot work around if it's wrong — it must be solved once, here.

### II. Test-First for Replication & CRDT Behavior (NON-NEGOTIABLE)

Any change to context/role/relation merge logic, replication (`src/networking.js`), or
encoding (`src/encodings/`) MUST add or extend a `test/brittle` scenario that fails before
the change and passes after. New edge cases (a new interleaving, a new partial-replication
shape, a new failure mode) are added to the matching suite under `core/`, `networking/`,
or `replication/` — not treated as a one-off manual check. Application-facing features
(query helpers, high-level APIs) follow standard test-first practice but are not held to
this non-negotiable tier.
Rationale: the existing brittle suite (concurrent writes, partial replication, out-of-order
delivery, late joiners, peer reconnection) is the project's accumulated, hard-won knowledge
of what breaks in P2P replication. Losing or weakening it is the single biggest risk to
"reliable foundation" — it must grow, never shrink, as new cases are found.

Beyond this non-negotiable tier, every significant fix or behavior change anywhere in `src/`
MUST add or update a test that fails before the change and passes after — not only within
context/role/relation/replication/encoding. "Significant" excludes pure formatting/comment
changes and excludes changes with no observable behavior difference; it includes every bug
fix, every new capability, and every refactor that could plausibly change behavior.
Rationale: the same AI-assisted, high-velocity development that produced 48+ CHANGELOG
"Round N" bug-hunt entries is exactly the setting where a regression silently reappears
because nothing was pinned down the first time it was fixed. Regression tests are cheaper
than re-discovering the same bug twice.

### III. Thin, Consistent Composition Over Holepunch Primitives

Hypergraph is a composition layer over Hypercore, Corestore, Autobase, Hyperbee, and
keet-identity-key, not a reimplementation of them. New functionality MUST be built by
composing these primitives (UserCore, ContextBase/Autobase, RoleBase, Hyperbee indexes)
rather than duplicating what they already provide. Any direct divergence from a primitive's
own model (e.g. inventing a parallel replication or auth mechanism) requires explicit
justification in the relevant plan's Complexity Tracking section.
Rationale: keeps the surface small enough for one person plus AI assistance to hold in
their head, and keeps hypergraph upgradeable as the underlying Holepunch libraries evolve.

### IV. One Coherent API Surface (NON-NEGOTIABLE)

A feature is not "done" until it removes the manual wiring it was meant to replace, not
just adds an alternative alongside it. Concretely: no shipping a peer-discovery or change
event that still requires the consumer to hand-roll Hyperswarm connection handling,
`store.replicate()`, and `graph.handlePeerConnection()` themselves — the API MUST own that
wiring end-to-end, or MUST NOT claim to solve it. Method placement (instance vs. static),
naming, and error handling MUST follow one consistent convention across the public API
(`graph.*`, `Hypergraph.*`), decided once in the relevant plan and not per-feature.
Rationale: directly targets the pattern documented in API_PROBLEMS.md — partial
abstractions that still leak the full underlying complexity are worse than no abstraction,
because they cost consumers a false sense of safety.

### V. Alpha Versioning & Explicit Breaking Changes

Hypergraph is pre-1.0 and breaking changes are allowed, but MUST be intentional and visible:
called out in the plan for the change, and recorded in CHANGELOG.md as a single dated
entry describing the break and the migration, not left to be discovered by a diff.
CHANGELOG.md is a curated history for humans and AI context, not an automatic dump —
routine internal refactors with no consumer-visible effect do not need an entry.
Rationale: "ALPHA — breaking changes expected" (README.md) is a license to iterate, not a
license to leave consumers (including your own other projects) guessing what changed.

## Documentation & Specification Hygiene

`specs/<feature>/` (spec → plan → tasks) is the source of truth for anything new or
changed, going forward. The existing `docs/` tree (architecture, storage-model, networking,
contexts-and-roles, contributors/*) remains the current-state reference for what already
exists and is trusted implementation context — it is updated as specced work lands, not
retroactively rewritten as specs. Do not create specs for already-stable, unchanged modules
purely for documentation's sake.

`API_PROBLEMS.md` and `TODO.md` are backlog/problem-statement material, not specs: items
from them get promoted into a `/speckit-specify` pass (see Adoption below) and are then
removed from those files so there is one live copy of each open problem, not two. These files
stay in short, undecorated bullet-point form — no essay-style write-ups — precisely because
that prose format was itself an ad hoc, pre-spec-kit attempt at what `specs/` now does
properly; the moment an item is worth more than a bullet, it belongs in a real spec, not a
longer paragraph here.

**Doc-sync-on-change (NON-NEGOTIABLE)**: a change to a module backed by a `docs/contributors/*.md`
file, or by a top-level `docs/*.md` file, MUST update that file in the same change — never as a
promised follow-up. `/speckit-plan`'s Constitution Check gate covers this explicitly. Rationale:
this is the concrete mechanism that stops docs and code from silently diverging again, which is
exactly what happened before spec-kit was adopted (see the `docs/networking.md` vs
`src/networking.js` spot-check and the wider audit referenced in this amendment's Sync Impact
Report — some docs had drifted, some hadn't, and nothing was checking either way).

**CHANGELOG.md vs. specs/ — where reasoning lives**: for any new or changed feature going
through `specs/`, the *reasoning* (why this approach, what was tried, what broke and why) belongs
in that feature's `spec.md`/`plan.md`, not in a narrative CHANGELOG entry. `CHANGELOG.md` stays a
terse, dated, consumer-facing summary per Principle V, linking to the relevant `specs/<feature>/`
for detail instead of restating it. The existing 48+ narrative "Round N" `[Unreleased]` entries
predate this rule and remain as historical record — this governs new entries only.

When writing specs with the `spec-template.md` "User Story" / "Given/When/Then" format,
"user" means the developer consuming the hypergraph API (via `require('hypergraph')`),
not an end-user of a downstream app — hypergraph has no UI of its own.

## Adoption in an Existing Codebase

This constitution governs new and changed work from this point forward. It does NOT
require retroactive specs for existing, working modules. A 2026-09-09 docs/code audit (see
the Sync Impact Report on this amendment) found the networking rewrite that originally
motivated Principles III and IV is already substantially built (`HypergraphNetwork` in
`src/networking.js`) — `API_PROBLEMS.md` and `TODO.md` have been trimmed down to reflect only
what's genuinely still open. The first real `/speckit-specify` pass pulls one bounded item
from the now-minimal `API_PROBLEMS.md`/`TODO.md`, chosen deliberately rather than defaulted
to whichever was listed first. Later passes continue one bounded slice at a time the same way.

## Governance

This constitution supersedes ad hoc practice, including anything implied by TODO.md,
API_PROBLEMS.md, or prior CHANGELOG entries, wherever they conflict. Amendments happen via
`/speckit-constitution`, using semantic versioning for this document itself: MAJOR for a
principle removed or redefined incompatibly, MINOR for a principle or section added, PATCH
for wording/clarity fixes. Every `/speckit-plan` MUST pass the Constitution Check gate
against the current version of this file before Phase 0 research begins, and re-check
after Phase 1 design; violations are either resolved or justified in that plan's
Complexity Tracking table.

**Version**: 1.1.0 | **Ratified**: 2026-09-09 | **Last Amended**: 2026-09-09
