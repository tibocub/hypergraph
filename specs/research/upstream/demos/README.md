# HyperDHT: simultaneous dials on one host leave dead connections

Standalone: only `hyperdht` (and `b4a`), at the versions in `package.json`.

```bash
npm install
npm run demo
```

Two processes on one machine (local testnet). Node *i* of each process connects to node *i* of the other at the same
moment, as two Hyperswarm peers finding each other on a topic do. Each connection writes one byte and waits for the
echo; a connection that opened but never echoes counts as dead (still none after 15 s).

```bash
node hyperdht-lan-race.js 10 --one-way   # control: only one side dials
node hyperdht-lan-race.js 10             # both sides dial at once
```

## Results (Windows 10, Node 26, 2026-10-27; numbers vary between runs)

| hyperdht | dead connections, 20 dials per run |
|---|---|
| 6.32.0 | 0 (2 runs) |
| 6.34.1 | 2–10 |
| **6.35.0** (latest) | **3–7** (4 runs) |
| 6.35.0 + PR #283 | **0** (5 runs, 100 dials); hyperdht's suite 107/107 |
| any, `--one-way` | 0 |
| 6.35.0 + #278, #279, #281, #286 or #308 (each alone) | still 0–10 (3 runs each): none fixes it |

Example on 6.35.0:

```
one way: 10 dials: 10 opened, 10 echoed, 0 open but dead
both ways at once: 10 dials: 10 opened, 10 echoed, 0 open but dead; 10 dials: 10 opened, 5 echoed, 5 open but dead
```

## What goes wrong

On the same machine or LAN, the dialer connects through the local-address shortcut while the other side's NAT analysis
fails and aborts the handshake, discarding that same connection; the dialer learns it only ~13 s later. A regression
from 6.33 (issue #304). PR #283 keeps the handshake alive while the LAN route is pending (`lanPending`), which fixes it
here. Real apps hit it too: two devices behind one home router count as "same network".

To try the PR: clone hyperdht, apply #283's `lib/server.js` change on v6.35.0 (it applies cleanly), and link it as
`node_modules/hyperdht`.
