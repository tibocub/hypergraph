---

description: "Tasks for 006-role-invites"
---

# Tasks: Invite Links That Carry a Role

Tests first (encodings and apply: non-negotiable tier).

## Phase 1: Foundational

- [X] T001 Test first `test/brittle/core/event-encoding.js`: `context/invite`, `context/redeem` round-trip
- [X] T002 `src/encodings/event.js` codes 18–19; `src/utils.js` digests for invite/redeem
- [X] T003 Test first `test/brittle/replication/invites.js`: streams from `graph.replicate()` let a peer discover a non-writer's log (a redeem is applied by the minter)
- [X] T004 `src/hypergraph.js`: one shared `ProtomuxWakeup`, passed to every context; `graph.replicate()` adds streams to it; `src/networking.js` replicates through `graph.replicate()`; `package.json` adds `protomux-wakeup`; `src/context-base.js` Autobase `optimistic: true`, `wakeup`, apply skips non-writer blocks other than redemptions

## Phase 2: US1 + US2

- [X] T005 [US1] Test first `test/brittle/replication/invites.js`: owner mints an admin invite; a peer with only the link redeems it with the owner merely replicating; it becomes a writer, admin on every peer, and an indexer; a member invite gives a non-indexing writer
- [X] T006 [US2] Test first: unauthorized minting (a plain member minting admin) ignored and unredeemable; single-use reused → refused; revoked → refused; wrong secret → refused; a non-writer's stray block ignored; two concurrent redemptions of the last use → exactly one wins, same on every peer
- [X] T007 `src/context-base.js`: invite/redeem apply, `createInvite`/`revokeInvite`/`invites()`; `src/hypergraph.js`: `parseInvite`, `redeemInvite`

## Phase 3: Polish

- [X] T008 Docs: contexts-and-roles (invites), networking (`graph.replicate()` and writer discovery), event-encoding, index-structure, autobase-integration, README; CHANGELOG
- [X] T009 `npm test`, HyperBBS, hyperDNS

## Phase 4 (later): US3 — read-scope invites

- [X] T010 [US3] Test first `test/brittle/core/event-encoding.js`: scoped `context/invite` and `context/redeem` with `encryptionKey` round-trip; old ones keep their bytes
- [X] T011 [US3] Test first `test/brittle/replication/scope-invites.js`: owner mints an invite with a scope; a peer with only the link redeems; the owner's `update()` grants the key; the peer reads encrypted content. Also: a minter without the key can't mint; an unentitled minter's scoped invite (forged with append) gets no grant from another key holder; a revoked member is not re-granted; a plain invite grants no key
- [X] T012 [US3] `src/encodings/event.js`, `src/utils.js` (hash), `src/context-base.js` (apply, `scopeRequests()`, `createInvite({ scope })`, `redeem` with encryption key), `src/hypergraph.js` (`createInvite` pass-through of ScopeBase/RoleBase keys, `#grantInvitedScopes` in `update()`, `redeemInvite` opening bases, `scopeTimeout`)
- [X] T013 [US3] Docs: read-permission (invites section replaces the blind-pairing note), contexts-and-roles, event-encoding, index-structure; CHANGELOG; full suite, HyperBBS, hyperDNS — 312/312; HyperBBS and hyperDNS green (they use no invite API). Also fixed: redeemInvite() hang with several indexers (waits on the confirmed view now)
