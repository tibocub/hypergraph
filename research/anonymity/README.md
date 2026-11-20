# Anonymity prototype

Two hypergraph engines share one public space over a chosen transport. Findings: `specs/028-anonymity-research/research.md`.

- `stream-swarm.js`: a stand-in for Hyperswarm with no DHT. It dials addresses it is given (an onion address an
  invite would carry) and wraps each socket in Hyperswarm's own Noise handshake, so hypergraph sees an ordinary
  connection. ~80 lines: this is what an anonymous mode costs at the transport level.
- `tor.js`: starts a local C `tor` (Tor Expert Bundle), optionally with an onion service; a minimal SOCKS5 dialer.
- `bench.js`: the scenario (join, record latency, 16 KB-record bulk) over `swarm`, `relay`, `tcp` or `tor`.
- `relay-only.js`: can hyperdht be forced through a blind relay? (No: see research.md.)
- `test.js`: self-check (the adapter replicates a space). Not in `npm test`.

The engines are given a transport by setting `hg._network._swarm` before `connectToSwarm()`: there is no public
option for it, and `lib/` is unchanged.

```bash
export HG_TEST_TMP='E:\Code\P2P\.tmp\tmp'
node research/anonymity/test.js
node research/anonymity/bench.js swarm                       # Hyperswarm on a local DHT (baseline)
node research/anonymity/bench.js relay                       # + relayThrough a local blind relay
node research/anonymity/bench.js tcp                         # the adapter over a local socket
node research/anonymity/bench.js tor --tor E:\Code\P2P\.tmp\anon\tor\tor\tor.exe   # over two real Tor clients
node research/anonymity/relay-only.js
```

Tor: the Windows "Tor Expert Bundle" from https://dist.torproject.org/torbrowser/ (16.0.1 was the newest Windows
build on 2026-11-19; it holds C tor 0.4.9.16), checked against that folder's `sha256sums-signed-build.txt`. The `tor` run uses two separate
tor processes (one hosts the onion service, one dials it), both `ClientOnly 1`.
