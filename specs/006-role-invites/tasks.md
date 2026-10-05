---

description: "Tasks for 006-role-invites"
---

# Tasks: Invite Links That Carry a Role

Tests first (encodings and apply: non-negotiable tier).

## Phase 1: Foundational

- [ ] T001 Test first `test/brittle/core/event-encoding.js`: `context/invite`, `context/redeem` round-trip
- [ ] T002 `src/encodings/event.js` codes 18–19; `src/utils.js` digests for invite/redeem
- [ ] T003 Test first `test/brittle/replication/invites.js`: streams from `graph.replicate()` let a peer discover a non-writer's log (a redeem is applied by the minter)
- [ ] T004 `src/hypergraph.js`: one shared `ProtomuxWakeup`, passed to every context; `graph.replicate()` adds streams to it; `src/networking.js` replicates through `graph.replicate()`; `package.json` adds `protomux-wakeup`; `src/context-base.js` Autobase `optimistic: true`, `wakeup`, apply skips non-writer blocks other than redemptions

## Phase 2: US1 + US2

- [ ] T005 [US1] Test first `test/brittle/replication/invites.js`: owner mints an admin invite; a peer with only the link redeems it with the owner merely replicating; it becomes a writer, admin on every peer, and an indexer; a member invite gives a non-indexing writer
- [ ] T006 [US2] Test first: unauthorized minting (a plain member minting admin) ignored and unredeemable; single-use reused → refused; revoked → refused; wrong secret → refused; a non-writer's stray block ignored; two concurrent redemptions of the last use → exactly one wins, same on every peer
- [ ] T007 `src/context-base.js`: invite/redeem apply, `createInvite`/`revokeInvite`/`invites()`; `src/hypergraph.js`: `parseInvite`, `redeemInvite`

## Phase 3: Polish

- [ ] T008 Docs: contexts-and-roles (invites), networking (`graph.replicate()` and writer discovery), event-encoding, index-structure, autobase-integration, README; CHANGELOG
- [ ] T009 `npm test`, HyperBBS, hyperDNS

## Phase 4 (later): US3 — read-scope invites

- [ ] T010 Invite carries a scope; a member holding the scope key grants it to the redeemer's encryption key on `update()`
