# Research: Fast-Forward Joins, Indexer Topology and App Validation Rules

Measurements: `bench/scale.js`, `bench/multiwriter.js` (with temporary toggles in the
`perf-experiments` worktree), Windows 10, 16 GB, Node 26.4, autobase 7.28.1, 2026-10-05.

## R1 — Who indexes, and acks

**Measured** (3 writers × 2,000 files, `bench/multiwriter.js`):

| topology | acks | converged | view blocks confirmed |
|---|---|---|---|
| every writer an indexer (today) | off (today) | 22.9 s | 0 of 24,013 |
| every writer an indexer | 1,000 ms | 31.4 s | 24,013 of 24,013 |
| **creator only indexes, others write** | 1,000 ms | **13.1 s** | 24,013 of 24,013 |

**Decision**: new contexts make the creator the sole indexer; every writer added later is a
non-indexing writer (`host.addWriter(key, { indexer: false })`). Acks on with
`tuning.ACK_INTERVAL = 1000` ms (Autobase's own default).

**Rationale**: one indexer confirms its own view of the linearized log without waiting on anyone,
so confirmation is fastest and agreement is trivially deterministic (R4). It is also the most
conservative trust model: a fast-forwarding member trusts exactly one party, the context's
creator.

**Deferred to a second phase**: appointing further indexers (spec FR-003, FR-006). It needs
permission decisions in apply to be identical on every indexer (R4), which they are not today.

**Alternatives**: keep every writer an indexer with acks on — confirms, but slower (31 s vs 13 s
above) and makes every member a party whose signature newcomers trust; an untrusted forum member
should not be able to stall or co-sign the shared index.

## R2 — Fast-forward on join

**Measured**, single-writer context, fresh peer replicating the context only:

| entries | replay (today) | fast-forward |
|---|---|---|
| 20,000 | 17.2 s, 826 MB peak, 81 MB disk | 1.2 s, 288 MB, 39 MB |
| 100,000 | 132 s, ~3 GB peak (full join) | **0.85 s, 325 MB, 64 MB** |

Fast-forwarding peers make one apply call and fetch index blocks on first read: a 1,000-entry
folder listing took ~650 ms on localhost (vs ~380 ms local). After fast-forward the peer applies
new events normally.

**Trigger** (`autobase/index.js` `_queueFastForward`): Autobase fast-forwards when the signed
system length is at least `FastForward.MINIMUM` (16) system nodes ahead of the local one. A peer
may start replaying first and be switched to fast-forward mid-way as soon as it learns how far
behind it is — confirmed at 100k (one apply call). With small contexts (≈20 system nodes, e.g.
3 writers × 2 bulk calls), the newcomer often finishes replaying before it learns the signed
length (fast-forwarded in 1 of 4 runs) — harmless: replaying a small context is cheap.

**Tried and dropped**: pausing a fresh peer's Autobase until it learns the signed length — the
system core does not learn its remote length while the base is paused, so the hold only adds
delay (9 s joins, 0 of 5 fast-forwarded).

**Decision**: enable `fastForward` (Autobase's default) for every context, with an opt-out
(`fastForward: false`) for peers that want to replay and verify everything themselves.

## R3 — Recording a context's topology: a `context/init` event

Autobase's `apply` must reach the same decisions on every peer from the log alone. Whether an
added writer indexes therefore cannot depend on local configuration: it must be declared in the
log. **Decision**: `createContext()` appends a `context/init` event first
(`{ version: 2, rules: '<app rules id>' }`). Apply honours it only from the bootstrap writer and
only once, storing it in the view as the context's record. Writers added to a context with a
version ≥ 2 record are non-indexers; a context without one is version 1 (previous behavior:
every writer an indexer).

- A new event type means a new type code in `src/encodings/event.js` (non-negotiable test tier).
  Older peers decode unknown codes to `{ type: undefined }` and ignore them — they would keep
  making writers indexers and diverge. Mixed versions in one context are therefore not
  supported; the upgrade note says so. New peers interrupt (`host.interrupt`) on a context version
  they do not know, instead of guessing (FR-018).
- The record is also where spec 002 P2's per-context index layout will be declared.

## R4 — Determinism of permission checks in apply

`ContextBase#isWriterChangeAllowed` / `#isModerationAllowed` consult the attached RoleBase — a
separate Autobase that reaches each peer at its own pace — with a bounded retry and a pending
queue. Two peers can decide the same event differently.

- With every peer building its own view (today) the difference is local.
- With one indexer (this phase), agreement is trivial; a non-indexer whose local decision
  differs gets a view that does not match the signed one, cannot commit it, and fast-forwards to
  the signed state when it is ≥ 16 nodes behind.
- With several indexers, differing decisions mean no quorum. **That is why multi-indexer
  appointment is deferred**: it needs role decisions made from the context's own log (e.g. role
  grants recorded in the context, or events pinning the RoleBase length they were authorized
  against) — a design of its own.

## R5 — App validation rules

**Decision**: `createContext({ rules })` / `openContext(key, { rules })` with
`rules = { id, validate(event, reader) }`.

- Runs in apply after the built-in checks, for app data events: `relation/create`,
  `relation/delete`, `tag/add`, `tag/remove`, `message`. Governance events (writer changes,
  moderation, `context/init`) keep their built-in rules only.
- `reader` is read-only, backed by apply's own batch, with semantic methods only (`hasEdge`,
  `edges`, `countIn`, `countOut`, `hasTag`), so rules see the index as it stood before the event,
  identically on every peer, and do not depend on the key layout (which spec 002 P2 changes).
- Returns `true` to accept; anything else, a throw, or a rejected promise rejects the event.
- The rules id is recorded in `context/init`. A peer whose `rules.id` does not match the
  context's record interrupts the context with a clear reason (FR-016) rather than applying with
  different rules. A rules id cannot change after creation in this phase.

**Why indexers matter for rules**: a fast-forwarding member does not re-run rules on history; it
trusts that the signed state was built with them. With the creator as sole indexer, the
creator's rules are the context's rules.

**Alternative rejected**: rules as data (e.g. a declarative schema stored in the context) — far
less expressive than SwarmFS needs ("only the folder's owner adds to it"), and a schema
interpreter is a bigger surface than one deterministic function.

## R6 — Existing (version 1) contexts

Opened by this version: no `context/init` → version 1 → every added writer still indexes,
exactly as before. Acks and fast-forward now apply to them too (R1 shows all-indexer contexts
confirm with acks, just slower). Converting a version 1 context (US4) needs an owner-signed
upgrade event and demoting existing indexers; it depends on the same deterministic-permission
work as R4, so it moves to the second phase.

## R7 — What changes for HyperBBS and hyperDNS

- HyperBBS: one shared open context created by the forum owner; members are added as writers on
  connection. They become non-indexers: their posts are applied immediately everywhere as today,
  and confirmed when the owner's device is online.
- hyperDNS: authority contexts (open or closed) created by the authority; same effect.
- Neither reads indexer state. Both suites are the acceptance test (FR-020).
