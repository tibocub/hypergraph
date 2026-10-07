# Research: v2 private channels and invites

Decisions for [spec.md](./spec.md), building on spec 007 (v2 prototype) and v1's read permission
([docs/read-permission.md](../../docs/read-permission.md)).

## R1 — Where grants live, and what a member pays to find theirs (decision, measured)

**Decision**: each channel keeper also keeps a **grants** Hyperbee for the channel, keyed
`[recipient encryption public key, epoch]`. A grant is a channel epoch key sealed to the recipient
(`crypto_box_seal`), signed by its granter. Granters send grants to keepers the same way authors send
roster announcements (Hypercore extension on the roster core, retried until listed); keepers check
signature and right before writing; readers check them again. A member reads only the range of its
own key, from each keeper's grants bee, and takes the union.

**Measured** (one Hyperbee, N entries of ~170 B, a remote reader fetching one entry):

| entries | bytes to fetch one's own grant | to learn there is none |
|---|---|---|
| 10 | 1.6 KB | 1.0 KB |
| 1,000 | 8.7 KB | 6.3 KB |
| 50,000 | 25.7 KB | 27.3 KB |

Never anyone else's grants, but the bytes grow with the index depth (logarithmic), as v2 rosters do
(spec 007 T031). The spec's first SC-002 ("within 10% from 10 to 50,000") can't hold with any tree
index; it is revised to a measured bound (under 32 KB at 50,000, never others' grants). A flat lookup
would need the grant's position delivered to its recipient out of band; not worth it for ~26 KB once
per channel.

**As built and measured (T013, `bench/v2-grants.js`, 2026-10-07)**: what a member pays to obtain
access (roster header, grants tree lookup), and revocation:

| members granted | to obtain access | revoke (rotation + re-grant all) | an online member holds the new epoch |
|---|---|---|---|
| 10 | 3.4 KB, 16 ms | 25 ms | 4 ms after |
| 1,000 | 10.0 KB, 20 ms | 0.37 s | 0.34 s after |
| 50,000 | 23.4 KB, 29 ms | 15 s | 15 s after |

SC-002 (< 32 KB at 50,000) and SC-003 (1,000 members < 60 s, new epoch < 10 s) pass. Two changes got
there: the identity index (recipient identity → encryption key) moved out of the grants tree into its
own core (in the same tree it doubled the entries a lookup walks: 44.6 KB at 50,000), and the tree's
key uses a 16-byte prefix of the recipient's key. Grants are keyed `[recipient prefix, epoch,
commitment prefix]`: keyed by `(recipient, epoch)` alone, two admins rotating at once both granted
epoch n + 1 with different keys and the keeper kept whichever came first (found by T011's test).
Members look up one key per epoch: a range read loaded every key it passed (~30 of 80 blocks).

**Alternatives considered**: grants in the control log (every member downloads every grant:
O(members), against FR-008); one Autobase of grants per channel (multi-writer for granters, but rights
checks at apply time would read another log: non-deterministic, the v1 RoleBase problem); a core per
recipient (50,000 cores per channel on each keeper).

## R2 — Encryption identity (decision)

A member's encryption key pair: `crypto_box_seed_keypair(sha256('hg-v2-box\0' + identity seed))`, as
v2 derives its other per-identity keys (author logs, rosters) and as v1 derives it per identity (any
device of the identity gets the same pair). Without a seed: from the secret key, as elsewhere in v2.
The public part is published with the member's first redemption or by the app (`community.encryptionKey`);
grants are addressed to it.

## R3 — Message encryption (decision)

A private message block: `{ t, epoch, nonce, box }` instead of `{ t, text, reply }`. `box` is
XChaCha20-Poly1305 (IETF AEAD, `sodium-universal`) of the encoded `{ text, reply }`, with additional
data `sha256(community, channel, author log key, epoch, t)`: a ciphertext copied into another channel,
log, epoch or time doesn't open. Overhead ~42 B per message (24 nonce, 16 tag, epoch). `t` stays in
the clear (segments and ordering need it; metadata is visible by design).

## R4 — Epochs, rotation, convergence (decision)

- Epoch 0 is created with the channel: the `channel` event carries `private: true` and
  `commit: sha256(K0)`; the creator grants K0 to itself.
- Rotation: a control log event `rotate { channel, epoch: n + 1, commit: sha256(K) }`, written by an
  admin holding epoch n. Apply accepts it only if `epoch === current + 1`; of two concurrent
  rotations, the one the control log orders first wins on every peer; the other is ignored and its
  author rotates again.
- A grant for epoch e is valid only if `sha256(key) === commit(e)`: grants of a losing rotation are
  ignored. Posters encrypt only with the epoch the control log names as current and whose key they
  hold, so no message uses a losing key.
- `revoke { channel, member }` (control log) marks a member revoked from that channel; the caller's
  `revoke()` then rotates and re-grants the new epoch to every current member (every recipient of a
  valid grant, minus revoked), in one call (FR-009). The admin reads every grant to list members: an
  admin cost, O(members); 1,000 members = 1,000 seals + one keeper batch (SC-003, measured in T0xx).

## R5 — Who may grant (decision)

Admins and up, from the control log. A channel created with `memberGrants: true` also lets any
member holding a valid grant grant it (checked against the grant chain: the granter's own grant for
that channel must be valid; cached per reader). Grants by anyone else are refused by keepers and
ignored by readers. A demoted or banned granter's grants stop counting for **new** checks (rotation
re-grants to current members only); keys already handed out can't be taken back (stated).

## R6 — Invites (decision)

- **Link** = community key + a signed invite `{ id, community, role?, channels?, expires?, uses?,
  maker, sig }`, encoded z32/base64. No key material (FR-015).
- **Redemption**: the newcomer signs `{ invite, identity, encryptionKey, writer?, t }` (`writer`: its
  control log writer key when the invite carries a staff role) and sends it over a Hypercore extension
  on the control log's key core, retried until it sees itself recorded.
- **Recording**: any control log writer (owner, admin, mod, keeper; keepers are the ones usually
  online) appends `redeem { redemption }`. Apply checks, deterministically: the invite's signature; its
  maker's right at that point of the log (`mayAssign` for a role; admin+ for channels, or
  `memberGrants` channels; the grant-chain part is checked by the key holder at grant time); not
  revoked (`revokeInvite { id }`); not expired against the recording event's timestamp (signed by the
  recorder, a writer); uses counted per invite id, one per distinct identity. It then applies the role
  (`addWriter` for staff roles, as `setRole` does) and records `redeemed:<id>:<identity>` with the
  channels and encryption key.
- **Channel access**: any member able to grant those channels (R5) sees pending redemptions in the
  control state (redeemed, no valid grant yet) and grants. So: role when a writer is online, keys when
  a key holder is online; the maker can be offline (FR-016).
- **As built (T014–T016)**: writers also pre-check a redemption against the current state before
  recording it (a forged or used-up invite would otherwise add a rejected event on every retry). A
  role is never a step down for someone already above it. Found while testing: a key arriving from
  an online key holder doesn't make a message readable if its author's log is offline and nobody
  else held its blocks (keepers list posts, they don't store them); availability is the
  replication setting's job (`all` helpers), not the invite's.
- **Alternative considered**: Autobase optimistic appends by the newcomer (v1's redemption). v2's
  control log admits staff writers only, and an optimistic block's timestamp is the newcomer's own
  (expiry could be backdated); a recorder's event fixes both.

## R7 — Reading and following private channels (decision)

The reader decrypts with the epoch key from its grants (cached in memory per channel); a message
whose epoch it lacks comes back `{ encrypted: true, text: null, epoch }` (FR-003). When a grant
arrives later, pages re-read blocks already held (no new download). Keepers handle private channels
unchanged: roster entries never contain text.

**Found in T017**: anyone can append plain text to their own log and be listed by a keeper, so a
non-member could put readable posts in front of a private channel's members. In a private channel only
messages sealed with one of its keys are shown; plain ones come back unreadable.

## R8 — Moderation on private channels (decision)

Unchanged: hides name `(author, log, seq)`, bans and cuts use log lengths; none needs the text. A mod
without the key moderates by reference (FR-019).

## R9 — Measuring (decision)

**Measured (T019, `bench/v2-chat.js --private`, 2026-10-07)**, the newcomer's latest page:

| | public | private | difference |
|---|---|---|---|
| 10k: time / bytes / memory | 221 ms / 68.4 KB / 17.6 MB | 269 ms / 76.3 KB / 18.5 MB | +48 ms / +7.9 KB / +0.9 MB |
| 1M: time / bytes / memory | 247 ms / 96.9 KB / 18.2 MB | 280 ms / 104.1 KB / 19.4 MB | +33 ms / +7.2 KB / +1.2 MB |
| 1M: one page back | 186 ms / 163 KB | 178 ms / 182 KB | |
| live arrival p50 / p95 | 2 / 20–25 ms | 2–3 / 18–27 ms | |
| offline restart | 174–283 ms | 167–184 ms | |

The bytes are the grant lookup (~3.4 KB, once) plus ~42 B per fetched message (nonce, tag, epoch:
log blocks 12.4 → 18.8 KB for 148 blocks): +7.4% at 1M with the lookup included. The time is mostly
the lookup's round trips. SC-001 passes.

- `bench/v2-chat.js --private`: the same history, encrypted; the newcomer is granted; compare page
  time/bytes/memory with the public run (SC-001).
- `bench/v2-grants.js`: a keeper's grants bee with 10, 1,000, 50,000 members (bulk), a newcomer
  fetching its grant (SC-002); a revocation with 1,000 members: rotation + re-grants time, and the
  time for an online member to get the new epoch (SC-003).
- Tests for SC-004..SC-006: `test/brittle/v2/private.js`, `grants.js`, `invites.js`, and the spec 007
  moderation/replication/offline checks repeated on a private channel.
