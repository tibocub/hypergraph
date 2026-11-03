# Tasks: Open spaces at scale

**Input**: `specs/016-open-spaces-at-scale/`: [spec.md](spec.md), [plan.md](plan.md),
[research.md](research.md), [data-model.md](data-model.md), [contracts/api.md](contracts/api.md),
[quickstart.md](quickstart.md)

**Tests**: required (constitution Principle II, CLAUDE.md rules 2 and 3, perf-on-change). Each test task is
written first and must fail before its code.

**Paths**: `lib/` is hypergraph/next; tests under `test/next/{unit,net,forum}`; perf under `perf/scenarios/`.
Run one file as `node <file>` (`bare <file>`), a group with `node scripts/test-runner.js next`.

## Phase 1: Setup

- [ ] T001 Record perf before: on master (4502f88) run `npm run perf` once, keep its line in `perf/history.jsonl` (the "before" of every scenario this spec touches)
- [ ] T002 Read the plan's "Order" and research R1-R10; list in this file, under "Built differently", any place the code disagrees with them before building

## Phase 2: Foundational (blocks every story)

- [ ] T003 [P] Test: `settings/set` with `public: true` by an owner/admin counts; by a member doesn't; `public: false` on a public scope doesn't count and leaves it public; scoped to a sub-space applies there only, not inherited, in `test/next/unit/decisions-public.js`
- [ ] T004 [P] Test: `State.roleOf` falls back to `'member'` for an unrecorded, unbanned identity in a public scope only; a banned identity gets null; a recorded role wins; `mustAdmit` is false for fallback members; `touched()` marks `all` when `public` changes, in `test/next/unit/decisions-public.js`
- [ ] T005 Add the trailing `public` field (bool, absent = unchanged) to `settings/set` in `lib/encodings.js` (old decisions decode with `public` absent)
- [ ] T006 Apply `public` in `lib/decisions/apply.js` (`settings/set`: only a writer who may decide; `true` → the scope's `meta.public = true`; `false` on a public scope not counted; `decisionInfo` lists it)
- [ ] T007 `State.public`, the `roleOf` fallback, `mustAdmit` for fallbacks, `touched()` in `lib/decisions/state.js` (and `SubState`: its own meta, not the parent's)

**Checkpoint**: T003-T004 pass; `node scripts/test-runner.js next` still green (no space is public yet).

## Phase 3: User Story 1 - Join an open space with no one online to let you in (P1) MVP

**Goal**: make a space public once; anyone joins with its one link, no decision, no decider online.

**Independent test**: owner makes the forum public and goes offline; a newcomer joins with the link and
posts; a third member sees the post; the decision log's length is unchanged.

- [ ] T008 [P] [US1] Test: `publicLink` encodes `hg:` + z32(space key [+ root]) and `decodeLink` returns `{ public: true, space, root }` for 32/64-byte bodies, still decodes invite links, rejects other lengths, in `test/next/unit/invites-public.js`
- [ ] T009 [P] [US1] Test (net, two processes not needed): a public space whose deciders are all offline; a newcomer `redeemInvite(publicLink)` resolves once it reaches a plain member; its records are accepted by a third member; decision log length unchanged; a not-public space's link → `INVITE_INVALID` "This space isn't public"; nobody reached → the timeout error, in `test/next/net/public-join.js`
- [ ] T010 [P] [US1] Test: a banned identity's new device log in a public space counts for nothing; a removed (not banned) one writes in a new log that counts; `revokeInvite(publicLink)` → `NOT_ALLOWED`; `makePublic()` by a member → `NOT_ALLOWED`; a space from before (recorded members) keeps them all, in `test/next/net/public-join.js`
- [ ] T011 [US1] `publicLink(space, root)` and the 32/64-byte branch of `decodeLink` in `lib/invites.js`
- [ ] T012 [US1] `space.makePublic()` (`#unless` may decide; `#decide({ type: 'settings/set', public: true })`), `space.isPublic` (behind `_ready`, spec 015 getters), `space.publicLink()` (`NOT_ALLOWED` before), `revokeInvite` refusing the public link, in `lib/space.js`; add the new methods to the `OPENING` list
- [ ] T013 [US1] `redeemInvite` for a public link: open, connect, wait for `state.meta` within the timeout; public → keep and return; else `INVITE_INVALID`; no `redeem` message sent, in `lib/index.js` (and `lib/scope.js`'s link path)
- [ ] T014 [US1] Check `#redeem`, `_redeem`, `#mayPost`, `#whyNot`, `checkLog` (`lib/gate.js`) and `limitOf` against fallback members; fix what T009-T010 show
- [ ] T015 [US1] Forum helpers (rule 3) in `test/next/forum/forum.js`: `openLink(forum, { perHour })` → `setWriteLimit` + `makePublic` + `publicLink`; drop `revokeLink`; `whoJoined` on the public link reads known members
- [ ] T016 [US1] `test/next/forum/invites.js`: replace "a public link lets many in; revoked, it lets no one else in and members stay" with "a public forum lets many in with every admin offline; making it private again is refused; a one-use invite still works as before"; update `test/next/forum/open-forum.js` to the new helpers

**Checkpoint**: US1 tests pass; forum group green.

## Phase 4: User Story 2 - Known members, with devices (P1)

**Goal**: `members()` lists recorded people and every person whose log this member holds.

**Independent test**: a public joiner who posted once is listed with its device by members who read it,
not by one that didn't (until it does); the `members` event fires once.

- [ ] T017 [P] [US2] Test: `members()` after a public joiner's first post: listed with role `member`, `you`, `devices: [{ device, log }]`, order unchanged (highest role first); a member that never met the log doesn't list it; `members` event fires; `redemptions(publicLink)` lists it with `at: null`, in `test/next/net/public-join.js`
- [ ] T018 [US2] `members()` adds held device logs' identities whose role is the fallback member; `redemptions(publicLink)`, in `lib/space.js`
- [ ] T019 [US2] Forum scenario `test/next/forum/public.js` (new): make public, sign up with every decider offline, post, appear in members on another member, ban a public joiner (its posts stop counting), making it private refused

## Phase 5: User Story 3 - A silent member costs nothing (P1)

**Goal**: no log made, announced or listed before a member's first record.

**Independent test**: silent joiners never reach other members' directories; the first record does.

- [ ] T020 [P] [US3] Test: a member (public or invited) that joined and never wrote: other members' `directory.logs` and summaries never hold its key; after its first `put` the log is announced and the record arrives; in a private space the log is accepted at join (grants still reach it), in `test/next/net/silent-members.js`
- [ ] T021 [P] [US3] Test: `status()`, `inspect()`, budget passes and activity work for a member with no accepted own log yet, in `test/next/unit/lazy.js`
- [ ] T022 [US3] Remove the own-log accept from `#onDecisions` except in a private space; `#log()` keeps accepting at the first write, in `lib/space.js`; guard every reader of `directory.logs.get(own)` that T021 shows
- [ ] T023 [US3] Forum scenario in `test/next/forum/public.js`: a joiner who never wrote isn't listed by others, then is after its first post

## Phase 6: User Story 4 - Logs open only while used (P2)

**Goal**: another author's log stays open only while it downloads, is written or read beyond the index.

**Warning**: spec 015 counted ~45 places in replication, the indexer and Space that assume an accepted
log's core is open. Inventory them first (T024); if the change looks bigger than this phase, stop and tell
the lead before going on.

- [ ] T024 [US4] Inventory every use of `log.core` on accepted logs (`lib/directory.js`, `lib/replication.js`, `lib/index/indexer.js`, `lib/space.js`, `lib/storage.js`, `lib/activity.js`); write the list and the plan for each under "Built differently"
- [ ] T025 [P] [US4] Test: a space with 2,000 logs (scripted, everyone keeps everything): after catching up at most ~20 cores open (own, decision log, downloading); a new record in a closed log arrives; a newcomer fetches a closed log's blocks from this member; reopening the space opens no other log, in `test/next/net/closed-logs.js`
- [ ] T026 [US4] Directory entries without a core: `open(log)` / `release(log)`, closed after 30 s with no use (research R6) in `lib/directory.js`
- [ ] T027 [US4] `Replicator.hold` only while open; open on "behind" (activity entry or a peer's length > indexed), on reads beyond the index, and for budget passes, in `lib/replication.js`, `lib/activity.js`, `lib/space.js`, `lib/storage.js`
- [ ] T028 [US4] `_open` no longer opens every held log's core (rows only), in `lib/space.js`

## Phase 7: User Story 5 - A new log costs one key, not the whole list (P2)

**Goal**: log-list differences settled by key ranges; protocol renamed for the version.

**Independent test**: two peers with 10,000 logs, one new log: under 3 KB to settle, and about the same at
1,000.

- [ ] T029 [P] [US5] Test (unit, no network): range digests from a sorted key list (counts, XOR) match a brute-force computation; reconciling two sets with 0, 1, 50 and 5,000 differences converges to the union in ⌈log16(L/32)⌉+1 rounds; a peer whose keys don't match its counts is ignored for that round, in `test/next/unit/ranges.js`
- [ ] T030 [P] [US5] Test (net): two members, 2,000 logs each, one new log on one side: settled, bytes sent under 3 KB; an old-protocol peer: no channel, `status().warnings` has `OTHER_VERSION`, in `test/next/net/directory.js`
- [ ] T031 [US5] Range messages in `lib/encodings.js`: `ranges { prefix, bits, parts: 16 × { count, digest } }`, `keys { prefix, bits, keys }` (data-model.md "Space channel")
- [ ] T032 [US5] Reconciliation in `lib/directory.js`: sorted key array beside `logs`; on a summary difference send `ranges` for the root; answer and recurse per sub-range; ≤ 32 keys → `keys`; replaces `want`/`logs`; `PROTOCOL = 'hypergraph/space/2'`
- [ ] T033 [US5] `OTHER_VERSION` in `status()` warnings (a connection that opened `hypergraph/space` and not `/2`), in `lib/directory.js` and `lib/space.js`

## Phase 8: Polish and cross-cutting

- [ ] T034 [P] Perf scenarios: `members.public-join`, `members.public-cost` (flat), `members.public-join-kb` (flat) in `perf/scenarios/members.mjs`; `logs.held-start` (flat), `logs.settle-kb` (flat) in `perf/scenarios/scale.mjs`; run `npm run perf`, then `npm run perf:compare` against T001
- [ ] T035 [P] Docs: `docs/next/api.md` (makePublic, isPublic, publicLink, redeemInvite's two links, members() = known members, redemptions, revokeInvite on the public link, OTHER_VERSION) and `docs/next/concepts.md` (public spaces, why the door can't close, logs made at the first record, logs open while used)
- [ ] T036 [P] `CHANGELOG.md` entry (apply-time + wire: update every app together; forum's openLink/revokeLink change), `ECOSYSTEM.md` note (SwarmFS moves with it), `ROADMAP.md` item 10(a) status, Story 6 (helpers' `listed:`) as a follow-up
- [ ] T037 Full suites: `npm test`, `npm run test:next`, `npm run test:next:bare`; SwarmFS `npm test` and `npm run test:bare`; HyperBBS and hyperDNS `npm test`. Report numbers; any failure investigated, not retried away
- [ ] T038 Fill "Built differently" and "Not built" at the top of this file

## Dependencies

- Phase 2 blocks everything. US1 (Phase 3) → US2 (Phase 4) (members of a public space need joins).
- US3 (Phase 5) needs only Phase 2 (it changes invited members too); can follow US1 or run before it.
- US4 (Phase 6) and US5 (Phase 7) are independent of US1-US3 and of each other, but touch `lib/directory.js`
  both: do them one after the other. US5 last (the protocol rename).
- Polish after all.

## Parallel examples

- Phase 2: T003 and T004 (one new file, write together), then T005 → T006 → T007 in order.
- US1: T008, T009, T010 together (different files), then T011-T014.
- Polish: T034, T035, T036 together.

## Implementation strategy

MVP = Phases 1-4 (public spaces, known members): forums can grow without admins online. Then US3 (cheap,
big win), US4 (the risky one: stop and report if it balloons), US5 with the version bump last. Commit per
phase on `016-open-spaces-at-scale`; never push.
