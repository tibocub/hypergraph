# Contract: v2 private channels and invites (unstable)

Additions to the [v2 prototype API](../../007-scaling-v2-prototype/contracts/api.md). Same
`Community` object; nothing in v1 changes.

## Encryption identity

```js
community.encryptionKey      // hex: this member's encryption public key (derived from its identity)
```

## Private channels

```js
const id = await community.createChannel({ name, private: true, keep: true, memberGrants: false })
// admin and up; the creator holds epoch 0. private can't be undone.

await community.post(id, text)          // encrypted with the current epoch, if this member holds it
                                        // throws if it holds no key for the channel
const page = await community.latest(id) // members: { ..., text, encrypted: true, epoch }
                                        // others:  { ..., text: null, encrypted: true, epoch, unreadable: true }
                                        // plain text in a private channel: { text: null, encrypted: false, unreadable: true }
community.channel(id)                   // { name, segmentMs, private: true, epoch: n, memberGrants }
await community.access(id)              // { epochs: [n...], current: bool } for this member
```

## Grants and revocation

```js
await community.grant(id, { identity, encryptionKey })   // admin+, or a key holder if memberGrants
                                                         // seals every epoch the caller holds
await community.grantMany(id, [{ identity, encryptionKey }, ...])   // one batch
await community.revoke(id, identity)                     // admin+: marks revoked, rotates, re-grants
                                                         // the new epoch to every current member
                                                         // resolves { epoch, granted: n }
await community.rotate(id)                               // admin+ holding the current epoch
await community.members(id)                              // admin view: identities with a valid grant
```

Grants and rotations by someone not allowed throw on their side and are ignored by every peer.

## Invites

```js
const link = await community.createInvite({ role?, channels?: [id], expires?: ms, uses?: n })
// throws unless the caller could grant the role / each channel itself

// the newcomer
const community = await Community.join(store, link, { identity })   // opens the community from the link
const result = await community.redeem(link, { timeout })
// { recorded, role, channels: { id: 'granted' | 'pending' } }; recorded: false after timeout

await community.revokeInvite(link)       // its maker or an admin
community.redemptions(inviteIdHex)       // identities (hex) that redeemed it
```

`redeem` resolves once the redemption is recorded (role applied); channel access may be `pending`
until a key holder is online; `community.access(id)` turns current when the grant arrives.

## Test hooks (prototype)

```js
await community.writeGrantUnchecked(id, { recipient, identity, epoch, sealed, granterKeyPair })  // keeper
await community.grantsCores(id)          // the keepers' grants core keys
community.adoptEpochKey(id, epoch, key)  // benchmarks: bulk-written encrypted history
```
