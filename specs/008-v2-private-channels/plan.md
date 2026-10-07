# Implementation Plan: v2 private channels and invites

**Branch**: `008-v2-private-channels` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-v2-private-channels/spec.md`

## Summary

Private channels in the v2 prototype (`require('hypergraph/v2')`): messages encrypted in authors'
logs with the channel's current key epoch; epochs and revocations recorded in the control log (one
small event per rotation, not per member); grants (epoch keys sealed to each member) kept by the
channel's keepers in a grants Hyperbee next to the roster, so a member fetches only its own; invite
links whose redemptions any control log writer records (role, use limits, expiry decided in apply)
and any key holder completes (grants). Moderation, replication, offline and following carry over.
Decisions and the measurement behind the grants layout: [research.md](./research.md).

## Technical Context

**Language/Version**: JavaScript, Node.js 26 (CommonJS)

**Primary Dependencies**: as spec 007 (Corestore, Hypercore, Autobase, Hyperbee, protomux-wakeup,
hypercore-crypto, compact-encoding), plus `sodium-universal` (already a dependency) for
`crypto_box_seal`, `crypto_box_seed_keypair` and XChaCha20-Poly1305

**Storage**: Corestore: control log (new events), rosters, author logs (encrypted blocks), grants
bees (one per keeper per private channel)

**Testing**: brittle, `test/brittle/v2/` (runner group `v2`)

**Target Platform**: Node.js (Bare later)

**Project Type**: library module (prototype, unstable)

**Performance Goals**: spec SC-001 (private page within 10% of public + a constant), SC-002 (own
grant < 32 KB at 50,000 members), SC-003 (revocation with 1,000 members < 60 s)

**Constraints**: no forks; dev machine load limits; v1 untouched; hyperDNS green (HyperBBS is
paused, see ECOSYSTEM.md; its suite still runs while it exists)

**Scale/Scope**: private channels of 10 → 50,000 members; rotations with 1,000 members

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| principle | check | status |
|---|---|---|
| I. Correctness under concurrency & partition | Epochs, revocations and redemptions are decided by the control log's apply (deterministic on every peer): concurrent rotations converge on the first ordered; use limits count distinct identities per invite in apply; expiry uses the recording writer's timestamp. Grants are unions of keepers' bees, each grant checked against its epoch's commit and its granter's right. | PASS |
| II. Test-first for replication | Each story starts with failing tests: non-member reads nothing; revoked member reads nothing after rotation; concurrent rotations; grant arriving after the message; forged grant/ciphertext; invite over the limit, expired, maker demoted; redemption with maker offline. | PASS |
| III. Thin composition | Only existing primitives: control log events, keeper-held Hyperbees, Hypercore extensions, libsodium boxes. No new transport, no fork. | PASS |
| IV. One coherent API | Same `Community` object: `createChannel({ private })`, `grant`, `revoke`, `createInvite`, `redeem`; reads return the same message shape plus `encrypted`. | PASS |
| V. Alpha versioning | Additive to an unstable prototype; v1 untouched; CHANGELOG entry. | PASS |
| Doc-sync / regression tests | `docs/v2-prototype.md`, contracts, data model and research updated with the code; every fix lands with a test. | PASS |

Re-check after Phase 1 design: unchanged (PASS).

## Project Structure

### Documentation (this feature)

```text
specs/008-v2-private-channels/
├── spec.md
├── plan.md              # this file
├── research.md          # R1–R9
├── data-model.md
├── quickstart.md
├── contracts/api.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/v2/
├── index.js            # Community: private channels, grant/revoke, invites, reading with keys
├── control.js          # new events: channel{private, commit}, rotate, revoke, redeem, revokeInvite
├── encodings.js        # private message block, grant entry, invite, redemption
├── crypto.js           # NEW: encryption identity, seal/open grants, encrypt/decrypt messages
├── grants.js           # NEW: keeper grants bee (accept, list mine, list all), granter checks
├── invites.js          # NEW: make/parse links, sign/verify invites and redemptions
├── roster.js           # carries grant submissions on the same extension channel
└── replication.js      # unchanged (grants bees replicated with rosters in 'all')

test/brittle/v2/
├── private.js          # US1
├── grants.js           # US2
├── invites.js          # US3
└── private-rest.js     # US4: moderation, replication, offline, follow on a private channel

bench/
├── v2-chat.js          # --private
└── v2-grants.js        # NEW: grant lookup 10 / 1k / 50k; revocation with 1,000 members
```

**Structure Decision**: the single-project layout of spec 007; new modules inside `src/v2/`.

## Phases

1. **Foundation**: encodings, `crypto.js` (identity box keys, seal/open, AEAD with AD), control log
   events (private channel with commit, rotate, revoke).
2. **US1 (P1)**: private channel create/post/read; non-members see `encrypted: true`; keepers list
   without the key.
3. **US2 (P1)**: grants bee at keepers, `grant`, lookup of one's own grant, `revoke` + rotation,
   concurrent rotations; `bench/v2-grants.js` (SC-002, SC-003).
4. **US3 (P2)**: invites: make, redeem (extension → writer records `redeem`), role application, use
   limits, expiry, revocation, pending grants completed by key holders.
5. **US4 (P2)**: spec 007's moderation/replication/offline/follow on a private channel.
6. **Polish**: `bench/v2-chat.js --private` (SC-001), docs, CHANGELOG, full suite + hyperDNS.

## Complexity Tracking

None.
