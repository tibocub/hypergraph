# Spec 022: private spaces encrypted on disk, and `space.rotateKey()`

**Created**: 2026-11-13 · **Asked by**: HyperBrowser circles (grilled with Tibo, 2026-11-13) · **Status**: draft

Circles (spec 023) will have people's devices and helpers keep each other's spaces. Today a private space seals record
fields only: its decision log, member list, record types, stamps, links' absence, grants and log headers are plain, so a
holder learns who talks to whom and when. Tibo's rule: anything private leaves a device encrypted, even for a server.
The personal space is already encrypted at the core level (`space.js` `_coreOpts`, the decision log's `encryptionKey`);
private spaces get the same. "User" here: a developer calling the API.

## Requirements

- **FR-001** A private space created from now on has a **disk key**: its decision log (Autobase `encryptionKey`) and
  every log of it (members' data logs, sub-spaces included) are opened with it. A holder without it sees core keys,
  lengths and sizes only.
- **FR-002** The disk key is **never in an invite**. When a decider records a redemption, its device sends the disk key
  to the newcomer's device directly (the space's channel), sealed to that device's box key (`lib/private/crypto.js`).
  The newcomer can then read the decision log and find its grants as today. A redemption that is refused sends nothing.
- **FR-003** The disk key follows the person: kept in the personal space with the joined space, so their other devices
  (spec 012) open it without asking anyone.
- **FR-004** A device added to a person later, and a device rejoining after a restart, get it from the personal space.
- **FR-005** Epoch keys (content), grants, history links and the automatic change of key on removal work as today, on
  top of the disk key.
- **FR-006** `space.rotateKey()`: a member who may decide or moderate changes the content key now (the existing
  `key/rotate`), granted to who is entitled. Others get `NOT_ALLOWED`. Resolves once the new key is recorded.
- **FR-007** Public and closed spaces, the personal space, and private spaces made before this spec are unchanged.
  No migration (Tibo: today's apps and sites are recreated for the public beta).
- **FR-008** Blind peers (spec 013 helpers) keep and serve an encrypted space without its key.

## Not covered (decided)

The disk key never changes: a removed member who keeps it and gets the ciphertext (from a copy, or anyone serving the
space's cores) can read members and timing, never content written after the removal (FR-005). Changing it means new
cores: a later "renew space" spec, done progressively in the background, triggered by owners and admins (intrusions)
and later after removals. Writing our own per-block rotating encryption was refused (unreviewed crypto).

Joining still needs a decider online, as today.

## Tests

`test/next/unit/sealed.js` (a holder's store has no plaintext: no member key, type name or field in any block),
`test/next/net/sealed.js` (join, second device, refused redemption, blind peer serving it), forum scenario
`test/next/forum/private.js` extended, `perf/scenarios/members.mjs`: join time of a private space before and after.
