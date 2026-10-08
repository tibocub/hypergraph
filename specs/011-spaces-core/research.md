# Research: Spaces — hypergraph's redesigned core

Decisions for [spec.md](spec.md). Each: what, why, what else was considered. Measurements behind them
are in [`specs/research/design-brief.md`](../research/design-brief.md) (experiments 1–6, the spike) and
[`specs/research/v2-prototype-lessons.md`](../research/v2-prototype-lessons.md).

## R1. Where the new core lives, how it is loaded

**Decision**: a new tree `lib/` (the core), tests in `test/next/` (unit, scenario, network), benchmarks in
`bench/next/`, docs in `docs/next/`. Loaded as `require('hypergraph/next')` until hyperDNS moves; then it
becomes `require('hypergraph')` and `src/` (v1) and `src/v2/` (prototype) are removed in a later spec.
Modules reused from `src/v2/` and `src/` are **copied into `lib/` and adapted**, never imported across
trees, so v1 and the prototype stay frozen.

**Why**: FR-035 (v1 unchanged for hyperDNS); a fresh tree avoids grafting new rules onto v1's files
(design brief, "Layout").
**Alternatives**: a new repo (rejected: ~1/3 of `src/` and all tooling carry over; HyperBBS/hyperDNS links
stay valid); importing from `src/v2/` (rejected: couples the prototype's freeze to the new core).

## R2. Node and Bare

**Decision**: swarmwire's proven approach (`E:\Code\P2P\swarmwire\AGENTS.md`): an `imports` map in
`package.json` sends `fs`, `path`, `os`, `events`, `process` to `bare-*` modules under Bare; `lib/` uses
`b4a` instead of `Buffer`, never the `process` global, never `node:` specifiers, no dependency that
imports `module`. Tests run with `brittle` on Node and with `bare node_modules/brittle/bin/bare.js` on
Bare (brittle 3.19.1 ships it). `npm run test:next` and `npm run test:next:bare`; `scripts/test-runner.js`
gains a `next` group and a `--bare` switch.

**Why**: FR-034, SC-014. Checked 2026-10-08: every Holepunch dependency loads in Bare 1.27; Node built-ins
don't. swarmwire runs 101 tests on both this way.
**Alternatives**: test Bare only before shipping on Pear (rejected by Tibo: late surprises).

## R3. Dependencies

**Decision**: add as direct dependencies: `hyperswarm` (one-call networking; today only a dev dependency),
`hyperdb` and `hyperschema` (local index; today only installed through `blind-peer`), `bare-fs`,
`bare-path`, `bare-os`, `bare-events`, `bare-process` (imports map), `blind-pairing` (device join codes,
R9) after checking it loads on Bare and doesn't import `module`. Keep: `hypercore`, `corestore`,
`autobase`, `keet-identity-key`, `protomux`, `compact-encoding`, `hypercore-crypto`, `sodium-universal`,
`b4a`, `ready-resource`, `safety-catch`, `z32`.

**Why**: proven Holepunch dependencies first (design brief point 7); a dependency must be declared, not
present by accident (HyperDB was).

## R4. One instance, one storage folder, many spaces

**Decision**: `Hypergraph.open(dir, opts)` owns one Corestore (`<dir>/cores`), one HyperDB
(`<dir>/index`), one Hyperswarm, one identity, the personal space and any number of spaces. Every
index key starts with the space's key, so dropping a space is a range delete and cross-space queries
(e.g. "what my devices hold") are possible later.

**Why**: FR-013 (Tibo: no more one hypergraph per space); one connection set for all spaces.
**Alternatives**: one HyperDB per space (simpler drop, but N RocksDB instances, N write queues, no
cross-space query) — rejected.

## R5. Records and logs

**Decision**:
- Each device has **one log per space** (a Hypercore from the instance's Corestore, namespaced by space).
  Block 0 is the **log header**: format version, space key, the device's identity proof
  (keet-identity-key, 139–235 B), and the decision log key. Readers check the proof once per log.
- Every later block is a **record**: `{ kind, type, stamp, links, fields, target? }` where `kind` is
  `put` | `edit` | `delete`, `type` the app's type name, `stamp` the "latest wins" time (R7), `links`
  record ids or space keys, `fields` the tagged encoding of experiment 6 (field number, length, value;
  readers skip unknown numbers), `target` the record an edit or delete applies to.
- **Record id** = log key + block number (32 B + varint); shown to apps as a short z32 string. An edited
  record keeps its id; its current version is the latest allowed edit.
- Records are at most 64 KB; content held elsewhere uses spec 001's reference envelope (`src`, `size`,
  `type`, `digest: "blake3:…"`, e.g. `swarmwire://<root>`). `relate` and `tag` are records of built-in
  types `hg/relation` (from, to, type, value, data ≤ 4 KB) and `hg/tag`.
- Compact encoding throughout (`compact-encoding`), no JSON.

**Why**: append-only underneath, mutable on the surface (Tibo, 2026-10-08); one log per device
(Scuttlebutt; Hypercore forks otherwise); experiment 6 (tagged: 40–116 B vs 103–179 B JSON, both
directions across app versions).
**Alternatives**: one log per identity shared by devices (forks); per-record Hyperbee (writes path nodes
in every block, v2 lesson).

## R6. Types

**Decision**: `Hypergraph.open(dir, { types })` declares types: `fields` (`string`, `text`, `int`, `uint`,
`float`, `bool`, `bytes`, `ref` (spec 001 envelope), `link`, `space`; field numbers by order), `links`
(field names that link, with allowed target types), `onePerMember`, `editable` (`'author'` default,
`{ permission: 'x' }`, `'members'`), `index` (app-declared keys, e.g. `['forum', 'stamp']`). The last
declaration is stored in the index (`@hg/meta`); at startup, any change other than appending fields or
adding types throws `HypergraphError` naming the type and field. Records of unknown types are kept and
indexed by type but not decoded beyond the envelope (another app version may know them).

**Why**: FR-001, FR-003, FR-004, US7; app-declared keys work through HyperDB map indexes without an app
build step (experiment 2).

## R7. "Latest wins" stamps

**Decision**: `stamp = max(now, newestOwnSeen + 1)` in ms, where `newestOwnSeen` is the highest stamp of
any record by the same identity this device holds (all its devices' logs in that space, plus its personal
space). Ties: lower device key wins. Used for edits, deletes, one-per-member types and decisions that
replace earlier ones of the same member. A stamp more than 10 minutes ahead of the reader's clock is
treated as now + 10 minutes for ordering and flagged (adversarial clocks, SC-006).

**Why**: Tibo approved 2026-10-08; SC-009.

## R8. The decision log

**Decision**: one Autobase per space, adapted from `src/v2/control.js` (apply is deterministic, 'change'
events, serialized reloads). Writers = members whose role has the `decide` permission (owner, admins by
default; moderators get `moderate` which also makes them writers). Decisions: `space/init` (types
policy, parent, settings), `member/add|remove`, `role/set|remove`, `role/define` (custom roles,
permission lists), `moderate` (flag, hide, remove, reveal, ban — a ban records the banned identity's
device logs' lengths as held by the moderator, the "cut"), `invite/create|revoke|redeem`, `key/rotate`
(private spaces), `subspace/create`, `settings/set` (policy, write limits). A decision is applied only if
its author had the permission at that point of the order; otherwise ignored (FR-019). Concurrent
decisions converge because Autobase orders them identically for everyone (Principle I).

**Why**: agreement only where needed (design brief point 2); v2's control log is tested and measured.
**Alternatives**: activity or records in the decision log (rejected: spec 007 R2, ~162 KB per member on
indexers).

## R9. Identity, devices, personal space

**Decision**:
- Identity from `src/identity-manager.js` (keet-identity-key, mnemonic), adapted to b4a/Bare.
- **Personal space**: a private space created with the identity, whose members are the identity's
  devices only. Holds: device list, spaces joined (key, name, invite), settings, budgets, app records
  (e.g. `swarmfs/held`), and **device heads** (each device's log lengths per space, written periodically,
  so another device can cut a lost one precisely).
- **Join by code**: device A shows a code (text or QR); device B enters it; they meet through
  `blind-pairing` (Holepunch's pairing library, as Autopass uses), B sends its device key, A attests it
  (`IdentityKey.attestDevice`) and returns the proof, the personal space key and its keys. B then
  replicates the personal space and joins the listed spaces.
- **Removing a device**: a `device/remove` record, attested by another device (keet `attestData`), in
  that device's log of **every** space (it knows them from the personal space), carrying the cut (the
  removed device's log length in that space, from device heads or what it holds). Readers ignore the
  removed device's blocks past the cut. A removal attested by the identity key itself (recovery phrase)
  overrides device-made ones (a thief's device removing the owner's).

**Why**: FR-024–026, US3, SwarmFS's first version. Cut by length because a thief can backdate stamps,
not rewrite blocks others hold (v2 bans).
**Open for implementation**: verify `blind-pairing` on Bare (R3); if it fails, pair over a one-time
Hyperswarm topic derived from the code.
**Checked (T002, `bench/experiments/pairing/check.js`)**: adopted. `blind-pairing` 2.3.1 loads and pairs
on Node and on Bare (local DHT, ~5 s with `poll: 1000`), imports no `module`. Two things for story 3: a
refusal is swallowed on the candidate side (it keeps polling), so `joinCode` needs its own time limit and
the adding device closes its listener after one use; the code (the invite, z32) is 106 characters — fine
as a QR or pasted text, long to type by hand. Bare needs 1.32+ for brittle's dependencies: the repo's
`bare` dev dependency (1.34) is used through `npx bare`, not an older global one.

## R10. Finding a space's logs

**Decision**:
- **Log directory**, per space: the set of device logs known to write in it. Each entry is just a log
  key (32 B); members keep it in the index and exchange it on a Protomux channel per space
  (`hypergraph/space` with the space key as channel id): on connect, a summary (count + XOR digest,
  experiment 1); if different, the missing keys; new logs announced with a short notice and asked for by
  whoever lacks them (experiment 1: halves traffic). Before keeping or passing an entry on, a member
  fetches the log's header and checks: valid proof, identity is a member (or allowed by the space's
  write rules), device not removed (FR-018, spam).
- **Big spaces (story 9)**: entries gain `(period, start)` (~40 B, unsigned, checked against the log),
  and readers open only the logs active in the periods they read. Switch-over point fixed by measurement
  in story 9 (design brief: the member list is the author list while it is small).

**Why**: one mechanism from story 1, extended in story 9; experiment 1 measured it on a real network.
**Alternatives**: register logs in the decision log (writers only; members can't); derive log keys from
device keys (needs a public device list per identity — not available without another log).

## R11. Readers enforce, before keeping

**Decision**: a record enters a member's index only through one gate (`lib/gate.js`): its log passed R10's
checks; it is within the log's cut (ban, device removal); it decodes; its type's rules pass (links point
to allowed types, edits/deletes by allowed editors — FR-003); the app's rules pass (`rules: [{ id,
validate(record, ctx) }]`, deterministic, given read-only access to held records); the space's write
limit (open spaces) isn't exceeded. A record failing the gate is not indexed and its log's blocks are
cleared if the whole log is refused. Decisions that change the gate's outcome later (ban, hide, role
removed) update the index (delete or flag rows) — the spike's `#cut`.

**Why**: FR-017/018, SC-006, Tibo: rejecting before keeping stops pollution (SwarmFS Q21).

## R12. The local index

**Decision**: HyperDB (RocksDB engine), one definition built by hypergraph (`lib/index/build.js`,
generated spec committed, like experiment 2). Collections: `records` (space, id, type, author identity,
device log, seq, stamp, current fields, links, flags hidden/removed/deleted), `logs` (space, log key,
identity, indexed length, cut), `meta` (types, settings). Indexes: by type+stamp, by author+stamp, by
link target+type+stamp, by app-declared keys (map), one-per-member (space, type, target, author). One
write queue per instance (the spike found HyperDB refuses to commit during another insert). Rebuild:
`logs.indexed` tells where each log stopped; a missing or corrupt index is rebuilt from held logs
(experiment 2: ~14 s per 100k records). Live queries: HyperDB `watch()` after flush, re-running only
queries whose types were written (spike: unfiltered re-runs fired 15 times).

**Why**: FR-010–012, experiment 2 (≈1 ms queries at 1M), the spike.

## R13. Bounded reads and "complete"

**Decision**: every read takes `{ timeout }` (default **5 s**, `opts.readTimeout` per instance). A read
answers from the index; if some logs it needs (all logs, or the active ones in story 9) have blocks the
member lacks but peers advertise, it requests them and waits up to the bound. It returns `{ items,
complete }`: `complete` is false when, at return time, any needed log has known blocks not held, or the
log directory may be missing entries (no member reached yet). Downloads continue in the background.
Stall detection and retries from `src/v2/replication.js` (STALL 5 s; retries 2–120 s with fresh sessions).

**Why**: FR-011, SC-007, v2 lessons (hangs at 0 peers).
**Alternatives**: arrays with a hidden `complete` property (rejected: implicit); throwing on timeout
(rejected: an incomplete answer is still useful).

## R14. Storage budgets and policies

**Decision**: adapted from `src/v2/replication.js` (stored bytes = block + ~130 B; reads accounting; clear
oldest-unread first; held/closed items skipped; inactive planning sessions). Budgets: one app budget
(default **5 GB**; a share of free disk if the runtime reports it — checked during implementation on
both runtimes), per-space budgets taken out of it, the rest shared by the other spaces in proportion to
use. Never evicted: own logs, decision logs, the personal space. Policies per space: `auto` (default),
`everything` (creator's choice; a member below it is told via an event and `space.status()`). Budgets
cover hypergraph's data only.

**Why**: FR-027, SC-011, Tibo's per-space budget (2026-10-08).

## R15. Sub-spaces and private spaces

**Decision**:
- A sub-space is a space whose `space/init` names its parent; created by a `subspace/create` decision in
  the parent (key, name, `private`, `writeRoles`). Its effective state = parent's members and roles,
  then its own decisions (stricter write roles, own guests, own role overrides); **bans and removals in
  the parent always apply** (union of cuts). Members open the parent's decision log anyway.
- Private (spaces and sub-spaces): spec 008's design — epoch keys, commitments in `key/rotate`
  decisions, XChaCha20-Poly1305 per record — with **grants as records** (`hg/grant`, sealed epoch key per
  recipient device box key, signed) in the granter's log instead of keeper rosters, which no longer
  exist; recipients find theirs through an index by recipient prefix. Revocation = rotate + re-grant
  (008). Copied from `src/v2/crypto.js`, `grants.js`, `invites.js`, adapted.

**Why**: FR-020–022, US8; one building block (Tibo, Q8/Q14).

## R16. Invites

**Decision**: spec 008's design (`src/v2/invites.js`): signed link `hg2:`-style (renamed `hg:`) with
community key, role, sub-spaces, expiry, uses; redemption recorded by any decision writer online
(pre-checks, idempotent per identity, never downgrades); key holders complete grants for private
spaces. Open spaces: a public link with unlimited uses + `settings/set { writeLimit: { records,
periodMs } }` enforced by the gate.

**Why**: FR-023; tested in 008.

## R17. Networking

**Decision**: one Hyperswarm per instance; each space joins its topic (decision log's discovery key);
each connection: `store.replicate(conn)`, then per shared space a `hypergraph/space` Protomux channel
(R10) and any app protocol registered with `space.addProtocol(name, handlers)` (FR-031; hypergraph's own
stays on). Simultaneous starts: v1's re-look after a random delay (`src/networking.js`). Tests use the
local DHT helpers (`test/brittle/helpers.js` pattern), never the internet; no `process.exit`.

**Why**: FR-030/031, experiment 1's finding (simultaneous joins never meet), CLAUDE.md test rules.

## R18. API conventions (Principle IV)

**Decision**: one static constructor `Hypergraph.open(dir, opts)`; everything else are async instance
methods on `Hypergraph` (identity, spaces, devices, network) and `Space` (records, graph, queries, roles,
moderation, invites, sub-spaces). v1 names where meanings hold. Errors: `HypergraphError` with a stable
`code` (`NOT_ALLOWED`, `NOT_FOUND`, `INVALID_RECORD`, `INCOMPATIBLE_TYPES`, `INVITE_EXPIRED`, …). Reads
return `{ items, complete }`; single gets return `{ record, complete }`. Events: `space.on('change')`,
`space.on('status')`, `hg.on('connection')`. Full surface in [contracts/api.md](contracts/api.md).

## R19. Forum scenario tests

**Decision**: `test/next/forum/` — one file per flow (sign-up, create, post-comment-vote, edit-delete,
live, moderation, invites, devices, subforums, versions), sharing a ~300-line `forum.js` "app" that
declares the forum's types and wraps the flows using the public API only (SC-002 measures its size).
Three members on the local DHT; run on Node and Bare. Every API change updates them in the same commit
(CLAUDE.md rule 3).

## R20. Benchmarks

**Decision**: `bench/next/` re-runs the design brief's measurements on the real core (SC-012): first page
at 10k and 1M records (SC-004), 50 writers (SC-005), index rebuild (SC-008), activity-list traffic
(story 9), budgets (SC-011). Short runs by default; big sizes behind flags (machine load rule).

## Amendments during implementation

Small changes made while building, and why. Design changes were decided by Tibo first.

### A1. R7: raw stamps for ordering; edits stamped above what they replace (decided by Tibo, 2026-10-08)

R7 said a stamp more than 10 minutes ahead of the reader's clock is ordered as "now + 10 minutes".
Each member's "now" differs (and changes over time), so two members indexing the same far-future
version at different moments would cap it differently and could settle on different winners — breaking
convergence (constitution Principle I). Now:
- every member orders by the **raw stamps**, ties to the lower device key;
- a stamp more than 10 minutes ahead of the reader's clock only sets a display flag (`futureStamp: true`);
- an edit or delete is stamped `max(now, newestOwnSeen + 1, replacedStamp + 1)`, where `replacedStamp` is
  the stamp of the version it replaces as seen by the writing device. Any edit made after seeing a
  future-dated version therefore still wins.
Test: `test/next/unit/stamp.js` ("a version stamped a day ahead loses to an edit made after seeing it").

### A2. The index definition: a `changes` collection and a `spaces` collection; `grants-for` later (T013)

- **`changes`** (space, target, id → kind, author, device, stamp, fields): edits and deletes are kept by
  the record they replace. They can arrive before it (another device's log, or a slower log), and the
  record's current version is the latest *allowed* one, which can only be decided once both are held.
  The `records` row keeps the current version (`vstamp`, `vdevice`, `fields`).
- **`spaces`** (key → Corestore namespace, name, parent): the spaces this instance holds.
- `records` rows carry `opm` and `target` for the one-per-member index; superseded votes stay as rows,
  flagged, so the order of arrival never matters.
- `grants-for` is not built yet: grants are story 8's, and HyperDB definitions only grow by appending,
  so it is added then.

### A3. Small choices made while building story 1

- **Keys are z32 strings in the API** (record ids, space keys, identity and device keys), and methods
  accept the record or space object where a key is expected. One convention (R18), JSON- and URL-safe.
- **Link fields live in the record's `links` list**: a link field stores a small index into it, so
  readers can index links without knowing the type (another app version may not).
- **A link to a record not held yet is accepted**; its target type is checked when the target is held
  (at write time locally, at index time on readers). A vote can arrive before its post (spec edge cases).
- **An allowed delete is final**: whatever the stamps, a record with an allowed delete is gone; a later
  edit of it is kept in `changes` but never applied. Converges without comparing a delete's stamp to
  edits'.
- **An edit carries all the fields of the new version** (the writer merges the change into the version
  it holds), so the current version is simply the latest allowed edit.
- **The space key is the decision log's key**; the log header's `decisions` field repeats it (sub-spaces
  may differ later). A decision-log writer key speaks for an identity through `space/init`'s proof
  (`writer:` entries in the view), so decisions need no signature of their own.
- **Invites** (story 1): a newcomer sends its signed redemption on the space channel (a `redeem` message,
  added to data-model.md's channel messages); a member who records decisions appends `invite/redeem`.
  No `invite/create` decision: an invite carries its maker's signature, and its uses are counted at
  redemption (spec 008 did the same).
- **"Complete"** (R13): every member of the decision log has a known log, every known block is indexed,
  and a member was reached on the space channel since opening — or this device is the only member.
- **Field names `id`, `type`, `author`, `device`, `stamp`, `edited`, `futureStamp` are refused** in type
  declarations: records carry them next to their fields.
- **The identity's recovery phrase is stored in the instance folder** (the index's `meta`), so
  `recoveryPhrase()` works after a restart. Open question for the lead: encrypt it, or drop it once the
  user confirms having written it down.
- **`test:next` runs through `scripts/test-runner.js`** (one process per file; `--bare` for Bare).
