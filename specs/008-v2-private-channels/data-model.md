# Data model: v2 private channels and invites

Extends [spec 007's data model](../007-scaling-v2-prototype/data-model.md).

## Control log (new and changed records)

| key | value | written by (event) |
|---|---|---|
| `channel:<id>` | adds `private: true`, `memberGrants: bool` | admin (`channel` with `private`, `commit`, optional `memberGrants`) |
| `epoch:<channel>:<n>` | `{ commit, by, at }` (`commit` = sha256 of the epoch key) | `channel` (n = 0) or `rotate` (n = current + 1, admin holding epoch n) |
| `revoked:<channel>:<member>` | `{ by, at }` | admin (`revoke`) |
| `invite-revoked:<id>` | `{ by, at }` | the invite's maker or admin (`revokeInvite`) |
| `redeemed:<id>:<identity>` | `{ channels, encryptionKey, role, at, by }` | any control log writer (`redeem`) |
| `uses:<id>` | count of distinct identities | `redeem` |

`current epoch of a channel` = highest n with `epoch:<channel>:<n>`.

## Encryption identity

`{ publicKey, secretKey }` = `crypto_box_seed_keypair(sha256('hg-v2-box\0' + seed))`. Public part:
32 bytes, hex in APIs.

## Private message block (author log)

`{ t, epoch, nonce (24 B), box }`; `box` = XChaCha20-Poly1305 of `encode({ text, reply? })`, AD =
`sha256('hg-v2-msg\0' + community + channel + authorLogKey + epoch + t)`. Public messages keep
`{ t, text, reply? }`; the encoding tells them apart by a flag.

## Grants bee (one per keeper per private channel)

Single-writer Hyperbee kept by the keeper next to its roster; its key in the roster header
(`metadata.userData`, beside the author index's `contentFeed`).

| key | value |
|---|---|
| `[recipientBoxPub (32 B), epoch (uint)]` | `{ sealed, granter, sig }` |

- `sealed` = `crypto_box_seal(epoch key, recipientBoxPub)`.
- `granter` = granter identity public key; `sig` = granter's signature over
  `sha256('hg-v2-grant\0' + community + channel + recipientBoxPub + epoch + sealed)`.
- Valid for a reader when: signature checks; the granter may grant (admin+ in the control state, or
  `memberGrants` and the granter holds a valid grant for that channel); and once opened,
  `sha256(key) === commit(epoch)`.

## Grant submission (Hypercore extension on the roster core, as announcements)

`{ channel, recipient, epoch, sealed, granter, sig }`; the keeper checks signature and right, writes
the entry if missing, replies by the entry appearing (granter retries until listed).

## Invite (in a link)

`{ id (16 B), community (32 B), role?, channels?: [id], expires? (ms), uses? (uint), maker (32 B),
sig }`, signature over `sha256('hg-v2-invite\0' + fields)`. Link text: `hg2:` + z32 of the encoding.

## Redemption

`{ invite, identity (32 B), encryptionKey (32 B), writer? (32 B), t, sig }` signed by the newcomer's
identity. Sent over a Hypercore extension on the control log's key core to writers; recorded by a
writer's `redeem` event; idempotent per (invite id, identity).

## State transitions

- Channel epoch: 0 at creation → n + 1 per accepted `rotate`. Never decreases.
- Member access (per channel): none → granted (valid grant for some epoch) → revoked (no grants for
  epochs created after `revoked:`) → granted again (new grant for a later epoch; `revoked:` cleared by
  a later grant from an admin).
- Invite: open → used up (`uses` reached) / expired / revoked.
