# Implementation Plan: Open spaces at scale

**Branch**: `016-open-spaces-at-scale` | **Date**: 2026-11-03 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md); reasons and alternatives in [research.md](research.md), states and fields
in [data-model.md](data-model.md), API in [contracts/api.md](contracts/api.md), checks in
[quickstart.md](quickstart.md).

## Summary

A space can be made public, once and for good, by an owner or admin. In a public space anyone whose log
header verifies counts as `member` with no decision (the header's existing device proof is the join: no
format change, R1). The public link is the space's key in link form, the same for everyone (R5). A
member's log is made and announced only at its first record (R4), other authors' logs stay open only
while used (R6, spec 015's US4), and peers settle log-list differences by key ranges instead of whole
lists (R7). Invite links, bans, roles and moderation are unchanged. Helpers' `listed:` entries stay for
now (R8, Story 6 deferred).

## Technical Context

**Language/Version**: JavaScript, Node 26 and Bare (`lib/`, hypergraph/next).

**Primary Dependencies**: corestore 7, hypercore 11, autobase 7, hyperdb, protomux, hyperswarm 4.17.2. No
new dependency.

**Storage**: unchanged formats for logs, records and the index; `meta` (decision view) gains `public`;
the directory keeps closed logs as index rows (`@hg/logs`, as today).

**Testing**: brittle; `test/next/unit` (state, apply, gate, directory ranges), `test/next/replication`,
`test/next/forum` (scenario tests, rule 3); `npm run perf` (perf-on-change rule).

**Target Platform**: desktop (Node, Pear later), phones (Bare).

**Project Type**: library.

**Performance Goals**: SC-002/003 flat from 1k to 10k public members; SC-004 ~20 open logs, start flat;
SC-005 under 3 KB to settle one new log at 10k logs (spec updated from 1 KB, R7).

**Constraints**: apply-time change (everyone updates together, R9); no header or record format change;
thin composition (no reconciliation library).

**Scale/Scope**: 1M accounts ever / 10k-100k active in a forum; perf measured at 1k and 10k, extrapolated.

**Decided by Tibo (2026-11-03)**: spec "Decisions" 1-7 (public is one-way like a public Discord server;
known members; no spam gate; one spec).

## Constitution Check

*Before Phase 0 and again after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Correctness under concurrency & partition | The fallback role depends only on applied decisions (`public`, bans): every member reaches the same answer for every log, whenever it meets it; one-way `public` removes the only ordering race (R2). Concurrent ban and first post: the ban's cut applies as today. Range reconciliation converges to the union (each round only adds keys, every key still passes the gate). | pass |
| II. Test-first for replication | Unit: apply `settings/set public` (allowed, refused, undo refused, scoped), fallback roles, gate on a public space; replication: two members, a public joiner with every decider offline, a banned joiner's new log, a closed log receiving a record, ranges settling from 0, 1, many differences and a peer lying about counts. Written before the code. | pass (in tasks) |
| III. Thin composition | Uses the existing header proof, Autobase apply, Corestore's serving of closed cores, Protomux channel naming for the version. Range reconciliation: ~80 lines, no dependency. | pass |
| IV. One coherent API | One new call to make a space public, one to read its link; `redeemInvite` takes both kinds of links; `members()` keeps its shape. No "close the door" call to misuse. | pass |
| V. Explicit breaking changes | Apply-time + wire (`hypergraph/space/2`); CHANGELOG entry; ECOSYSTEM.md note (SwarmFS moves with it); forum's `openLink`/`revokeLink` change. | pass |
| Doc-sync | `docs/next/api.md` (makePublic, publicLink, isPublic, redeemInvite, members() = known members, redemptions), `docs/next/concepts.md` (public spaces, why the door can't close, logs made at the first record), CHANGELOG, ECOSYSTEM.md. | in tasks |
| Rule 2 + perf-on-change | Regression tests above; `perf/scenarios/members.mjs` gains public variants, `scale.mjs` held logs and list settling (R10); `npm run perf` before and after. | in tasks |
| Rule 3: forum scenarios | Listed below, same change. | in tasks |

No violations; no Complexity Tracking.

## Design

### A. Public spaces (`lib/decisions/apply.js`, `state.js`, `lib/encodings.js`) — **apply-time**

- `settings/set` gets a trailing `public` field (bool, absent = unchanged). Apply: only a writer who may
  decide; `true` stored in the scope's `meta.public`; `false` on a public scope: not counted (listed in
  `decisions()` with `counted: false`). Sub-spaces scoped as today, not inherited.
- `State.public`; `roleOf(h)`: recorded role, else `public && !banned` → `'member'`. `mustAdmit` is
  false for fallback members. `touched()` marks `all` when `public` changes (every pending log rechecked).

### B. Joining (`lib/invites.js`, `lib/index.js`, `lib/space.js`)

- `publicLink(space)`: `hg:` + z32(space key [+ root]); `decodeLink` returns `{ public: true, space, root }`
  for 32/64-byte bodies.
- `redeemInvite(publicLink)`: open the space, connect, wait for the decision log's `meta` (bounded by the
  timeout); public → kept, returned; not public → `INVITE_INVALID`; nobody reached → as today.
- `space.makePublic()`: `#unless` the caller may decide; `#decide({ type: 'settings/set', public: true })`.
  `space.isPublic` (sync, via `_ready` like other getters, spec 015). `space.publicLink()`: throws
  `NOT_ALLOWED` "not public" before.
- `redemptions(link)` on the public link: the known fallback members, `{ identity, at: null }`.

### C. Known members (`lib/space.js` `members()`)

- Add each identity of a held device log whose role is the fallback member (not in `state.members`). Same
  fields; `role: 'member'`. Order unchanged. The `members` event already fires per accepted device log.

### D. No log before the first record (`lib/space.js` `#onDecisions`, `#log`)

- Remove the accept of the own log from `#onDecisions`, except in a private space (grants, R4). `#log()`
  accepts at the first write (it does today). Audit callers that read `directory.logs.get(own)`:
  `inspect()`, `status()`, budget passes, `activity`: each tolerates its absence (tests).

### E. Logs open only while used (`lib/directory.js`, `lib/replication.js`, `lib/space.js` `_open`)

- As spec 015 research R4 (here R6): entries without cores; `open(log)`/`release(log)` with a 30 s idle
  close; opened when own, behind (activity entry or peer length > indexed), read beyond the index, budget
  pass. `_open` no longer opens every core. Replicator holds open logs only.

### F. Ranges (`lib/directory.js`, `lib/encodings.js`) — **wire**

- `PROTOCOL = 'hypergraph/space/2'`. Messages: `summary` (unchanged fields), `ranges { prefix, depth,
  parts: [{ count, digest }] × 16 }`, `keys { prefix, keys }` (replaces the whole-list `want`/`logs`).
  A sorted array of held keys gives counts and XOR digests of any prefix range on demand (binary search).
  A peer answering with more keys than its counts claimed is ignored for that round.
- `status()` warning `OTHER_VERSION` when a connected peer opened only the old channel name.

### G. Forum scenario tests (rule 3) — `test/next/forum/`

- `forum.js`: `openLink(forum, { perHour })` → `makePublic` + `publicLink` (+ write limit); `revokeLink`
  removed; `whoJoined` reads known members for the public link.
- `invites.js`: "a public link lets many in; revoked…" → "a public forum lets many in with every admin
  offline; making it private again is refused; one-use invites still work as before".
- `open-forum.js`: built on `makePublic`.
- New `public.js`: sign up through the link with every decider offline, post, appear in members on
  another member; a banned joiner's new device log counts for nothing; a silent joiner isn't listed and
  appears after its first post.

### H. Perf (`perf/scenarios/`)

- `members.mjs`: `members.public-join` (ms until a third member reads the joiner's post),
  `members.public-cost` (other members' CPU and memory, `flat`), `members.public-join-kb` (`flat`).
- `scale.mjs`: `logs.held-start` (start time and open cores with L logs, `flat`), `logs.settle-kb` (one
  new log between peers with L logs, `flat`).

### Files touched

`lib/decisions/{apply,state}.js`, `lib/encodings.js`, `lib/invites.js`, `lib/index.js`, `lib/space.js`,
`lib/directory.js`, `lib/replication.js`, `lib/scope.js` (link path), tests under `test/next/`,
`perf/scenarios/{members,scale}.mjs`, `docs/next/{api,concepts}.md`, `CHANGELOG.md`, `ECOSYSTEM.md`,
`ROADMAP.md`. SwarmFS: run its suite (no code change expected: its spaces use invite links).

## Order

1. A + B + C (+ their tests): the public path works on today's directory. Forum tests G.
2. D: no log before the first record.
3. E: logs open only while used.
4. F: ranges and the protocol name.
5. H perf before (on master) and after; docs; full suites (hypergraph default + next on Node and Bare,
   SwarmFS, HyperBBS, hyperDNS).

Each step merges into the branch with its tests green; the version bump (F) comes last so the branch
stays testable against itself throughout.

## Post-design Constitution re-check

Unchanged: pass. The design is smaller than the spec first said (no header field, R1), and Story 6 left
(R8): both recorded in the spec.
