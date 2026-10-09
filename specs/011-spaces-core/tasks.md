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

**Granularity**: Phases 1–5 (setup, foundation, stories 1–3) are detailed: they are the first worker
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

## Phase 6: User Story 4 — Invites and joining (Priority: P2)

- [ ] T054 [P] [US4] test/next/forum/invites.js: redeem while the inviter is offline and another admin online; expired, used-up, revoked links refused with their codes; an inviter whose role can't give the role → refused; a public link with unlimited uses; revoking it stops new joins, members stay; a write limit per period enforced by every member (US4 #1–4, FR-023)
- [ ] T054a [P] [US4] test/next/forum/moderation.js: **unban** — a banned member let back in (`moderateAction('unban', who)`, then an invite or `setRole`) writes again; what they wrote during the ban stays ignored for everyone, newcomers included; new writes count from the unban (ROADMAP 2026-10-09)
- [ ] T054b [P] [US4] test/next/net/indexers.js: **admins share the settling of the decision order with the owner** — members with `decide` are Autobase indexers; with the owner gone for good, two admins still settle new decisions (a role, a ban, a redemption) that every member applies the same way; an admin demoted later stops being an indexer (v1 spec 003's lesson; ROADMAP 2026-10-09)
- [ ] T054c [P] [US4] test/next/forum/devices.js: an owner's second device moderates and invites (its decision-log key becomes a writer); a removed device's later decisions are ignored by every member (research.md A7)
- [ ] T055 [US4] lib/invites.js complete (uses, expiry, revocation, redemptions, recorded by any decision writer, never downgrades — spec 008's design), `settings/set { writeLimit }` in the gate; `revokeInvite`, `redemptions`, `setWriteLimit`; a second device of a member with `decide` or `moderate` becomes a decision-log writer too (a signed claim, like a redemption), and removing a device removes its writer key (research.md A7); unban (a `moderate` action lifting `banned:`; the ban's cut stays, so the member writes again in a new device log, as after a removal — research.md A4); decision-log indexers = members with `decide` (`host.addWriter(key, { indexer: true })`, removed when demoted); docs; CHANGELOG

## Phase 7: User Story 5 — Graph vocabulary, shared editing (Priority: P2)

- [ ] T056 [P] [US5] test/next/forum/graph.js: the meanings of v1's test/brittle/core/relations.js, tags.js and query.js (relate with type/value/data ≤ 4 KB, unrelate, edges in/out with counts, tag/untag/getByTag newest first, paging without gaps or repeats)
- [ ] T057 [P] [US5] test/next/forum/wiki.js: a page type editable by permission `edit-pages`; three editors, the latest allowed edit wins; an edit without the permission ignored (US5 #4)
- [ ] T058 [US5] `hg/relation` and `hg/tag` built-in types, `relate/unrelate/edges/tag/untag/getByTag`, `editable` by permission or members in the gate; docs; CHANGELOG

## Phase 8: User Story 6 — Holding part of a space, honestly (Priority: P2)

- [ ] T059 [P] [US6] test/next/forum/budgets.js: app budget shared by spaces; a space with its own budget keeps within it and the others share the rest; own logs, decision logs, personal space never dropped; disk within limits +10% (SC-011)
- [ ] T060 [P] [US6] test/next/forum/policies.js: a small space held entirely by default; `everything` required by the creator; a member below it is told (status event)
- [ ] T061 [P] [US6] test/next/forum/rebuild.js: a deleted index is rebuilt from held logs; after a simulated crash only the unfinished part is redone
- [ ] T062 [US6] lib/replication.js complete (budgets per research R14, eviction oldest-unread first, policies, `status()`), free-disk check on both runtimes (or the 5 GB default), index rebuild; `setBudget`; docs; CHANGELOG

## Phase 9: User Story 7 — App versions (Priority: P2)

- [ ] T063 [P] [US7] test/next/forum/versions.js: two type versions in one space read each other's records; a bad change (reorder, kind change, removal) refused at open with INCOMPATIBLE_TYPES naming type and field
- [ ] T064 [US7] lib/types.js persisted declaration in the index's `meta`; records of unknown types kept and indexed by type; docs; CHANGELOG

## Phase 10: User Story 8 — Sub-spaces, private ones included (Priority: P3)

- [ ] T065 [P] [US8] test/next/forum/subforums.js: a sub-forum seen inside its parent without a separate join; write-restricted sub-space; a guest of the sub-space only; a parent ban applies in the sub-space even if it invited the member; a record linking to another space (US8 #1, #3–5)
- [ ] T066 [P] [US8] test/next/forum/private.js: spec 008's private-channel scenarios on a private sub-space (grant, read, revoke, no access to new posts, invite with access) (US8 #2)
- [ ] T067 [US8] `subspace/create`, effective state (parent then own, parent bans win), `createSubspace`, `subspaces()`, space links
- [ ] T068 [US8] lib/private/crypto.js and grants.js adapted from src/v2/ (grants as `hg/grant` records, key/rotate decisions, revoke = rotate + re-grant); docs; CHANGELOG

## Phase 11: User Story 9 — Big spaces (Priority: P3)

- [ ] T069 [P] [US9] test/next/net/activity.js: entries gain (period, start); readers open only active logs; false and spam entries dropped and not passed on; 10,000 throwaway-key entries add nothing (SC-006)
- [ ] T070 [P] [US9] bench/next/first-page.js: newcomer's latest 20 posts at 10k and 1M records (SC-004) — 1M only after asking
- [ ] T071 [US9] lib/directory.js periods and the switch-over point (measured), active-log reads in lib/index/query.js; docs; CHANGELOG

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
