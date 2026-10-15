# "Hyperswarm double dial": dead connections between peers on one machine

2026-10-15, branch `deps-and-upstream`. **Nothing posted**: Tibo decides. Versions: hyperswarm 4.17.2, hyperdht 6.34.1
(both latest), Node 26.4, Windows 10, local testnet (`hyperdht/testnet`, 3 nodes on 127.0.0.1).

## Verdict

**Theirs, but HyperDHT's, not Hyperswarm's**, and **already reported**: holepunchto/hyperdht#304 ("LAN shortcut race
(6.33+) leaves connections half-open between same-host peers", open), whose comment of 2026-10-07 traces the same server
abort; a fix is open as hyperdht#283. Our earlier explanation (Hyperswarm's duplicate-connection rule,
`specs/011-spaces-core/upstream-hyperswarm.md`) was wrong: with HyperDHT fixed, Hyperswarm keeps every pair connected.
Still there on the latest versions. Our workaround in `lib/network.js` (close a silent connection, dial again) stays
until a HyperDHT release has a fix.

## What happens

Two peers on the **same host or the same LAN** (same public address) dial each other at about the same moment. The
dialing side gets a connection that "opens" (emitted by Hyperswarm), but the other side never gets it: nothing ever
arrives, it closes after ~13 s (`connection timed out`), and a retry can hit the same race, so pairs can stay apart.
In the old bench (8 processes, 30 s): 22–29 dead connections and 8–11 pairs apart near the end, every run.

## Reproductions (only their libraries)

- [`hyperdht-lan-race.js`](hyperdht-lan-race.js): **plain HyperDHT**, two processes with 10 fresh nodes each; node *i*
  of each connects to node *i* of the other at once, writes a byte, waits for the echo. Runs: 2/20 and 10/20
  connections open on the dialer but never reaching the other side; with `--one-way` (only one side dials): 0/20, 0/20.
- [`hyperswarm-double-dial.js`](hyperswarm-double-dial.js): plain Hyperswarm, N processes join a topic; each reports
  the connections it got (by handshake hash, the same at both ends); one emitted on one side only is dead. Sends no
  bytes (`--send`: one byte per connection, as apps do; same result). 8 processes, 30 s: 27–28 dead, 10–11 pairs apart
  (no bytes); 22–23 dead, 8–9 apart (`--send`).
- `bench/next/double-dial.js` (Hyperswarm + Protomux, the pre-merge bench): 22–29 dead, 9–11 pairs apart.

## Exact cause (hyperdht 6.34.1)

Instrumented copies of hyperswarm and hyperdht (scratch, never `node_modules`), timestamps across processes:

```
551872 [8d86fa] dht server hs <- 96a860 (same host): LAN path (setupHolepuncher + 10 s prepunch timer)
551883 [96a860] dht client holepunch -> 8d86fa: lan true, holepunchable true
551890 [8d86fa] dht server holepunch msg <- 96a860: punching false, round 0
551903 [96a860] dht client LAN ping ok -> 8d86fa  -> onsocket: raw stream connected
551907 [8d86fa] dht server _abort hs <- 96a860 (server.js:572, NAT analysis not stable)
551912 [8d86fa] dht server ABORT: onabort destroys the raw stream
551912 [96a860] client open -> 8d86fa (emitted)       ... 565127 client close: connection timed out
```

1. Same host: the **client** races a LAN ping against the coordinated holepunch (`lib/connect.js:248–276`, since 6.33,
   #259). When the ping answers, `onlanconnect` calls `c.onsocket`: the raw stream connects to the server's LAN
   address and the connection opens on the client.
2. The **server** takes its same-LAN branch (`lib/server.js:449–463`): a holepuncher plus a 10 s timer, both with
   `onabort` (line 458).
3. The client's first holepunch message reaches the server. Both nodes just started (and each is busy dialing the
   other), so the server's NAT analysis is not stable: `_onpeerholepunch` returns `this._abort(h)` (line 572), which
   destroys the puncher, whose `onabort` (lines 431–447) destroys `hs.rawStream` (line 446).
4. If that happens before the client's first packet reaches the server, the stream the client connected to is gone:
   the server never calls `hs.onsocket` / `onconnection` (lines 333–362), the client's packets are dropped, and the
   client only finds out from UDX's timeout ~13 s later. The client side guards against this
   (`maybeDestroyEncryptedSocket` returns once its raw stream is in use, `connect.js:765`); the server side doesn't.

Why simultaneous dials matter: one-way dials between fresh nodes don't trip it here (0/40), dials both ways do; each
node is then also holepunching as a client, which keeps its NAT analysis unsettled at the moment of step 3. Not pinned
further (#304's comment found a second abort path, `p.punch()` returning false at once with a remote that says
`firewall: OPEN, addresses: null`; ours was the `!stable` one each time).

Hyperswarm was checked first, as planned: in 5 instrumented runs (4–8 processes), `_handleServerConnection` never
had to choose between two connections (the server side never got the dead ones), so `existingIsOutdated` /
`expectedInitiator` never came into play, and `_handleServerConnectionSwap` lost nothing. (Logging shifts the timing:
with HyperDHT instrumented, every first connection failed.) Nothing hypergraph-specific is needed: no Protomux, no bytes sent, no
firewall, plain keys.

## Suggested fix

The smallest change that makes all three reproductions pass, in `lib/server.js`'s same-LAN branch: a failed holepunch
no longer destroys the stream; the 10 s prepunch timer still cleans up.

```diff
         if (addr) {
           hs.payload = new SecurePayload(h.holepunchSecret)
-          setupHolepuncher(this.dht, hs, remotePayload.firewall, onabort)
+          // the client may already be connected through this LAN address: a failed
+          // holepunch must not destroy the stream, prepunching still aborts
+          setupHolepuncher(this.dht, hs, remotePayload.firewall, noop)
           hs.prepunching = setTimeout(onabort, HANDSHAKE_INITIAL_TIMEOUT)
           return hs
         }
```

Results with it (scratch copy): `hyperdht-lan-race.js` 0/40 dead; `hyperswarm-double-dial.js` 0 dead, 0 pairs apart
(4 runs, with and without `--send`); `bench/next/double-dial.js` 0 dead, 0 apart (2 runs). HyperDHT's own suite on a
clone of v6.34.1: 100/100 before and after (`node test/all.js`), prettier clean. No in-process test: the race needs two
event loops (it never shows in one process).

Upstream's candidates, applied to 6.34.1 copies and run against the same scripts:

| | lan-race (2 runs × 20) | hyperswarm-double-dial (8 × 30 s) |
|---|---|---|
| 6.34.1 as published | 2 and 10 dead | 27–28 dead, 10–11 pairs apart |
| ours (above) | 0, 0 | 0 dead, 0 apart |
| #283 (lanPending: keep the handshake while a LAN route may win; its logic by hand, the diff doesn't apply to 6.34.1) | 0, 0 | 0 dead, 0 apart |
| #308 (`nat.js`: advertise addresses when OPEN) | 2 and 8 dead | 24 dead, 9 apart |

So #283 fixes our case; #308 alone doesn't. #283 is narrower than ours (only the `!stable` abort), ours also covers
the other abort paths of the same branch but keeps the stream up to 10 s after a real failure.

## What we did on our side

- `lib/network.js`: comment corrected (the cause); the workaround itself unchanged. `test/next/net/dead-connection.js`:
  header corrected.
- `bench/next/double-dial.js` counted pairs wrongly: a pair was "apart" when an old connection closed after its
  replacement opened, and at the very end when the first process to exit closed its connections. Fixed (counts
  connections, 3 s before the end). The earlier "pairs stay apart" figures were partly this.
- Real-world reach: two devices of one user behind one home router are "same host" for HyperDHT, so this matters for
  apps, not only tests. Hyperswarm doesn't pass `localConnection: false` to `dht.connect`, so apps can't opt out.

## Draft comment (on holepunchto/hyperdht#304, not a new issue)

> Same here on 6.34.1 (Windows 10, Node 26), and it doesn't need hyperswarm: two processes with fresh DHT nodes on a
> local testnet, node *i* of each dialing node *i* of the other at once, 2/20 and 10/20 connections open on the
> dialer but never reach the server; one-way dials 0/40. One file, hyperdht only: [link]. Instrumented, it's the
> `!stable` abort in `_onpeerholepunch` (server.js:572) destroying `hs.rawStream` through the same-LAN branch's
> `onabort` after the client's LAN ping already connected. #283's `lanPending` guard (applied by hand to 6.34.1) fixes
> it for us: 0/40, and 0 dead connections with 8 hyperswarm processes (was 27). #308 alone doesn't (10/40). An even
> smaller change also works: in the same-LAN branch pass `noop` as the puncher's `onabort` and let the prepunch timer
> abort (suite 100/100). Hope this helps get #283 in.
