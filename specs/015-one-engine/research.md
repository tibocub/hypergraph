# Research: One engine for many sites (spec 015)

2026-11-01. Code read: hypergraph `09a9763` (`lib/index.js`, `lib/network.js`, `lib/types.js`,
`lib/instance.js`, `lib/storage.js`, `lib/index/build.js`), node_modules: hyperswarm 4.17.2, hyperdht
6.32.0, dht-rpc 6.27.0, corestore 7.x. **M** = measured here, **M-old** = measured before (file named),
**E** = estimated.

## R1. What causes Hyperswarm's step past ~25 topics (M)

**Question**: perf-habit measured 20 topics 22 ms, 30 → 767 ms, 80 → 2.3 s. Hyperswarm settings,
announce vs lookup, client vs server?

**Bench**: `bench/one-engine/topics.mjs` — one Hyperswarm joins N new topics at once and awaits every
`flushed()`; counts the DHT requests sent. Local DHT (`hyperdht/testnet.js`), no disk, a few seconds.

3-node local DHT (what our tests use):

| variant | 10 | 20 | 25 | 30 | 40 | 80 | 160 |
|---|---|---|---|---|---|---|---|
| both (server + client) | 18 ms / 57 req | 21 / 107 | 18 / 132 | **750** / 157 | 760 / 207 | 2270 / 407 | 4530 / 809 |
| server (announce) | 6 / 57 | 12 / 107 | 13 / 132 | **756** / 157 | 750 / 207 | 2249 / 407 | 4534 / 809 |
| client (lookup) | 2 / 30 | 3 / 60 | 6 / 75 | **752** / 90 | 755 / 120 | 2273 / 240 | 4542 / 480 |
| `maxWindow` 1000 | 5 / 57 | 10 / 107 | 12 / 132 | 13 / 157 | 23 / 207 | 38 / 407 | 72 / 807 |
| batches of 20 | 5 / 57 | 10 / 107 | 12 / 132 | 18 / 157 | 18 / 207 | 36 / 407 | 69 / 807 |

20-node local DHT (closer to the real one: a query reaches 10–20 nodes):

| variant | 4 | 6 | 8 | 10 | 16 | 40 | 80 |
|---|---|---|---|---|---|---|---|
| both | 39 ms / 182 req | **754** / 260 | 757 / 338 | 1501 / 416 | 2280 / 650 | 6833 / 1592 | 13656 / 3180 |
| server | 19 / 182 | **748** / 260 | 752 / 338 | 1509 / 416 | 2288 / 650 | 6823 / 1592 | 13672 / 3160 |
| client | 10 / 80 | 8 / 120 | **751** / 160 | 750 / 200 | 1517 / 320 | 3775 / 800 | 7559 / 1600 |
| `maxWindow` 1000 | 25 / 182 | 32 / 260 | 37 / 338 | 50 / 416 | 72 / 650 | 188 / 1586 | 810 / 3146 |
| batches of 20 | 24 / 182 | 759 / 260 | 760 / 338 | 1510 / 416 | 2286 / 650 | 6050 / 1592 | 12093 / 3158 |

**Cause** (code: `dht-rpc/lib/io.js` `CongestionWindow`, `_drain`): every DHT node sends at most **80
requests per 750 ms slot** (and 160 over the last slots); a request past that waits in `_pending`, which
is only drained by a `setInterval(…, 750)`, never by a reply. A topic's first wave is one request per
node it asks (3 on the test DHT, up to 10 at `concurrency` 10 on a real one): 25 × 3 = 75 fits, 30 × 3 =
90 doesn't, so the rest waits a whole tick. The steps are exact multiples of 750 ms. It's not
Hyperswarm, not memory, not client vs server: those only change how many requests a topic costs.

**Per-topic cost** on a 20-node DHT: announce (server, what `lib/network.js` does) **~40 requests**,
lookup (client only) **~20**. Batching by 20 fixes the 3-node case but not the 20-node one (20 × 10 =
200 > 80): what matters is requests per slot, not topics.

**What it means at 500 spaces** (E, from the numbers above, real DHT ≈ the 20-node case):

- Announcing 500 topics = ~20,000 requests at ≤ ~107/s ≈ **3 minutes**, during which every other DHT use
  (connecting to a peer: holepunching goes through the same node) queues behind it.
- Staying announced: Hyperswarm refreshes each topic every 10 min (`REFRESH_INTERVAL`): 500 × 40 / 600 s
  ≈ **33 requests/s, a third of the node's budget, forever** — and battery on a phone.
- Our re-looks (`lib/network.js` `RELOOK_MS`, 6 refreshes while alone): 500 sites with nobody online =
  ~120,000 requests ≈ 19 min of the whole budget.

**Decision**: design under the window; don't raise it.
- A **topic queue** per engine (FR-021): one background join in flight at a time (each ~40 requests,
  half a slot), the space in use jumps ahead; leaves go through it too (an unannounce is a query too).
- An **announce cap** (FR-022): default 32 desktop / 8 phone ⇒ refresh cost ≤ ~2 req/s desktop.
- **Re-looks only for spaces in use** (FR-023).
- A **grace period** before leaving a topic (default 5 min): revisits cost nothing.

**Alternatives**:
- *Raise `maxWindow`* (HyperDHT option, passed to dht-rpc): removes the step locally (80 topics in 38 ms),
  but it is the node's congestion control on real networks (phone NATs, being a fair DHT citizen), and it
  doesn't change the per-topic cost or the refresh load. Rejected for real networks; harmless for tests'
  local DHT if a test ever needs many topics (not needed now).
- *One topic per engine + a protocol saying which spaces a peer has*: doesn't help a visitor find a
  site's holders (that needs a lookup by the site's key, i.e. its topic). The useful half already exists:
  one connection per peer opens the channel of every space both hold (`lib/network.js` `mux.pair`), so
  a peer met through any space serves all shared ones. Kept as is; no new protocol.
- *Lookup-only (client) for visits*: halves a visit's cost, but a visitor who holds the site should also
  serve it. Possible later for one-off visits of sites not kept; not now.

**Not measured**: real-network round trips (a slot's 80 requests then take longer to come back, so the
step is at least as bad); whether a queued burst delays `joinPeer`/holepunching (it shares `_pending`:
E from the code).

## R2. Types in the space

**Today**: types are the app's (`Hypergraph.open(dir, { types })`), stored once per folder (`@hg/meta`
`types`), checked append-only at open (`checkCompatible`), and a change re-indexes every space
(`#reindex`). Only the rules' ids are in the space (`settings/set` `rules`). Records carry their type's
name; readers decode with their own declaration and keep unknown types undecoded (`lib/gate.js`
`checkRecord`).

**Decision**: a new decision `types/set` in the top space's decision log carrying a `version` (uint,
the previous version + 1) and the full declaration (the `describe()` form: fields with kinds, links,
onePerMember, editable, put, index), compact JSON, ≤ 32 KB. Each applied version is stored as its own
view entry (`types:<version>`), never overwritten, and the state points at the latest: that leaves room
for Tibo's future direction (older apps reading with the version a record was written for, as HyperDB
keeps several schema versions) without a format change. A `version` that isn't the current + 1 is
refused (two concurrent `types/set`: the second in the order is refused, its writer's app records again
at its next open). Applied only if (a) its writer may `decide`, (b) it is compatible with the space's current types
(`checkCompatible`, the same function, run inside apply: deterministic). Sub-spaces use their top space's
types (they already share its decision log). The state gains `types` (latest applied). **Apply-time**:
older versions can't apply it, so everyone updates together.

**Who writes it**: `createSpace({ types })` writes it in the space's first batch (with `space/init`);
a decider's app whose declaration is a compatible superset of the space's writes it at open (the app
"publishes its version"). A non-decider with a newer version works with the space's types and gets
`INCOMPATIBLE_TYPES` ("this space doesn't have …") for what the space lacks.

**Effect on a forum** (`test/next/forum/versions.js`): today a member who updates first can post polls
right away; with this, polls work once a decider's updated app has opened the forum. Old apps decode the
new fields too (they get the space's types), which is better than today. Decided (Tibo, 2026-11-02):
only a decider's app records types, automatically at open; members' apps never do, and there is no
explicit call.

**Indexing per space**: the index already keys every row by space (`lib/index/build.js`: `record`,
`log`, `change` collections start with `space`), and `#purge` already deletes a space's rows. A types
change for one space = delete that space's rows + re-index its held logs (`#restore`'s path for one
space). `@hg/meta 'types'` (global) becomes `types:<space hex>` (local copy of what this device indexed
with), which also tells after a crash whether a space needs re-indexing.

**Rules** (`rules`, app code that filters records) stay app-declared; their ids already live in the
space (`setRules`). A site's rules would be site JS running in the engine: no (the roadmap's rule: site
code never runs in the engine). So HyperBrowser sites get types, not rules.

**Alternative**: types as a record in the space's own records (an `hg/types` record, latest wins).
Rejected: readers must agree on one version at a given point of the decision order (types decide who may
put and edit), which is what the decision log gives.

## R3. Lazy spaces

**Today**: `_open` builds a `Space` per `@hg/spaces` row and joins its topic, one after another (30–50 ms
each, M in scale audit); `space(key)` is synchronous and throws if not held.

**Decision**:
- `hg.space(key)` stays synchronous and returns the same `Space` object for a held space, open or not.
  Every async method awaits `this._ready()` (opens if closed, through the engine's open queue). Sync
  getters that need the decision state (`state`, `peers()`, `helpers`, role getters) are valid after
  `await space.ready()`; on a closed space they return what the `@hg/spaces` row has (name, parent) or
  empty. This keeps every existing call site working.
- "In use" = a call in flight, a live view or `on('change')` listener, a `hold()` (new, returns a
  release function), a scoped handle with an open site view. Idle = none for `idleMs` (default 2 min).
- Close = the `Space.close()` that exists (directory detach, logs closed, decision log released) + leave
  topic after the grace period. Reopen = `_open()` again; the index is kept, so reopening reads rows,
  not logs (30–50 ms, SC-003 targets < 100 ms with the first query).
- Seeded set (FR-014): own (created here or by this identity, from `hg/space` records), pinned
  (`hg.pin(key)`, stored in the personal space as a setting so devices share it), then recent visits by
  last use. Cap `maxSeeded` (default = `maxAnnounced`).
- Memory budget: `memory` option (bytes). Estimate per open space = 250 KB + 18 KB × open logs (M, scale
  audit). Over budget or over `maxOpen` → close the least recently used open unseeded space.
- Events of closed spaces: none (nothing happens to them here). `hg.on('spaces')` unchanged.

**Alternatives**: `await hg.openSpace(key)` explicit — rejected: every app would have to manage open and
close; the easiest kit opens on demand. Many engines per process (one per site) — rejected: one identity
and one swarm is the point.

## R4. Logs open only while used

**Today**: every accepted log is an open Hypercore with a live download (`lib/directory.js` `accept`,
`lib/replication.js` `hold`); `_open` reopens them all.

**Decision** (local only; formats unchanged): a directory entry keeps (key, identity, device, limit,
indexed length) without a core; a core is opened when (a) it is this device's own log, (b) it is behind:
an activity entry or a peer's heads say it is longer than what is indexed, (c) a read needs blocks the
index doesn't have (dropped content, `get` of a record not indexed), (d) budget passes need it. It is
closed after 30 s with none of these. **Serving**: Corestore opens any core held on disk when a peer asks
for its discovery key (`corestore/index.js` `_attachMaybe`, read in the code), so closed logs are still
served. Bound: own + decision log + those downloading (~20 at once, SC-006).

**To verify while building** (risks): that a closed log with `everything` policy learns of new blocks
fast enough through activity entries alone (a member who isn't online when an entry passes gets it from
the period's list at next contact: fine); that Autobase's own writer cores (decision log) stay open
(they must). If (b) misses cases, fallback: keep logs of authors active in the newest period open.

## R5b. Per-site keys (decided by Tibo, 2026-11-02)

**Decision**: a scoped handle acts under a per-site key by default; the main identity only when the app
opens the handle with `{ identity: 'main' }` (HyperBrowser asks the person first, remembers per site).
`site.identity` returns the key in use. Shape now, derivation later:

- A held space records which identity holds it here (`as`: `'main'` or `'site'`); one per space per
  engine. The space's own log, invites redeemed and decisions all use that identity.
- Derivation (follow-up spec): a per-site identity derived from the recovery phrase and the site's top
  space key (deterministic, so every device of the person gets the same one; one-way, so it can't be
  linked to the identity), with device proofs of its own. The personal space lists `as` with each space
  (seen only by the person's devices) so other devices open it under the same key.
- Until built: `hg.scope(key)` without `{ identity: 'main' }` throws `NOT_SUPPORTED` ("per-site keys
  aren't built yet"); never a silent fallback to the main identity. HyperBrowser milestone 1 then runs
  writing sites only with the person's yes.
- Not covered: a site already held under the main identity switching to a site key (it would be a new
  member): later, with the derivation.

## R5. Scoped handle (engine / web-view boundary)

**Decision**: `hg.scope(key, { identity })` returns a `ScopedSpace`-style object: the space's own API
(every method of `Space` for that top space and its sub-spaces, `on`/`off` filtered to that scope),
`identity.publicKey` (the per-site key by default, R5b), nothing else: no phrase, devices, personal space, `spaces()`, other keys,
`connectToSwarm`, budgets. It is a plain JS object: HyperBrowser maps web-view messages (method name +
args) onto it; anything not on it is `NOT_ALLOWED`. Opening a not-yet-held site: `hg.scope(key)` on an
unknown key opens it by key (public reading) or `scope.redeem(invite)`. The handle holds the space "in
use" while the site's view is alive (`scope.close()` releases).

**Why a handle, not checks in every method**: one place to audit; sites can't name what isn't on it.

## R6. Personal space shared by apps

Confirmed by Tibo 2026-11-02. The personal space has no decider other than the identity itself, and apps write their own records
there (SwarmFS's `held`). Its types are the union of every attached app's declarations, kept locally
(not a `types/set`: the personal space's devices are one person, and every device runs its own apps).
Two declarations of one name that differ → `INCOMPATIBLE_TYPES` at attach. Advice: prefix
(`swarmfs/held`). SwarmFS isn't released: it can rename now.

## R7. Phone (Bare, short runs)

- Bare: everything used exists on Bare today (`test:next:bare`); `fs.statfs` via bare-fs 4.
- `hg.suspend()`: stop queued joins, leave no topics (leaving costs requests; the DHT forgets an
  unrefreshed announce in ~20 min anyway), `swarm.suspend()` (Hyperswarm has it), close every space not
  in use, flush heads. Pending calls on spaces that close fail with `SUSPENDED`.
- `hg.resume()`: `swarm.resume()`, the space in use first, then seeded spaces through the queue (8 on a
  phone).
- Push wake-ups: resume, wait for the pinned spaces to catch up or a deadline, suspend. The helper that
  sends pushes is later (availability plan).

## R8. Perf scenarios (`npm run perf`)

The perf suite lives on the perf-habit branch (`perf/run.mjs`, `perf/scenarios/spaces.mjs`), not on
master yet: these scenarios land after it merges.

- `perf/scenarios/engine.mjs`: sizes 100 / 500 held spaces, 5 posts each. Metrics: `engine.open` (ms to
  ready), `engine.rss` (MB after open, gc'd), `engine.visit` (closed space → first `latest(20)`, ms),
  `engine.open-count` (spaces open after start: ≤ cap), `engine.reindex-one` (types change in one space:
  ms, and others' row counts unchanged).
- `perf/scenarios/topics.mjs`: 500 seeded spaces on a 20-node local DHT: `topics.visit` (a visited
  space's flush with the queue full vs idle), `topics.announced` (≤ cap), `topics.requests` (DHT requests
  per minute when settled). Keep the 20-node DHT short: one size.
- `perf/scenarios/logs.mjs`: a space with 2,000 logs caught up: `logs.open` (open cores, ≤ ~20),
  `logs.reopen` (start time vs today).

## R9. Things checked in passing

- `lib/network.js` attaches every space over every connection: closed spaces must be skipped there and
  attached when they open (it already handles spaces opened after connecting, research.md A7 of 011).
- `#settle` opens every space listed in the personal space: with lazy spaces it **adds rows** (held,
  closed) instead of opening them.
- `_openSubspaces` opens every sub-space this identity is in: same, rows only; a sub-space opens with its
  top space's use.
- `_writeHeads` walks every open space: closed spaces keep their last heads.
- Budgets (`#hold`, `storage.shares`) walk every space: they must read closed spaces' sizes from the index
  (rows have them) rather than opening them.
