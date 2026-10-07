# Data Model: Scaling v2 Prototype

All structures per community. "Signed" = by an Ed25519 key pair (hypercore-crypto).

## Community control log (Autobase, writers: admins)

Bootstrapped by the creator (owner). Written only by members whose role allows it; every member
replicates and applies it in full. View: Hyperbee, UTF-8 keys, JSON values (small; v1's compact
layout is not worth it here).

| key | value | written by |
|---|---|---|
| `meta:community` | `{ version: 'v2-prototype', name, createdAt }` | owner, once |
| `role:<pubkey>` | `{ role: 'owner' \| 'admin' \| 'mod' \| 'keeper', by }` | owner (admin, mod, keeper), admin (mod, keeper) |
| `channel:<channelId>` | `{ name, segmentMs, createdAt, by }`; an event carrying `rosterKey` also writes `keeper:<channelId>:<by>` (created and kept in one event) | admin |
| `ban:<pubkey>` | `{ at, reason, by, cut: { <logHex>: length } }` (absent = not banned; unban deletes) | mod and up |
| `hide:<authorPub>:<logKey>:<seq>` | `{ reason, by, at }` | mod and up |
| `keeper:<channelId>:<keeperPub>` | `{ rosterKey }` | the keeper itself (role `keeper` required) |

Events: `{ type, ...fields, author, timestamp, signature }`, signature by `author` over a stable
hash bound to the community key (as v1 contexts). Apply checks the author's role at that point of
the log. Writers: the owner, plus every admin, mod and keeper (a handful).

## Channel segments (derived)

`segment(channel, t) = floor(t / channel.segmentMs)`. A message belongs to the segment of its
claimed time `t`. Readers do not show messages with `t > now + 5 min` until then.

## Author log (Hypercore, one per author per channel)

Key pair: `keyPair(hash('hg-v2-log', identitySeed, communityKey, channelId))` (deterministic,
reopenable on any device holding the identity seed). Block (compact-encoding):

| field | type |
|---|---|
| `t` | uint (claimed time, ms) |
| `text` | string (≤ 4 KB) |
| `reply` | optional (logKey, seq) |

Blocks are in non-decreasing `t` (the author's own log); a block with `t` lower than its
predecessor is shown at its predecessor's time.

## Roster (Hyperbee, single writer: one keeper, per channel)

Key: `index-encoder [uint segment, buffer authorPub]`. Value (compact-encoding):

| field | type | meaning |
|---|---|---|
| `log` | fixed32 | the author's log key for this channel |
| `start` | uint | first seq of the author's log in this segment |
| `sig` | fixed64 | author's signature over (communityKey, channelId, segment, log, start) |

Readers verify `sig` against `authorPub`, check the author isn't banned for that segment, and take
the union over all keepers they reach (same (segment, author) → lowest `start`).

## Announcement (Hypercore extension message on the roster core)

`{ channel, segment, author, log, start, sig }` sent by an author to keepers when it first posts in
a segment. A keeper accepts it if: the signature is valid, the author isn't banned, the segment is
the current or the previous one (by the keeper's clock), and the entry isn't already listed.

## Keeper author index (per keeper, per channel)

A Hyperbee (binary) beside each roster, written only by its keeper: `author` → `{ segment, log,
start, sig }`, the author's latest roster entry (signed by the author, as in the roster). Its key
is the roster header's `metadata.contentFeed`. Read only by mods, to cut every log of a banned
author (T035).

## Local database (RocksDB, per peer, not replicated)

| key | value |
|---|---|
| `page:<channel>:<segment>` | the roster entries used for that segment (author, log, start, end seen) |
| `budget:<community>` | `{ bytes, mode, decidedAt }` |

## State transitions

- Segment: open (current time inside it) → closed (time past it). Closed segments receive no new
  roster entries; their logs can be dropped locally (`core.clear` of that range) without affecting
  others.
- Ban: absent → present (new roster entries refused; in a log named in `cut`, messages from that
  seq on are hidden; in any other log, messages claiming a time after `at`) → absent (unban).
  `cut` holds the author's logs listed in the current or previous segment of each channel, with
  the length the mod saw: a claimed time can be backdated, a length can't.
