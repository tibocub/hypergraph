# API contract: Open spaces at scale (`hypergraph/next`)

## New

```js
await space.makePublic()   // owner or admin; one-way. NOT_ALLOWED otherwise. Resolves when recorded.
space.isPublic             // boolean (after space.ready(), like other getters)
space.publicLink()         // 'hg:…', the same on every member. NOT_ALLOWED "This space isn't public" before.
```

## Changed

```js
await hg.redeemInvite(link, { timeout })
```
- An invite link: unchanged (a decider records it; refusals as today).
- A public link: resolves once one peer is reached and the space is public; nothing is written; no
  decider needed. `INVITE_INVALID` "This space isn't public" if it isn't; "No one reachable" after the
  timeout. `hg.scope(...)` taking a link follows.

```js
await space.members()
```
Same shape (`[{ identity, role, you, banned, removed, devices }]`, same order). Lists **known members**:
recorded people plus every person whose device log this member holds. A public joiner who never wrote is
not listed. Two members may list different people.

```js
await space.redemptions(link)
```
Invite link: unchanged. Public link: the known public joiners, `{ identity, at: null }`.

## Unchanged

`createInvite` (any uses, any role; revocable), `revokeInvite` (invite links only; on the public link:
`NOT_ALLOWED` "A public link can't be revoked"), `ban`, `removeMember`, `setRole`, `setWriteLimit`,
`moderate`, events (`members` fires on each newly met member's device).

## Status

`space.status().warnings` may include `OTHER_VERSION`: a peer runs a version that can't talk to this one
(update every app together).
