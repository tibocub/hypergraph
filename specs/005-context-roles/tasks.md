---

description: "Tasks for 005-context-roles"
---

# Tasks: Roles Inside the Context, and Several Indexers

Tests first for every `src/` change (encodings and apply: non-negotiable tier).

## Phase 1: Foundational

- [X] T001 Test first `test/brittle/core/event-encoding.js`: `context/writer`, `context/role`, `context/upgrade` round-trip; `context/init` with and without trailing `owner`
- [X] T002 `src/encodings/event.js`: codes 15–17, `owner` on `context/init`; `src/utils.js`: `stableContextHash`
- [X] T003 Test first `test/brittle/core/context-roles.js`: a new context is version 3, `roles()` shows the creator as owner
- [X] T004 `src/hypergraph.js` createContext writes version 3 + owner; `src/context-base.js` applies init into `meta:context` + `meta:roles`, links the bootstrap writer, `roles()`, accepts version 3

## Phase 2: US2 — decisions from the context's table

- [X] T005 [US2] Test first `test/brittle/core/context-roles.js`: `setRole` by owner works; by a non-member, by an admin for `admin`, or a forged signature is ignored; `mod.add` holder can grant `mod`
- [X] T006 [US2] Test first: closed-mode `addWriter` by a context admin is accepted, by a RoleBase-only admin refused; moderation by a context `mod` accepted, by a RoleBase-only `mod` refused (version 3)
- [X] T007 [US2] `src/context-base.js`: `context/role` apply (`#mayAssign`), `context/writer` apply, closed-mode and moderation checks from `meta:roles` in version 3; `setRole`/`removeRole`/`addWriter({ member })`; `src/hypergraph.js` `moderateAction` pre-check

## Phase 3: US1 — several indexers

- [X] T008 [US1] Test first `test/brittle/replication/indexers.js`: owner grants admin to a member whose writer was added with `member`; that writer becomes an indexer on every peer; with the owner offline, owner-less writes are confirmed by two admins within 10 s; revoking demotes but keeps writable; a member's second device added later inherits indexing
- [X] T009 [US1] Test first: the owner cannot drop its own ownership, so the owner's writer — always an indexer — cannot be demoted by a role change (the `host.removeable()` guard covers other last-indexer cases and is not exercised separately)
- [X] T010 [US1] `src/context-base.js`: promote/demote linked writers on role change; last-indexer refusal; indexer flag for `context/writer` from the member's role
- [X] T011 [US1] Test first `test/brittle/replication/indexers.js`: three peers apply role and writer events delivered in different orders and end with identical role tables and indexer sets (SC-002)

## Phase 4: US3 — conversion

- [X] T012 [US3] Test first `test/brittle/core/context-roles.js`: a version 1 context (all writers indexers) converted by its creator → only the creator indexes, others still write; a version 2 context likewise; conversion by a non-creator ignored
- [X] T013 [US3] `src/context-base.js` `context/upgrade` apply + `upgrade()`

## Phase 5: Polish

- [X] T014 Fix hypergraph's own tests that relied on RoleBase roles in new contexts (grant in the context instead); list them in the changelog
- [X] T015 Docs (plan's doc-sync list); CHANGELOG
- [X] T016 `npm test`, HyperBBS, hyperDNS; benchmark spot-check (100k join still fast-forwards)
