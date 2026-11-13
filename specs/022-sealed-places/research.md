# Research 022: private spaces encrypted on disk

Read on autobase 7.28.2, hypercore 11.37.2, corestore 7.13.0, blind-peer 3.16.0 (2026-11-13).

## R1 — the personal space's path, every core of a space

- `Space` builds `_coreOpts = { encryption: { key } }` from `encryptionKey` (`space.js:89`); every core a space opens
  goes through it: `getCore` (`space.js:437`, members' logs), the identity log (`:482`), held logs (`:504`), own logs
  (`:553`), `testing.js:207`. The decision log gets `encryptionKey` (`space.js:385` → `decisions/log.js:53`).
- Autobase encrypts its writers, system and view cores with it (`lib/encryption.js`), and stores it in its local core's
  user data (`autobase/encryption`, `lib/boot.js`): a reopen without the key still decrypts. The Autobase key doesn't
  depend on it (the local core's key). So any space, not only the personal one, can take an `encryptionKey`.
- Sub-spaces share the top space's decision log (`index.js _decisions`): their logs take the top space's disk key.
  One place decides a space's key: `hg._diskKeys` (top space hex → key), read by the `Space` constructor.
- Key-free sessions (no `encryption`), what they touch:
  - `decisions/log.js:135` `catchUp`: writers' cores `ready()`, `update()`, `.length`. No block read.
  - `index.js:1017` `exportSpaces`: lengths, then raw copies; public spaces only, and a private space can't be public.
  - `index.js:1162` `#purge`: `clear()` only.
  None reads a block, so none can take ciphertext for data. Tests: each run on a sealed space (spec Tests list +
  `unit/sealed.js`).

## R2 — handover (finding: the newcomer needs to know before it opens)

The plan assumed the newcomer has the space channel before it reads the decision log. In the code it doesn't:
`redeemInvite` opens the space first (`openSpace` → `Space._open`), which opens the decision log (Autobase boot),
**writes its own log's header** (`OwnLog.ready`, block 0) and the identity log, and only then the directory exists
and the channel opens. Opened without the key, that header goes out in the clear and the Autobase reads ciphertext.

So a sealed space's newcomer joins in two steps, without changing anything for other spaces:
1. A **joiner** (`lib/joiner.js`): the space's topic, a bare channel on `hypergraph/space/3` (same id and capability
   handshake as the directory's; only the redeem message is sent, only the new key message read). It sends the
   redemption, whose writer key comes from `Autobase.getLocalKey()` (the same core the decision log will use), and
   waits for the key.
2. With the key: the joiner's channel closes, the space opens as today with `encryptionKey`, and `_redeem` finds
   itself recorded.

The newcomer learns the space is sealed, and checks the key it gets, from the link: **a sealed space's invite link
carries a 16-byte commitment to the disk key** (`hash('hypergraph/disk\0', key)`), never the key. It sits after the
signed invite (as the sub-space root does), so invites, redemptions and decisions keep their encoding. A changed
commitment only breaks the link (no key arrives that matches, or a stripped one is opened like an old private
space and gets nothing readable). A peer sending a wrong key is ignored (the commitment doesn't match).

Decider side: `Space.#redeem` (`space.js:2398`), after appending `invite/redeem`, reads `redeemed:<id>:<identity>`;
if recorded, it sends the disk key sealed to the redeeming device on the channel the redemption came on (new message,
index 11). A recorded member's redemption that comes again (lost message) gets it again, unless the device is removed
or the member banned. A refused redemption gets its refusal code instead, sealed the same way (the newcomer can't
read the log to tell why): `INVITE_USED_UP`, `INVITE_REVOKED`, `NOT_ALLOWED` as today, at once. (Changed after
SwarmFS's invite tests caught the first version, which sent nothing: a 30 s timeout instead of the reason. Agreed
with the lead, 2026-11-13.) A refusal isn't authenticated: any peer knowing the space key could fake one, which
only makes the join fail, as dropping the redemption would.

## R3 — the newcomer's device box key

The redemption's proof is `identity.attest(...)`: `invites.verifyRedemption` returns `{ identity, device }`, the device
key that signed it. `pc.boxPublicKey(device)` seals to it; `pc.boxKeyPair(hg._identity.device)` opens. Nothing added
to the redemption.

## R4 — personal space

`hg/space` gets a trailing `disk` field (bytes): the top space's disk key, on the top space's record and its
sub-spaces'. `#settleOnce` reads every record's key into `_diskKeys` before opening any listed space. This device
also keeps them in `@hg/meta` `disk-keys` (as the personal space's own key is kept in `@hg/meta personal`), read
before the held spaces are built at start.

## R5 — `space.rotateKey()`

`#rotate()` (`space.js:1311`) records `key/rotate` and grants; `#decider()` is "may decide or moderate, and writable".
`rotateKey()`: `NOT_ALLOWED` unless private, the member may decide or moderate, and the current key is held; then
`#rotateOnce()` until a rotation of this device is recorded (a race lost to another: tried again).

## R6 — blind peers

`Helpers.update` hands `decisionLog.base` to blind-peering (`addAutobaseBackground`) and every held log by key; a
blind peer replicates blocks as they are (ciphertext). To check in `net/sealed.js`: the helper's store has no
plaintext, and a member offline the whole time catches up from the helper alone.

## Scope finding: which spaces get a disk key

A **private top space** gets one; every sub-space of it (private or not) uses the same key, since they share its
decision log, and a sub-space's guest gets it at redemption (needed to read that log). A **private sub-space of a
space that isn't private** stays as today (content sealed, logs plain): its decisions are in the top space's plain
log anyway, and the forum's admins enter it with no redemption, so there is no moment to hand a key over. Covering it
would need its own key travelling like grants: not in this spec (said in the docs).

HyperBrowser Chat: conversations are private top spaces, so they get it.
