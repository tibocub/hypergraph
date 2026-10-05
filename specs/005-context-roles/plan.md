# Implementation Plan: Roles Inside the Context, and Several Indexers

**Branch**: `005-context-roles` | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md)

## Summary

Contexts created from now on are **version 3**: they carry their own role table, changed only by
signed role events in the context's log, and every permission decision in apply reads that table
as of that point of the log — so all peers, and all indexers, decide identically. A writer indexes
exactly when its member's role allows it (owner, admin), and is promoted or demoted when that role
changes. The creator of an older context can convert it to version 3.

## Research (measured / decided)

**R1 — Autobase supports the needed topology changes** (bare Autobase script, 2026-10-05):
re-adding an existing non-indexer with `indexer: true` promotes it; re-adding an indexer with
`indexer: false` demotes it and it stays writable; `removeWriter` then re-add works; with three
indexers and `ackInterval` 500 ms, 93 nodes → 85 signed within seconds; a newcomer to that
context fast-forwarded. `host.removeable(key)` reports whether removing a writer would remove the
last indexer.

**R2 — Where roles live.** Role table in the context view (`meta:roles`), using
`src/roles-registry.js` unchanged (`initRegistry`, `applyRoleEvent`, `can`): the same pure state
machine the RoleBase uses, now fed only from the context's own log. Default table:
`initRegistry(owner)` plus `context.index` for admin (owner has `*`).

**R3 — Who may change roles** (spec FR-003): owner (`*`) any role; members with `mod.add` may
grant `mod` or `member`; with `mod.remove` may remove a member whose role is `mod` or `member`;
nobody may grant a role above their own. Encoded once in `#mayAssign(table, author, member,
role)`.

**R4 — Writers linked to members.** A new event `context/writer` `{ key, member, author,
timestamp, signature }` adds a writer and records which member it belongs to (`w:m:<key>` →
member, `w:k:<member>:<key>` for the reverse). Authorized like today's signed `roles/addWriter`
but against the context's table (`context.write` in closed mode; any writer in open mode). The
writer indexes iff `can(table, member, 'context.index')`. The legacy unsigned `addWriter` and
`roles/addWriter` events still work in version 3 contexts and add non-indexing writers with no
member link.

**R5 — Role changes re-evaluate indexers.** After a `context/role` changes a member's role, each of
the member's linked writers is re-added with the indexer flag its new role implies. Demoting the
last indexer is refused via `host.removeable()`; the whole role change is then refused (the table
is not changed), so the decision stays all-or-nothing.

**R6 — Conversion.** `context/upgrade` `{ version: 3, owner }`, honoured only from the bootstrap
writer (like `context/init`), on a version 1 or 2 context: writes the record and the default role
table, links the bootstrap writer to the owner, and demotes every current indexer except the
bootstrap writer (from Autobase's system indexer list at that point of apply, which is the same on
every peer).

**R7 — The owner's identity.** `context/init` gains a trailing optional `owner` (device public
key) — written by `createContext()` from version 3 on. The bootstrap writer is linked to it.

**R8 — Consumer impact.** hyperDNS checks `dns.publish` with `graph.can()` against its RoleBase at
read time: untouched. Its moderation test acts as the context's creator, who is owner in the new
table. HyperBBS uses no roles. Hypergraph's own tests that moderate or add writers in a new
context with roles granted only in the RoleBase must grant the role in the context instead — a
deliberate behavior change for new contexts, recorded in the changelog.

## Design

### Events (new type codes)

| type | code | fields | accepted when |
|---|---|---|---|
| `context/writer` | 15 | key, member, author, timestamp, signature | signed by `author`; open mode: author is any member, closed: `can(author, 'context.write')` |
| `context/role` | 16 | member, role (`''` = remove), author, timestamp, signature | signed; `#mayAssign`; not demoting the last indexer |
| `context/upgrade` | 17 | version (3), owner | from the bootstrap writer, on a version 1 or 2 context |
| `context/init` | 14 | + optional trailing `owner` | unchanged rules |

Signatures: `stableContextHash(event, contextKeyHex)` over the event's fields, like relations.

### Context view

```
meta:context  → { version, rules, owner }
meta:roles    → role registry (roles-registry.js shape)
w:m:<writerKeyHex>          → { member }
w:k:<member>:<writerKeyHex> → {}
```

### Decisions in version 3 contexts

| decision | source |
|---|---|
| closed-mode writer add/remove (`roles/addWriter`, `roles/removeWriter`, `context/writer`) | `can(meta:roles, author, 'context.write')` |
| moderation (`moderation/action`) | `can(meta:roles, author, action)` |
| indexer status of a writer | `can(meta:roles, member, 'context.index')` |
| role changes | `#mayAssign` (R3) |

No RoleBase lookups, no pending queues: the table is always local to the apply.

### API

- `graph.createContext()` creates version 3 (owner = this device).
- `context.addWriter(key, { keyPair, member })` — in version 3, appends a signed `context/writer`
  (keyPair required; `member` optional, defaults to none → non-indexing writer).
- `context.setRole(member, role, { keyPair })`, `context.removeRole(member, { keyPair })`.
- `await context.roles()` → `{ roles, members }` (the table).
- `context.upgrade({ keyPair })` — creator only; converts a version 1 or 2 context.
- `graph.moderateAction()`: the client-side pre-check uses the context's table in version 3.
- `status()` reports version 3.

## Constitution Check

- **I**: every decision now comes from the context's own linearized log — this feature *removes*
  the cross-log non-determinism documented in spec 003 R4 for version 3 contexts. PASS.
- **II**: new event types (encodings) and apply logic → failing tests first. PASS.
- **III**: reuses `roles-registry.js` and Autobase's own indexer flag. PASS.
- **IV**: role methods on the context, mirroring the RoleBase's `setRole` naming. PASS.
- **V**: changelog: new contexts take roles from the context, not the RoleBase. PASS.
- Doc-sync: `docs/contexts-and-roles.md`, `docs/contributors/event-encoding.md`,
  `docs/contributors/index-structure.md`, `docs/contributors/autobase-integration.md`,
  `docs/contributors/critical-implementation-details.md`, `docs/glossary.md`.
