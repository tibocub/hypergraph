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
  types `hg/relation` (from, to, type, value, data ≤ 4 KB) and `hg/tag` (shapes amended by A9).
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
  in story 9 (design brief: the member list is the author list while it is small). *Built in story 9: A14
  (entries derived and checked by every member; newest first beyond 2,000 records, by activity lists beyond 300
  logs).*

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

**Why**: FR-020–022, US8; one building block (Tibo, Q8/Q14). *Amended by A13: a sub-space's decisions live in its parent's decision log; grants are sealed per device.*

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
  (Changed by A4.)
- **Field names `id`, `type`, `author`, `device`, `stamp`, `edited`, `futureStamp` are refused** in type
  declarations: records carry them next to their fields.
- **The identity's recovery phrase is stored in the instance folder**, so `recoveryPhrase()` works
  after a restart. (Replaced by A4's "recovery phrase".)
- **`test:next` runs through `scripts/test-runner.js`** (one process per file; `--bare` for Bare).

### A4. Fixes from the review of story 1 (lead conversation, 2026-10-08)

- **Recovery phrase: the person chooses** (Tibo's decision). `hg.forgetRecoveryPhrase()` erases it from
  the device; `hg.protectRecoveryPhrase(password)` keeps it sealed (Argon2id-derived key,
  XSalsa20-Poly1305, `sodium-universal`, same on Node and Bare); `recoveryPhrase(password)` reads it
  back. Until one is chosen it stays as before, and the docs tell apps to ask right after showing it.
  It lives in its own file (`<dir>/recovery-phrase`), not in the index: RocksDB keeps overwritten values
  in old files until it compacts, so "erased" would not be true there. Forgetting overwrites the file
  before removing it. Opening a folder with `mnemonic` now compares the identity the phrase gives, not
  the stored words (which may be gone). Test: `test/next/forum/sign-up.js` (the words are no longer
  anywhere in the folder after forgetting or protecting).
- **Test-only helpers are off the public classes**: `writeRaw`, `holdsBlock`, `logs`, `ownLog` and
  `openSpace` are functions of `lib/testing.js`, reaching the instance through its fields and one
  internal symbol (`lib/symbols.js`). Test: `test/next/unit/surface.js`.
- **"Complete" no longer needs every member's log** (lead's review): it is "every block this member knows
  of is held and indexed, and it reached another member since opening" (or it is the only member). A
  member who wrote and went offline before anyone fetched their log made answers incomplete forever,
  which teaches apps to ignore the flag. Test: `test/next/net/bounded.js` ("a member whose log nobody
  holds…").
- **Deleted records stay wiped, and their holes don't stall anyone.** Downloads now start where indexing
  stands (`log.indexed`) instead of block 0, so a restart or a stall-retry never asks for blocks this
  member wiped. A newcomer after a delete exposed a real bug: nobody holds the deleted block any more,
  and the indexer stopped at the first missing block, so it never indexed anything after it — including
  the author's delete record that explains the hole. The indexer now looks at every held block once
  (`log.scanned`), keeps the missing ones as holes indexed when they arrive, and treats a hole as done
  when its author deleted it (`log.indexed` stays the point below which everything is done; after a
  restart the blocks past it are looked at again, so indexing a block is idempotent). Holes count as
  missing for "complete", except wiped ones. Test: `test/next/net/wipe.js` (reconnect and restart; a
  newcomer indexes past the hole and is complete; nobody holds or serves the block). Found while
  writing it: a block arriving while the indexer was checking it got lost (fixed: arrivals below the
  scan point are always rechecked).
- **Removing a member makes no one disagree (constitution Principle I).** Before, a member who had indexed
  someone's records before `member/remove` kept them, while a newcomer never indexed them (the gate
  refused non-members' logs). Now a removal works like a ban: `member/remove` carries a **cut**, the
  removed identity's device logs' lengths as the decider held them (`removeRole` computes it; nobody
  gives lengths). The view keeps `cut:<identity>` (a log's first cut stays its cut for good), and the
  gate gives every log a **limit**: its cut if it has one, else everything if its author may write,
  else nothing (`State.limitOf`). Records below the limit count for everyone; records past it are
  ignored by everyone: members who indexed them take them back (rows and changes go, an edit undone
  brings back the version before, a vote undone brings back the member's earlier vote, blocks are
  cleared), newcomers never index them, downloads stop at the cut, and a log is no longer refused just
  because its author was removed later. A log whose cut leaves nothing is dropped from the directory.
  The cut is recorded only when someone *loses* the right to write (`post`), so a later decision can't
  widen it. Someone removed and let in again writes in a new device log (`log/1`, …): the old one keeps
  its cut. The index gains `changes-by-id` (append-only definition change) to find a cut edit by its
  own id. Tests: `test/next/net/cut.js` (old member and newcomer show the same; a re-invited member
  writes again; a member that already showed records past the cut takes them back, decided by an
  offline decider).
  **The pattern for story 5**: losing an edit permission must be handled the same way. A record isn't
  ordered against decisions, so "was this edit allowed?" can't be answered by "is the permission held
  now?" (members who settled earlier would keep the edit, later ones wouldn't). The decision taking the
  permission away records the cut of the editor's logs; edits below it stay allowed, edits past it
  don't. Today `editable: 'members'` already relies on it (an edit that passed its log's limit was
  made while its author could write); `{ permission }` still checks the current state and must move to
  cuts in story 5.

### A5. Story 2: choices made while building roles, moderation and rules

- **v1's meanings** (FR-016, US2 #8): `removeRole(x)` takes x out of the space (v1's `roles/removeMember`),
  recorded as `member/remove` with a cut (A4); `setRole(x, role)` on a non-member adds them (v1). The
  `role/remove` decision is gone. "A moderator whose role is removed" (US2 #6) is `setRole(x, 'member')`.
- **Who may give what**: the owner gives any role but owner; others need `roles`, act only on members
  below their rank and give roles below it (a custom role ranks as a member), and hand on hypergraph's
  own permissions (`decide`, `moderate`, `invite`, `roles`) only if they hold them; an app's own
  permissions (e.g. `edit-pages`) are free. The same pure functions (`lib/decisions/state.js`) decide in
  `apply` and in the API's early `NOT_ALLOWED`.
- **A custom role never loses `post`**: records aren't ordered against decisions, so taking `post` from
  everyone holding a role would need a cut per holder, which the decider can't list reliably (holders
  may change concurrently). `role/define` that drops `post` is ignored, and the API refuses it; give
  holders another role instead (`role/set` carries the holder's cut).
- **Decision-log writers**: a redemption now carries the redeemer's decision-log key, signed; a role
  with `decide` or `moderate` makes it a writer (`host.addWriter`, not an indexer: only the owner
  indexes for now). A demoted member stays a writer, but `apply` checks the author's role at each
  point, so its later decisions count for nothing (FR-019). `Decisions.append` waits up to 5 s to become
  writable, for a member just given such a role. Open: a custom role that *gains* `decide`/`moderate`
  later doesn't make its existing holders writers until they are set again; moderators as indexers
  (decisions settled while the owner is offline) is story 4's question.
- **Moderation**: `flag` (`record.flagged`), `hide` (lists leave it out; `get()` returns it with
  `hidden: true`, so apps can show "hidden by moderators" and moderators can reveal it), `reveal`,
  `remove` (for good: the row goes, blocks are cleared, edits too, a reveal doesn't bring it back; it
  explains the hole for newcomers), `ban` (out, `banned:` marker so neither an invite nor `setRole` lets
  them back in, and a cut). No unban yet. A hide decided before the record arrives applies when it does.
  Rows get moderation when inserted; a decision change reconciles the rows it touches (`Indexer.moderate`).
- **A ban keeps what the moderator held** (FR-017), spam included if the moderator held it. The forum
  takes the spam down after the ban (`forum.ban(f, who, { since })`, a few lines). Open question for
  the lead: should `moderateAction('ban', who, { since: record })` cut at a record instead?
- **App rules**: `validate(record, ctx)`, record = its fields plus `id, type, author, device, stamp`,
  `ctx = { space }`; false or a throw rejects. Checked by the writer's app (`RULE_REJECTED`, naming the
  rule) and by every member before indexing puts and edits. Rejected records are not indexed and
  other members clear them; **a member's own log is kept whole** (FR-027), so a newcomer fetches the
  record from its author, checks it and drops it, instead of being left with a hole nobody can fill
  (which would make its answers incomplete for good). Rules must look only at the record: one reading
  held records would differ between members.
- **A Hypercore bug, worked around**: a peer learns "this holder has blocks 0..n" as a contiguous length
  with no per-block bits; a later "dropped block k" sets that length to k, so the peer forgets the holder
  still has k+1..n and (having asked for that range before) never asks again. Found as members stuck
  behind a rejected record. `clearBlocks()` (`lib/replication.js`) announces the held blocks after a
  clear again (`core.replicator.onhave`). Test: `test/next/unit/clear-blocks.js` (fails without it).
  Worth reporting upstream.
- **Holes are looked at again** after a short wait growing to 5 s while none fills: a block's arrival can
  be missed, and a missed hole stayed "missing" for good.

### A6. A ban can start from a chosen record (decided by Tibo, 2026-10-09)

Answers A5's open question. `moderateAction('ban', who, { from: record })`: the cut of the log holding
`record` is that record's position, so it and everything after it in that log are dropped for everyone;
the banned identity's other logs are cut where the moderator holds them, as before. Without `from`,
unchanged. Nothing new on the wire: the ban's cut entries already carry a length per log, and "a log's
first cut stays its cut" (A4) still holds. `from` must be one of the banned member's records in a log
this member holds (`NOT_ALLOWED` otherwise). The forum bans a spammer in one call (`forum.ban(f, who,
{ from: firstSpam })`), replacing A5's "ban, then take down each spam since a time". Test:
`test/next/forum/moderation.js` ("a ban from the first spam…").

### A7. Story 3: devices, the personal space, removals with the recovery phrase (decided by Tibo, 2026-10-09)

**Removing a device needs the recovery phrase** (Tibo's decision, replacing R9's "attested by another
device; identity-attested removals override device-made ones"). R9's rule let two devices remove each
other; each removal sat in a log the other one cut, so a member that had fetched both and a newcomer
that fetched only up to the cuts would disagree (constitution Principle I), unless every member kept
downloading a removed device's log past its cut to look for removals (a thief writing junk would cost
everyone bandwidth). Now there is one kind of removal, signed by the identity key:
- `hg.removeDevice(publicKey, { password })` (the phrase kept on this device behind a password) or
  `{ recoveryPhrase }` (typed; needed once the device forgot it). Without either: `NOT_ALLOWED`.
- **Every device holds the phrase**: a device added by code receives it over the pairing connection
  (blind-pairing's reply is encrypted to the new device) and the app asks the person for that device's
  own password, as after signing up (A4's choices hold per device: protect, forget, or neither yet).
  `addDevice()` therefore needs the phrase too: `{ password }` if protected, `{ recoveryPhrase }` if
  forgotten here.
- Since every device holds the phrase, **each device proves itself straight from the identity key**
  (`bootstrap`, a chain of one), instead of T048's `attestDevice` by the adding device: no device
  depends on another, so removing one never strands the devices it added.
- A removal is an `hg/device-remove` record `{ device, cut, proof }` (`proof`: the identity key's
  signature over space, device and cut) written in the remover's **identity log** of every space: a
  log whose header is signed by the identity key itself, not by a device. No removal can touch an
  identity log, so no removal ever cuts the log holding another removal, and every member reads every
  removal: removals only ever lower a log's limit, the same everywhere, in any order of arrival.
  Records in an identity log other than signed removals are ignored; signed removals in a device log
  too.
- The cut of each of the removed device's logs in a space is where the remover holds it, or the
  device's own last **head** (its log lengths, written to the personal space when they changed, at most
  every 10 minutes, and at close; not the personal space's own, which every heads record changes) if
  that is further. A log of the removed device the removal doesn't name counts for nothing (a log
  made after the removal, or one nobody had heard of).
- The removed device's own app refuses to write once it learns (`DEVICE_REMOVED`). It can still read
  the personal space it already holds (taking that away is key rotation, story 8).
- Forgotten password: recovering it from another device is a later task (tasks.md, phase 12).

**The personal space** is a space whose only member is the identity, so every device of it may write
and nobody else's records count (the gate as for any space). It is **encrypted** (Hypercore block
encryption and Autobase's `encryptionKey`) with a key derived from the identity, and its key is
derived from the identity too (its first writer's key pair comes from the phrase): a device restored
from the phrase alone finds the same personal space. It is not listed in `hg.spaces()`. Built-in
records: `hg/device { device, name }` (each device writes its own), `hg/space { space, name }` (written
when the identity creates or joins a space; every device joins the listed spaces), `hg/setting { name,
value }` (`hg.setSetting`, `hg.settings()`, latest wins per name), `hg/heads`. Apps add their own types
(`hg.personal.put('held', …)`). Space channels now use the space's discovery key as their Protomux id
(it used the key, which told every connected peer the keys of all the spaces held, the personal one
included).

**Stamps** (T050): "newest own seen" already covered every device of the identity (the indexer feeds the
stamper any record whose log is the identity's, in any space, the personal one included). Added: on
opening a space, the last record of each of the identity's logs held is fed to it, so a device whose
clock was ahead and is now right still stamps its next change above its earlier ones after a restart.

**Found and fixed while building** (both with tests):
- **A space opened on a connection already up never got its space channel** (a story 1 bug): Protomux
  turns down a channel the other side opens before this side has one, so if two peers were connected
  (through any space) and one opened another space they share later, each side's channel was turned
  down by the other, and its directory and redemptions never passed. A member connected to an inviter
  couldn't join a second space from them. Each connection now accepts the space channel for any space
  held here when the other side opens it (`mux.pair`, lib/network.js). Test: `test/next/net/directory.js`
  ("a second space joined over a connection already open…"). Found because a new device joins its
  spaces over the connection pairing just opened.
- **Space channel ids were the space keys**, sent to every peer on a connection, whatever topic it came
  from: any peer learnt the keys of all the spaces held, the personal one included. Now the discovery
  key.

- **A removal counts only for the devices of the identity that signed it.** Removals were first kept
  by device key alone, so any member of a shared space could sign, with their own phrase, a removal of
  someone else's device, and every member would cut it. Test: `test/next/forum/devices.js` ("someone
  else can't remove your device…", writing the removal through `lib/testing.js` since the API refuses
  it: `NOT_FOUND`, not one of your devices).

**Smaller choices**:
- **Each device writes its own `hg/device` record** once it is in the personal space (`deviceName`
  from `open()`); a device added by code sends its name with the request, `added` resolves with it, and
  the adding device lists it at once. `removeDevice` refuses a key that isn't listed (`NOT_FOUND`).
- **Spaces are listed by whichever device creates or joins them**, and every device keeps the list and
  what it holds in step (it joins listed spaces, lists the ones it holds), so a device that joined a
  space before its personal space had synced still lists it later.
- **"Only member" is complete only on the only device**: a space whose only member is this identity
  (the personal space, a private notes space) is complete without reaching anyone only while this
  device is the identity's only one (`meta.alone`: a new identity that never added a device).
  Otherwise a new device would call its empty personal space complete.
- **Hypergraph's own types** (`hg/…`) can't be written, edited or deleted by apps, and app rules don't
  apply to them (an app rule rejecting unknown types would drop removals).
- **Settings**: `hg.setSetting(name, value)` with any JSON value, `hg.settings()` → `{ name: value }`,
  latest wins per name (records are only added; a setting set many times keeps every version).

**Not in story 3, flagged for story 4**: a second device of an owner, admin or moderator is not a
writer of the spaces' decision logs (it writes records, not decisions), and removing a device doesn't
stop that device's key from recording decisions where it was a writer. Both need decision-log writer
management (add a device's writer key, remove a removed device's), which story 4 reworks anyway
(admins as indexers).
*(Done in story 4: A8.)*

### A8. Story 4: decision rights follow devices, settlers, invites, unban (decided by Tibo, 2026-10-09)

**Found first, fixed first: a device could mint devices.** keet-identity-key verifies a proof chain of
any length (identity → device → device …), and only the last key is the "device". A stolen device could
attest a new device key; that one's logs and decisions passed every check, and no removal named it.
A7 already made every device prove itself straight from the identity key, so `Identity.verify` now
accepts chains of zero (the identity key itself: identity logs, removals) or one (a bootstrapped
device) only. Test: `test/next/unit/identity.js`.

**Decision rights follow devices** (FR-019, A7's flag):
- A device of a member whose role has `decide` or `moderate` **claims** its decision-log writer key:
  `writer/add { key, proof }`, the proof signed by the device on its identity's behalf (the same
  signable as `space/init`'s). It can't append it itself (not a writer yet), so it sends it on the space
  channel in an `ask` message; any writer records it after checking it would count (the member's other
  device, an admin). Sent when the decisions change (at most every 5 s) and on every new channel.
- A device removal (A7's identity-key-signed `hg/device-remove` record) also goes into the decision log
  as `device/remove { device, cut, proof }`, with the record's exact bytes. **Any writer that indexes a
  removal record records it** (and a device of the same identity asks if it can't): so it reaches the
  decision log even when the remover can't write there, and also in spaces where the device has no
  writer key yet (a member promoted later can't have a removed device claim one). Apply drops every
  writer key of that device and marks it `gone:`, refusing its later claims.
- Losing both `decide` and `moderate` (demotion, removal, ban) drops all the member's writer keys, from
  the view and from Autobase (`host.removeWriter`). Before, a demoted moderator stayed a writer whose
  decisions were ignored; now it can't even append. Promoted again, the redemption's key comes back
  and other devices claim again.
- Apply checks it, not only Autobase: a decision ordered after a removal is ignored because its writer
  key no longer has a `writer:` entry, whatever Autobase does with removed writers. "After" is the
  settled order (constitution Principle I): a decision the settlers saw before the removal settled
  counts, like a demoted moderator's earlier ones. Test: `test/next/forum/devices.js` ("a removed
  device's decisions afterwards…": the stolen phone, offline, bans someone; nobody, newcomer included,
  applies it; the test fails without the removal decision).

**Settlers: one device per decider person** (Tibo, 2026-10-09; the brief said every device of members
with `decide`). Autobase indexers settle the order once most of them have seen a decision. With every
device a settler, a person with a laptop and a rarely-opened phone would need both online to settle,
and a lone owner losing one of two devices would stall settling for good. So: the first writer key of
each member with `decide` settles (owner: the space's first writer; an admin: its redemption's key or
first claim); removing that device hands settling over to another key of the same person; demoted to
moderator, they write but don't settle. Owner gone for good with two admins: 2 of 3 settle (test:
`test/next/net/indexers.js`). Limits, stated in docs/next/concepts.md: Autobase never removes its last
settler (`host.removeable`): a lone owner whose only settling device is lost keeps applying new
decisions but never settles them again; and if that device is stolen, the thief as sole settler
decides the order (its decisions can stay ahead of the removal). A space should have an admin.
Open: Autobase's `fork()` (new settlers when most are gone for good) wasn't tried.

**Invites complete** (FR-023): `invite/revoke { invite }` (body changed from `id`, never written
before: the whole invite, so apply can check its maker), by the maker or who may decide;
`redemptions(link)`; `uses: Infinity` for a public link (encoded 0, as before); who may invite to
what is one pure function (`mayInvite`, used by `createInvite` and apply): `invite` permission, never
owner, below one's rank or member / guest, only permissions held; custom roles allowed (before:
built-in only). A redemption never lowers a role (custom roles by rank).
**Refusals say why, judged by the newcomer itself**: while waiting, the newcomer applies the
recorder's checks (`State.inviteRefusal`: expired, revoked, used up, maker not allowed or newcomer
banned) to its own copy of the decision log, once a member was reached. No refusal message on the wire:
a peer could lie, the decision log can't. Uses and revocations only grow, so a copy that lags never
refuses wrongly for them; "not allowed" from a lagging copy could (the maker's promotion not received
yet): a small risk, noted. `redeemInvite` waits `readTimeout` by default (was 60 s) and drops the space
it opened if refused (`Network.leave`); nobody answering is still `INVITE_INVALID`.

**Unban** (Tibo, 2026-10-09: "new log after unban"): `moderateAction('unban', who)` lifts `banned:`;
the ban's cut stays for good, so once let back in (invite or `setRole`) the member's app writes in a new
log, as after a removal (A4). The brief's "record the lengths held at unban time, like a cut in reverse"
can't work: members stop downloading a banned member's logs at the cut, so they hold nothing from the
ban; ban-time writes would count again. Only someone at least at the rank of who banned lifts a ban.
**Known gap** (also true for a removed member let back in since A4): a modified app could prepare a
brand-new log during the ban (no cut names it) that counts once they're back. Closing it needs a log
header proving it was made after being let back in (e.g. a random code from that decision); later.

**Write limit postponed to story 9** (Tibo, 2026-10-09). A per-log rule ("a record counts if the one N
places earlier is at least a period older") needs earlier records' stamps, but deleted and taken-down
records are wiped everywhere: a newcomer never sees those stamps, older members did, and they would
disagree. `setWriteLimit` stays out of the API (tasks.md T071a).

**Small additions**: `Hypergraph.open(dir, { password })` seals the phrase at once for a new account,
`mnemonic` or `joinCode` (`phrase.saveSealed`: never in the folder in plain text), and protects a
still-plain phrase of an existing folder. `query(type).fromDevice(key)`: records one device put
(`row.device`), filtered while reading the type's index (no new HyperDB index: a folder made before
would miss old rows; a `by-device` index can come when a big space needs it).

### A9. Story 5: the graph vocabulary, shared editing, follow-ups of story 4's review (2026-10-09)

**Relations and tags** (FR-007, FR-008, R5): records of built-in types in their author's own log,
`hg/relation { from, to, rel, value, data, off }` and `hg/tag { on, tag, off }` (R5's field `type` is
`rel`: `type` is the record's own). They are never edited or deleted: `unrelate` and `untag` write a
new one with `off: true`, and the latest wins per (from, to, rel) and per (record, tag). So an
unrelate is undone by relating again (v1: "after unrelate, relate again recreates the edge"), the same
everywhere in any order of arrival; v1's "relating twice doesn't duplicate" holds too. A delete that is
final (A3) would have let one member erase what others can't restore.
- **Who says it** (worker's choice, for the lead's review): a relation from X, or a tag on X, counts only
  if its author **may edit X** — X's author by default (v1's from-ownership rule, test/brittle/core/
  relations.js: a forged edge "from the victim's post" is ignored at apply time), its editors for a
  shared type, with the same cuts as edits. This also gives v1's "any authorized writer can unrelate"
  its new-core meaning: any editor of X. Tags in v1 had no owner; here a tag is the record's (the
  author's, or editors'), like an edit. Personal tags (bookmarks) belong in the personal space.
  Alternative considered: per-author edges and tags (anyone tags anything, `untag` removes only your
  own): simpler, but lets any member hang labels on anyone's records and breaks v1's from-ownership.
- **Edges are computed when read**, from the by-link index (relations touching one record are few):
  group per (from, to, rel), keep the latest allowed, drop `off`. An edge whose `from` isn't held
  doesn't show (its author can't be checked). `edges()` returns `{ items, count, complete }` (the
  contract's "items carry count" made concrete: `count` is before `limit`).
- **Tags live on the tagged row** as index keys (`\0#<tag>`, next to the app's `index` keys in `by-ix`),
  recomputed when a tag record arrives, the target arrives, an edit or resettle rewrites the row's keys,
  a tag record is cut, hidden or taken down, and when edit rights change. So `getByTag` and
  `query(type).tag()` are newest first by when the record was put and page like any query, with no new
  HyperDB index. `getByTag` without a type merges the app's types.
- **Queries compose** (v1: "chained filters compose with AND"): one filter picks the index (where/tag →
  by-ix, `on` → by-link, `by` → by-author, else by-type), the others are checked on each row; `since`
  (inclusive) and `until` (exclusive) bound the stamp. Paging with `after` was already exact for equal
  stamps (rows are ordered by stamp, then id); now tested with three members' records tied.
- `linked(x)` without a type leaves hypergraph's own records out (relations and tags link too).

**Shared editing** (FR-003, US5 #4):
- **Deletes**: only the author's own delete counts, whatever the type (Tibo, 2026-10-09). A moderator who
  isn't the author calling `del()` gets a `remove` decision (A5): ordered and permission-checked at its
  point, so it needs no cut, unlike a "moderators may delete" record rule would (a moderator demoted
  later: was their delete allowed?).
- **Edits by permission use A4's cut**: `role/set` already carries the decider's held lengths; apply now
  also records them under `editcut:<id>` for each app permission the role change takes away (not
  `post`, which has its own cut, nor hypergraph's decision rights, which are ordered). An edit (or
  relation, or tag) by someone other than the author counts if its position is below the editor's cut
  for that permission, or, for a log no cut names, while the editor holds it. Two consequences, both
  converging: edits made before the permission was given count once it is (only a modified app writes
  them: the API refuses); and given it back, the editor writes in a new log (its app switches before
  writing, as after an unban), since a log's first cut stays.
- `editable: 'members'` relies on the log limit (A4), as before.
- **A custom role never loses an app permission** (extends A5's rule for `post`): its holders can't be
  listed reliably to cut each one. It may lose `decide`, `moderate`, `invite`, `roles`.
- **The owner holds every permission**, the app's included (it had only hypergraph's: an owner couldn't
  edit a wiki page without giving itself a role).
- When edit rights change (who holds an app permission used by a type, or a new edit cut), the indexer
  judges the edits of those types and the tags on their records again (`Indexer.reauthorize`: a scan of
  the space's `changes` and tag rows; decisions are rare). It also runs once at open.

**Follow-ups settled in story 4's review (ROADMAP 2026-10-09)**:
- `redeemInvite` waits 30 s by default; reads keep `readTimeout`.
- **Catching up before refusing**: role, moderation and invite methods, and `put`/`edit`/`del`/`relate`/
  `tag`, check first; if refused, they catch up with the connected decision writers (`Decisions.catchUp`:
  `core.update({ wait: true })` on every writer's log of the decision log, a wakeup hint to Autobase, then
  wait until it applied what is new, within `readTimeout`) and check again. Only refusals pay the wait,
  and only while connected peers know more. `NOT_ALLOWED` names the reason (banned, not a member, your
  role, their role at or above yours, the permission a type needs). The forum tests' retries after an
  unban and after promoting an admin are gone. A device just *promoted to record decisions* may still
  wait up to 5 s to become a writer (`Decisions.append`); the devices tests keep their retries for that.
- `space.status()` → `{ peers, settlers, warnings }`, with `SINGLE_SETTLER` while one member settles
  (not for the personal space, whose settler comes back from the phrase); docs say "give a space an
  admin".

### A10. Story 6: holding part of a space, rebuild, diagnostics (2026-10-09)

**Dropping content, not records** (R14 left open what eviction does to the index). A dropped record keeps
its row in the local index (type, author, time, links, tag keys: ~0.5 KB) and loses its content: its block
is cleared and the copy of its fields in the row too (flag `DROPPED`). So lists, counts, votes, edits, tags
and edges stay exact on every member whatever it holds (constitution Principle I: holding less changes
only whether an answer is complete). A read needing dropped content fetches it within its bound and keeps
it (flag `READ`, dropped last); if it can't, it leaves the record out and says `complete: false`.
Alternative considered: dropping whole rows past a time horizon (bounded disk whatever the size), rejected
for now: a record fetched back would lose edits and tags dropped with it, and a member couldn't tell. Cost:
the list itself is never dropped, so a space whose list outgrows its share is reported (`OVER_BUDGET`);
members that don't list every record are story 9's. Records under 256 B (votes, tags) and `hg/` records
are never dropped (little to gain; sums need them); nor this identity's records, decision logs, the
personal space. Only rows below their log's `indexed` are dropped, and downloads restart there, so a
dropped block is never fetched again unless read. In an `everything` space, dropped content comes back
once it fits; in `auto`, only when read.

**Stored bytes are estimated** (v2's lesson), measured on this core: content + ~150 B per record in its log,
content + ~550 B in the index (`lib/storage.js`). The SC-011 test measures real disk: 2.84–2.89 MB for a
3 MB budget on Node and Bare, the estimate within 0.2% of it.

**Hypergraph compacts the storage itself.** Block contents ≥ 4 KB live in RocksDB blob files
(hypercore-storage: 256 MB files, garbage collected from the oldest quarter), so dropped content stayed on
disk (+0.5 MB over a 3 MB budget on Bare). After dropping a tenth of its budget, at most every 10 minutes,
an instance compacts both databases, forcing blob collection of its oldest files.

**Dropped counters live in the index's `meta` rows** (`dropped:<space>:<log>`), written in the same
transaction: hyperschema refuses to grow a compact struct, so `@hg/log` couldn't take new fields.

**Rebuild** (FR-012): `instance.json` keeps what the index can't be rebuilt from (identity proof, personal
space keys, spaces and their Corestore namespaces, types, budgets) and an append-only `logs` file names
every accepted log (64 B each). The plan said "found in the Corestore" (`store.list()`): rejected because
the personal space's logs are encrypted, so telling them apart from other cores means guessing encryption
on cores that aren't ours (and a refused probe clears block 0). An unreadable index is set aside
(`index.broken-<time>`), never deleted. Content dropped before is fetched again once. Found while building:
a rebuilt personal space indexing at open made the instance join a listed space it was still opening, which
opened its Autobase twice and hung (fixed: joining listed spaces waits until open is done; opening a space
by key dedupes). The rebuild got 2.7× faster by skipping lookups a space can't need (edits, tags and rows
that came before, when its index held none at open) and 256 blocks per transaction.

**Superseded personal records** (ROADMAP 2026-10-09): only the latest `hg/setting` per name and `hg/heads`
per device keep a row; older blocks are cleared, **except in this device's own log**, kept whole (FR-027,
as A5): other devices fetch and check from it, so none meets a hole nobody can fill. A device's own old
heads and settings therefore stay in its own log (small, written at most every 10 minutes).

**Smaller**: `space.inspect()` (contract "Diagnostics"); `space.roles()`; a device just able to record
decisions waits within `readTimeout` (at least 5 s), claiming its writer key again every second; a new
device code replaces an unused or just-used one (a second code crashed the process: blind-pairing allows
one listener per account); `settings/set { policy }` applied by who may decide.

**Routed to story 9** (lead, 2026-10-09): a newcomer to a space bigger than its share still downloads it
once, then drops the oldest part.

### A11. Story 7: app versions (2026-10-09)

R6's check at open and experiment 6's encoding were already there; building the forum test found three gaps.

**An older app's edit erased the fields it doesn't know.** An edit carries all the fields of the new version
(A3), and the old app only knows its own. Now an edit keeps the replaced version's unknown field entries byte
for byte, and with them that version's links first, in place: an unknown field may be a link into that list,
and the old app can't tell. Cost: when such a record's known link field is re-pointed by the old app, the
earlier target stays in its links (`linked(old target)` still lists it). Rare; the same on every member.

**The index derives things from declarations, and they go stale when the app learns more.** Rows of a type
the app didn't know have no one-per-member grouping, no app index keys, no link-target or rule check, and
others' edits are judged "author only"; a type that gains an index has its old rows missing from it; a link
field appended with allowed targets was never checked. At open, if a type is new, gained an index, or gained
a link field with allowed targets, **and** the index holds records of it, the index is replaced and rebuilt
from the held logs (A10's rebuild; the old one is removed, not set aside: it isn't damaged). The member then
shows exactly what a member who always had this version shows (Principle I). Considered: re-judging only the
rows of those types (a scan per type) — rejected for now: the rows of a newly checked type can depend on
records refused earlier (cut, rules) and on content dropped since, which the rebuild already handles. Cost:
one rebuild per such update (100k records ~20 s, A10), reads `complete: false` meanwhile. A type gaining a
plain field rebuilds nothing.

**Declarations that looked compatible but changed meaning.** `describe()` now stores indexes (folders that
stored none are taken as unchanged). Appending a link field with allowed targets is allowed (it failed as
"links changed"); changing an existing link field's targets is refused naming the field; appending the first
link field of a one-per-member type is refused (it would change what one per member groups by). A downgrade
(opening with an older declaration than the one stored) is refused like any removal and leaves the folder
unchanged.

**App indexes leave out records whose indexed fields are all empty.** Adding `post.topic` with an index gave
every post (all the old version's) an index entry for "no topic", which the stored-bytes estimate (A10, ~550 B
a row, measured without app indexes) doesn't count: the budgets test went 10% over on disk. An index entry for
"no value" is useless to `where()` and different on members that indexed before and after the field existed, so
those records aren't indexed and `where()` with no value throws `INVALID_RECORD`.

**Limits found, not fixed here** (for the lead):
- The stored-bytes estimate doesn't count app index entries (one per declared index per record that has a
  value): an app indexing several fields of many records can go past its budget. Measure and add per index.
- `test/next/forum/budgets.js` #2 ("the oldest post's content is dropped") is flaky on Bare: 3 of 12 runs on
  `011-spaces-core` itself (it can check before the first drop happened: "settled" accepts 10% over the share).
- App `rules` are code: a newer version refusing what an older one accepted (or the reverse) makes members
  disagree on what exists. Documented (docs/next/api.md); hypergraph can't detect it.
- A link field's allowed targets are checked when the record arrives, only if its target is already held
  (A3: "checked when the target is held"); nothing re-checks the record when the target arrives later. A
  misbehaving member can therefore make two honest members disagree (one held the target first, one didn't).
  Predates story 7; story 7's rebuild doesn't change it.
- A record of a hypergraph type (`hg/…`) this version doesn't know is refused: a future hypergraph version
  adding a built-in type would be disagreed on by members on the older one.

### A12. Core follow-ups of the review of story 7 and the inspector (2026-10-09)

**Link targets are judged when read** (Principle I, A11's limit). A link field's allowed targets were checked
when the record arrived, only if the target was held then, and never again: a member that held the target first
refused the record, one that got the record first kept it, and a misbehaving member could make them disagree.
Now a record is kept whatever its links point at, and every read that follows a link (`linked`, `count`, `sum`,
`query().on()`, and the link field shown on the record) looks at the target: held here with a type the field
doesn't allow → that link counts for nothing (the field reads `null`, the record isn't "on" it); not held → the
link stands as written. A record's type never changes, and a target that isn't held is either on its way or gone
on every member (deleted, taken down, cut), so every member judges alike whatever arrived first.
Considered: marking rows when the target arrives (reads stay free) — rejected: once a target is deleted its type
is gone, so a member that marked the row and a newcomer that never saw the target would disagree. Costs: one
index lookup per target followed (cached per read); a record whose content was dropped here (story 6) is fetched
to tell which of its fields points at the target only when that matters (some fields allow the type, others
don't), or the answer says `complete: false`. Consequence: a type gaining a link field with targets no longer
rebuilds the index (A11's `stale()` drops that case). Known limit, as for fields: an older app version that
doesn't know a link field counts a link through it as written. Test: `test/next/forum/link-targets.js` (both
orders of arrival, a newcomer, the target deleted).

**Future hypergraph types** (`hg/…` unknown to this version) are kept and counted by type like unknown app types
(`test/next/forum/versions.js`).

**Flaky tests.** `budgets.js` #2 checked the drop before the budget pass made it: it waits for it now. Disk is
measured once RocksDB flushed its write-ahead log (compacting until within, bounded): right after a reader
downloaded and dropped a lot, that log holds the churn (seen at 0.8 MB). `inspect.js`'s stranger announced its log
once; a member whose header fetch missed it never heard again (by design: someone may offer it again): the
stranger now keeps pushing while waited for, as a spammer would. Tests' own limits are above their waits.

**Reads for the inspector**: `space.members()` (members by role, then banned and removed people), `space.decisions()`
(a list apply writes into the decision log's view — `~log:<n>`, after every other key so the state's read skips it —
so it follows Autobase's reorders and every member lists the same once settled; a decision is `counted` when it
changed the view; one by a removed writer key that Autobase never applies is not listed), `hg.types()`,
`space.tags(record)`, `space.peers()` (the swarm uses the device key pair, so a connection's remote key is the
peer's device key; each side sends its device proof, `hello`, checked against it), `inspect({ records })`,
`inspect({ record })`, events `peers` and `logs` (at most every 100 ms). Renamed inside: `space.decisionLog` (the
Autobase), `hg._types`, to free the method names. The inspector uses them and no longer polls.

**Storage estimate**: app index entries and tag keys are counted per log (`meta dropped:<space>:<log>` gains `ix`),
each ~160 B plus twice its key (`bench/next/ix-cost.js`: 175–183 B per entry with ~10-character keys). A reader of a
forum indexing three fields went 25% over its budget on disk before (2.74 MB for 2 MB once flushed).

**`undefined` is absent** in `put` and `edit` (an edit leaves the field as it was), known to the type or not; an unknown
field with a value (`null` included) is still a typo (`INVALID_RECORD`).

**App rules are code**: `settings/set` gains `rules` (a trailing field, absent from older entries), recorded by who
may decide (`createSpace` records the creator's app's, `space.setRules()` this app's); `status()` warns `RULES_DIFFER`
naming the ids that differ. Nothing can make every member run the same rules; this only detects it. A rule changed
in place under the same id goes unnoticed: change the id with the behavior (docs/next/api.md).

### A13. Story 8: sub-spaces and private spaces (2026-10-10)

**A missed announcement is recovered without a reconnect** (routed from the review of the core follow-ups). A new
log was announced once (a notice); a member that missed it (the message lost, or its header fetch timed out, as
A12's stranger showed) never heard of the log again until a reconnect sent the summary. Now each member sends its
directory summary again 250 ms after its directory changed (once per burst) and every 10–11 s; a member whose
directory differs asks for the list, but not again for the same difference (both digests unchanged) within a
minute, so two members that disagree for good (a log one refuses and the other keeps) don't trade lists every
period. Cost: one 40-byte message per connection per space every 10 s. Tests: `test/next/net/directory.js` ("a log
whose announcement was missed still arrives": after a change, and with only the periodic summary left, which fails
without it).


**A sub-space's decisions live in its parent's decision log** (decided by Tibo, 2026-10-10, replacing R15's "a
sub-space is a space whose `space/init` names its parent"). With a decision log of its own, a sub-space's decisions
and its parent's would have no common order: when a parent admin is demoted or banned, members couldn't agree
whether that admin's decision inside the sub-space (a guest let in) came before or after, and fixing it needed
copying the parent's role changes into every sub-space log, with a delay during which the demoted admin still acted
there. Now a decision about a sub-space is `scoped { space, decision }` in its top space's log, applied to the
sub-space's own entries (`sub:<key>:…` in the view) with the roles that count there: its own, else the parent's
(for a private one, only the parent's owner and admins), and nobody banned there or above. One order for everything:
a parent ban always wins whatever arrives first, and FR-019 holds exactly (decisions made before losing a role stay
valid). The sub-space keeps its own key, logs, topic, index and budget; its log headers name the top space's
decision log (the header's `decisions` field, A3), checked by the gate. Costs: members download the sub-spaces'
decisions too (small); a sub-space-only moderator becomes a writer of the top space's decision log (apply lets it act
only there); settlers stay the top space's deciders. Rules (all in `lib/decisions/apply.js` and `state.js`):
- `subspace/create { key (random), name, private, writeRoles }` by who may decide where it is recorded; nesting is a
  `scoped` subspace/create. `writeRoles`: only those roles write (the owner and admins always may).
- A removal from a space drops the member's own entries in every sub-space below (a parent removal applies below); a
  ban is checked up the chain. Bans and removals carry the cut of the member's logs in the sub-spaces the decider holds
  (`#cutOf`), and a ban records its cut even for someone with no role at that level (a guest below). Cuts are the union
  (lowest length per log, `mergeCuts`).
- Custom roles stay the top space's (a sub-space's own `role/define` isn't supported).
- **Seen without joining**: members of a space open its sub-spaces they're in (`hg._openSubspaces`, after every change
  of decisions); a guest joins with a sub-space invite, which carries the top space's key after the invite and is
  signed with it (top-level links unchanged). The guest opens the top space's decision log only (one shared
  `Decisions` per top space, a registry: opening one Autobase twice hangs), not its content. `@hg/spaces.parent` holds
  the top space's key for a sub-space (the compact struct can't grow), instance.json `root`, and the personal
  space's `hg/space` gains `root` so the person's other devices join it.
- A device removal in a sub-space where only a sub-space is held (a guest) doesn't reach the top space's decision log
  (its proof names the sub-space): its writer keys there stay until the top space hears of it. Rare; noted.
- `createInvite({ subspaces })` stays unused: invite to the sub-space itself.
Tests: `test/next/unit/decisions-subspaces.js` (apply and state), `test/next/forum/subforums.js` (seen without joining,
nested, write roles, guests and their restart, a parent ban in both arrival orders — an offline member coming back
and a newcomer —, a parent removal, shortcuts).

**Private spaces** (FR-021, spec 008's design with grants as records). `lib/private/crypto.js`, `grants.js`:
- A device's box key pair is its device key pair converted to X25519 (spec 008 derived one pair per identity from its
  seed; here a device may not hold the recovery phrase unlocked, A4, and per-device grants leave a removed device
  out). Anyone seals to a device knowing its public key, from its log header's proof.
- `hg/grant { to, epoch, commit, sealed }` records in the granter's log of the private space (signed by that log);
  recipients find theirs through the type's index on `to` (the "grants-for" lookup, through `by-ix`: no new HyperDB
  index). A grant counts for whoever opens it if its key matches a commitment the decision log recorded.
- `key/rotate { epoch, commit }`: epoch = current + 1, by who may decide or moderate there. **Two rotations at once**:
  the first in the order becomes current; the other's commitment is kept as readable (`others`). Found while testing a
  ban: Autobase can reorder two rotations after each rotator already used its key, so a device keyed by epoch kept the
  losing key and couldn't open the winner's posts, and posts sealed with the losing key would have been unreadable to
  everyone but their author. Keys are therefore looked up by commitment (a sealed record names the first 8 bytes of
  its key's), and both keys stay readable.
- Records are sealed per epoch: fields and links, AD = space, log, position and epoch (`OwnLog.append` writes one at a
  time so the position is known before sealing); type, author, stamp, kind and target stay visible (metadata, as in
  008). Deletes, grants and device removals are never sealed. A record sealed with a key this device doesn't hold is a
  hole until the key arrives (counted as missing: `complete: false`), then indexed; a sealed record that doesn't open
  with its key counts for nothing, for everyone. A put written in the clear in a private space is an `unreadable` row
  (listed, no content); an edit in the clear counts for nothing.
- Key holders grant the current key to every entitled device (members' devices in the directory, removed devices left
  out) that lacks it. **Before writing**, a writer checks that no device holding the current key has lost access; if
  one has, it changes the key first if it may decide or moderate, else waits (within `readTimeout`) for one who may:
  a removed member never reads what is written after its removal by a writer who knew of it. (A writer who hadn't yet
  heard of the removal still uses the old key: the same window spec 008 had.)
- Keys live in memory only (a JS private field), re-opened from the grants in the index at open; never in `inspect()`,
  `status()`, errors or the inspector (`inspect()` gives `private`, `epoch`, `readable`).
- A member without the key (removed, or a relay) holds blocks it can't open, so its answers stay `complete: false`
  and every read waits its full bound. Honest, but slow for such a member; a later story may let it say "not for me".
Tests: `test/next/unit/private-crypto.js`, `decisions-subspaces.js` (key/rotate), `test/next/forum/private.js` (members
read, a plain member doesn't have it, a relay holds blocks with no plaintext, keys back after a restart, an invite with
the inviter offline, a removal and a parent ban change the key, a record in the clear is unreadable, no key shown, a
private top-level forum).

### A14. Story 9: big spaces, write limits, routed items (2026-10-10)

**Periods and activity entries** (FR-029, R10). A period is an hour of record stamps (fixed; the brief's "periods
shrink in busy spaces" is left for later: at 10,000 active authors an hour's list is ~410 KB). An entry `{ log,
period, start }` (~40 B, `lib/activity.js`) says "block `start` is this log's first record stamped in `period` or
later". No signature: whoever keeps it first checks it against the log (block `start − 1` is the header or a record
stamped in an earlier period; block `start`, when held, is not earlier) and against the gate (its log was accepted:
header proof, the author may write here, `start` below the log's cut). False entries and entries for logs that may not
write are dropped and never passed on. The entry is as short as the brief's notice (~40 B), so **the entry itself is
the notice**: flooding it once per connection (at most one copy per connection, tested) costs less than a notice plus
an ask. Every member derives the entries of the logs it indexes (the first record of each period, skipping wiped
blocks back to the last readable one, so the block before a start is always checkable) and keeps them in a new index
collection (`@hg/activity`, appended to the HyperDB definition). When a block is wiped later (a delete, a take-down),
an entry starting right after it is moved to start earlier, else nobody could check it any more (found by the
newest-first test: the forum's newest post deleted made its period's entry uncheckable). Entries waiting for their
check are bounded (1,000, dropped after 60 s; a drop makes the lists "not whole" until asked again); logs learnt from
entries are fetched 16 at a time with at most 256 waiting: **10,000 throwaway-key entries leave no entry, no log, no
row and reach no other member** (SC-006, `test/next/net/activity.js`).

**Reading from a horizon** (US9 #1, T071b). A member reads each log from its first block in its *horizon* period on
(null: everything, as every member before story 9 and every small space). A newcomer chooses at the first summary it
receives (which now carries how many records the sender's logs hold): more than 2,000 records → newest first (horizon
= the current hour; it asks one member at a time for the entries from there, `want { from }` / `list { from, entries,
done }`, the answer saying from which period the sender's lists are whole); 300 logs or more → also by activity lists:
it doesn't ask for the whole directory and opens only the logs the entries name. A read needing older records widens
the horizon (to a page's oldest post's period, or one step back, the window doubling, once what it reads is all
here). In the background, after each budget pass, it widens one step while `stored × 2 < 90%` of its share (or always
under `everything`), and once it holds everything from the space's first period it reads everything again, as any
member that always had it. Past its share it stops: **a newcomer to a space bigger than its share never downloads the
rest** (`status().held` 'part', `heldFrom`). A log read from earlier keeps what it indexed (`skip`), and rows already
indexed are never inserted twice (found by the test: a vote indexed twice superseded itself).

**Complete, per read.** Reads now say what they need: a page from its oldest item on (`since` included); `linked`,
`count`, `sum`, `edges`, `tags` from their target's stamp; `get` from the record's. A member reading everything
answers as before (the whole space); one reading from a horizon is complete when the lists from that period were
received whole, none waits for its check, and every log with an entry from then on is read from its start with
nothing missing. So that whoever holds a record's period on holds what points at it, **a record is now stamped above
the records it links to** (held where it is written; a target stamped far ahead of the writer's clock is ignored, not
to drag its stamps into the future), as edits already were (A1). Principle I: reading fewer logs changes only
`complete`; the tests compare pages, scores and comments with a member holding everything (`newest-first.js`,
`big-directory.js`). **Limits** (modified apps only): records stamped out of order inside one log, or a link stamped
below its target, can be missed by a member reading part of a space while it says complete (members holding
everything show them); the lists a member gives are trusted to be whole, as the directory always was.

**The switch-over, measured** (`bench/next/first-page.js --slices`, 10,000 records by 20 writers each writing one
stretch of time, local DHT, one process): reading the whole directory (22 logs) 357 ms and 202 KB for the first page;
by activity lists (3 logs opened) 375 ms and 173 KB. Each log opened costs a newcomer ~1.5 KB and ~1 ms (header,
replication handshake; ~120 KB of memory per open log, spec 007 R1), so the switch is set at **300 logs** (~0.45 MB),
keeping a first page under 1 MB whatever the size. (A 50-writer run stalled in its setup: many writers in one process
spend their time in Hypercore's replication, not in hypergraph, seen in a CPU profile; also true before story 9.)

**SC-004** (`bench/next/first-page.js`, 2 writers, 10% posts, 60% comments, 30% votes, ~40 posts an hour, the owner
alone online, local DHT; 2026-10-10):

| records | first page | received | as before story 9 (read everything) |
|---|---|---|---|
| 10,000 | 223 ms | 92 KB | 2,387 ms, 1,449 KB (SC-004 not met) |
| 100,000 | 238 ms | 95 KB | not run |
| 1,000,000 | 227 ms | 77 KB | not run (2026-10-11, A15: writers in their own processes; 10,000 in that harness: ~203 ms, 73 KB) |

100,000 vs 10,000: 1.07 times the time, 1.03 times the bytes (SC-004 asks at most 1.5 times at 1,000,000). Activity
per member per period: one ~41-byte entry per log active in that hour, received at most once per connection.

**Found by the benchmark, fixed (also true before story 9)**: (1) a newcomer counted as having "reached" a member as
soon as any summary arrived, so a read could be complete before it had heard of the other members' logs; now only
once a member's whole list of logs was looked at (or matched this one). (2) The indexer counted blocks as looked at
before their batch was committed, so a read in between was complete without the newest records; now a log with an
uncommitted batch counts as missing something, and a read is complete only if nothing was indexed while it read. (3)
A log whose length no peer has told yet (or that a peer says is longer) counts as missing (for 2 s after it was
accepted, if no peer ever says). Tests: `test/next/net/directory.js` (slow lists, slow commits; both fail without the
fixes).

**Write limits for open spaces** (T071a, FR-023; A8 postponed it). `setWriteLimit({ records, periodMs })` by who may
decide (`settings/set { writeLimit }`, `meta.writeLimit`; `records` 0 lifts it). A device's log counts at most
`records` records within any `periodMs`: block `seq` counts if `seq ≤ records`, or if the first *readable* block from
`seq − records` on is stamped at least `periodMs` before it (`lib/limit.js`). A wiped block (deleted, taken down)
takes the stamp of the next readable one: **deleting never frees room**, and once a member knows of a wipe it judges
again the records just after it, so a member who saw the wiped record and a newcomer who never did agree (A8's
problem). Deletes, grants and device removals are never refused (they still take their place). Records over the limit
are neither indexed nor kept (their stamps are remembered for later judgments; after a restart they are fetched from
their author again); raising or lifting the limit judges every log again and reads it again from its start, so refused
records come back from their authors. The writer's own app refuses beyond it (`NOT_ALLOWED`, saying when). Limit:
stamps are the writer's; a modified app gets past the limit only by stamping its records ever further in the future,
where every member flags them `futureStamp`. Tests: `test/next/unit/write-limit.js`, `test/next/forum/open-forum.js`
(forum.js: `openLink(forum, { perHour })`).

**A log prepared during a ban** (story 4's gap, A8). A decision letting someone with a cut post again records a code
(`admit:<id>`: hash of its writer key and bytes; the first such decision after their latest cut). Every log they make
afterwards carries it in its header (`admitted`, trailing); a log of someone cut before that no cut names counts only
with the current code. A log a modified app prepared during the ban can't have it (the decision didn't exist yet), so
it counts for nobody. The app's own log made before being let back in is replaced by a new one. Not covered: edit
cuts (A9: a log prepared while an app permission was taken away). Test: `test/next/forum/readmitted.js` (fails
without it).

**Not for me** (routed, ROADMAP 2026-10-10). `status().access`: 'full', 'waiting' (a member of a private space whose
key hasn't arrived) or 'none' (a private space this member may not read: removed, or a relay). With 'none', reads
answer at once with `{ items, complete: false, access: 'none' }` instead of waiting their bound for keys that will
never come. `inspect()` and the inspector show it. Test: `test/next/forum/private.js`.

**Invites with sub-spaces** (routed). `createInvite({ subspaces })`: the newcomer gets the invite's role in each listed
sub-space (inside the space, at any depth; its maker must be able to invite to that role there, judged by the recorder
too), a private one included: one link lets someone into a forum and its private room. Test:
`test/next/forum/private.js`.

**Not done.** (1) T071b's second half: a member that already holds everything and whose list of records alone
outgrows its share still reports `OVER_BUDGET`; raising its horizon (dropping the rows of old periods, which come back
when a read widens) fits this design but isn't built. (2) The horizon and `from` live in the index's meta: an index
rebuild reads the space whole again. (3) The 1,000,000-record run of SC-004 (asked first). (4) A random key per
connection (ROADMAP 2026-10-10: later).

### A15. The final pass (2026-10-11)

Phase 12, by the final-pass worker session (branch `011-spaces-core-final`); the lead's decision of 2026-10-11 (the
1,000,000 benchmark approved; ponytail as a read-only audit).

**SC-004 at 1,000,000 records** (`bench/next/first-page.js 1000000`, 2 writers, alone on the machine, instances on
E:): first page **227 ms, 77 KB** (newest first, complete, the same 20 posts as the owner's); at 10,000 in the same
harness ~203 ms / 73 KB (two runs), at 100,000 205 ms / 71 KB: **1.12 times the time, 1.05 times the bytes (met)**.
Setup 7.7 min (writing 86 s, the owner downloading and indexing 1,000,000 records 378 s); disk ~1.03 GB per instance
(owner and each writer, which also held the other's log); peak memory 0.90 GB in the owner's process, 1.37 GB in the
two writer processes together; the newcomer stored 1.2 MB. The benchmark now stops by itself past 30 minutes of setup
or 6 GB of memory (`--max-minutes`, `--max-gb`). **The harness changed**: with every instance in one process, at
1,000,000 records the writers indexing and serving their own 500,000-record logs shared one thread with the owner,
which held ~250 records/s (over an hour of setup; one instance indexing alone: ~5,600–8,000/s). Writers now run in
their own processes (`bench/next/_writer.js`, below-normal priority); 10,000 and 100,000 were re-run in it.

**SC-005, partly** (`bench/next/writers.js`, 5 processes × 10 authors, 3 posts each, 1 s apart, all at once; the
owner and one member watch with a live query): **34 authors writing at once: every member saw every post within 2 s**
(102/102; median 140 ms, 95% 1,072 ms, slowest 1,234 ms). **16 of the 50 authors could not join** (two tries of 30 s
each), and joining took 21 minutes. Cause, found with plain Hyperswarm (no hypergraph): across processes, when two
peers dial each other at the same moment, one side can keep a connection the other already dropped; it times out
after ~15 s, or stays longer; meanwhile no channel opens on it, and a newcomer whose only link to the members able to
let it in is such a connection waits. This is also why joins on the local DHT take either ~1 s or ~15 s. In one
process (the tests) it doesn't happen. Not changed in `lib/` (an upstream behaviour; options in the report): ROADMAP
open question.

**SC-006** (`test/next/net/adversarial.js`, Node and Bare): a member's modified app writing junk into its log
(garbage, empty and 70 KB blocks, a record over 64 KB, an unknown kind, a put with a target, a link that isn't an id,
fields that don't decode, a 10 KB type name, a record breaking the forum's rule, edits and deletes of someone else's
post, an empty tag, an empty relation, a comment on nothing, a stamp past 2^53 written raw, posts stamped a year and
"the end of time" ahead), a stranger sending odd and malformed messages of every kind on the space channel, a banned
member and a removed device writing on: **no crash; every member and a newcomer show exactly the valid posts**,
records stamped far ahead flagged `futureStamp`, a reply to one stamped near the writer's clock. **Found and fixed
(test first)**: log keys named by any peer (notices, lists of logs) were fetched all at once (2,500 at once in the
test; ~120 KB per open log, so ~100,000 made-up keys would take ~12 GB): now 16 at a time, at most 1,024 waiting,
more dropped (a list with dropped keys is asked again at the next summary). Each made-up key tried leaves ~250 B in
the Corestore (measured), now at most 16 every ~10 s. Remaining, in the audit: a flood still delays real logs
(audit 5), a stranger can make `complete` lie for a newcomer (audit 3), and anyone who sees a space's topic can read
it (audit 1).

**SC-003**: a new forum test plays a partition healed after both sides wrote (posts, comments, votes on the same
post, an edit, a shared note edited on both sides): every member shows the same (`test/next/forum/partition.js`).

**SC-012**: `bench/next/brief.js` and `rebuild.js`; results and every difference over 25% explained in
`specs/research/design-brief.md` ("Re-run on the real core"). Rebuild of 100,000 records: 17.8 s (SC-008).

**Docs (FR-033)**: `docs/next/deleting-and-incomplete.md`, the README section, docs/next checked against
contracts/api.md: **`hg.leaveSpace()` and `space.addProtocol()` (FR-031, SwarmFS's transfers) are not built**, though
the contract said "all of spec 011"; now marked there.

**Audit**: `specs/011-spaces-core/audit.md` (read-only, nothing applied).

#### Success criteria

| | criterion | | evidence |
|---|---|---|---|
| SC-001 | every forum flow tested, three members, agree within 1 s | met | a test per flow in `test/next/forum/` (25 files); 1 s asserted for posts, comments, votes (`post-comment-vote.js`); three members agree in 16 ms median (design brief re-run) |
| SC-002 | forum data code: public API only, under 400 lines | met | `test/next/forum/forum.js`: 398 lines, `require('hypergraph/next')` only |
| SC-003 | convergence, partition healed after both sides wrote | met | `partition.js` (new), concurrent edits from two offline devices, two admins deciding at once, offline members catching up |
| SC-004 | first page within 2 s and 1 MB at 10k and 1M; 1M ≤ 1.5 × 10k | met | 203 ms / 73 KB and 227 ms / 77 KB (1.12×, 1.05×) |
| SC-005 | 50 authors at once, every member sees every record within 2 s | partly | 34 authors: 102/102 within 2 s (slowest 1.2 s); 16 of 50 couldn't join across processes (above). **A16**: 47 of 50 joined (two runs), 141/141 within 2 s (slowest 1.5 s, 0.95 s); 3 still not let in |
| SC-006 | nothing a peer sends crashes a member or shows where it shouldn't; 10,000 spam entries add nothing | met | `adversarial.js` (and the fix above), `activity.js` (10,000 throwaway-key entries); caveats: audit 1, 3, 5 (**A16**: 1 and 3 fixed, `closed.js`; 5 remains) |
| SC-007 | no read waits past its bound; incomplete when holders are offline | met | `test/next/net/bounded.js`, `private.js` (`access: 'none'` at once) |
| SC-008 | 100,000-record index rebuilt within 30 s; after a crash only the unsaved part | met | 17.8 s (`bench/next/rebuild.js`); `forum/rebuild.js` (crash test) |
| SC-009 | a change after seeing an earlier one wins, other clock an hour ahead | met | `forum/devices.js` |
| SC-010 | second device by code shows spaces and settings within 10 s | met | `forum/devices.js` asserts < 10 s |
| SC-011 | disk within each budget (+10%) while spaces grow | met | `forum/budgets.js` (A10: 2.84–2.89 MB measured against 3 MB) |
| SC-012 | design brief re-run, differences over 25% explained | met | `specs/research/design-brief.md` |
| SC-013 | v1 and hyperDNS suites pass at every commit | met at the checkpoints | final run below; not re-run at every commit of this pass (only `src/` changes could break them, and none touched it) |
| SC-014 | whole suite on Bare and Node | met | final run below |

**Final run** (2026-10-11, after the last change, one suite at a time): `npm run test:next` **257/257**;
`npm run test:next:bare` **256/256** (the inspector test is Node only), but 2 of 3 full Bare runs had one failure:
`test/next/forum/rules.js` "nor kept by the others" (a 3 s wait for a rejected block to be cleared, under the
suite's load; 3/3 alone) — timing-sensitive, like `budgets.js` and `inspect.js` before; v1 `npm test` **390/390**;
hyperDNS `npm test` **46/46** (linked to the main checkout; this branch doesn't touch `src/`).

### A16. Pre-merge fixes (2026-10-11)

Phase 13, by the pre-merge worker session (branch `011-spaces-core-premerge`); the lead's decision of 2026-10-11
("review of spec 011's final pass"). Ponytail (full) for new code; every item test first, on Node and Bare.

**A closed forum stays closed (audit 1).** The space channel's handshake now carries a capability, as Hypercore's
replication does: `hash(NS_INITIATOR|NS_RESPONDER, space key, the connection's handshake hash)` (per side, so it can't
be sent back). A channel whose peer doesn't prove it knows the key is closed in `onopen`, before anything is
answered: no log list, notice, activity entry or list reaches a peer knowing only the topic. Wire change within
`next` (no released peer speaks the old one). `test/next/net/closed.js`: a peer on the topic with no capability, or a
guessed one, gets no log key; members sync.

**A stranger can't make a page complete (audit 3).** Activity lists are asked of members only (their `hello`
proved who they are; asked again when a hello comes or the decisions change), and only an asked member's list makes
the lists "whole". `test/next/unit/activity.js`.

**The recovery phrase (audit 2).** Written with mode 0600 (and chmod'd, for a `.tmp` left by a crash); a new
instance folder is created 0700 (the device key pair is inside). Node and Bare (bare-fs takes `mode`); Windows ignores
modes (the user's profile folder is private by default): documented in docs/next/api.md. The mode tests skip on
Windows; they couldn't be run on Linux or macOS in this session (no Node in the machine's WSL).

**Crash-safe writes (audits 6, 7).** `protect` writes the sealed copy and renames it over the plain one (it used to
delete the plain file first: a crash in between lost the phrase). The `logs` file: the lead's list said "temporary
file and rename"; the audit's own fix was used instead — a torn tail is cut when the file is read at open, before
any append — which gives the same guarantee (a crash leaves the old entries, never shifted ones) without rewriting
the whole file for every log accepted. Tests simulate the crash (a rename that throws; 40 torn bytes).

**Connections that never open their space channel (A15's SC-005 cause).** Reproduced with plain Hyperswarm across
processes (`bench/next/double-dial.js`: 11–18 dead connections over 8 peers per run, each closed after ~13 s), and
found why in Hyperswarm's code: each side resolves the duplicate on its own and can keep the connection the other
destroyed, and a closed *server* connection is never dialed again — so the pair stays apart (22–23 of the peers that
met had no channel 30 s later). Workaround in `lib/network.js`: a connection nothing arrives on within 5 s is closed
and the peer dialed again with `joinPeer` (the side Hyperswarm expects to dial at once, the other after 2–4 s if still
apart; `leavePeer` once linked). Measured over a minute (6 processes plus the owner, alone): with it, every pair that
met was linked from ~15 s on; without it, 11–12 of ~30 stayed apart all minute. Not perfect: Hyperswarm can keep
swallowing a pair's new connections while it holds a dial of its own (`_handleServerConnectionSwap`); in bad runs up
to 7 of ~35 are apart after 25 s. `test/next/net/dead-connection.js` (separate processes; on Bare through
bare-subprocess) asserts what the workaround guarantees — no connection open 8 s without its space channel — and
reports the pairs still apart. Draft upstream report, not posted: `specs/011-spaces-core/upstream-hyperswarm.md`.

**`space.addProtocol()` (FR-031).** A Protomux channel `name` with id the discovery key, opened next to the space
channel once it opened (so only with peers that proved they know the key), and through `mux.pair` when the other side
adds it later. Handlers get `peer = { identity, device, send(i, msg) }`. `test/next/net/protocol.js`.

**`hg.leaveSpace()`.** Closes the space and its sub-spaces held here, clears every block of their logs (own, identity
log, every accepted log) and deletes their index rows and meta; this device remembers it left (`left` in the index's
meta and instance.json) so the personal space's list doesn't open it again; `redeemInvite` (any `keep`) clears that.
Membership doesn't change. Not deleted: the cores themselves (their trees) and the decision log — Hypercore 11.37's
`purge()` calls methods that don't exist (`_closeAllSessions`, `core.purge`), and deleting a named core from storage
leaves its name, so rejoining would fail (`STORAGE_EMPTY`). Another upstream report candidate.
`test/next/forum/leave.js` (sub-forum included, reopening the app, joining again).

**`rules.js`**: it already waited for its condition; the bound went from 3 s to 10 s.

**SC-005 re-run** (`bench/next/writers.js`, 5 processes × 10 authors, alone on the machine), two runs: **47 of 50
authors joined** (A15: 34), in 796 s and 571 s (A15: 21 minutes), 7 and 4 joins needing a second 30 s try, 3 never let
in after two; then **141/141 posts seen by both members within 2 s** (median 646 / 442 ms, slowest 1,507 / 946 ms).
Still *partly*: the 3 authors left out are most likely the remaining Hyperswarm case above (a newcomer whose only
links to the owner — the only one who lets people in — keep being swallowed); the benchmark's joins depend on one
member, which a real forum with admins online would not.

**Private spaces: the history, a key chain** (added by the lead conversation during the session; a gap found in
review). Key holders granted only the current epoch key, so after any rotation a newcomer couldn't open older records
and its answers stayed `complete: false` for good. No re-encryption: `hg/key-link { from, to, epoch, sealed }` records
(plain, in the writer's log, never refused by the write limit) hold an older epoch key sealed with a newer one
(XChaCha20-Poly1305, AD = space and the older key's commitment); a reader holding `from` opens `to` if its commitment
is one the decision log recorded for that epoch, and so on back to epoch 0. Whoever holds the current key links every
key of an *earlier* epoch it holds that the current one doesn't reach yet: after a rotation, the previous key. Links go
**from a later epoch only, never between keys of one epoch**: in a race (two rotations at once, A13), a member removed
on one side may hold the other side's key, and a link between the two would hand it the post written after its
removal (found by the partition test). Instead the side holding the losing key changes the key once more (both sides
at once raced again, measured), and the next epoch links both. `setHistory('visible' | 'hidden')` is a
`settings/set` field (a trailing optional string: older entries decode without it): hidden means no links written nor
followed, a decider changes the key when a device lacks it (a newcomer or a member's new device) before granting, and
records sealed before the first key a device got count for nothing there (not missing: its reads are complete), so
members see different histories by design. A plain member writing while a newcomer waits still uses the current key
(the newcomer won't read that post). **Found and fixed on the way, both pre-existing**: (1) key work listed who may
read, then wrote grants with awaits between: when the decisions changed meanwhile (a partition healing that removed
someone), the removed member got the new key — each grant is now judged again when written; (2) a write checked
"does a device that lost access hold the current key?" against indexed grants only, so a grant still being written
was missed and the post sealed with a key the removed member was getting — grants this device wrote count at once.
Also seen, not changed: an admin reopening its app rotates the key once while its directory is still loading (its
logs not accepted yet look like devices that lost access); harmless but wasteful.
Tests: `test/next/forum/history.js` (a newcomer after three key changes reads everything, removed members read
nothing new; hidden: a newcomer reads from its join, complete; who may set it; two key changes at once across a
partition: members and a newcomer read both sides, each removed member nothing after its removal — 10/10 runs),
`test/next/unit/decisions-basic.js`, `encodings.js`.

**Docs, said plainly**: docs/next/api.md ("Closed or private?", where the two are chosen) and concepts.md: a closed
space is readable by anyone holding its key, removed members included; only a private space stops them reading what
is written afterwards.

### A17. Dependencies updated; the two Holepunch bugs pinned (2026-10-15)

Worker session `deps-and-upstream` (lead's decision of 2026-10-11, "review of the pre-merge fixes"). Every dependency at
its latest (`specs/research/upstream/dependency-update.md`): brittle 4 runs Bare under plain `brittle` (scripts use
`brittle-node`); Autobase 7.28.2 opens a store session while closing, so four v1 tests close a standalone base before
its store. No `lib/` or `src/` logic changed.

**Hypercore clear (A5)**: theirs, still in 11.37.2. A peer that clears block k makes the others lower its contiguous
length to k without keeping bits for the blocks after it, and a peer that already sent it a "want" (one per 2M blocks)
never asks again: it stalls. Plain reproduction, exact cause, a 7-line patch passing Hypercore's suite, draft issue:
`specs/research/upstream/hypercore.md`. With our re-announce off, no forum test stalls (the trigger is timing), but our
reads send wants all the time: `clearBlocks()` stays. `test/next/unit/clear-blocks.js` now also tests the stall.

**"Hyperswarm double dial" (A16)**: A16's cause was wrong. It is HyperDHT 6.33+: between peers on one host or LAN
dialing each other at once, the client's LAN shortcut connects while the server aborts its holepunch (NAT analysis not
stable) and destroys the stream; the client finds out ~13 s later and retries can race again. Already reported
upstream (holepunchto/hyperdht#304); the open PR #283 fixes our reproductions, as does a one-line patch
(`specs/research/upstream/hyperswarm.md`). Hyperswarm's duplicate rule is not involved. The workaround in
`lib/network.js` stays until a HyperDHT release has the fix; comments corrected. `bench/next/double-dial.js` miscounted
pairs apart (old connections closing after their replacement, processes exiting first); fixed.
