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
