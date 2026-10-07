# Tasks: v2 private channels and invites

**Input**: Design documents from `/specs/008-v2-private-channels/` (plan.md, spec.md, research.md,
data-model.md, contracts/api.md, quickstart.md)

**Tests**: required (constitution Principle II): every task changing `src/v2/` behavior is preceded
by a failing test.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Add `src/v2/crypto.js`, `src/v2/grants.js`, `src/v2/invites.js` (empty modules exporting `{}`) and confirm `node scripts/test-runner.js v2` still runs green

## Phase 2: Foundational (blocking all stories)

- [X] T002 [P] Test `test/brittle/v2/crypto.js`: the encryption key pair is the same from the same identity seed on two stores and differs between identities; a sealed epoch key opens only with the recipient's secret; a private message box opens only with the same epoch key and the same AD (community, channel, author log key, epoch, t) and fails with any of them changed; a tampered box fails
- [X] T003 [P] Implement `src/v2/crypto.js`: `boxKeyPair(identity)` = `crypto_box_seed_keypair(sha256('hg-v2-box\0' + seed))`, `seal/openSealed`, `encryptMessage/decryptMessage` (XChaCha20-Poly1305 IETF, 24-byte nonce, AD = `sha256('hg-v2-msg\0' + community + channel + authorLogKey + epoch + t)`), `commitOf(key)` = sha256
- [X] T004 [P] Extend `src/v2/encodings.js`: private message block `{ t, epoch, nonce, box }` distinguished from `{ t, text, reply? }` by a flag; grant entry `{ sealed, granter, sig }` and grant key `[recipient (32 B), epoch (uint)]`; grant submission; invite `{ id, community, role?, channels?, expires?, uses?, maker, sig }`; redemption `{ invite, identity, encryptionKey, writer?, t, sig }`; tests in `test/brittle/v2/encodings.js`
- [X] T005 Test `test/brittle/v2/control.js`: `channel` with `private: true` + `commit` records `epoch:<id>:0`; `rotate` accepted only for `current + 1` and from admin+; two concurrent `rotate` for the same epoch converge on the first ordered on two peers; `revoke` admin+ only; events from someone without the role are ignored everywhere
- [X] T006 Implement the control log events in `src/v2/control.js` (`channel{private, commit, memberGrants}`, `rotate`, `revoke`) and state (`epochs`, `revoked`), exposed by `community.channel(id)` (`private`, `epoch`, `memberGrants`)

## Phase 3: User Story 1 — a private channel only its members can read (P1) 🎯 MVP

**Independent test**: admin, member with access, member without, keeper without the key, newcomer.

- [X] T007 [US1] Test `test/brittle/v2/private.js`: `createChannel({ private: true, keep: true })`; the creator posts and reads its text; a member without access and a keeper read `{ encrypted: true, text: null, unreadable: true }` with author and time; the raw author log blocks contain no message text; a member who isn't granted can't post (throws)
- [X] T008 [US1] Implement in `src/v2/index.js`: `community.encryptionKey`; channel keys in memory per channel (`#keys`: channel → epoch → key); private `createChannel` (epoch 0 key, commit, self-grant kept locally until US2 stores it); `post` encrypting with the current epoch; `#shape` decrypting or marking unreadable; `follow` the same

## Phase 4: User Story 2 — giving and taking away access (P1)

**Independent test**: grant three members, revoke one, post, check each view; grant lookup cost.

- [ ] T009 [US2] Test `test/brittle/v2/grants.js`: an admin grants a member (sealed to its `encryptionKey`), the member reads old and new messages; a grant by a non-admin is refused locally, and one forged anyway is ignored by keepers and readers; `memberGrants: true` lets a key holder grant; a grant whose key doesn't match the epoch's commit is ignored; the member fetches only its own grant (the grants bee holds others it never downloads)
- [ ] T010 [US2] Implement `src/v2/grants.js` (keeper grants bee per private channel: create with the roster, key in the roster header `metadata.userData`; accept submissions over the roster extension with signature + right checks; `mine(recipient)` range read; `all()` for admins) and `community.grant`, `community.access`, own-grant lookup on first read of a private channel (cached)
- [ ] T011 [US2] Test (extend `grants.js`): `revoke(id, member)` → the revoked member reads none of the messages posted after, still reads older ones; other members read the new ones; concurrent `rotate` by two admins → every member ends on the same epoch and reads every message; a member offline during the rotation gets the new epoch when back
- [ ] T012 [US2] Implement `community.rotate`, `community.revoke` (revoke event, rotate, re-grant every current member: valid grant recipients minus revoked, one keeper batch), `community.members`; posters use only the epoch the control log names current
- [ ] T013 [US2] Create `bench/v2-grants.js`: keeper grants bee with 10 / 1,000 / 50,000 members (bulk), a newcomer fetching its own grant (bytes, time); `revoke` with 1,000 members (time; time for an online member to get the new epoch); record in research.md (SC-002, SC-003)

## Phase 5: User Story 3 — one link to join (P2)

**Independent test**: links with/without role and channels, expiry, use limit; maker offline.

- [ ] T014 [US3] Test `test/brittle/v2/invites.js`: `createInvite` refused for a role/channel the caller couldn't grant; a community-only link joins (reads public, posts); a link with a role and a private channel redeemed with the maker offline: role once a keeper (writer) is online, key once a key holder is online; `uses: 2` → exactly 2 of 3 get access, same on two peers; same person twice counts once; expired and revoked links give nothing; maker demoted before redemption → nothing it can no longer give; a forged invite gives nothing; the link contains no key
- [ ] T015 [US3] Implement `src/v2/invites.js` (link encode/decode, sign/verify invite and redemption) and in `src/v2/control.js` the `redeem` and `revokeInvite` events (checks in apply: invite signature, maker's right at that point, not revoked, not expired against the recorder's timestamp, uses per distinct identity; role applied with `addWriter` for staff roles)
- [ ] T016 [US3] Implement in `src/v2/index.js`: `createInvite`, `revokeInvite`, `Community.join(store, link, opts)`, `redeem` (extension on the control log key core, retried until recorded); writers record redemptions they receive; key holders grant pending redeemed channels when they see them

## Phase 6: User Story 4 — moderation and the rest on private channels (P2)

- [ ] T017 [US4] Test `test/brittle/v2/private-rest.js`: hide and ban (with the ban cut) on a private channel, by a mod without the key; replication `all` / `auto` window on a private channel; offline restart shows the page again; follow delivers decrypted messages; a grant arriving after the message turns it readable without re-downloading
- [ ] T018 [US4] Implement whatever T017 shows missing (expected: replication `all` also holds the grants bees; follow re-shapes on grant arrival)

## Phase 7: Polish

- [ ] T019 `bench/v2-chat.js --private` (history encrypted, newcomer granted): latest page time/bytes/memory vs the public run at 10k and 1M (SC-001); record in research.md and `bench/README.md`
- [ ] T020 [P] Update `docs/v2-prototype.md` (private channels, grants, invites, measured numbers, known gaps), `CHANGELOG.md` (dated, unstable), spec 008 contracts if names moved
- [ ] T021 Run `npm test` and hyperDNS (and HyperBBS while it exists) (SC-007); merge to master

## Dependencies & Execution Order

- Phase 1 → Phase 2 → US1 → US2 → US3 (needs grants) → US4 → Polish.
- Within a phase: each test before its implementation; [P] tasks touch different files.

## Implementation Strategy

MVP = Phases 1–4 (private channels with grants and revocation, measured). Invites (US3) build on the
grants; US4 confirms nothing regressed.
