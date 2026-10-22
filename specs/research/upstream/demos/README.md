# Two Holepunch bugs, one script each

Standalone: only Holepunch's own libraries, at the versions in `package.json`. Nothing else is needed.

```bash
npm install
npm run hypercore
npm run hyperdht
```

## 1. Hypercore: a read hangs after a peer clears one block

Peer A holds blocks 0–9. Peer B is connected to A only. A clears block 5 (`core.clear(5, 6)`). B then asks for
block 7, which A still has.

```bash
node hypercore-clear-stall.js plain    # B never asked A for anything before the clear
node hypercore-clear-stall.js wanted   # B asked A for a block A didn't have yet (as apps do all the time)
```

Expected output (hypercore 11.37.2 and 11.39.0, the latest on 2026-10-17):

```
plain:  A has block 7: true; B thinks A has it: true;  wants B sent A: 1; B.get(7): block 7
wanted: A has block 7: true; B thinks A has it: false; wants B sent A: 1; B.get(7): REQUEST_TIMEOUT
```

**What goes wrong**: B tracks what A holds with a contiguous length plus a bitfield. A's "dropped block 5" message
makes B's `onrange` lower the contiguous length to 5 without first recording that A still has 6–9 in the bitfield,
so B believes A lacks them. In "plain" mode B still asks and gets the block; in "wanted" mode B had already sent A a
`want` covering that range before the clear, so it doesn't ask again, and the read times out although A has the
block. Hypercore's own tests (`test/clear.js`) clear before peers connect, or on a peer whose data comes from
elsewhere — none clears while connected after a `want`. Details, the exact lines and a 7-line patch (Hypercore's own suite passes with it): `../hypercore.md`.

## 2. HyperDHT: two peers dialing each other at once keep dead connections

Two processes on one machine (local testnet). Node *i* of each process connects to node *i* of the other at the
same moment, as two Hyperswarm peers finding each other on a topic do. Each connection writes one byte and waits for
the echo.

```bash
node hyperdht-lan-race.js 10 --one-way   # only one side dials: control
node hyperdht-lan-race.js 10             # both sides dial at once
```

Expected output (hyperdht 6.34.1, the latest on 2026-10-17; the numbers vary between runs; a connection counts as
"dead" when its byte is never echoed — rerun with a 15 s wait, still none echoed):

```
one way:              10 dials: 10 opened, 10 echoed, 0 open but dead
both ways at once:    10 dials: 10 opened, 10 echoed, 0 open but dead; 10 dials: 10 opened, 0 echoed, 10 open but dead
```

**What goes wrong**: on the same machine or local network, the dialer connects through the local-address shortcut
while the other side abandons its own hole-punch and discards that same connection; the dialer only learns it ~13 s
later, and a retry can lose the same race. **A regression from 6.33**: on hyperdht 6.32.0 the same script gives 0 dead connections (two runs), matching
hyperdht issue #304, which reports the same symptom and names 6.32.0 as the last unaffected release; open PR #283 fixes it for us
(PR #308 doesn't). Details and a one-line patch (HyperDHT's suite passes with it): `../hyperswarm.md`. Real apps hit it
too: two devices behind the same home router count as "same network".
