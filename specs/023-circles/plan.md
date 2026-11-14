# Plan 023: circles

**Spec**: [spec.md](spec.md) · Node and Bare · no new dependency (blind-peer 3.16.0 and blind-peering 2.10.1 are
installed).

## What the lead found (blind-peer 3.16.0, `node_modules/blind-peer/index.js`)

- `trustedPubKeys`: only trusted clients may ask a blind peer to `announce` a core (join its topic so others find it).
- Announced cores are **never** dropped by its gc (`_gc`: `if (record.announce) continue`). Its gc drops by least
  recent activity (`cores-by-activity`), over one `maxBytes` for the whole store; no limit per client, but records
  keep the `referrer`.
- It replicates its own store on swarm connections only when it owns the store (`if (this.ownsStore)`).
- Today's helpers (`lib/helpers.js`) hand a space's logs only while it's open, and the list is in the space's
  settings (owner only).

## Research (worker, before code): a spike first

- **R1 The spike** (`test/next/net/circles-spike.js`, throw away or keep as a test): the holder is a `BlindPeer` inside
  the instance, own store in its own folder under the instance's storage, sharing the instance's swarm (or its own if
  sharing breaks hypergraph's replication: say which and why). Member A's blind-peering client, trusted, hands a
  private space's decision log with `announce` and its data logs without. A goes offline; C (outsider, a member of
  that space) finds the holder through the space's topic and reads everything. Measure the time. If announcing data
  logs is needed for C to get them, say so: the caps (FR-006) then need our own deletes (`delete-core`).
- **R2** Trust: who is the client key (the device's swarm key?) and the holder key; each holding device writes one
  record in the circle (a new type, e.g. `hg/holder`: device key, on/off); members trust each other's holder keys and
  hand to them. Removed members are untrusted at once.
- **R3** Handing closed spaces (FR-005): from the directory's saved lists (spec 017) without opening the space, or
  open briefly as helpers do; one queue per device for all circles, private spaces first.
- **R4** Caps: the share is the blind peer's `maxBytes`; the 200 MB per member by the sender (spec's shortcut) or by
  the holder from `referrer` if cheap. Oldest activity first.
- **R5** Deleting on leave and removal (FR-009/010): per core, which circles' members it was held for; delete when
  none left.
- **R6** `createCircle`: how a space is marked a circle at creation (a creation setting, like `private`), the 50 limit
  at redemption (`CIRCLE_FULL`), invites limited to owner and admins.

## Order

1. Spike (R1); report to the lead before step 3 if it changes the design.
2. Tests first (spec's list), failing.
3. `createCircle`, roles, limit (R6); holder records and trust (R2).
4. Holding: `setHolding`, the in-instance blind peer, handing including closed spaces (R3), caps (R4).
5. Leave and removal (R5), `status()`.
6. Docs (`docs/` circles page, API), forum scenario, perf. SwarmFS and HyperBrowser suites against it.

One worker, one commit per step.

## Risks

- Two corestores on one swarm connection (the holder's and the instance's): may conflict. R1 decides.
- Announced cores never dropped: if every log must be announced, caps need our own bookkeeping (R1, R4).
- Phones: one more DHT server per device if sharing the swarm fails.
