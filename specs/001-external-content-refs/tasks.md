---

description: "Task list for 001-external-content-refs"
---

# Tasks: External Content References

**Input**: Design documents from `/specs/001-external-content-refs/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Test tasks are the DEFAULT here, per constitution Principle II and its project-wide
regression rule. Every test task below is paired with an explicit **verify-it-fails** step. This is
not ceremony: this project has twice shipped tests that passed *without* their fix and were
therefore worthless. A test that has never been seen red proves nothing.

**Organization**: Grouped by user story so each can be implemented and tested independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: US1–US4, mapping to the user stories in spec.md
- Exact file paths are included in every task

## Hard constraints (apply to every task)

- `src/view.js` and `src/encodings/event.js` MUST remain **unchanged**. No wire-format change, no
  apply-path change. If a task seems to require touching either, stop — the design is wrong.
- **No new npm dependency.** Address parsing uses the built-in `URL` class.
- The content-type marker is the plain string `link`, exported as `CONTENT_LINK_TYPE`.
- `formatReference` **throws** on bad input. `parseReference` **never throws**.
- On Windows, spec-kit scripts need `PYTHONIOENCODING=utf-8` or they crash on non-ASCII output.

---

## Phase 1: Setup

- [x] T001 Confirm a clean baseline: run `npm test` at repo root and record that the full suite passes before any change, so later failures are unambiguously attributable to this feature
- [x] T002 Confirm `package.json` dependencies before starting, so the no-new-dependency constraint can be verified by diff at the end

---

## Phase 2: Foundational — the format module

**Blocking**: every user story depends on this. Nothing else starts until Phase 2 is done.

This module is pure — no file I/O, no crypto, no graph access — so it is fully unit-testable
without standing up a graph.

- [x] T003 Write failing tests for `formatReference()` in `test/brittle/core/content-ref-format.js`: round-trip every field (single address; multiple addresses; with and without `digest`; `mutable` true and false), asserting the parsed result equals the input
- [x] T004 Write failing tests for `formatReference()` rejection in `test/brittle/core/content-ref-format.js`: it MUST throw on each of — empty `src`, `src` not an array, an entry that is not a parseable URI, an entry with no scheme, `size` negative, `size` not an integer, `type` missing or empty, `mutable` not a boolean, `digest` present but not matching `<algo>:<hex>`
- [x] T005 Write failing tests for `parseReference()` tolerance in `test/brittle/core/content-ref-format.js`: it MUST NOT throw on any of — invalid JSON, JSON that is not an object, a JSON array, `null`, empty string, missing required fields, wrong-typed fields, unknown `v`. Each returns `{ valid: false, error: <string> }`
- [x] T006 Run `npx brittle test/brittle/core/content-ref-format.js` and confirm every test from T003–T005 **fails** (module does not exist yet). Record the failure output
- [x] T007 Create `src/content-ref.js` exporting `CONTENT_LINK_TYPE = 'link'`, `formatReference(ref)`, `parseReference(body)`, and `isReferenceType(contentType)`. Implement per `data-model.md`: payload is `{ v: 1, src: [...], size, type, mutable, digest? }`; `src` accepts a bare string and normalizes to a one-element array; validation rules exactly as listed in T004; `parseReference` returns `{ valid, error, src: [{ scheme, address }], size, type, mutable, digest }` and never throws
- [x] T008 Run `npx brittle test/brittle/core/content-ref-format.js` and confirm all tests now **pass**
- [x] T009 Export `CONTENT_LINK_TYPE` from the package entry point in `index.js` so consumers never hardcode the string

**Checkpoint**: the format module is correct and proven in isolation.

---

## Phase 3: User Story 1 — Reference content without ingesting it (P1)

**Goal**: An entity's content can be an address instead of bytes, and storing one costs the graph
essentially nothing regardless of how large the referenced content is.

**Independent test**: Store a reference declaring multi-gigabyte content; the context's on-disk size
grows by only the payload.

- [x] T010 [US1] Write a failing test in `test/brittle/core/content-ref-api.js` that calls `graph.putContentRef()` with a valid reference and asserts `getContent()` returns it with `contentType === 'link'` and a parsed `reference` object matching what was written
- [x] T011 [US1] Write a failing test in `test/brittle/core/content-ref-api.js` measuring the context's on-disk size before and after storing a reference declaring `size: 2147483648`, then after storing a second declaring ten times that; assert both grow by only the payload size and that the two growths are effectively equal (SC-001)
- [x] T012 [US1] Write a failing test in `test/brittle/core/content-ref-api.js` asserting `putContentRef()` throws on a malformed reference, and that nothing is appended when it does
- [x] T013 [US1] Write a failing test in `test/brittle/core/content-ref-api.js` asserting `getContent()` on a record whose payload is malformed returns `reference.valid === false` with an `error` string, still exposes the raw `body`, and does **not** throw
- [x] T014 [US1] Run `npx brittle test/brittle/core/content-ref-api.js` and confirm T010–T013 all **fail**
- [x] T015 [US1] Add `putContentRef(entityId, reference, opts)` to `src/hypergraph.js` per `contracts/api.md`: validate via `formatReference()`, then delegate to the existing `putContent()` with `contentType = CONTENT_LINK_TYPE` and the serialized payload as body, passing `opts.scope` straight through. Return `{ entityId, contentType, reference }`
- [x] T016 [US1] Extend `getContent()` in `src/hypergraph.js` to attach a parsed `reference` field when `isReferenceType(record.contentType)`, leaving `body` and every existing field untouched. Attach nothing for inline content, and nothing when `body` is `null` (no scope key)
- [x] T017 [US1] Run `npx brittle test/brittle/core/content-ref-api.js` and confirm T010–T013 now **pass**
- [x] T018 [US1] Run `npm run test:core` and confirm no existing core test regressed

**Checkpoint**: US1 delivers the feature's entire justification and is independently shippable.

---

## Phase 4: User Story 2 — Uniform addressing (P1)

**Goal**: One code path resolves references to any backend, branching only on scheme, with no
backend-specific code anywhere in `src/`.

**Independent test**: Store references to several different backends and resolve them all in one
loop that switches on `scheme`.

- [x] T019 [P] [US2] Write a failing test in `test/brittle/core/content-ref-api.js` storing references using `swarmfs:`, `hyper:`, `https:` and `hypergraph:` addresses on different entities, then resolving all of them through a single loop that branches only on `reference.src[0].scheme`
- [x] T020 [P] [US2] Write a failing test in `test/brittle/core/content-ref-api.js` storing a reference whose only address uses an undefined scheme (`somefuturebackend://abc`), asserting it reads back `valid: true` with the scheme reported — well-formed but unresolvable here — and does not throw (SC-005)
- [x] T021 [P] [US2] Write a failing test in `test/brittle/core/content-ref-api.js` with `src` ordered `[unknown-scheme, swarmfs]`, asserting preference order is preserved so a consumer can skip to the entry it supports (FR-016)
- [x] T022 [US2] Run `npx brittle test/brittle/core/content-ref-api.js` and confirm T019–T021 **fail** if anything is missing, then make them pass. Most should already pass from Phase 2–3 work; any that do not indicate a real gap in `src/content-ref.js`
- [x] T023 [US2] Grep `src/` for backend names (`swarmfs`, `hyperdrive`, `hyperblobs`) and confirm zero matches outside comments and the docs — no scheme-specific logic exists (SC-003)

**Checkpoint**: the address grammar is proven to work uniformly across backends.

---

## Phase 5: User Story 3 — Stable address while content changes (P2)

**Goal**: Replacing a reference does not change the entity id, break its relations and tags, or
destroy earlier versions.

**Independent test**: Store a reference, replace it, confirm the entity id and everything pointing
at it survive.

- [x] T024 [P] [US3] Write a failing test in `test/brittle/core/content-ref-api.js`: create an entity, store a reference, add a relation and a tag pointing at it, store a *different* reference for the same entity, then assert `getContent()` returns the newest, the entity id is unchanged, and the relation and tag still resolve (FR-011, SC-006)
- [x] T025 [P] [US3] Write a failing test in `test/brittle/core/content-ref-api.js` asserting an entity can switch from reference to inline content and back, with each version discriminated correctly by `contentType` (data-model.md state transitions)
- [x] T026 [US3] Write a failing test in `test/brittle/replication/content-ref-replication.js`: two peers on one context, each stores a *different* reference for the same entity while unable to see each other, then they reconnect. Assert both converge on the same reference, and that the superseded version remains addressable — convergence must not mean silent data loss (FR-012, SC-002, Principle I)
- [x] T027 [US3] Write a failing test in `test/brittle/replication/content-ref-replication.js` where one peer appends a **malformed** payload directly via `putContent()` (bypassing validation, as a hostile peer would). Assert the receiving peer keeps applying, converges on everything else, surfaces that record as `valid: false`, and that apply neither stalls nor corrupts the view (FR-015, SC-004)
- [x] T028 [US3] Confirm `test/brittle/replication/content-ref-replication.js` contains **no** `process.exit()` call — per CLAUDE.md, a force-exit in one replication file silently truncates sibling files' tests
- [x] T029 [US3] Run both test files and confirm T024–T027 pass; investigate any that passed *before* implementation, since that indicates the test is not actually exercising the behavior

**Checkpoint**: convergence and stability are pinned by tests, not merely inherited by assumption.

---

## Phase 6: User Story 4 — Restrict who learns the address (P3)

**Goal**: A reference stored under a read scope is readable only by scope members.

**Independent test**: Read the same scoped reference as a member and as a non-member.

- [x] T030 [P] [US4] Write a failing test in `test/brittle/core/content-encryption.js` storing a reference with `opts.scope`, asserting a scope member reads back a valid parsed `reference` (FR-014, SC-007)
- [x] T031 [P] [US4] Write a failing test in `test/brittle/core/content-encryption.js` asserting a non-member gets `body: null`, no `reference` field, and no recoverable part of any address — while still being able to tell that referenced content exists
- [x] T032 [P] [US4] Write a failing test in `test/brittle/core/content-encryption.js` rotating the scope key and asserting a reference stored under an earlier epoch behaves exactly as scoped inline content does, with no reference-specific divergence
- [x] T033 [US4] Run `npm run test:core` and confirm T030–T032 pass and no existing encryption test regressed

**Checkpoint**: all four user stories complete.

---

## Phase 7: Polish & Cross-Cutting Concerns

### Documentation (doc-sync-on-change — MUST land in this same change)

- [x] T034 [P] Update `docs/storage-model.md`: content may now hold an address instead of bytes, marked by `contentType: 'link'`; explain that the referenced content never enters the graph
- [x] T035 [P] Update `docs/contributors/index-structure.md`: note that references are ordinary content records at `c:<entityId>:<sortableSeq>`, so no new index or key prefix exists
- [x] T036 [P] Update `docs/contributors/event-encoding.md`: record that **no encoding change was required**, and why — a future reader will expect a `content/ref` event type and should learn why there isn't one
- [x] T037 [P] Add a `CHANGELOG.md` entry: additive feature, not a break. State the new `putContentRef()`, the `reference` field on `getContent()`, and the `link` content type. Link to `specs/001-external-content-refs/` for reasoning rather than restating it

### Tooling fix found during this work

- [x] T038 [P] Add a note to `CLAUDE.md` that spec-kit's Python scripts need `PYTHONIOENCODING=utf-8` on Windows, or they crash with a `UnicodeEncodeError` when their output contains non-ASCII characters. Confirmed while running `setup_tasks.py`

### Final verification

- [x] T039 Confirm `git diff` shows `src/view.js` and `src/encodings/event.js` **unchanged**
- [x] T040 Confirm `git diff package.json` shows no dependency added
- [x] T041 Run `npm test` at repo root; full suite must pass
- [x] T042 Run `npm test` in `E:\Code\P2P\HyperBBS`; must pass — it is symlinked to this working tree and receives this change instantly
- [x] T043 Run `npm test` in `E:\Code\P2P\hyperDNS`; must pass, same reason
- [x] T044 Walk `specs/001-external-content-refs/quickstart.md` and tick off its Definition of Done, including that every new test was seen to fail before its implementation

---

## Dependencies

```text
Phase 1 (Setup)
   ↓
Phase 2 (Foundational: src/content-ref.js) ← BLOCKS EVERYTHING
   ↓
Phase 3 (US1) ← the MVP; delivers the feature's whole point
   ↓
   ├── Phase 4 (US2) ─┐
   ├── Phase 5 (US3) ─┤ independent of each other; can run in any order or in parallel
   └── Phase 6 (US4) ─┘
   ↓
Phase 7 (Polish, docs, cross-repo verification)
```

- **US2, US3 and US4 do not depend on one another.** Each only needs Phase 3 complete.
- US3's replication tasks (T026–T028) are the slowest — they use a real network. Start them early
  if working in parallel.

## Parallel opportunities

- T034–T038 are all different files and can be done together.
- T019–T021 (US2) are in one file but independent tests; they can be written in one pass.
- T030–T032 (US4) likewise.
- Phases 4, 5 and 6 can proceed simultaneously once Phase 3 is done.

## Implementation strategy

**MVP = Phase 1 + Phase 2 + Phase 3.** That delivers the entire justification for the feature: an
entity can point at content the graph does not hold, at constant cost. It is independently useful
and shippable; the remaining phases prove properties that are largely inherited from existing
content behavior rather than newly built.

**Suggested stopping points**: after Phase 3 (working feature), after Phase 6 (fully proven),
after Phase 7 (documented and verified across the other repos).

**Do not skip Phase 7's cross-repo runs.** HyperBBS and hyperDNS resolve hypergraph through
symlinks to this working tree, so this change is live in both the moment it is saved.
