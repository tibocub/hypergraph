# Tasks: A space's own types, added by its deciders

**Input**: [spec.md](spec.md), [plan.md](plan.md).

## Phase 1: User Story 1 - a decider adds types to one live space (P1)

- [X] T001 [US1] Tests first in test/next/unit/space-types.js: declareTypes adds and keeps the space's types;
      same declaration records nothing; field added at the end recorded; retype, onePerMember change,
      `hg/` name, unknown link target refused; sub-space refused; two peers: member refused, member reads the
      owner's post and votes with a type its app never declared
- [X] T002 [US1] `Types.adding()` in lib/types.js
- [X] T003 [US1] `space.declareTypes()` in lib/space.js (in `OPENING`), and in lib/scope.js `METHODS`

## Phase 2: User Story 2 - the engine's own app keeps updating (P1)

- [X] T004 [US2] Tests: engine's updated app keeps a space's declared types; the old `TYPES_BEHIND` test now
      expects the admin to record on top
- [X] T005 [US2] `types.over()` in lib/types.js; `#recordTypes()` merges, only in spaces sharing a type with
      the app; `TYPES_BEHIND` removed

## Phase 3: Polish

- [X] T006 Forum scenario: a forum site in an engine with other types, owner declares through its site handle
      (test/next/forum/engine.js)
- [X] T007 docs/next/api.md, docs/next/concepts.md, CHANGELOG.md
- [X] T008 Suites: hypergraph, SwarmFS, HyperBBS, hyperDNS, one after another
