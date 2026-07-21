# Read Permission

This document covers Hypergraph's read-access model: `ScopeBase`, sealed key grants, and
content encryption. It's a newer, separate system from write-access (see
[Contexts and Roles](contexts-and-roles.md)) — read on for why they're different axes, not
two names for the same thing.

## The problem this solves

Write access is controlled by autobase's own writer-set mechanism, plus Hypergraph's role
system on top (who is *allowed* to write). Neither says anything about who can *read*. In a
P2P system, that matters more than it might in a client-server one: once a peer has
replicated a context or a UserCore, there is no way to prevent them from reading the bytes
they already have. Access-list enforcement works for controlling contribution; it says
nothing about confidentiality. The only real lever for read access control in P2P is
encryption.

## Why this is a separate concept from write-access, not a rename of it

An early design idea considered giving contexts themselves different read/write access per
role — essentially, multiple Autobases as the access boundary. That turned out to be the
wrong direction for write-access specifically: Hypergraph's role/permission system already
gives fine-grained, per-action control within a single context (a member can post freely, but
only specific roles can moderate or grant/revoke writers), which is more flexible than coarse
per-scope write segregation would have been.

But the same idea is legitimate for **read** confidentiality, because read boundaries don't
need to align with write boundaries at all. A context where everyone can post, but only a
subset should be able to *read* certain sensitive content (private messages, a members-only
area), is a real, different axis — this is what `ScopeBase` is for.

## What NOT to encrypt: open, public content

If a context is open-mode (anyone can join and become a writer), encrypting its regular
content provides no real security benefit — anyone can trivially become a participant and
receive the same key. Encryption is opt-in per call to `putContent()` (via `opts.scope`); the
default, with no scope, is exactly the previous unencrypted behavior, at zero cost. Reserve
scopes for content that genuinely shouldn't be readable by just anyone who joins.

## Core primitives

- **`IdentityManager.encryptionKeyPair`** — a stable, per-*identity* (not per-device)
  `crypto_box`/X25519 keypair, deterministically derived from the same mnemonic/seed the rest
  of the identity comes from (via `keet-identity-key`'s own namespaced key derivation, used as
  a seed for `crypto_box_seed_keypair()`). Any of a person's devices can independently derive
  the same keypair — a granter only needs to seal a secret once per person, not once per
  device.
- **`ScopeBase`** — an Autobase-backed structure, structurally mirroring `RoleBase` but a
  different concern: RoleBase decides who is *allowed* to do what; ScopeBase stores sealed key
  material for who has actually *been granted* the ability to decrypt a given scope's content.
  A single ScopeBase can host many independent scopes.
- **`scopes-registry.js`** — the pure state machine behind ScopeBase (mirrors
  `roles-registry.js`'s design). The actual symmetric key is never stored anywhere in the
  clear — only sealed copies, each readable only by its intended recipient.

## Creating a scope and granting access

```js
await graph.createRoleBase()
await graph.roleBase.init(ownerPubkeyHex)
// grant scope.create / scope.grant / scope.revoke to whichever roles should have them,
// the same way you'd grant content.flag or context.write
await graph.roleBase.append({
  type: 'roles/setRolePermissions',
  role: 'admin',
  permissions: ['scope.create', 'scope.grant', 'scope.revoke'],
  author: ownerPubkeyHex,
  timestamp: Date.now()
})

await graph.createScopeBase()
const { scopeId, key } = await graph.scopeBase.createScope('private-dms')
// the creator is automatically granted epoch 0's key

// granting a second person requires their encryptionKeyPair.publicKey — this needs to be
// exchanged out-of-band (e.g. alongside their identity's public key), the same way you'd
// need someone's public key before adding them as a writer
await graph.scopeBase.grantKey(scopeId, recipientPubkeyHex, recipientEncryptionPublicKey)
```

`grantKey()` has two independent requirements, not one: the granter must hold that scope's
current key themselves (an inherent cryptographic requirement — you cannot seal a key you
don't have, regardless of role), AND pass the `scope.grant` permission check against the
attached RoleBase. Both are enforced; either one failing throws immediately.

## Encrypting and reading content

```js
// write, encrypted
await graph.putContent(postId, 'a private message', 'text', { scope: scopeId })

// read — transparently decrypts if the caller holds the scope's key for the relevant epoch
const content = await graph.getContent(postId)
// { contentType: 'text', body: 'a private message', encrypted: true, scope, epoch }

// without access:
// { contentType: 'text', body: null, encrypted: true, scope, epoch }
```

`getContent()` never throws or returns garbage for missing access — a clean `body: null`
shape lets an app render "you don't have access" without special-casing errors.

**Only the content body is encrypted, not metadata.** `contentType`, and all of an entity's
type/author/timestamp/relations, stay in the clear — this is a deliberate choice, not an
oversight, since encrypting that structure too would break Hypergraph's indexing/query model
entirely (nothing could index or query encrypted structure without decrypting first). This
means a scope hides *what* was said, not *that* something was said, by whom, or when. If
hiding the existence of activity itself is ever required, that's a different, larger design
question than this system currently addresses.

## Revocation and key rotation

```js
await graph.scopeBase.revoke(scopeId, revokedPubkeyHex)
```

This is informational only — it marks a pubkey as no longer a current member going forward,
but does not, and cannot, undo a grant they already received. Confirmed directly: a
previously granted key remains resolvable after revocation. To actually cut someone off from
*future* content, rotate to a new epoch and re-grant it to everyone except the revoked
member — there's no single "rotate" convenience method yet; this currently means calling
`grantKey()` again, at a new epoch, for each remaining member. A revoked person keeps whatever
they already downloaded and decrypted before revocation — a fundamental, unavoidable property
of any offline-first/local-first system, not something worth trying to engineer around with
complexity that wouldn't actually work.

## Onboarding new, not-yet-known peers

Everything above assumes the granter already knows the recipient's public keys (identity and
encryption). For *inviting* someone who isn't a known participant yet — e.g. a shareable
invite link/code — a different primitive is the better fit:
[`blind-pairing`](https://github.com/holepunchto/blind-pairing) (used by
[`autopass`](https://github.com/holepunchto/autopass) for exactly this). It solves a
different problem than `crypto_box_seal` does: proving someone holds a valid invite and
getting them accepted, without the group owner needing to know their public key in advance.
The two compose well: `blind-pairing` for bootstrapping trust with a new person via an invite
code, `crypto_box_seal`-based key grants (as above) for ongoing distribution/rotation once
someone is already a known member. This isn't implemented in Hypergraph yet — noted here as
the intended direction, not a currently-available feature.

## A simpler design than the state of the art, deliberately

This is a symmetric key per scope, rotated wholesale on membership change, distributed
pairwise. That's not what mature encrypted-group systems use for large or
frequently-changing groups — [MLS](https://www.rfc-editor.org/rfc/rfc9420) (Messaging Layer
Security) is the real, efficient, forward-secure answer for that (its TreeKEM construction
gives efficient add/remove with forward secrecy and post-compromise security, at real
implementation complexity). Given Hypergraph's early stage, the above is the pragmatic first
version — worth upgrading later if group sizes or rotation frequency ever make wholesale
re-encryption a real bottleneck, and worth treating MLS as inspiration for that eventual
redesign rather than building it now.

## See Also

- [Contexts and Roles](contexts-and-roles.md) - Write-access model this system's permission
  checks (`scope.create`/`scope.grant`/`scope.revoke`) build on
- [Glossary](glossary.md) - Terminology
- [Component Details](contributors/component-details.md) - `ScopeBase`'s internals
- [Index Structure](contributors/index-structure.md) - The scope registry's on-disk shape
