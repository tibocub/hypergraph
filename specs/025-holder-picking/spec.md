# Spec 025: picking holders by how much they're online (research first)

**Created**: 2026-11-17 · **Asked by**: Tibo, grilled 2026-11-17 · **Status**: research (no build until the lead and
Tibo review the research)

Spec 024 picks each space's 5 holders by a plain hash (one device per person, unseen 7 days last) and records online
numbers it doesn't use yet: each device's hours online over 30 days (observed locally per holder, `hours`) and a
self-reported share in `hg/holder.online`. 025 is to use them. Tibo: "a very important and serious matter we
shouldn't overlook": **research first, with real measurements, then a build spec.** Long-term goal: a circle with
many people stays reliable with no helper; short-term, helpers (always-on, spec HyperBrowser 020) give certainty that
some copy is always reachable. It's fine that always-on devices end up holding most spaces; the others are backups so
nothing is ever lost.

## Starting point (decided, the research compares against it and may argue for changes)

- **S1 Whose number**: the self-reported `online`, capped by what this device observed once it has watched that
  holder a while.
- **S2 Weighted pick**: weighted rendezvous hashing, weight = the online number (more online, more spaces; load
  still spread).
- **S3 Short history**: the Wilson lower bound of the online share over the hours watched (≤ 30 days): 1 h always on
  ≈ 20 %, 1 day ≈ 86 %, 30 days ≈ 99 %. Known: 30 days and years look the same.
- **S4 Certainty**: copy 1 of each space always goes to the most-online holder of its circles; copies 2–5 by S2.
- **S5 Few moves**: numbers rounded to 10-point steps; a space moves only to a holder better by 2+ steps.
- **S6** Percentages only (no hour maps shared) for now; covering different hours is a later option the research
  weighs. No settings.

## Research questions (all to answer, `research.md`)

- **RQ1 Copies**: how many for a target availability (e.g. a space readable 99 % / 99.9 % of the time) given devices'
  online rates; plain copies vs erasure coding (k of n pieces), for our sizes (circles of 2–50, spaces up to 200 MB).
- **RQ2 Repair**: add a copy as soon as a holder is gone, or wait for it to come back (Carbonite, Total Recall); what
  024's 7-days rule and extra copy cost and buy.
- **RQ3 Cost**: uploads and bandwidth per strategy under churn (devices coming and going).
- **RQ4 Strategies compared**: 024's plain hash; S2; S1–S5 together; hour coverage (S6's later option); anything the
  literature suggests.
- **RQ5 Blind peers**: our use of `blind-peer`/`blind-peering` (`lib/holding.js`, `lib/helpers.js`) against their
  documentation and code (github.com/holepunchto/blind-peer, github.com/holepunchto/blind-peering): what they offer
  that we rebuilt or skipped (peer picking, mirrors, wake-ups, trusted keys…), what switching would gain or cost.
  Tibo: make sure we're not avoiding them only because we misunderstood them.
- **RQ6 Others**: what comparable systems do: Holepunch/Keet blind peers, Tahoe-LAFS, Storj, IPFS pinning, Briar
  Mailbox, Secure Scuttlebutt; and the papers (e.g. Total Recall, Carbonite, "High availability, scalable storage,
  dynamic peer networks: pick two").

## Deliverables

- **D1** `specs/025-holder-picking/research.md`: answers RQ1–RQ6 with sources, and ends with a **recommended
  algorithm** (and what it changes from S1–S6), its expected availability and cost for circles of 2, 5, 15, 50.
- **D2** A simulator, `research/holders/` (plain JS, no new dependencies unless argued): replays devices' online hour
  patterns and a strategy's picks; measures per space the share of time at least one copy is reachable (and the owner
  isn't), uploads, moves. Patterns: real ones (D3) and made-up: always-on helper, office hours (several time zones),
  phone (short bursts), evenings, on and off for days, leaves for good.
- **D3** An export script (`research/holders/export.js` or an `hg` call): writes the online-hour maps a device has
  recorded (its own and each holder's, `hours` in `lib/holding.js`) to a file, **keys replaced by random labels**.
  Tibo runs it on his PC, his other device and the VPS helper (a HyperBrowser engine folder: say the exact command
  for each, e.g. on the VPS with the helper stopped or read-only); the simulator reads those files.
- **D4** Results: the simulator's numbers for each strategy and pattern mix, in `research.md`.

## Not in 025

Building the new pick into `lib/holding.js` (a later spec after review). Storage numbers per member (spec 026).
