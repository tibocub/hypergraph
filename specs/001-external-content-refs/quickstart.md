# Quickstart & Validation: External Content References

How to prove this feature works. Scenarios map to spec Success Criteria; each names the test file
that will pin it.

## Prerequisites

```bash
cd E:\Code\P2P\hypergraph
npm install
```

Tests use `brittle`. Per `CLAUDE.md`: **never call `process.exit()` in a real-network test file** —
suites run every file in one process, and a force-exit truncates sibling files silently.

## Running

```bash
npm test                                       # full suite
npm run test:core                              # unit + API scenarios
npm run test:replication                       # two-peer scenarios
npx brittle test/brittle/core/content-ref-format.js    # one file
```

---

## Scenario 1 — A reference costs the graph nothing (SC-001)

*The feature's entire justification.*

Create an entity, store a reference declaring multi-gigabyte content, and measure the context's
on-disk size before and after. Growth must be proportional to the payload (hundreds of bytes), not
to the declared size. Then store a second reference declaring a size an order of magnitude larger
and confirm growth is effectively identical.

**Expected**: storage growth is independent of declared content size. No network activity occurs —
nothing is fetched, because nothing exists to fetch.

**Pins**: `test/brittle/core/content-ref-api.js`

---

## Scenario 2 — Round-trip and malformed tolerance (SC-004)

Unit-level, no graph required.

- `formatReference` → `parseReference` round-trips every field for: one address; several addresses;
  with and without a digest; `mutable` both ways.
- `formatReference` **throws** on each write-time rule in `data-model.md`: empty `src`, a non-URI
  entry, a scheme-less entry, negative or non-integer `size`, missing `type`, non-boolean
  `mutable`, malformed `digest`, unknown `v`.
- `parseReference` **never throws** on any of: invalid JSON, JSON that is not an object, an array,
  `null`, a missing field, a wrong-typed field, an unknown `v`, a deeply nested payload, an empty
  string. Each returns `{ valid: false, error }`.

**Expected**: the throwing/non-throwing split holds exactly. This is the property that keeps a
hostile peer from causing a denial of service.

**Pins**: `test/brittle/core/content-ref-format.js`

---

## Scenario 3 — Unknown schemes degrade (SC-005)

Store a reference whose only address uses a scheme nobody has defined
(`somefuturebackend://abc`). Read it back.

**Expected**: `getContent()` returns `valid: true` — the reference is *well-formed*, merely
unresolvable here — with `src[0].scheme` reporting the scheme so a consumer can name precisely
what it lacked. No throw.

Also: a reference offering `[unknown, swarmfs]` lets a consumer skip to the entry it supports,
confirming preference order is usable (FR-016).

**Pins**: `test/brittle/core/content-ref-api.js`

---

## Scenario 4 — Stable address across changes (SC-006)

Create an entity, store a reference, add a relation and a tag pointing at it, then store a
different reference for the same entity.

**Expected**: `getContent()` returns the newest reference; the entity id is unchanged; the relation
and tag still resolve; the earlier version remains addressable at its own sequence. Then store
*inline* content on the same entity and confirm the switch works in both directions, discriminated
per version by `contentType`.

**Pins**: `test/brittle/core/content-ref-api.js`

---

## Scenario 5 — Two peers converge (SC-002)

Two peers, real Hyperswarm, both writers on one context. Partition them, have each store a
*different* reference for the same entity, reconnect, and let replication settle.

**Expected**: both peers return the **same** reference, with no manual intervention. Also assert
the loser's version remains addressable — convergence must not mean silent data loss (Principle I).

Second case in the same file: a peer writes a **malformed** payload directly (bypassing
`putContentRef`, as a hostile peer would). The receiving peer must continue applying, converge on
everything else, and surface that one record as `valid: false`. **Apply must not stall and the view
must not be corrupted.**

**Pins**: `test/brittle/replication/content-ref-replication.js`

> This scenario is not strictly required by Principle II's non-negotiable tier — the wire encoding
> is unchanged, so that tier is not triggered. It is written anyway: a reference that survives a
> local write but not a round trip through replication is precisely the class of bug this project
> has repeatedly re-discovered.

---

## Scenario 6 — Scoped references stay private (SC-007)

Store a reference under a read scope. Read as a member and as a non-member.

**Expected**: the member gets a parsed `reference`; the non-member gets `body: null`, no
`reference`, and no recoverable part of any address — while still being able to tell that
referenced content exists. Then rotate the scope key and confirm behavior matches existing
scoped-content behavior exactly, with no reference-specific divergence.

**Pins**: `test/brittle/core/content-encryption.js` (extended)

---

## Scenario 7 — Uniform addressing (SC-003, SC-008)

Store references to several backends on different entities — `swarmfs:`, `hyper:`, `https:`,
`hypergraph:` — and resolve them all through one loop that branches only on `scheme`.

**Expected**: one code path handles all of them. No backend-specific code exists anywhere in
`src/`, and `package.json` gained no dependency. This is the contract other projects rely on.

**Pins**: `test/brittle/core/content-ref-api.js`

---

## Definition of done

- [ ] All seven scenarios pass.
- [ ] Full `npm test` green — no regression in existing content, encryption, or replication suites.
- [ ] Each new test verified to **fail before** its implementation and pass after. (A test that
      passes without its fix is worthless; this has already bitten this project twice.)
- [ ] `package.json` dependencies unchanged.
- [ ] `src/view.js`, `src/encodings/event.js` unchanged.
- [ ] Consumers re-verified against the working tree, since both are symlinked to it:
      ```bash
      cd E:\Code\P2P\HyperBBS && npm test
      cd E:\Code\P2P\hyperDNS  && npm test
      ```
- [ ] Doc-sync in the same change: `docs/storage-model.md`,
      `docs/contributors/index-structure.md`, `docs/contributors/event-encoding.md`.
- [ ] `CHANGELOG.md` entry (additive feature, not a break).
- [ ] `contracts/address-grammar.md` agreement checklist reviewed before any sibling repo builds
      against it.
