---
description: "Tasks for spec 011: spaces, hypergraph's redesigned core"
---

# Tasks: Spaces — hypergraph's redesigned core

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md) (R1–R20),
[data-model.md](data-model.md), [contracts/api.md](contracts/api.md), [quickstart.md](quickstart.md)

**Tests**: test-first everywhere (constitution Principle II). Every implementation task is preceded by a
test task that fails before it and passes after. The forum scenario tests (`test/next/forum/`) are
written at the start of each story.

**Rules for every task** (from CLAUDE.md and research R2):
- `lib/` uses `b4a` (no `Buffer`), never the `process` global, never `node:` specifiers or Node built-ins
  except through the `imports` map; no dependency that imports `module`.
- Every test runs on Node **and** Bare; network tests use the local DHT helpers, never the internet; no
  `process.exit()`; no `Promise.race` with sleeps (use `within()`).
- v1 (`src/`, `test/brittle/`) is not touched. Reused code is copied into `lib/` and adapted.
- Any change to the public API updates `test/next/forum/` and `contracts/api.md` in the same commit.
- Keep runs short; ask before long benchmarks (machine load).

**Granularity**: Phases 1–6 (setup, foundation, stories 1–4) are detailed: they are the first worker
sessions. Phases 6–12 are deliberately coarser; the lead conversation refines them after reviewing
stories 1–3, when the real API exists.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on unfinished tasks)
- **[Story]**: US1…US9 from spec.md

---

## Phase 1: Setup

**Purpose**: the new tree loads on Node and Bare, and its tests run.

- [X] T001 Add direct dependencies in package.json (research R3): hyperswarm, hyperdb, hyperschema, hypercore, b4a, z32, ready-resource, safety-catch, bare-fs, bare-path, bare-os, bare-events, bare-process; dev: bare; add the `imports` map (fs, path, os, events, process → bare-* under Bare, as in `E:\Code\P2P\swarmwire\package.json`) and the export `"./next": "./lib/index.js"`; `npm install`; v1's `npm test` still passes
- [X] T002 Check `blind-pairing` on Node and Bare (loads, no `module` import, pairs two local instances) in bench/experiments/pairing/check.js; record the result in research.md R9 (adopt it, or fall back to a one-time topic derived from the code)
- [X] T003 Add the `next` group and a `--bare` switch to scripts/test-runner.js; npm scripts `test:next` (Node) and `test:next:bare` (`bare node_modules/brittle/bin/bare.js` over test/next/**)
- [X] T004 [P] Create test/next/helpers.js (temp dirs with retrying removal, local DHT testnet per test, `within()`, open N instances, teardown with bounded waits), Bare-compatible, adapted from test/brittle/helpers.js
- [X] T005 [P] Write test/next/unit/bare-rules.js: fails if any file in lib/ uses `Buffer`, the `process` global, a `node:` specifier, or requires a Node built-in missing from the imports map
- [X] T006 Create the lib/ skeleton per plan.md (empty modules exporting nothing yet) and lib/index.js loading on both runtimes; a smoke test test/next/unit/load.js passes on Node and Bare

**Checkpoint**: `npm run test:next` and `npm run test:next:bare` run (and pass) on the skeleton.

---

## Phase 2: Foundational

**Purpose**: encodings, types, stamps, identity and the index definition every story uses.

- [X] T007 [P] Test test/next/unit/errors.js, then lib/errors.js: `HypergraphError` with codes from contracts/api.md ("Error codes")
- [X] T008 [P] Test test/next/unit/fields.js (round trip per kind; a reader with fewer fields skips unknown numbers; a reader with more fields gets them empty; experiment 6's sizes ±10%), then lib/fields.js (tagged encoding: field number, length, value — from bench/experiments/schema/encoding.js)
- [X] T009 [P] Test test/next/unit/encodings.js (round trip of the log header, records of each kind, every decision of data-model.md, channel messages; records over 64 KB refused with INVALID_RECORD), then lib/encodings.js (compact-encoding structs per data-model.md)
- [X] T010 [P] Test test/next/unit/types.js (declare types with every field kind; validation errors name type and field; `links` target checks; `onePerMember`; `editable` forms; compatibility: appending fields and adding types allowed, anything else throws INCOMPATIBLE_TYPES), then lib/types.js
- [X] T011 [P] Test test/next/unit/stamp.js (stamp = max(now, newest own seen + 1); ties broken by lower device key; a stamp > 10 min ahead is ordered as now + 10 min and flagged), then lib/stamp.js (research R7)
- [X] T012 [P] Test test/next/unit/identity.js (new identity with recovery phrase; restore from phrase gives the same identity; device proof verifies to the identity; a device attested by a device verifies; `attestData` verifies), then lib/identity.js adapted from src/identity-manager.js (b4a, no Node built-ins)
- [X] T013 Write lib/index/build.js + lib/index/helpers.js (HyperDB definition per data-model.md: records, logs, meta; indexes by-type, by-author, by-link, by-ix map, one-per-member, grants-for; every key starts with the space), run it, commit lib/index/spec/; test test/next/unit/index-def.js inserts and finds through every index on both runtimes
- [X] T014 Test test/next/unit/indexer-queue.js (concurrent inserts from several logs never hit "Insert/delete in progress"), then the write queue in lib/index/indexer.js (the spike's `#exclusive`)

**Checkpoint**: all unit tests pass on Node and Bare.

---

## Phase 3: User Story 1 — A forum in a few lines (Priority: P1) 🎯 MVP

**Goal**: create an account and a forum, post, comment, reply, vote, edit, delete, live list — three
members agree. **Independent test**: forum scenarios of story 1 pass on Node and Bare (quickstart.md).

### Tests for User Story 1 (write first, they fail)

- [X] T015 [P] [US1] Write test/next/forum/forum.js: the reference app (declares post, comment, vote per contracts/api.md "Types"; functions signUp, createForum, invite/join, post, comment, vote, score, latest, liveLatest) using only the public API; keep it under 400 lines (SC-002)
- [X] T016 [P] [US1] test/next/forum/sign-up.js: a new identity gets a recovery phrase; reopening another folder with it restores the same identity (US1 #7)
- [X] T017 [P] [US1] test/next/forum/post-comment-vote.js: three members on a local DHT; a post appears in everyone's latest within 1 s; comments and replies agree ("what points at X"); three votes, one changed, score agrees counting one per member, the latest (US1 #1–3, SC-001)
- [X] T018 [P] [US1] test/next/forum/edit-delete.js: author edits → everyone shows the latest; author deletes → everyone hides it and its blocks are cleared; an edit or delete by a non-author is refused locally (NOT_ALLOWED) and, written through a raw log, ignored by every member (US1 #5–6)
- [X] T019 [P] [US1] test/next/forum/live.js: a live latest-posts query updates on a new post; it is not recomputed when only comments or votes arrive (US1 #4, FR-010)
- [X] T020 [P] [US1] test/next/net/directory.js: a newcomer learns every member's log from any one member; a new log is announced with a notice and fetched by who lacks it; a non-member's log is neither kept nor passed on; two members started at the same moment still meet (research R10, R17)
- [X] T021 [P] [US1] test/next/unit/decisions-basic.js: `space/init` and `member/add|remove` applied deterministically; a decision by a non-writer ignored; two orders of the same concurrent decisions converge
- [X] T022 [P] [US1] test/next/net/bounded.js: a read whose only holder is offline returns within its bound with `complete: false`; once the holder is back, the same read is complete (FR-011, SC-007)

### Implementation for User Story 1

- [X] T023 [US1] lib/log.js: a device's log in a space (block 0 header with proof; append records with stamps; read; header check for others' logs)
- [X] T024 [US1] lib/decisions/log.js, apply.js, state.js: the decision log (Autobase) adapted from src/v2/control.js — space/init, member/add|remove, owner as first writer; 'change' events; serialized reloads
- [X] T025 [US1] lib/directory.js: the `hypergraph/space` Protomux channel (summary + XOR digest, want, logs, notice, get — from bench/experiments/activity/gossip.js with notices), calling the gate's log check before keeping or passing on an entry
- [X] T026 [US1] lib/gate.js (first part): log check (proof valid, identity a member, device not removed), record check (decodes, type rules, links' targets, editors per `editable`)
- [X] T027 [US1] lib/index/indexer.js: logs → gate → rows; edits replace current fields when their stamp is newer (ties by device key); deletes flag the row and clear the record's blocks; one-per-member rows; `logs.indexed` per log; flush + `watch()` with the set of types written
- [X] T028 [US1] lib/index/query.js: `query(type).latest/where/by` with paging cursors, `linked`, `count`, `sum` (one per member), bounded reads returning `{ items, complete }` (research R13), `live` re-run only for its types
- [X] T029 [US1] lib/replication.js (first part): download everything of small spaces; stall detection and retries with fresh sessions adapted from src/v2/replication.js; "known but not held" bookkeeping for `complete`
- [X] T030 [US1] lib/network.js: one Hyperswarm; a topic per space; `store.replicate`; the space channel per shared space; re-look after a random delay (from src/networking.js); `hg.on('connection')`
- [X] T031 [US1] lib/invites.js (first part): `createInvite` / `redeemInvite` for a member role, single use, recorded by the creator while online (adapted from src/v2/invites.js; offline inviters, expiry, revocation and public links come in US4)
- [X] T032 [US1] lib/space.js and lib/index.js: `Hypergraph.open` (types, readTimeout, mnemonic, bootstrap), `recoveryPhrase`, `createSpace`, `redeemInvite`, `spaces`, `space`, `connectToSwarm`, `close`; `Space.put/get/edit/del/query/linked/count/sum/on('change')` per contracts/api.md
- [X] T033 [US1] docs/next/concepts.md (spaces, records, edits and deletes, decisions, readers enforce, complete answers) and docs/next/api.md (story 1's surface); CHANGELOG.md entry linking to specs/011-spaces-core/
- [X] T034 [US1] Checkpoint: story 1 tests pass on Node and Bare; v1's `npm test` and hyperDNS's `npm test` pass; report sizes of forum.js (SC-002)

**Checkpoint**: MVP — a forum works between three members. Review in the lead conversation before Phase 4.

---

## Phase 4: User Story 2 — Community rules that hold (Priority: P1)

**Goal**: roles, moderation, bans with cuts, app rules — applied identically everywhere, before keeping.
**Independent test**: moderation and rules scenarios pass with a member offline during decisions.

### Tests for User Story 2

- [X] T035 [P] [US2] test/next/forum/moderation.js: assign a moderator; hide/reveal/remove a comment; ban a member who posted, voted then spammed (earlier vote still counts, spam gone, later posts never indexed); a member offline during all of it converges; a demoted moderator's later decisions ignored, earlier ones kept (US2 #1–3, #6)
- [X] T036 [P] [US2] test/next/forum/rules.js: an app rule (title ≤ 300 characters) rejects a record on every member before it is kept or passed on; a non-member's records are never kept (US2 #5, #7, FR-018)
- [X] T037 [P] [US2] test/next/unit/decisions-roles.js: built-in roles (owner, admin, moderator, member, guest — data-model.md) and custom roles with permission lists; a decision valid only if its author held the permission at that point; conflicting concurrent admin decisions converge (US2 #4, #8, FR-019)
- [X] T038 [P] [US2] test/next/net/cut.js: a ban's cut is the moderator's held lengths; a member that already indexed records past the cut removes them; nothing past the cut is ever indexed again (FR-017)

### Implementation for User Story 2

- [X] T039 [US2] lib/decisions/apply.js + state.js: role/define, role/set, role/remove, moderate (flag, hide, remove, reveal, ban with cut), permission checks at each point of the order; members with `decide`/`moderate` become decision-log writers
- [X] T040 [US2] lib/gate.js (second part): cuts, app rules (`rules: [{ id, validate }]`, deterministic, read-only context), moderation flags
- [X] T041 [US2] lib/index/indexer.js: apply decisions to the index (hidden/revealed flags, removed rows, ban cuts deleting rows past the cut)
- [X] T042 [US2] lib/space.js: `defineRole`, `setRole`, `getRole`, `removeRole`, `moderateAction` (no key pair; ban computes the cut from held lengths)
- [X] T043 [US2] docs/next/api.md (roles, moderation), docs/next/concepts.md (readers enforce, cuts); CHANGELOG.md
- [X] T044 [US2] Checkpoint: stories 1–2 pass on Node and Bare; v1 and hyperDNS suites pass

---

## Phase 5: User Story 3 — Devices and the personal space (Priority: P1)

**Goal**: one identity on several devices; join by code; personal space; latest wins; lost device cut.
**Independent test**: devices and personal scenarios pass. **After this phase SwarmFS can start.**

### Tests for User Story 3

- [X] T045 [P] [US3] test/next/forum/devices.js: device B joins with A's code and shows A's spaces and settings within 10 s (SC-010); posts from both show one person; +1 on the laptop then -1 on the phone (laptop clock +1 h) → -1 wins everywhere (SC-009); simultaneous offline edits settle identically; removing a lost device ignores what it writes afterwards and keeps what it wrote before; an identity-attested removal overrides a device-made one (US3 #1, #3–6)
- [X] T046 [P] [US3] test/next/forum/personal.js: an app record in the personal space ("this device holds X") is read by the other device and by nobody else; someone else's device writing into it is ignored (US3 #2, FR-026)
- [X] T047 [P] [US3] test/next/net/pairing.js: join codes work over the local DHT on Node and Bare; a wrong or used code is refused

### Implementation for User Story 3

- [X] T048 [US3] lib/pairing.js: `hg.addDevice()` → `{ code, added }`; `Hypergraph.open(dir, { joinCode })`; attestation with `IdentityKey.attestDevice` (per T002's result: blind-pairing or the fallback) — *the new device receives the recovery phrase and proves itself from it (research.md A7)*
- [X] T049 [US3] lib/personal.js: the personal space created with the identity (members = its devices; private), holding devices, spaces joined, settings, device heads (log lengths per space, written periodically); the new device joins the listed spaces
- [X] T050 [US3] lib/stamp.js integration: "newest own seen" includes the identity's other devices' logs and the personal space
- [X] T051 [US3] `hg.devices()`, `hg.removeDevice()`: `hg/device-remove` records (attested) in this device's log of every space, with cuts from device heads or held lengths; lib/gate.js applies them; identity-attested removals override — *changed by Tibo (research.md A7): every removal is signed by the identity key (`{ password }` or `{ recoveryPhrase }`), in an identity log; no device-made removals*
- [X] T052 [US3] docs/next/api.md (devices, personal space), docs/next/concepts.md (latest wins); CHANGELOG.md
- [X] T053 [US3] Checkpoint: stories 1–3 pass on Node and Bare; v1 and hyperDNS suites pass; tell the lead conversation SwarmFS can start — *next 99/99 on Node and Bare, v1 390/390, hyperDNS 46/46 (2026-10-09)*

---

## Phase 6: User Story 4 — Invites, joining, decision rights that follow devices (Priority: P2)

**Goal**: decision rights follow devices (a removed device loses them everywhere; a member's other devices
gain them); admins settle the decision order with the owner; invites complete (uses, expiry, revocation,
redemptions, refusals with their reason, public links); unban; `open({ password })`; `fromDevice()`.
**Independent test**: invites, unban, devices and settling scenarios pass on Node and Bare.

**Decided with Tibo before starting (2026-10-09, research.md A8)**: the decision order is settled by **one
device per decider person** (owner and admins), not by every device of theirs; **unban** keeps the ban's
cut and the member writes in a new log once let back in (the brief's "reverse cut from held lengths" can't
work: members stop downloading at the cut); the **write limit is postponed to story 9** (a per-log rule
needs earlier records' times, which deletes wipe: members would disagree). Found while reading: a device
proof whose chain has a device attesting another device verifies today, so a stolen device could mint
devices no removal names — fixed first.

### Security first: decision rights follow devices

- [X] T054 [US4] Test test/next/unit/identity.js: a proof made by a device attesting another device
  (`IdentityKey.attestDevice`, a chain of two) doesn't verify, for logs and for data (a stolen device can't
  mint new devices that no removal names); then lib/identity.js accepts chains of zero (the identity key)
  or one (a device bootstrapped from it) only; drop the unused `attestDevice`
- [X] T054a [P] [US4] Test test/next/unit/decisions-writers.js (in-memory view, as decisions-roles.js):
  `writer/add { key, proof }` (a device's claim, signed on its identity's behalf) makes the key a writer only
  for a member whose role has `decide` or `moderate`, once, and never for a removed device; a forged or
  someone else's claim is ignored; `device/remove { device, cut, proof }` (the identity key's signed removal,
  the same bytes as the record) drops every writer key of that device, its later decisions are ignored and
  its later claims refused; only that identity's own key counts; losing both `decide` and `moderate`
  (demotion, removal, ban) drops the member's writer keys
- [X] T054b [P] [US4] Same file: settlers (Autobase indexers) are one writer key per member with `decide`
  (the owner's first, an admin's first); a removed settling device hands over to another writer key of the
  same person; demotion below `decide` stops settling (moderators write, don't settle); the last settler is
  never removed (Autobase refuses: `host.removeable`); two orders of the same concurrent decisions converge
- [X] T054c [P] [US4] test/next/forum/devices.js: an owner's second device moderates and invites with no
  extra step (it claims its writer key itself); an admin's phone moderates; a removed device's decisions
  written afterwards (raw, `testing.decide`) are ignored by every member, a newcomer included
- [X] T054d [US4] Implementation: lib/encodings.js (`writer/add`, `device/remove` appended to the decision
  types), lib/decisions/apply.js + state.js (writers carry `{ identity, device, indexer }`, removed devices,
  settlers), lib/space.js (a device claims its writer key when its member may decide or moderate; a device
  removal also records `device/remove` in every space where that device could decide; a device that can't
  write the decision log yet asks peers to record it: an `ask` message on the space channel, as
  redemptions), lib/directory.js (the message), lib/testing.js (`settled()`)

### Admins settle the decision order with the owner

- [X] T054e [P] [US4] test/next/net/indexers.js: owner + two admins; the owner closes for good; the admins
  make decisions (a role, a ban, a redemption); both settle them (settled length grows on each) and a newcomer
  shows the same roles and members; an admin demoted later stops settling (v1 spec 003's lesson)
- [X] T054f [US4] Implementation in T054d's modules (`host.addWriter(key, { indexer })`, handover, demotion)

### Invites complete (spec 008's design, FR-023)

- [X] T054g [P] [US4] Test test/next/unit/decisions-invites.js: `invite/revoke` (by `decide`, or the maker)
  stops later redemptions; uses counted per distinct person; expiry against the recorder's stamp; who may
  invite to what (`mayInvite`: `invite` permission, never owner, below one's rank except member and guest,
  only permissions one holds; custom roles allowed); a role is never lowered by a redemption
- [X] T054h [P] [US4] test/next/forum/invites.js (US4 #1–4): redeemed while the inviter is offline and another
  admin online; expired → `INVITE_EXPIRED`, used up → `INVITE_USED_UP`, revoked → `INVITE_REVOKED`, an
  inviter whose role can't give the role → `NOT_ALLOWED` (at `createInvite`, and for a link made anyway), each
  within the read bound instead of a generic error after 60 s; `redemptions(link)`; a public link
  (`uses: Infinity`) lets many in, revoking it stops new joins and members stay; nobody able to let us in
  online → `INVITE_INVALID` after the bound (`timeout` overrides it)
- [X] T054i [US4] Implementation: lib/invites.js (`refusal(state, invite, identity, now)`: the reason, the same
  pure checks `apply` makes), lib/decisions/apply.js (`invite/revoke`, `mayInvite`), lib/space.js
  (`createInvite` checks, `revokeInvite`, `redemptions`; the newcomer judges refusals from its own copy of the
  decision log), lib/index.js (`redeemInvite` waits `readTimeout` by default)

### Unban (decided 2026-10-09)

- [X] T054j [P] [US4] test/next/forum/moderation.js: `moderateAction('unban', who)`, then an invite or
  `setRole`: they write again (in a new log); what they wrote during the ban stays ignored for everyone,
  newcomers included; until unbanned, neither an invite nor `setRole` lets them in
- [X] T054k [US4] Implementation: `unban` in the moderation actions, apply lifts `banned:` (the cut stays);
  forum.js `unban()`

### Small API additions

- [X] T054l [P] [US4] test/next/forum/sign-up.js and devices.js: `Hypergraph.open(dir, { password })` (new
  account, restore from the phrase, or `joinCode`) keeps the phrase sealed from the first moment: never in
  the folder in plain text; `recoveryPhrase(password)` reads it
- [X] T054m [P] [US4] test/next/forum/personal.js: `query(type).fromDevice(key)` lists what one device wrote
  (SwarmFS: "what does this device hold"), with paging
- [X] T054n [US4] Implementation: lib/phrase.js (`saveSealed`), lib/index.js, lib/index/query.js
  (`fromDevice`)

### Docs and checkpoint

- [X] T054o [US4] contracts/api.md, data-model.md, docs/next/api.md and concepts.md (decision rights and
  devices, settling, invites, unban), research.md A8, CHANGELOG.md
- [X] T055 [US4] Checkpoint: `npm run test:next` and `npm run test:next:bare` pass; v1's `npm test` and
  hyperDNS's `npm test` pass; forum.js line count — *next 128/128 on Node and Bare, v1 390/390, hyperDNS 46/46,
  forum.js 265 lines (2026-10-09)*

## Phase 7: User Story 5 — Graph vocabulary, shared editing (Priority: P2)

**Goal**: v1's graph vocabulary on the new core (relations, edges with counts, tags, queries by type,
author, tag, link and time with paging); types editable by members or by a permission, the latest
allowed edit winning, losing the right to edit as a cut (A4); the follow-ups settled in story 4's review.
**Independent test**: graph and wiki scenarios pass on Node and Bare, with a member offline meanwhile.

**Choices made before starting** (research.md A9; for the lead's review):
- Relations and tags are records of built-in types in their author's own log: `hg/relation { from, to,
  rel, value, data, off }`, `hg/tag { on, tag, off }`. They are never edited or deleted: `unrelate` and
  `untag` write a new one with `off: true`, and the latest wins per (from, to, type) and per (record,
  tag) — so an unrelate is undone by relating again, the same everywhere in any order of arrival.
- **A relation from X, or a tag on X, counts only if its author may edit X**: X's author by default (v1's
  "an edge from a record is said by who owns it", test/brittle/core/relations.js), its editors for a
  shared type — the same check as edits, cuts included. So any editor of X can relate or unrelate from
  it (v1: "any authorized writer can unrelate").
- Edges are computed when read, from the by-link index (few per record); tags are kept on the tagged
  record's row as index keys, so tagged lists are newest first by when the record was put and page
  like any query (no new HyperDB index).
- **Shared deletes** (Tibo, 2026-10-09): only the author's own delete counts. `del()` by a moderator
  who isn't the author is a `remove` decision (ordered and permission-checked at its point, so no cut is
  needed); by anyone else, `NOT_ALLOWED`.
- **Losing an edit permission is a cut** (A4's pattern): `role/set` already carries the decider's cut;
  apply now also records it (view `editcut:<id>`) for every app permission the member loses. Edits,
  relations and tags of that member below it count for everyone, those past it for no one; a log
  without such a cut counts while the member holds the permission. A custom role never loses an app's
  permission (as `post`, A5: its holders can't be listed reliably). Given the permission back, the
  member's app writes in a new log (as after an unban).

### Tests for User Story 5 (write first, they fail)

- [X] T056 [P] [US5] test/next/unit/types.js and test/next/unit/gate.js (new): `hg/relation` and `hg/tag`
  are declared; `gate.mayChange` with cuts — the author always; `'members'`; `{ permission }` below the
  editor's cut yes, past it no, no cut: while holding it; a delete only by the target's author;
  relations and tags only as puts, `data` ≤ 4 KB, a finite `value`, a non-empty type or tag
- [X] T056a [P] [US5] test/next/unit/decisions-roles.js: `role/set` to a role without an app permission
  records `editcut:<id>` for it with the decider's lengths (a log's first cut stays); `state.editLimit`;
  `role/define` dropping an app permission is ignored (dropping `decide`, `moderate`, `invite`, `roles`
  still works)
- [X] T056b [P] [US5] test/next/forum/graph.js (the meanings of v1's relations.js, tags.js, query.js):
  relate with a type, a number and data ≤ 4 KB → out-edges of one, in-edges of the other, on every
  member, with counts; filters by type, order and limit; relating the same triple twice → one edge (the
  latest value); unrelate → gone everywhere; relate again → the new value; unrelating nothing →
  `NOT_FOUND`; bad value or data over 4 KB → `INVALID_RECORD`; a relation from someone else's record
  refused locally (`NOT_ALLOWED`) and, written raw, ignored by every member; tag / untag / getByTag
  (newest first, paged, empty for an unused tag); `query(type).tag()`, `.by()`, `.on()`, `.since()`,
  `.until()` compose; paging 25 posts by three members in pages of 7 never skips or repeats (equal
  stamps included); a member offline meanwhile shows the same edges and tags; `linked()` without a type
  leaves hypergraph's own records out
- [X] T056c [P] [US5] test/next/forum/wiki.js (US5 #4): a page type editable by `edit-pages`; three
  editors edit, every member shows the latest; a member without it: refused (`NOT_ALLOWED`), written raw
  ignored; an editor's delete refused, written raw ignored; a moderator's delete takes it down
  everywhere; a blanked page is restored by the next edit; an editor losing the permission — an edit
  before the cut stays, one after is ignored, by a member who had shown it and by a newcomer alike;
  given it back, they edit again; a type editable by `'members'`
- [X] T056d [P] [US5] Follow-ups (ROADMAP 2026-10-09): test/next/forum/invites.js — joining waits past
  `readTimeout` by default (an instance with `readTimeout: 500` joins an inviter who comes online 2 s
  later); test/next/forum/moderation.js — after an unban, `setRole` from another admin works at once (the
  retry removed), and `NOT_ALLOWED` says why (banned, not a member, role too low); test/next/net/indexers.js
  — `status()` warns while the owner is the only settler, not once an admin settles too

### Implementation for User Story 5

- [X] T057 [US5] lib/types.js (built-ins), lib/gate.js (`mayChange` with cuts, `mayEdit`, relation and tag
  checks), lib/decisions/apply.js + state.js (`editcut`, `editLimit`, `role/define` keeps app permissions)
- [X] T057a [US5] lib/index/indexer.js: tags as index keys of the tagged row (on insert, edit, resettle,
  cut, moderation); edits and tags looked at again when edit rights change
- [X] T057b [US5] lib/index/query.js: `edges()`, `getByTag()`, `Query.tag/on/since/until` composing;
  `linked()` without a type skips `hg/` types
- [X] T057c [US5] lib/space.js: `relate`, `unrelate`, `edges`, `tag`, `untag`, `getByTag`; `del()` by a
  moderator; a new own log when an edit permission comes back; decision methods catch up with connected
  decision writers before refusing, with the reason; `status()`; lib/index.js: `redeemInvite` waits 30 s
  by default
- [X] T058 [US5] test/next/forum/forum.js (tags, relations, pages, editors), contracts/api.md, data-model.md,
  docs/next/api.md and concepts.md ("give a space an admin"), research.md A9, CHANGELOG.md
- [X] T058a [US5] Checkpoint: `npm run test:next` and `npm run test:next:bare` pass; v1's `npm test` and
  hyperDNS's `npm test` pass; forum.js line count — *next 153/153 on Node and Bare, v1 390/390, hyperDNS
  46/46, forum.js 338 lines (2026-10-09)*

## Phase 8: User Story 6 — Holding part of a space, honestly (Priority: P2)

**Goal**: every member keeps its spaces within its storage budget without changing what it shows: one
budget for the app, an optional budget per space taken out of it, policies `auto` and `everything`, reads
that fetch dropped content within their bound or say they are incomplete; a lost or damaged index rebuilt
from the held logs; superseded personal-space records cleared; `space.inspect()` for the inspector; the
follow-ups of story 5's review.
**Independent test**: budgets, policies, rebuild and diagnostics scenarios pass on Node and Bare; disk stays
within each limit +10% while spaces grow past them (SC-011); a lost index of 100,000 records is rebuilt
within 30 s (SC-008, measured alone).

**Choices made before starting** (research.md A10; for the lead's review):
- **Dropping content, not records** (Tibo: "eviction drops the oldest unread content first"). A dropped
  record keeps its row in the local index (type, author, time, links, tags: ~0.5 KB) and loses its content
  (its block and the copy of its fields in the row). So counts, votes, edits, tags and links stay exact for
  every member whatever it holds; a read that needs dropped content fetches it within its bound (and keeps
  it: "plus what was read"), or leaves it out and says `complete: false`. Records under 256 bytes (votes,
  tags, relations) and hypergraph's own records are never dropped: dropping saves little and sums need
  them. The record list itself is never dropped: a space whose list alone outgrows its share is reported
  (`status()` warning); spaces bigger than that are story 9's (members who don't list every record).
- **Stored bytes are estimated** (v2's lesson: count what storing costs, not content): measured on the real
  core, a record costs its content plus ~150 B in the logs and its content plus ~550 B in the index
  (2 KB posts: 4.7 KB stored per record). The app's total is checked against real disk use in the test,
  after compaction (RocksDB's write-ahead log holds recent writes until it flushes).
- **Shares**: the app budget (default 5 GB, or less if half the free disk is smaller: `statfs` works on Node
  and on Bare, else 5 GB) minus the spaces' own budgets and what is never dropped elsewhere, shared by the
  other spaces in proportion to what each holds. Never dropped: this identity's records (any of its
  devices), decision logs, the personal space.
- **Oldest first**: records are dropped oldest first (by when they were put); records fetched back by a
  read go last. Dropped blocks are never fetched again unless read (downloads restart past them), even
  when room comes back — except in a space whose creator chose `everything`, where a member gets them
  back once they fit again (that is the creator's requirement).
- **Policies**: `auto` (default) and `everything` (`createSpace({ policy })`, changed later by who may
  decide with `space.setPolicy()`, a `settings/set` decision). A member keeping less than `everything`
  asks (its budget, or the space doesn't fit) is told: `status().belowPolicy` and a `status` event.
- **Rebuild**: what the index can't be rebuilt from (identity proof, personal space keys, the spaces held
  and their storage namespaces, declared types, budgets) is also kept in a small file next to it
  (`<dir>/instance.json`, written atomically). A lost or unreadable index is moved aside and rebuilt: the
  held logs are named in an append-only `<dir>/logs` file (amended, A10: not `store.list()`, which can't
  tell the personal space's encrypted logs apart without guessing), checked by the gate and indexed again; content this member had dropped is fetched again once (then dropped again).
  After a crash, indexing resumes where each log's last saved batch ended (already true since story 1).
- **Superseded personal-space records** (ROADMAP 2026-10-09): an `hg/heads` replaced by a newer one of the
  same device, an `hg/setting` by a newer one of the same name: the older row goes and its block is cleared
  — except in this device's own log, which stays whole (FR-027, as A5: other devices fetch from it, so they
  never meet a hole nobody can fill).

### Tests for User Story 6 (write first, they fail)

- [X] T059 [P] [US6] test/next/forum/roles.js (story 5's follow-ups): `space.roles()` lists the built-in roles
  and the forum's own with their permissions; forum.js's `makeEditor` defines `editor` only when missing;
  test/next/forum/devices.js: a phone of an owner or an admin hides, flags and lets people in right after
  joining with no retry (it waits, within the bound, to record decisions) — the retries removed
- [X] T059a [P] [US6] test/next/forum/inspect.js: `space.inspect()` on three members: logs (key, device,
  identity, length, held, indexed, cut, refused), the decision log (length, settled, settlers), records
  by type, storage (stored, budget, share, policy, belowPolicy, held), peers, complete; read-only (nothing
  written, nothing fetched); a banned member's log shows its cut, a refused log is listed as refused
- [X] T059b [P] [US6] test/next/forum/personal.js: settings set many times and heads written many times
  leave one row each on every device; another device's superseded blocks are cleared here; this device's
  own log stays whole; a newcomer device and a restart show the same settings, complete
- [X] T059c [P] [US6] test/next/forum/budgets.js (US6 #2, #3, SC-011): a reader with a small app budget and
  one space given its own budget, two spaces growing past them: the space with its own budget stays within
  it, the other within the rest, real disk within the app budget +10% (after compaction); the newest part
  is held, the oldest content dropped first; the reader shows the same lists, counts and scores as a full
  member, `complete` where nothing dropped is needed; paging back fetches dropped posts within the bound
  and keeps them (held after the read); a dropped block is not fetched again while nobody reads it; the
  author's own records, the decision log and the personal space are never dropped (the author over its
  budget keeps them and is warned); `hg.setBudget()`, `space.setBudget(bytes | null)`, `hg.storage()`
- [X] T059d [P] [US6] test/next/net/bounded.js (US6 #4, SC-007): content dropped here and its only other
  holder offline: the read returns within its bound, without it, `complete: false`; the holder back, the same
  read is complete and shows it
- [X] T060 [P] [US6] test/next/forum/policies.js (US6 #1, #5): a small space with default settings is held
  entirely by every member (nothing dropped, `held: 'all'`); a forum whose creator chose `everything`: a
  member whose budget is too small is told (`belowPolicy`, a `status` event) and still answers honestly;
  given room again it gets everything back and is no longer below; `setPolicy` by the owner reaches every
  member, refused (`NOT_ALLOWED`) for a member; an `auto` space doesn't fetch dropped content back
- [X] T061 [P] [US6] test/next/forum/rebuild.js (US6 #6, FR-012): the index folder deleted → reopened, the
  member shows the same posts, comments, scores, edits, tags, roles, settings and devices, complete, offline;
  a damaged index (unreadable files) → the same; a simulated crash in the middle of indexing (a write
  that never commits) → reopened, only the blocks after the last saved batch are indexed again
- [X] T061a [P] [US6] test/next/unit/budget.js: shares (own budgets first, the rest in proportion to what
  each space holds, never below what can't be dropped), the stored-bytes estimate, the default budget from
  free disk (and 5 GB when the runtime can't tell)

### Implementation for User Story 6

- [X] T062 [US6] lib/space.js `roles()`; a device whose member may decide waits (within `readTimeout`) to
  become a decision writer, claiming again at once instead of failing; forum.js `makeEditor`
- [X] T062a [US6] lib/space.js `inspect()`; lib/index.js `storage()`
- [X] T062b [US6] lib/index/indexer.js: superseded `hg/heads` and `hg/setting` dropped (rows, and blocks
  outside this device's own log)
- [X] T062c [US6] lib/storage.js (new): app budget (default from free disk), shares, stored-bytes estimate;
  dropped counters per log in the index's `meta` rows (amended, A10: the compact `log` schema can't
  grow); self-compaction after dropping a tenth of the budget (A10); lib/replication.js and
  lib/index/indexer.js: dropping content oldest first (flag `DROPPED`, fields cleared, block cleared,
  downloads restarted past it), restoring it on read (flag `READ`); lib/index/query.js and lib/space.js:
  reads fetch dropped content within their bound, `complete: false` when they can't; `setBudget`,
  `hg.setBudget`, policies (`settings/set`, `setPolicy`), `status()` and the `status` event
- [X] T062d [US6] Rebuild: lib/index.js (`instance.json`, a lost or unreadable index moved aside and rebuilt),
  lib/space.js (held logs found in the Corestore when the index knows none); lib/testing.js (`compact`,
  `crashAfter`)
- [X] T062e [US6] bench/next/rebuild.js: 100,000 records, index deleted, time to rebuild (SC-008: ≤ 30 s);
  run alone, once
- [X] T062f [US6] test/next/forum/forum.js (budgets, keep-everything, roles), contracts/api.md (budgets,
  policies, status, "Diagnostics": `inspect()`), data-model.md, docs/next/api.md and concepts.md
  (holding part of a space, rebuild), research.md A10, CHANGELOG.md
- [X] T062g [US6] Checkpoint: `npm run test:next` and `npm run test:next:bare` pass; v1's `npm test` and
  hyperDNS's `npm test` pass; forum.js line count; the 100k rebuild time — *next 180/180 on Node and Bare, v1 390/390, hyperDNS 46/46, forum.js 371 lines, 100k rebuild 20.6 s (2026-10-09)*

## Phase 9: User Story 7 — App versions (Priority: P2)

**Goal**: members on two versions of an app share a space: each reads the other's records (the old app
ignores the fields it doesn't know, the new one sees them empty on old records); the declared types are
stored in the index's `meta`, and at open any change other than appending fields or adding types throws
`INCOMPATIBLE_TYPES` naming the type and the field; records of types the app doesn't know are kept and
indexed by type, and shown correctly once the app learns the type. Mixed versions never make members
disagree on what exists, only on which fields they can show (constitution Principle I).
**Independent test**: `test/next/forum/versions.js` on Node and Bare: two instances with different type
versions in one space, both directions; each kind of bad change refused.

**Already there** (stories 1–6): the tagged field encoding skips unknown fields (experiment 6),
`Types.describe()` / `checkCompatible()` run at open and the declaration is stored in `meta` (and
`instance.json`), unknown types pass the gate with `values: null` and get a row by type.

**Gaps found while refining** (choices for the lead's review, research.md A11):
- **An old app editing a newer record erased the fields it doesn't know** (an edit carries all the fields
  of the new version, A3). Now an edit keeps the current version's unknown fields as they are, and the
  current version's links first, in place (an unknown field may be a link into that list).
- **What the index derives from a declaration goes stale when the app learns more**: rows of a type the
  app didn't know have no one-per-member grouping, no app index keys, no link-target or rule check, edits
  by others judged as "author only"; a type that gains an index has old rows missing from it; a link field
  added with allowed targets was never checked. At open, if a type is new, gains an index, or gains a link
  field with allowed targets, **and** this member's index holds records of it, the index is rebuilt from
  the held logs (story 6's rebuild): the member then shows exactly what a member who always had this
  version shows. Rare (an app update), costs one rebuild (100k records: ~20 s); reads say
  `complete: false` meanwhile.
- **Declarations that changed meaning while looking compatible** are refused: `describe()` now stores
  indexes too; appending a link field with allowed targets is allowed (it failed as "links changed");
  changing the allowed targets of an existing link field is refused naming the field; appending the first
  link field of a one-per-member type is refused (it would change what "one per member" groups by).
- Opening a folder with an older declaration than the one it stored (a downgrade) is refused like any
  removal, and leaves the folder as it was.

### Tests for User Story 7 (write first, they fail)

- [X] T063 [P] [US7] test/next/unit/types.js: `describe()` includes indexes; appending a link field with
  allowed targets passes `checkCompatible`; adding an index passes; changing an existing link field's
  allowed targets throws `INCOMPATIBLE_TYPES` naming type and field; appending the first link field to a
  one-per-member type throws naming type and field; `stale(stored)` lists the new types, the types that
  gained an index and the types that gained a link field with allowed targets (not those that only gained
  plain fields)
- [X] T063a [P] [US7] test/next/unit/fields.js: encoding an edit with `keep` (the current version's fields
  and links) keeps the fields this codec doesn't know, byte for byte, and the current links in place; a
  codec that knows them decodes the edit with the old app's change and the new fields intact
- [X] T063b [P] [US7] test/next/forum/versions.js (US7 #1): an old app (the forum without `post.topic` and
  `poll`) and the current one in one space, both directions: each reads the other's posts and comments
  (old: no `topic`; new: `topic: null` on old posts); the same post lists, comment counts and scores on both
  (Principle I); the old app edits a new post's text: its topic stays, on both
- [X] T063c [P] [US7] test/next/forum/versions.js (US7 #1, R6): polls written by the new app are kept by
  the old one and counted by type (`inspect().records.poll`), not readable there (`INVALID_TYPE`); a bad
  poll (linking to a comment, written by a misbehaving member) is refused by the new app, kept as unknown by
  the old; the old member reopened with the current types (the app updated) shows the same polls as the new
  member, the bad one refused, and `byTopic` finds the posts it received while it was old; a later restart
  doesn't rebuild again
- [X] T063d [P] [US7] test/next/forum/versions.js (US7 #2, FR-004): each bad change refused at open with
  `INCOMPATIBLE_TYPES` whose message names the type and the field: fields reordered, a field's kind changed,
  a field removed, a type removed, `editable` changed, `onePerMember` changed, a link field's targets
  changed; the old declaration on a folder the new one opened (a downgrade); after a refusal the folder
  opens again with the right types, unchanged

### Implementation for User Story 7

- [X] T064 [US7] lib/fields.js and lib/types.js: `encode(values, links, keep)` keeps unknown fields and the
  current links; lib/space.js `edit()` passes the current version
- [X] T064a [US7] lib/types.js: `describe()` with indexes, `checkCompatible()` per link field and
  one-per-member target, `stale(stored)`; lib/index.js: at open, a stale type with rows held → the index is
  replaced and rebuilt from the held logs (lib/instance.js `remove`)
- [X] T064b [US7] test/next/forum/forum.js: `post.topic` (with an index) and `poll` (the app's new
  version), `byTopic`, `ask`, `polls`; contracts/api.md ("Types": app versions), docs/next/api.md and
  concepts.md, data-model.md (`meta.types`), research.md A11, CHANGELOG.md
- [X] T064c [US7] SC-002: forum.js holds only app code (what a real forum writes with hypergraph); test
  plumbing (faking bad members, waiting for peers) lives in `_setup.js` or the test files; report its line
  count (all lines, and without blank and comment lines) — *nothing to move: forum.js was already only
  flows through the public API; the plumbing lives in `_setup.js`, `helpers.js` and `lib/testing.js`*
- [X] T064d [US7] Checkpoint: `npm run test:next` and `npm run test:next:bare` pass; v1's `npm test` and
  hyperDNS's `npm test` pass; forum.js line count — *next 188/188 on Node and Bare, v1 390/390, hyperDNS
  46/46; forum.js 391 lines, all app code (254 without blank and comment lines, 61 of them the export list)
  (2026-10-09)*

## Phase 9b: Core follow-ups (ROADMAP 2026-10-09, review of story 7 and the inspector)

**Goal**: the seven follow-ups decided in that review, before story 8: a Principle I bug fixed, future
hypergraph types kept, two flaky tests made to wait for their conditions, the read APIs the inspector asked
for (and the inspector moved onto them), app index entries in the storage estimate, `undefined` as absent,
and app rules recorded by the space so mismatches are detected.
**Independent test**: `npm run test:next` and `npm run test:next:bare` pass (the inspector's test on Node
only); the two formerly flaky files pass 10 runs each under the full suite's load on both runtimes.

**Choices made before starting** (research.md A12; for the lead's review):
- **Link targets are judged when read, not when a record arrives.** A record is kept whatever its links
  point at. Whether a link counts depends only on the target's type, which never changes, and on whether
  the target is held here. So every read that follows a link (what points at X: `linked`, `count`, `sum`,
  `query().on()`, and the link field shown on the record) looks at the target: held with a type the field
  doesn't allow → the link counts for nothing (the field shows `null`, the record isn't "on" X). Not held
  (not arrived yet, or deleted, taken down, cut: rows that are gone on every member) → the link stands as
  written. Nothing is decided at arrival, so no order of arrival can make two members differ. Considered:
  marking rows when the target arrives (reads stay free) — rejected: a deleted target's type is gone, so a
  member that marked a row and a newcomer that never saw the target would disagree. A consequence: a type
  gaining a link field with allowed targets no longer needs an index rebuild (A11), only new types and new
  indexes do.
- **`space.decisions()`** reads a list that apply writes into the decision log's view (`~log:<n>`: type,
  who, device, when, what, why, and whether it counted), so it follows Autobase's reorders like every other
  view entry and is the same on every member once settled.
- **`space.peers()`**: the swarm uses the device key pair, so a connection's remote key is the peer's
  device key; on the space channel each side sends its device proof (`hello`), checked against that key:
  identity and device known for every connected peer, unforgeable.
- **Storage**: per log, the bytes of its rows' app index entries and tag keys (each entry measured: its key
  plus a fixed cost), kept with the log's dropped counters in `meta`; never dropped (rows stay).
- **Rules**: `settings/set` gains `rules` (a list of rule ids, optional on the wire); `createSpace` records
  the creator's app's rule ids; `space.setRules()` records this app's (who may decide); `status()` warns
  `RULES_DIFFER` (naming the ids) when this app's rule ids differ from the space's. A space that never
  recorded any doesn't warn. Changing what a rule does means giving it a new id.

### Tests (write first, they fail)

- [X] F001 [P] test/next/forum/link-targets.js (item 1, Principle I): c (modified app) writes a comment and a
  poll whose `on` points at a vote (a type `on` doesn't allow): on a member that held the vote first and on
  one that got the comment first (the vote written later, delivered after), the record is kept on both, its
  `on` shows `null`, it isn't in `linked(vote)`, `count`, `sum` or `query().on(vote)`; both show the same
  lists; a newcomer (joined afterwards) shows the same; a link to a target not held yet counts as written
  until the target arrives; deleting the target restores the link as written on every member, newcomer
  included
- [X] F002 [P] test/next/forum/versions.js: the bad poll (on a comment) is now kept by every version, with
  its link ignored (shown `on: null`, not under the comment); test/next/unit/types.js: `stale()` no longer
  lists a type that only gained a link field with allowed targets
- [X] F003 [P] test/next/forum/versions.js (item 2): a record of a hypergraph type this version doesn't know
  (`hg/future`, written raw) is kept and counted by type on every member (`inspect().records`), not refused;
  later records of that log are indexed
- [X] F004 [P] Items 3: test/next/forum/budgets.js #2 waits until the oldest post's content is dropped
  (instead of checking at once); test/next/forum/inspect.js waits for every condition it checks (logs held
  and indexed, the decisions settled) with `eventually`/`within`; each file run 10 times under the full
  suite's load on Node and on Bare
- [X] F005 [P] test/next/forum/members.js (item 4): `space.members()` → `[{ identity, role, you, banned,
  removed, devices: [{ device, log }] }]` (banned and removed members listed with their state, role null);
  `space.decisions({ limit, after })` → newest first `[{ seq, type, by, device, at, counted, ... }]` (a role
  given, a ban with its reason, an invite redeemed, a decision by a demoted moderator `counted: false`),
  paging; `hg.types()` → the declared types (fields with kinds, links, onePerMember, editable, indexes;
  hypergraph's own marked `builtin`); `space.tags(record)` → sorted tag names; `space.peers()` → `[{ identity,
  device }]` of connected members; events: `space.on('peers')` when one connects or leaves, `space.on('logs')`
  when a log is accepted or grows
- [X] F006 [P] test/next/forum/inspect.js (item 4): `inspect({ records: { type, limit, after } })` lists every
  row of a type, hidden, superseded, dropped and edited ones included, with their state flags;
  `inspect({ record: id })` → its versions (the put and every edit, with who, when and whether it counts)
  and deletes, also for a deleted record
- [X] F007 [P] test/next/tools/inspector.js (item 4, Node only): the views use the new reads (members with
  roles and banned state, decisions, types, tags, peers) and the page updates from events (no polling)
- [X] F008 [P] test/next/unit/budget.js (item 5): `stored()` counts index entry bytes; test/next/forum/budgets.js:
  a forum indexing several fields stays within its budget on disk (+10%)
- [X] F009 [P] test/next/unit/types.js and test/next/forum/post-comment-vote.js (item 6): a field passed as
  `undefined` counts as absent in `put` and `edit` (an old helper passing a field the type doesn't have, or a
  new one passing nothing); an unknown field with a value (a typo) still throws `INVALID_RECORD`
- [X] F010 [P] test/next/forum/rules.js (item 7): the space records its creator's rule ids; a member whose app
  has another rule set gets `RULES_DIFFER` in `status()` (and a `status` event) naming them; `setRules()` by
  the owner records this app's, the warning goes away there and appears for members on the old rules;
  refused (`NOT_ALLOWED`) for a member; test/next/unit/decisions-basic.js: `settings/set { rules }` applied by
  who may decide, decoded from an entry written without `rules`

### Implementation

- [X] F011 lib/gate.js (no link check at arrival), lib/index/indexer.js (records kept whatever their links
  point at), lib/index/query.js + lib/space.js (links judged when read: `linkedRows`, `Query.on`, `shape`),
  lib/types.js (`stale()` without link fields)
- [X] F012 lib/gate.js: unknown `hg/` types kept like unknown app types
- [X] F013 lib/decisions/apply.js (the decision list `~log:<n>`, `settings/set { rules }`), state.js
  (`rules`), log.js (`list()`), encodings.js (optional trailing `rules`)
- [X] F014 lib/space.js: `members()`, `decisions()`, `tags()`, `peers()`, events `peers` and `logs`,
  `inspect({ records })`, `inspect({ record })`, `setRules()`, `RULES_DIFFER`; lib/index.js: `types()`,
  `createSpace` records rule ids; lib/network.js (device key pair), lib/directory.js (`hello`)
- [X] F015 lib/storage.js + lib/index/indexer.js + lib/space.js: index entry bytes per log in the estimate
- [X] F016 lib/types.js `validate()` and lib/space.js `edit()`: `undefined` is absent
- [X] F017 tools/inspector/: members, decisions, types, tags, peers from the new reads; events instead of
  3-second polling; README
- [X] F018 test/next/forum/forum.js, contracts/api.md, data-model.md, docs/next/api.md and concepts.md,
  research.md A12, CHANGELOG.md
- [X] F019 Checkpoint: `npm run test:next` and `npm run test:next:bare`; the two formerly flaky files 10 runs
  each under load; v1's `npm test` and hyperDNS's `npm test`; forum.js line count — *next 202/202 on Node and Bare;
  budgets.js, inspect.js and link-targets.js 10 runs each beside a full suite, Node and Bare: all passed (after fixing
  three test races the first round found); v1 390/390; hyperDNS 46/46; forum.js 361 lines (2026-10-09)*

## Phase 10: User Story 8 — Sub-spaces, private ones included (Priority: P3)

- [ ] T065 [P] [US8] test/next/forum/subforums.js: a sub-forum seen inside its parent without a separate join; write-restricted sub-space; a guest of the sub-space only; a parent ban applies in the sub-space even if it invited the member; a record linking to another space (US8 #1, #3–5)
- [ ] T066 [P] [US8] test/next/forum/private.js: spec 008's private-channel scenarios on a private sub-space (grant, read, revoke, no access to new posts, invite with access) (US8 #2)
- [ ] T067 [US8] `subspace/create`, effective state (parent then own, parent bans win), `createSubspace`, `subspaces()`, space links
- [ ] T068 [US8] lib/private/crypto.js and grants.js adapted from src/v2/ (grants as `hg/grant` records, key/rotate decisions, revoke = rotate + re-grant); docs; CHANGELOG

## Phase 11: User Story 9 — Big spaces (Priority: P3)

- [ ] T069 [P] [US9] test/next/net/activity.js: entries gain (period, start); readers open only active logs; false and spam entries dropped and not passed on; 10,000 throwaway-key entries add nothing (SC-006)
- [ ] T070 [P] [US9] bench/next/first-page.js: newcomer's latest 20 posts at 10k and 1M records (SC-004) — 1M only after asking
- [ ] T071a [US9] The write limit for open spaces (`setWriteLimit({ records, periodMs })`, `settings/set { writeLimit }` in the gate), postponed from story 4 (research.md A8): a rule every member judges the same although deletes wipe earlier records' times
- [ ] T071 [US9] lib/directory.js periods and the switch-over point (measured), active-log reads in lib/index/query.js; docs; CHANGELOG
- [ ] T071b [US9] A newcomer to a space bigger than its share fetches only the newest part (today it downloads the whole space once, then drops the oldest content: research.md A10; routed here by the lead, 2026-10-09); and members that don't list every record, for spaces whose list alone outgrows a share

## Phase 12: Polish & cross-cutting

- [ ] T072 [P] bench/next/writers.js (50 authors, SC-005), bench/next/rebuild.js (SC-008), bench/next/budgets.js (SC-011)
- [ ] T073 Re-run the design brief's measurements on the real core and record them in specs/research/design-brief.md with differences over 25% explained (SC-012)
- [ ] T074 [P] docs/next/deleting-and-incomplete.md (what "deleted" and "incomplete" mean, plainly — FR-028, FR-033); README section pointing to `hypergraph/next`
- [ ] T075 [P] test/next/net/adversarial.js: malformed and oversized records, forged entries, clocks far ahead, writes past cuts — no crash, nothing shown (SC-006)
- [ ] T075a A forgotten password (the one protecting the recovery phrase on a device): recover the phrase from another device of the account (Tibo, 2026-10-09; out of story 3's scope, research.md A7)
- [ ] T076 Update ROADMAP.md and ECOSYSTEM.md; full suites on Node and Bare; v1 and hyperDNS suites; merge to master after review

---

## Dependencies & execution order

- Phase 1 → Phase 2 → US1 (Phase 3) → US2 → US3, in that order: each story builds on the previous
  one's modules (the gate, the decision log, the index).
- US4–US9 depend on US1–US3; among them, US4 (invites) before US8 (sub-spaces use invites), US6 before
  US9 (big spaces need partial holding). US5 and US7 can go in any order after US3.
- Within a phase: tests first; [P] tasks touch different files.
- One worker session builds at a time (ROADMAP.md); each phase ends with a review in the lead
  conversation.

## Parallel examples

- Phase 2: T007–T012 are all [P] (different files) — one session can write them in any order.
- US1 tests T015–T022 are [P]; implementation T023–T032 is mostly sequential (shared modules).

## Implementation strategy

- **MVP**: Phases 1–3 (a forum between three members, on Node and Bare).
- **SwarmFS-ready**: through Phase 5.
- Then stories 4–9, each refined in the lead conversation before its session starts.
