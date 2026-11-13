# Tasks 022: private spaces encrypted on disk

From [plan.md](plan.md) and [research.md](research.md). One commit per phase.

## Phase 1: tests first (failing)

- [x] T001 `test/next/unit/sealed.js`: a private space's holder (opened keyless, as a relay) holds blocks with no
  plaintext: no member key, type name, field or space name in any block of its decision log or logs (FR-001); the
  disk key is not in the invite link (FR-002); closed and public spaces and the personal space are as before (FR-007);
  `rotateKey()` (FR-006): decider/moderator ok, member and closed space `NOT_ALLOWED`; key-free sessions on a sealed
  space: `catchUp`, `exportSpaces` refusal, `leaveSpace` purge (R1).
- [x] T002 `test/next/net/sealed.js`: join by invite (FR-002), a refused redemption gets no key (FR-002), a second
  device opens it from the personal space (FR-003/004), a restart reopens it (FR-004), removal changes the content key
  on top of it (FR-005), a blind peer keeps and serves it to a member offline the whole time (FR-008), a sub-space's
  guest (R2).
- [x] T003 forum scenario `test/next/forum/private.js`: a private forum (top) end to end, `rotateKey()`.

## Phase 2: disk key (R1–R4)

- [x] T010 `hg._diskKeys`, `@hg/meta disk-keys`; `Space` takes its top space's key; `createSpace({ private })` makes one.
- [x] T011 invite link: 16-byte commitment after the invite (`lib/invites.js`).
- [x] T012 decider sends the sealed key after recording (`space.js #redeem`, directory message 11).
- [x] T013 `lib/joiner.js`: newcomer gets the key before opening (`index.js redeemInvite`).
- [x] T014 `hg/space.disk` in the personal space; `#settleOnce` reads it.

## Phase 3: `rotateKey()` (R5), blind peer (R6)

- [x] T020 `space.rotateKey()`.
- [x] T021 blind peer test passes.

## Phase 4: docs, forum, perf

- [x] T030 docs (private spaces page, API), CHANGELOG.
- [x] T031 `perf/scenarios/members.mjs`: private space join time.
- [x] T032 hypergraph suite (Node, Bare), SwarmFS, HyperBrowser.
