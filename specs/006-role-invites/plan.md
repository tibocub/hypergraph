# Implementation Plan: Invite Links That Carry a Role

**Branch**: `006-role-invites` | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md)

## Summary

An authorized member mints an invite in a version 3 context (a public key, a role, a use limit);
the link carries the context key and the invite's secret seed. The holder redeems it by appending
a `context/redeem` block **as a non-writer** (an Autobase optimistic block); every peer's apply
checks it against the context's own record and, if valid, acknowledges and adds the redeemer's
device as a writer with the invite's role. Phase 1: roles. Phase 2 (later): read-scope keys.

## Research

**R1 — Optimistic redemption works** (bare Autobase, 2026-10-05): with `optimistic: true`, a
non-writer appends `{ optimistic: true }`; every peer's `apply` receives it flagged `optimistic`;
calling `host.ackWriter(from.key)` + `host.addWriter(from.key)` applies it and makes the peer a
writer, whose later appends reach everyone. A wrong secret and unrelated non-writer blocks were
ignored. Not acknowledged → never applied (same as today for non-writers).

**R2 — Writer discovery needs Autobase's wakeup protocol on the stream.** With plain
`store.replicate()` the owner never learned the redeemer's log existed (nothing applied); with
`base.replicate()` (which adds the stream to the base's `ProtomuxWakeup`) everything worked.
Decision: Hypergraph owns one `ProtomuxWakeup`, passed as Autobase's `wakeup` option to every
context, and `graph.replicate()` adds each stream to it; `HypergraphNetwork` replicates through
`graph.replicate()`. `protomux-wakeup` becomes a direct dependency (already installed through
Autobase).

**R3 — No behavior change for other non-writer blocks.** Autobase only takes the optimistic path for
nodes from non-writers flagged optimistic; un-acknowledged ones are skipped exactly as with
`optimistic: false` (`apply-state.js`), and writers' own appends take the normal path.

**R4 — Expiry is not enforceable** (author-claimed times); use limit + revocation are.

## Design

Events (signed with `stableContextHash`-style digests bound to the context):

| type | code | fields | accepted when |
|---|---|---|---|
| `context/invite` | 18 | inviteKey, role, uses, author, timestamp, signature | version 3; author may grant `role` to a new member (spec 005 `#mayAssign`); `uses: 0` revokes (author is the minter, or may grant that role) |
| `context/redeem` | 19 | inviteKey, member, key, timestamp, signature (invite key), memberSignature | invite exists, not revoked, uses left; both signatures valid; `key` equals the appending writer's key |

Apply for `context/redeem`: count the use; give `member` the invite's role if they have none yet
(an invite never lowers an existing role); link the writer to the member; if it came from a
non-writer, `host.ackWriter(key)`; `host.addWriter(key, { indexer })` with indexing from the role.
Non-writer (optimistic) blocks of any other type are skipped.

View: `inv:<inviteKey> → { role, uses, used, author }`.

Link: `hypergraph://invite/<contextKeyHex>/<seedHex>`; `Hypergraph.parseInvite(link)` →
`{ context, seed, inviteKey }`.

API:
- `await context.createInvite({ role = 'member', uses = 1, keyPair })` → link
- `await context.revokeInvite(linkOrInviteKey, { keyPair })`
- `await graph.redeemInvite(link, { timeout })` → the opened context, resolves once this device is a
  writer (or rejects on timeout)
- `await context.invites()` → `{ inviteKeyHex: { role, uses, used, revoked, author } }`
- `graph.replicate()` now carries writer discovery.

## Constitution Check

- **I**: every decision from the context's log (invite record, uses counter, role table); competing
  redemptions resolved by the context's order. Optimistic blocks other than valid redemptions are
  ignored. PASS.
- **II**: new event types and apply → failing tests first. PASS.
- **III**: Autobase's own optimistic and wakeup mechanisms. PASS.
- **IV**: invite methods on the context; redemption on the graph (it opens the context). PASS.
- **V**: changelog: apps replicating with `store.replicate()` must use `graph.replicate()` for invites.
- Doc-sync: contexts-and-roles, networking (graph.replicate carries wakeup), event-encoding,
  index-structure, autobase-integration, README.
