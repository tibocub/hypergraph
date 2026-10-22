# Hyperswarm: peers dialing each other at once stay apart (draft upstream report)

> **Superseded (2026-10-15, A17)**: the cause below is wrong. Measured with instrumented copies, the dead connections
> come from HyperDHT (its LAN shortcut races the holepunch; already reported upstream as holepunchto/hyperdht#304),
> not from Hyperswarm's duplicate rule; with HyperDHT fixed, no connection dies and no pair stays apart. See
> `specs/research/upstream/hyperswarm.md`. Kept for the record; do not post.

2026-10-11, spec 011's pre-merge fixes. **Nothing posted** — Tibo decides whether and where (holepunchto/hyperswarm
issues). Hypergraph works around it in `lib/network.js` (research.md A16).

## What we see

Peers in **separate processes** join one topic at the same moment (local DHT, `hyperdht/testnet`). Often two peers
dial each other at once. Then each side can end up holding a connection the other side already dropped:

- the connection is emitted (`'connection'`), but nothing ever arrives on it (no Protomux open, `rawBytesRead` 0);
- it closes only after ~13 s;
- after it closes, **the two peers never connect again** (as long as no new lookup happens), because the connection
  each kept was a *server* connection, and Hyperswarm only re-queues connections it dialed itself.

In one process (our test suites) it never showed.

## Reproduction (plain Hyperswarm + Protomux, no hypergraph)

`bench/next/double-dial.js` in this repo, self-contained (hyperswarm 4.17.0, hyperdht 6.34.1, protomux 3.11; the
latest hyperswarm, 4.17.2, has no change in this code): the parent starts a 3-node testnet and N child processes;
each child joins the same topic, opens one Protomux channel per connection, and after a few seconds reports the
connections on which the channel never opened.

```bash
node bench/next/double-dial.js 8 30
```

Typical output (Windows 10, Node 26, 8 processes, 30 s):

```
peer 48cff2: 8 connections, 5 distinct peers, 4 without a channel after 5 s (closed later: 13, 13, 13, 13 s)
peer 9914b9: 9 connections, 6 distinct peers, 5 without a channel after 5 s (closed later: 13, 13, 13, 13, 13 s)
peer fcb1c8: 9 connections, 5 distinct peers, 7 without a channel after 5 s (closed later: 13, 13, 13, 13, 13, 13, 13 s)
...
18 dead connections over 8 peers; 23 peers met but without an open channel at the end
```

Four runs: 11, 14, 17 and 18 dead connections over 8 peers; 22–23 peers that met had no open channel 30 s later.
With `--fix` (closing a connection nothing arrived on after 5 s, as a workaround would) the dead connections go
away, but the pairs still don't reconnect (19–21 peers apart at the end): closing alone is not enough.

## Why (reading `hyperswarm/index.js`, 4.17.x)

- `_handleServerConnection`: when a connection arrives from a peer we already have one with (`existing`, possibly
  our own dial still connecting), the tie-break keeps the connection initiated by the larger key, or the new one if
  `existing` already exchanged bytes. Each side decides alone, at different moments across processes, so they can
  keep *different* connections: each keeps one the other destroyed.
- The destroyed side's close doesn't reach the keeper at once (~13 s), so the keeper holds a silent connection.
- When a **server** connection closes, Hyperswarm doesn't re-queue the peer (only client connections are re-queued,
  in `_connect`'s close handler), so if both kept connections were server ones, nobody dials again.
- `_handleServerConnectionSwap` waits for `existing` to close before taking the new connection; while `existing` is a
  dial still connecting (or slow to close), every new connection from that peer waits there and is lost if it closes
  meanwhile. We saw a peer swallow five dials in a row from the other side over 20 s this way.

## Draft issue text

> **Simultaneous dials across processes leave both peers with a dead connection, and they never reconnect**
>
> When two peers on the same topic dial each other at the same moment (separate processes, local testnet), each can
> keep a different one of the two connections (the duplicate tie-break in `_handleServerConnection` runs on each side
> independently). Each then holds a connection the other already destroyed: it is emitted, nothing arrives on it, and
> it closes ~13 s later. Since the kept connections were server connections, the peer is not re-queued on close, so the
> two peers stay apart until a new lookup. Repro (one file, plain hyperswarm + protomux, 8 child processes):
> [link to a gist of `double-dial.js`]. Typically 10–20 dead connections over 8 peers, ~1/3 of the pairs apart after
> 30 s. Not seen in a single process. Expected: the duplicate resolution converges on the same connection on both
> sides (or the losing side re-dials), and a closed server connection to a peer still on a joined topic is re-queued.
> Workaround we use: close a connection nothing arrived on within 5 s and `joinPeer()` the peer (larger key first),
> `leavePeer()` once connected — most pairs relink within ~15 s, but `_handleServerConnectionSwap` can keep swallowing
> a pair's new connections for longer.

## Hypergraph's workaround and what remains

`lib/network.js`: a connection nothing arrives on within 5 s is closed and the peer dialed again with `joinPeer`
(the side Hyperswarm expects to dial at once, the other after 2–4 s if still apart; `leavePeer` once connected).
`test/next/net/dead-connection.js` (6 processes plus the owner, Node and Bare): no connection stays open past 8 s
without the space channel; peers apart at the end are reported: 0 in most runs, up to 7 of ~35 in a bad run, when
Hyperswarm keeps swallowing a pair's new connections (above). Measured over a minute, alone: with the workaround every
pair that met was linked from ~15 s on; without it, 11–12 of ~30 stayed apart for the whole minute.
