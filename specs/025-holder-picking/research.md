# 025 research: picking holders by how much they're online

**Date**: 2026-11-17 · **Spec**: [spec.md](spec.md) · **Simulator, export, commands**: [`research/holders/`](../../research/holders/README.md)

All numbers below are from the simulator on **made-up patterns** (no real data yet: this PC has 21 recorded hours).
They show which ideas matter and by how much; real hour maps (D3) must confirm them before the build spec.

## Answer in short

- **What matters most is one always-on holder, and S4 (copy 1 always goes to the most-online holder).** With one
  helper in the circle, the recommended pick reaches the ceiling (the availability you'd get if *everyone* held every
  space) in every mix and size: 97.7–99.7 % of the owner's offline hours. 024's plain hash with the same helper:
  59–96 %.
- **Without an always-on device, no picking rule saves a circle of evening/office/phone users.** People in one time
  zone are offline at the same hours (nights): even "everyone holds everything" gives 12–18 % (2 people), 32–45 % (5),
  57–85 % (15). Big mixed circles do better (50 people: 96–98 % with the recommended pick, because a few PCs left on
  exist among 50); 50 phones stay at 55 %.
- **S5 (stickiness) halves uploads and cuts moves 3x. S1's observed cap and S3 change almost nothing**; the observed
  share 024 records is off by 9–18 points (it only counts hours both devices were online).
- **The extra copy (024 FR-005) is the expensive part**: phone-heavy circles re-upload ~4 full copies per space per
  week to gain 4–5 points. Kept instead of deleted (Carbonite's lesson), it costs ~0.4 uploads/week and gives more
  (phones, 15 people: 47 % without, 51 % with 024's, 55 % kept).
- **Hour coverage (S6's later option) is not worth it**: 0–4 points over S1–S5 without a helper, nothing with one,
  1.5–4x more uploads, and it would share hour maps. It also can't use a holder never online with the owner (handing
  needs both online).
- **Blind peers (RQ5)**: we use them right. Their client picks static mirrors by XOR distance (unweighted, no online
  notion); holder picking is ours either way. Nothing to switch.

## RQ5 Blind peers: our use vs theirs

Read: `blind-peer` 3.16.0 and `blind-peering` 2.10.1 (installed), against the latest npm releases (3.18.3, 2.14.0,
both 2026-11) and `blind-peer-router` 0.2.4 (a POC). No change in the newer releases touches mirror picking.

What they are made for: **operator-run, always-on mirrors** (Keet's blind peers). The client (`blind-peering`) takes a
fixed list of mirror keys and, per core, contacts the `pick` (default 2) mirrors closest to a target by XOR distance,
optionally from different `group`s (where each mirror is hosted). It reconnects with backoff; it has no idea of a
mirror being offline for hours, of online shares, or of repair. The server (`blind-peer`) keeps what trusted or
untrusted clients hand it, garbage-collects by least recent activity past `maxBytes`, announces cores it was told
to announce, wakes a referrer's peers (protomux-wakeup), forwards push notifications (`blind-push`) and can ask a
`blind-peer-router` (a single-writer service mapping keys to mirrors by XOR distance, stored so it stays stable).

| Theirs | Ours (lib/holding.js, lib/helpers.js) | Verdict |
|---|---|---|
| Mirror picking: XOR-closest `pick` of a fixed list, `group` diversity | Our own pick (024 hash) per space; each hand-off passes that space's holders as `keys` with `pick` = all of them | Right: per-call `keys`/`blindPeers` is the documented way for "a core that should live on its own set of mirrors". Their pick has no weights, so 025's pick stays ours. Our "one device per person" is their `group` idea. |
| `blind-peer-router`: central assignment, stable | none | Central (one writer, one operator): fits helpers run by one person, not circles. Skip. |
| Server gc by activity past `maxBytes` | ours (`#fit`: whole spaces, public first, oldest first); theirs off | Right (023: theirs inverted our order and works per core, not per space). |
| `announce`, referrer wakeups | off; holder joins the space topic itself | Right: the referrer announces caused the circle crash (2026-11-16). |
| `delete-core` | used, with our own rule (only the member who handed it) | Right (023 hole: theirs lets any trusted peer delete). |
| Trusted keys, priority | used (members' client keys; private spaces priority 1) | Right. |
| `sendNotification` (blind-push to a push gateway) | not used | **A later option for phones**: a holder could wake a phone app when a space changes. Not needed for 025. |
| `client.keyPair` | we set `peering.keyPair` (undocumented property; still read in 2.14.0, line 467) | Works; a risk at an upgrade. Worth a regression test or an upstream option. |
| `lib/helpers.js`: `new BlindPeering(dht, store, { keys })`, default `pick` 2 | with 3+ helpers listed, each space goes to the 2 XOR-closest only | Probably intended (spreads load); say it in docs/helpers or pass `pick: keys.length` if every helper should hold everything. Not a 025 question. |

Switching to their picking would gain nothing for 025 (no weights, no availability) and lose our per-person rule.
Nothing here changes the rest of the research, so I went on.

## RQ1 Copies: how many, and erasure coding

Independent devices, each online a share *p* of the time (`node research/holders/run.js --analytic`):

| p | copies for 99 % | copies for 99.9 % | 5 copies | 3-of-10 pieces (3.3x) | 2-of-5 (2.5x) |
|---|---|---|---|---|---|
| 0.05 | 90 | 135 | 22.6 | 1.2 | 2.3 |
| 0.1 | 44 | 66 | 41.0 | 7.0 | 8.1 |
| 0.2 | 21 | 31 | 67.2 | 32.2 | 26.3 |
| 0.3 | 13 | 20 | 83.2 | 61.7 | 47.2 |
| 0.5 | 7 | 10 | 96.9 | 94.5 | 81.3 |
| 0.8 | 3 | 5 | 100.0 | 100.0 | 99.3 |
| 0.95 | 2 | 3 | 100.0 | 100.0 | 100.0 |

- With independent devices online 30 % of the time, 5 copies give 83 %; 99 % needs 13 copies, 99.9 % needs 20.
  With *one* device at 95 %, 2 copies already give 99.75 %. **Copies are cheap only when one of them is often on.**
- Devices are not independent: people in one time zone sleep at the same hours. The simulator's "everyone holds"
  ceiling is far below the independent formula (15 people, friends mix: 69 % instead of ~99 %). This is why the
  literature (Bhagwan et al. 2003; Blake & Rodrigues 2003) warns that availability in peer storage is bounded by
  how hosts behave, not by the number of copies.
- **Erasure coding (k of n pieces)** helps when pieces sit on *many* devices that are each often online (Storj:
  29 of 80 pieces on paid, always-on nodes; Tahoe-LAFS: 3 of 10 by default). At low *p* it is worse than plain
  copies for the same storage (p = 0.3: 3-of-10 at 3.3x storage = 62 %, 5 plain copies at 5x = 83 %; and any piece
  alone is useless). For us also: a hypercore is read block by block with proofs, pieces would need a decoding layer
  and every read would touch k holders. **Plain copies**, at our sizes (2–50 people, ≤200 MB).

## RQ2 Repair: add a copy at once, or wait?

Literature: Total Recall (Bhagwan et al., NSDI 2004) predicts each host's availability and repairs lazily, adding
redundancy instead of reacting to every departure. Carbonite (Chun et al., NSDI 2006) separates *durability* from
*availability*: count copies on hosts that come back (reintegration) and only create new ones below a threshold;
eager repair mostly wastes bandwidth on hosts that were only away for a while. Blake & Rodrigues (HotOS 2003):
maintenance bandwidth, not disk, is what limits peer storage under churn.

Simulator (`--repair`), 024's rules against variants, for 024's hash and S1–S5:

#### RQ2 repair, friends, 15 people

| strategy | rule | avail % | worst 10% | uploads/wk | copies |
|---|---|---|---|---|---|
| hash | 024 (7 d, extra) | 59.5 | 40.8 | 1.22 | 6.17 |
| hash | no extra copy | 51.3 | 30.6 | 0.34 | 5.09 |
| hash | never replace | 63.0 | 46.3 | 0.88 | 6.42 |
| hash | back = counts again | 59.9 | 42.5 | 1.14 | 6.10 |
| hash | lazy extras (kept) | 65.5 | 55.7 | 0.48 | 7.04 |
| s15 | 024 (7 d, extra) | 65.5 | 59.1 | 0.91 | 5.69 |
| s15 | no extra copy | 64.2 | 58.3 | 0.23 | 5.01 |
| s15 | never replace | 66.3 | 59.4 | 0.70 | 5.66 |
| s15 | back = counts again | 66.2 | 59.4 | 0.85 | 5.68 |
| s15 | lazy extras (kept) | 66.7 | 59.4 | 0.40 | 6.77 |

#### RQ2 repair, friends, 15 people + helper

| strategy | rule | avail % | worst 10% | uploads/wk | copies |
|---|---|---|---|---|---|
| hash | 024 (7 d, extra) | 85.1 | 57.8 | 0.97 | 5.60 |
| hash | no extra copy | 71.2 | 34.8 | 0.33 | 5.10 |
| hash | never replace | 87.7 | 59.0 | 0.72 | 5.35 |
| hash | back = counts again | 83.8 | 58.5 | 0.96 | 5.61 |
| hash | lazy extras (kept) | 94.7 | 78.0 | 0.37 | 5.82 |
| s15 | 024 (7 d, extra) | 97.9 | 97.6 | 0.22 | 4.91 |
| s15 | no extra copy | 97.9 | 97.6 | 0.21 | 4.91 |
| s15 | never replace | 97.9 | 97.7 | 0.14 | 4.73 |
| s15 | back = counts again | 97.9 | 97.6 | 0.25 | 4.92 |
| s15 | lazy extras (kept) | 97.9 | 97.6 | 0.22 | 5.04 |

#### RQ2 repair, friends, 50 people

| strategy | rule | avail % | worst 10% | uploads/wk | copies |
|---|---|---|---|---|---|
| hash | 024 (7 d, extra) | 72.8 | 42.5 | 1.23 | 6.16 |
| hash | no extra copy | 62.5 | 33.3 | 0.34 | 5.16 |
| hash | never replace | 75.5 | 45.1 | 0.89 | 6.40 |
| hash | back = counts again | 71.6 | 45.4 | 1.17 | 6.14 |
| hash | lazy extras (kept) | 81.3 | 49.6 | 0.45 | 6.88 |
| s15 | 024 (7 d, extra) | 96.0 | 95.6 | 0.44 | 5.20 |
| s15 | no extra copy | 95.9 | 95.4 | 0.36 | 5.10 |
| s15 | never replace | 96.0 | 95.4 | 0.34 | 5.15 |
| s15 | back = counts again | 96.1 | 95.6 | 0.45 | 5.21 |
| s15 | lazy extras (kept) | 96.1 | 95.7 | 0.40 | 5.48 |

#### RQ2 repair, friends, 50 people + helper

| strategy | rule | avail % | worst 10% | uploads/wk | copies |
|---|---|---|---|---|---|
| hash | 024 (7 d, extra) | 78.1 | 46.7 | 1.09 | 5.93 |
| hash | no extra copy | 68.1 | 34.5 | 0.34 | 5.14 |
| hash | never replace | 81.6 | 49.2 | 0.78 | 6.00 |
| hash | back = counts again | 77.0 | 47.8 | 1.04 | 5.92 |
| hash | lazy extras (kept) | 87.4 | 53.1 | 0.40 | 6.46 |
| s15 | 024 (7 d, extra) | 97.7 | 99.0 | 0.32 | 5.06 |
| s15 | no extra copy | 97.7 | 98.9 | 0.31 | 5.03 |
| s15 | never replace | 97.7 | 99.0 | 0.24 | 5.04 |
| s15 | back = counts again | 97.7 | 99.0 | 0.32 | 5.07 |
| s15 | lazy extras (kept) | 97.7 | 98.9 | 0.32 | 5.18 |

#### RQ2 repair, phones, 15 people

| strategy | rule | avail % | worst 10% | uploads/wk | copies |
|---|---|---|---|---|---|
| hash | 024 (7 d, extra) | 50.8 | 48.5 | 3.70 | 6.44 |
| hash | no extra copy | 46.8 | 43.7 | 0.30 | 5.00 |
| hash | never replace | 51.6 | 48.5 | 3.21 | 7.06 |
| hash | back = counts again | 50.8 | 48.5 | 3.70 | 6.46 |
| hash | lazy extras (kept) | 55.2 | 53.3 | 0.47 | 9.57 |
| s15 | 024 (7 d, extra) | 50.4 | 48.1 | 3.65 | 6.36 |
| s15 | no extra copy | 46.4 | 44.2 | 0.21 | 4.97 |
| s15 | never replace | 51.0 | 48.4 | 3.34 | 6.81 |
| s15 | back = counts again | 50.4 | 48.1 | 3.66 | 6.36 |
| s15 | lazy extras (kept) | 55.5 | 53.3 | 0.36 | 9.57 |

#### RQ2 repair, phones, 15 people + helper

| strategy | rule | avail % | worst 10% | uploads/wk | copies |
|---|---|---|---|---|---|
| hash | 024 (7 d, extra) | 74.6 | 52.6 | 2.48 | 5.72 |
| hash | no extra copy | 65.1 | 45.2 | 0.30 | 4.99 |
| hash | never replace | 77.0 | 52.7 | 2.24 | 5.82 |
| hash | back = counts again | 74.6 | 52.6 | 2.48 | 5.73 |
| hash | lazy extras (kept) | 96.8 | 85.7 | 0.38 | 6.60 |
| s15 | 024 (7 d, extra) | 99.2 | 99.1 | 0.25 | 5.00 |
| s15 | no extra copy | 99.2 | 99.1 | 0.20 | 4.98 |
| s15 | never replace | 99.2 | 99.1 | 0.22 | 4.90 |
| s15 | back = counts again | 99.2 | 99.1 | 0.25 | 5.00 |
| s15 | lazy extras (kept) | 99.2 | 99.2 | 0.24 | 5.41 |

#### RQ2 repair, phones, 50 people

| strategy | rule | avail % | worst 10% | uploads/wk | copies |
|---|---|---|---|---|---|
| hash | 024 (7 d, extra) | 51.3 | 48.5 | 4.09 | 7.03 |
| hash | no extra copy | 46.6 | 44.4 | 0.39 | 5.12 |
| hash | never replace | 52.8 | 48.8 | 3.37 | 8.44 |
| hash | back = counts again | 51.4 | 48.5 | 4.09 | 7.05 |
| hash | lazy extras (kept) | 55.4 | 52.6 | 0.54 | 9.71 |
| s15 | 024 (7 d, extra) | 51.4 | 48.7 | 4.04 | 6.93 |
| s15 | no extra copy | 46.5 | 44.0 | 0.26 | 4.98 |
| s15 | never replace | 52.2 | 48.9 | 3.69 | 7.68 |
| s15 | back = counts again | 51.4 | 48.7 | 4.04 | 6.93 |
| s15 | lazy extras (kept) | 55.3 | 53.0 | 0.41 | 9.56 |

#### RQ2 repair, phones, 50 people + helper

| strategy | rule | avail % | worst 10% | uploads/wk | copies |
|---|---|---|---|---|---|
| hash | 024 (7 d, extra) | 59.5 | 48.9 | 3.59 | 6.63 |
| hash | no extra copy | 52.7 | 44.6 | 0.39 | 5.11 |
| hash | never replace | 63.5 | 49.4 | 2.89 | 7.77 |
| hash | back = counts again | 59.6 | 48.9 | 3.58 | 6.66 |
| hash | lazy extras (kept) | 72.4 | 53.6 | 0.50 | 8.56 |
| s15 | 024 (7 d, extra) | 99.6 | 99.7 | 0.22 | 4.95 |
| s15 | no extra copy | 99.6 | 99.7 | 0.22 | 4.95 |
| s15 | never replace | 99.6 | 99.7 | 0.19 | 4.81 |
| s15 | back = counts again | 99.6 | 99.7 | 0.22 | 4.95 |
| s15 | lazy extras (kept) | 99.6 | 99.7 | 0.22 | 5.49 |

#### RQ2 repair, global, 15 people

| strategy | rule | avail % | worst 10% | uploads/wk | copies |
|---|---|---|---|---|---|
| hash | 024 (7 d, extra) | 76.4 | 56.7 | 0.98 | 8.42 |
| hash | no extra copy | 65.6 | 47.7 | 0.41 | 6.18 |
| hash | never replace | 78.5 | 63.5 | 0.61 | 8.77 |
| hash | back = counts again | 78.7 | 64.4 | 0.81 | 8.77 |
| hash | lazy extras (kept) | 78.4 | 63.6 | 0.48 | 8.74 |
| s15 | 024 (7 d, extra) | 76.8 | 61.2 | 0.94 | 8.06 |
| s15 | no extra copy | 68.4 | 52.0 | 0.41 | 6.25 |
| s15 | never replace | 78.1 | 63.7 | 0.68 | 8.01 |
| s15 | back = counts again | 77.1 | 63.1 | 0.78 | 7.87 |
| s15 | lazy extras (kept) | 78.3 | 64.7 | 0.44 | 8.47 |

#### RQ2 repair, global, 15 people + helper

| strategy | rule | avail % | worst 10% | uploads/wk | copies |
|---|---|---|---|---|---|
| hash | 024 (7 d, extra) | 96.1 | 85.2 | 0.58 | 6.66 |
| hash | no extra copy | 88.5 | 66.1 | 0.42 | 6.11 |
| hash | never replace | 97.2 | 83.3 | 0.36 | 6.36 |
| hash | back = counts again | 94.8 | 80.0 | 0.65 | 7.08 |
| hash | lazy extras (kept) | 98.7 | 98.6 | 0.41 | 6.68 |
| s15 | 024 (7 d, extra) | 99.4 | 98.8 | 0.37 | 6.09 |
| s15 | no extra copy | 99.4 | 98.8 | 0.35 | 6.03 |
| s15 | never replace | 99.3 | 98.8 | 0.22 | 5.50 |
| s15 | back = counts again | 99.4 | 98.8 | 0.37 | 6.10 |
| s15 | lazy extras (kept) | 99.4 | 98.8 | 0.36 | 6.16 |

#### RQ2 repair, global, 50 people

| strategy | rule | avail % | worst 10% | uploads/wk | copies |
|---|---|---|---|---|---|
| hash | 024 (7 d, extra) | 88.1 | 65.9 | 1.32 | 8.40 |
| hash | no extra copy | 76.6 | 52.3 | 0.41 | 6.11 |
| hash | never replace | 90.8 | 77.1 | 0.80 | 9.09 |
| hash | back = counts again | 89.9 | 73.8 | 1.18 | 9.06 |
| hash | lazy extras (kept) | 91.2 | 76.1 | 0.52 | 8.51 |
| s15 | 024 (7 d, extra) | 97.8 | 96.0 | 0.59 | 6.11 |
| s15 | no extra copy | 97.4 | 95.8 | 0.39 | 5.70 |
| s15 | never replace | 98.1 | 96.3 | 0.37 | 5.98 |
| s15 | back = counts again | 97.9 | 96.2 | 0.54 | 6.11 |
| s15 | lazy extras (kept) | 98.0 | 96.6 | 0.46 | 6.50 |

#### RQ2 repair, global, 50 people + helper

| strategy | rule | avail % | worst 10% | uploads/wk | copies |
|---|---|---|---|---|---|
| hash | 024 (7 d, extra) | 90.5 | 69.4 | 1.07 | 7.74 |
| hash | no extra copy | 81.2 | 54.6 | 0.40 | 6.10 |
| hash | never replace | 92.7 | 80.0 | 0.66 | 8.04 |
| hash | back = counts again | 91.6 | 77.3 | 1.03 | 8.30 |
| hash | lazy extras (kept) | 93.6 | 79.0 | 0.47 | 7.85 |
| s15 | 024 (7 d, extra) | 99.4 | 99.6 | 0.32 | 5.48 |
| s15 | no extra copy | 99.4 | 99.6 | 0.31 | 5.43 |
| s15 | never replace | 99.4 | 99.6 | 0.21 | 5.36 |
| s15 | back = counts again | 99.4 | 99.6 | 0.34 | 5.50 |
| s15 | lazy extras (kept) | 99.4 | 99.6 | 0.32 | 5.65 |

- **024's extra copy**: +4–14 points for the plain hash, but 3–12x the uploads (phones: ~4 full copies per space per
  week, because the extra copy is deleted once 2 regulars are back, then made again). With S1–S5 and a helper it adds
  nothing.
- **Kept extras (lazy, Carbonite)**: same trigger as 024 (no copy online), but the copy stays (up to 5 extras) and is
  only dropped when the holder's share is full. Better availability than 024's extra copy everywhere (plain hash +
  helper, 15 people: 85 % → 95 %) at 2.5–10x fewer uploads, for more stored copies where no holder is often online
  (up to ~9.6 per space for phones; ~5 with a helper).
- **7-day replacement**: within the 4 measured weeks, "never replace" is as good or better (a replaced holder that
  comes back is told to delete). Counting it again once back (reintegration) changes nothing measurable. Over months
  with people leaving for good, replacement still matters (not measured here: 4 weeks only). **Keep 024's rule.**

## RQ3 Cost

Costs below are per space; multiply by its size (≤ 200 MB) for bytes. "Uploads" = full copies the owner sends to a
holder that had none (the incremental appends are the same for every strategy: copies × what's written). "Copies" =
copies held on average (storage = copies × size, spread over holders, but not evenly: see load).

- Plain hash with 024's extra copy: 1–4 uploads/space/week (200–800 MB/week for a 200 MB space).
- Recommended: 0.2–0.5 uploads/space/week (40–100 MB/week for 200 MB).
- **Load is concentrated on purpose**: the most-online device (helper or a PC left on) holds copy 1 of *every*
  space: 5–9x the average device's load in circles of 50. That's Tibo's "fine that always-on devices hold most
  spaces", but **the simulator has no share limit**: with 024's default 1 GB share, a member's PC left on can hold
  only 5 spaces of 200 MB. The build must weigh the holder's free share (or give always-on holders a big share, as
  HyperBrowser 020's helper already does: half the free disk, ≤100 GB).

## RQ4 Strategies compared

Strategies (all with 024's rules: one device per person, handing only while owner and holder are both online,
holders sync with each other, 7-day replacement, extra copy):

- `hash`: 024. `weighted`: S2 (weighted rendezvous, Schindelhauer & Schomaker's logarithmic method, weight = the
  reported share). `top`: the 5 most online (Total Recall-style greedy, Rzadca et al.'s "selfish" placement).
  `s15`: S1–S5 together. `coverage`: S6's later option, greedy cover of the owner's
  offline hours from 4 weeks of hour maps (as My3, Rzadca et al. do). `ceiling`: everyone holds every space.
- Made-up patterns (`research/holders/sim.js` PATTERNS): helper (always on, rare 1–6 h outages), PC left on (off
  some days), office (weekdays 9–17), evenings (longer at weekends), phone (30 % of waking hours, in bursts), on/off
  for days, leaves for good (during the run); 10 % join during the measured weeks. Mixes: `friends` (2 time zones),
  `global` (5 time zones), `phones` (90 % phones). 8 weeks simulated, the last 4 measured, 5 seeds each.
- Columns: **avail** = share of the owner's offline hours some copy is online (mean over spaces); **worst 10 %** = the
  10th percentile space; **fresh** = same, with the owner's latest write; uploads and moves per space per week;
  copies held per space; **max load** = the busiest device vs the mean; **helper share** = share of all held copies on
  the helper.

Circles of 2 and 5: every strategy gives the same result (4 or fewer candidates for 5 copies: everyone holds), see the D4 table below.

#### friends, 15 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| hash | 59.5 | 40.8 | 56.4 | 1.22 | 0.49 | 6.17 | 1.7x | 0.0 |
| weighted | 62.8 | 47.1 | 59.9 | 1.05 | 0.67 | 5.99 | 1.9x | 0.0 |
| top | 65.2 | 58.8 | 62.2 | 1.67 | 2.41 | 6.25 | 2.0x | 0.0 |
| s15 | 65.5 | 59.1 | 62.6 | 0.91 | 0.27 | 5.69 | 2.3x | 0.0 |
| s15-noS1cap | 65.5 | 59.1 | 62.6 | 0.91 | 0.27 | 5.69 | 2.2x | 0.0 |
| s15-noS3 | 65.6 | 58.9 | 62.6 | 0.93 | 0.27 | 5.81 | 2.2x | 0.0 |
| s15-noS4 | 65.1 | 55.6 | 62.2 | 0.96 | 0.28 | 5.73 | 2.2x | 0.0 |
| s15-noS5 | 65.4 | 59.1 | 62.6 | 1.12 | 0.90 | 5.99 | 2.1x | 0.0 |
| rec | 65.5 | 59.1 | 62.6 | 0.91 | 0.27 | 5.69 | 2.2x | 0.0 |
| coverage | 67.5 | 61.0 | 64.6 | 1.48 | 1.81 | 6.10 | 2.2x | 0.0 |
| (ceiling: everyone holds) | 69.3 | 62.6 | 66.9 | 0.43 | 0.62 | 10.97 | 1.2x | 0.0 |

(024's observed share off by 18.0 points.)

#### friends, 15 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| hash | 85.1 | 57.8 | 84.3 | 0.97 | 0.45 | 5.60 | 1.9x | 11.6 |
| weighted | 96.5 | 84.7 | 96.3 | 0.50 | 0.64 | 5.13 | 2.7x | 16.9 |
| top | 97.9 | 97.8 | 97.9 | 1.47 | 2.29 | 5.54 | 2.7x | 17.1 |
| s15 | 97.9 | 97.6 | 97.9 | 0.22 | 0.25 | 4.91 | 3.1x | 19.3 |
| s15-noS1cap | 97.9 | 97.8 | 97.9 | 0.22 | 0.25 | 4.91 | 3.1x | 19.3 |
| s15-noS3 | 97.9 | 97.5 | 97.9 | 0.22 | 0.25 | 4.88 | 3.1x | 19.4 |
| s15-noS4 | 97.6 | 96.7 | 97.4 | 0.23 | 0.25 | 4.92 | 3.0x | 18.7 |
| s15-noS5 | 97.9 | 97.6 | 97.9 | 0.46 | 0.75 | 5.22 | 2.9x | 18.2 |
| rec | 97.9 | 97.8 | 97.9 | 0.22 | 0.25 | 4.91 | 3.1x | 19.3 |
| coverage | 97.9 | 97.7 | 97.9 | 0.79 | 0.99 | 5.19 | 2.9x | 18.3 |
| (ceiling: everyone holds) | 98.0 | 97.9 | 97.9 | 0.46 | 0.65 | 11.92 | 1.3x | 8.1 |

(024's observed share off by 16.8 points.)

#### friends, 50 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| hash | 72.8 | 42.5 | 71.0 | 1.23 | 0.49 | 6.16 | 2.4x | 0.0 |
| weighted | 88.4 | 68.8 | 86.9 | 0.83 | 0.84 | 5.69 | 4.7x | 0.0 |
| top | 96.9 | 98.2 | 96.2 | 1.21 | 1.89 | 5.78 | 8.1x | 0.0 |
| s15 | 96.0 | 95.6 | 95.2 | 0.44 | 0.40 | 5.20 | 8.9x | 0.0 |
| s15-noS1cap | 95.9 | 95.4 | 95.0 | 0.44 | 0.39 | 5.19 | 8.9x | 0.0 |
| s15-noS3 | 95.6 | 94.9 | 94.5 | 0.45 | 0.41 | 5.22 | 8.6x | 0.0 |
| s15-noS4 | 92.1 | 81.6 | 90.7 | 0.54 | 0.40 | 5.35 | 6.0x | 0.0 |
| s15-noS5 | 95.4 | 94.7 | 94.4 | 0.94 | 1.49 | 5.59 | 7.4x | 0.0 |
| rec | 95.9 | 95.4 | 95.0 | 0.44 | 0.39 | 5.19 | 8.9x | 0.0 |
| coverage | 95.9 | 95.5 | 95.1 | 1.22 | 1.72 | 5.78 | 8.0x | 0.0 |
| (ceiling: everyone holds) | 96.9 | 98.8 | 96.6 | 1.58 | 2.19 | 35.28 | 1.3x | 0.0 |

(024's observed share off by 17.5 points.)

#### friends, 50 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| hash | 78.1 | 46.7 | 76.7 | 1.09 | 0.47 | 5.93 | 2.4x | 3.2 |
| weighted | 93.0 | 82.1 | 92.3 | 0.70 | 0.81 | 5.41 | 5.1x | 9.4 |
| top | 97.9 | 99.9 | 97.9 | 0.70 | 1.02 | 5.15 | 9.5x | 18.5 |
| s15 | 97.7 | 99.0 | 97.7 | 0.32 | 0.35 | 5.06 | 9.3x | 17.9 |
| s15-noS1cap | 97.5 | 98.4 | 97.5 | 0.32 | 0.33 | 5.04 | 9.4x | 18.1 |
| s15-noS3 | 97.6 | 98.1 | 97.5 | 0.34 | 0.36 | 5.05 | 9.0x | 17.6 |
| s15-noS4 | 95.7 | 93.8 | 95.2 | 0.40 | 0.36 | 5.13 | 6.2x | 11.9 |
| s15-noS5 | 97.6 | 97.9 | 97.5 | 0.79 | 1.22 | 5.36 | 8.3x | 16.3 |
| rec | 97.5 | 98.4 | 97.5 | 0.32 | 0.33 | 5.04 | 9.4x | 18.1 |
| coverage | 97.3 | 97.9 | 97.2 | 1.00 | 1.30 | 5.45 | 8.2x | 14.6 |
| (ceiling: everyone holds) | 97.9 | 99.9 | 97.9 | 1.60 | 2.22 | 36.23 | 1.3x | 2.6 |

(024's observed share off by 17.2 points.)

#### global, 15 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| hash | 76.4 | 56.7 | 68.1 | 0.98 | 0.58 | 8.42 | 1.4x | 0.0 |
| weighted | 78.1 | 61.3 | 70.0 | 0.92 | 0.72 | 8.38 | 1.4x | 0.0 |
| top | 78.0 | 60.3 | 69.7 | 1.13 | 1.62 | 8.46 | 1.5x | 0.0 |
| s15 | 76.8 | 61.2 | 69.1 | 0.94 | 0.57 | 8.06 | 1.5x | 0.0 |
| s15-noS1cap | 77.3 | 61.0 | 69.5 | 0.90 | 0.57 | 8.24 | 1.5x | 0.0 |
| s15-noS3 | 76.4 | 58.5 | 69.0 | 0.99 | 0.60 | 8.04 | 1.5x | 0.0 |
| s15-noS4 | 76.4 | 59.1 | 68.5 | 0.89 | 0.57 | 8.02 | 1.5x | 0.0 |
| s15-noS5 | 77.4 | 61.3 | 69.6 | 0.98 | 1.18 | 8.27 | 1.5x | 0.0 |
| rec | 77.3 | 61.0 | 69.5 | 0.90 | 0.57 | 8.24 | 1.5x | 0.0 |
| coverage | 79.6 | 64.5 | 71.6 | 0.98 | 1.38 | 8.74 | 1.5x | 0.0 |
| (ceiling: everyone holds) | 85.3 | 75.1 | 77.1 | 0.39 | 0.44 | 11.61 | 1.2x | 0.0 |

(024's observed share off by 12.4 points.)

#### global, 15 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| hash | 96.1 | 85.2 | 95.5 | 0.58 | 0.53 | 6.66 | 2.1x | 13.3 |
| weighted | 99.0 | 97.5 | 98.8 | 0.56 | 0.73 | 6.39 | 2.4x | 15.0 |
| top | 99.4 | 99.0 | 99.4 | 0.76 | 1.57 | 6.72 | 2.4x | 14.7 |
| s15 | 99.4 | 98.8 | 99.3 | 0.37 | 0.45 | 6.09 | 2.6x | 16.2 |
| s15-noS1cap | 99.4 | 98.9 | 99.3 | 0.40 | 0.46 | 6.17 | 2.6x | 16.0 |
| s15-noS3 | 99.4 | 99.3 | 99.3 | 0.39 | 0.50 | 6.01 | 2.6x | 16.4 |
| s15-noS4 | 99.2 | 98.4 | 99.0 | 0.40 | 0.46 | 6.13 | 2.5x | 15.9 |
| s15-noS5 | 99.4 | 98.9 | 99.3 | 0.46 | 0.96 | 6.48 | 2.4x | 15.2 |
| rec | 99.4 | 98.9 | 99.3 | 0.40 | 0.46 | 6.17 | 2.6x | 16.0 |
| coverage | 99.4 | 98.8 | 99.3 | 0.56 | 0.78 | 6.46 | 2.4x | 15.3 |
| (ceiling: everyone holds) | 99.6 | 99.6 | 99.5 | 0.41 | 0.45 | 12.60 | 1.3x | 7.9 |

(024's observed share off by 11.6 points.)

#### global, 50 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| hash | 88.1 | 65.9 | 85.0 | 1.32 | 0.54 | 8.40 | 2.4x | 0.0 |
| weighted | 95.4 | 88.9 | 94.0 | 1.01 | 0.91 | 7.33 | 4.6x | 0.0 |
| top | 99.0 | 98.5 | 98.7 | 1.30 | 2.12 | 8.18 | 6.0x | 0.0 |
| s15 | 97.8 | 96.0 | 97.2 | 0.59 | 0.45 | 6.11 | 7.8x | 0.0 |
| s15-noS1cap | 98.1 | 96.3 | 97.5 | 0.61 | 0.47 | 6.34 | 7.6x | 0.0 |
| s15-noS3 | 97.7 | 95.8 | 97.1 | 0.61 | 0.48 | 6.25 | 7.7x | 0.0 |
| s15-noS4 | 96.2 | 91.9 | 95.2 | 0.72 | 0.46 | 6.53 | 6.2x | 0.0 |
| s15-noS5 | 97.9 | 95.2 | 97.2 | 0.93 | 1.37 | 6.74 | 6.7x | 0.0 |
| rec | 98.1 | 96.3 | 97.5 | 0.61 | 0.47 | 6.34 | 7.6x | 0.0 |
| coverage | 98.9 | 97.9 | 98.6 | 1.65 | 2.40 | 8.90 | 5.3x | 0.0 |
| (ceiling: everyone holds) | 99.6 | 99.9 | 99.6 | 1.27 | 1.47 | 39.87 | 1.2x | 0.0 |

(024's observed share off by 12.4 points.)

#### global, 50 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| hash | 90.5 | 69.4 | 88.2 | 1.07 | 0.53 | 7.74 | 2.3x | 3.9 |
| weighted | 97.5 | 94.1 | 96.9 | 0.67 | 0.82 | 6.39 | 5.2x | 9.7 |
| top | 99.6 | 99.9 | 99.6 | 1.00 | 1.52 | 6.61 | 7.6x | 15.0 |
| s15 | 99.4 | 99.6 | 99.4 | 0.32 | 0.35 | 5.48 | 9.0x | 17.7 |
| s15-noS1cap | 99.4 | 99.6 | 99.4 | 0.34 | 0.37 | 5.61 | 8.8x | 17.2 |
| s15-noS3 | 99.4 | 99.7 | 99.4 | 0.34 | 0.39 | 5.52 | 8.9x | 17.5 |
| s15-noS4 | 98.1 | 96.8 | 97.8 | 0.40 | 0.38 | 5.70 | 6.7x | 12.9 |
| s15-noS5 | 99.4 | 99.5 | 99.4 | 0.63 | 1.15 | 5.99 | 8.2x | 16.2 |
| rec | 99.4 | 99.6 | 99.4 | 0.34 | 0.37 | 5.61 | 8.8x | 17.2 |
| coverage | 99.2 | 98.8 | 99.1 | 0.72 | 0.91 | 6.16 | 7.4x | 14.5 |
| (ceiling: everyone holds) | 99.6 | 100.0 | 99.6 | 1.29 | 1.49 | 40.85 | 1.2x | 2.4 |

(024's observed share off by 12.2 points.)

#### phones, 15 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| hash | 50.8 | 48.5 | 46.0 | 3.70 | 0.32 | 6.44 | 1.4x | 0.0 |
| weighted | 50.4 | 48.0 | 45.7 | 3.84 | 0.64 | 6.38 | 1.6x | 0.0 |
| top | 51.2 | 49.2 | 46.8 | 4.91 | 3.94 | 6.91 | 1.9x | 0.0 |
| s15 | 50.4 | 48.1 | 45.7 | 3.65 | 0.21 | 6.36 | 1.7x | 0.0 |
| s15-noS1cap | 50.5 | 48.1 | 45.8 | 3.66 | 0.21 | 6.40 | 1.6x | 0.0 |
| s15-noS3 | 50.6 | 48.1 | 46.0 | 3.74 | 0.28 | 6.43 | 1.6x | 0.0 |
| s15-noS4 | 50.4 | 48.2 | 45.6 | 3.70 | 0.20 | 6.29 | 1.7x | 0.0 |
| s15-noS5 | 50.7 | 48.4 | 46.0 | 4.22 | 1.47 | 6.48 | 1.5x | 0.0 |
| rec | 50.5 | 48.1 | 45.8 | 3.66 | 0.21 | 6.40 | 1.6x | 0.0 |
| coverage | 51.8 | 50.0 | 47.4 | 5.74 | 5.38 | 6.96 | 1.8x | 0.0 |
| (ceiling: everyone holds) | 57.3 | 55.9 | 54.8 | 0.68 | 0.70 | 12.65 | 1.1x | 0.0 |

(024's observed share off by 9.6 points.)

#### phones, 15 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| hash | 74.6 | 52.6 | 72.4 | 2.48 | 0.31 | 5.72 | 1.5x | 8.6 |
| weighted | 95.0 | 80.3 | 94.7 | 0.87 | 0.59 | 5.12 | 2.8x | 17.3 |
| top | 99.1 | 99.0 | 99.1 | 2.61 | 3.75 | 5.63 | 2.7x | 17.0 |
| s15 | 99.2 | 99.1 | 99.2 | 0.25 | 0.20 | 5.00 | 3.1x | 19.1 |
| s15-noS1cap | 99.2 | 99.1 | 99.2 | 0.24 | 0.20 | 4.99 | 3.1x | 19.2 |
| s15-noS3 | 99.2 | 99.1 | 99.2 | 0.28 | 0.24 | 4.99 | 3.1x | 19.2 |
| s15-noS4 | 98.7 | 99.1 | 98.6 | 0.28 | 0.19 | 4.98 | 3.0x | 19.0 |
| s15-noS5 | 99.2 | 99.2 | 99.2 | 0.63 | 0.90 | 5.04 | 3.0x | 19.0 |
| rec | 99.2 | 99.1 | 99.2 | 0.24 | 0.20 | 4.99 | 3.1x | 19.2 |
| coverage | 99.1 | 99.0 | 99.1 | 1.75 | 1.88 | 5.32 | 2.9x | 18.1 |
| (ceiling: everyone holds) | 99.3 | 99.3 | 99.3 | 0.71 | 0.73 | 13.61 | 1.1x | 7.0 |

(024's observed share off by 9.0 points.)

#### phones, 50 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| hash | 51.3 | 48.5 | 46.6 | 4.09 | 0.41 | 7.03 | 1.8x | 0.0 |
| weighted | 51.4 | 48.7 | 46.6 | 4.10 | 0.72 | 6.93 | 1.7x | 0.0 |
| top | 53.7 | 51.0 | 50.1 | 6.47 | 6.98 | 9.36 | 4.6x | 0.0 |
| s15 | 51.4 | 48.7 | 46.6 | 4.04 | 0.27 | 6.93 | 2.6x | 0.0 |
| s15-noS1cap | 51.4 | 48.7 | 46.6 | 4.04 | 0.27 | 6.96 | 2.6x | 0.0 |
| s15-noS3 | 51.4 | 48.9 | 46.5 | 4.13 | 0.40 | 6.83 | 3.7x | 0.0 |
| s15-noS4 | 51.2 | 48.6 | 46.3 | 3.92 | 0.24 | 6.88 | 1.9x | 0.0 |
| s15-noS5 | 52.0 | 49.1 | 47.4 | 4.61 | 2.00 | 7.16 | 1.9x | 0.0 |
| rec | 51.4 | 48.7 | 46.6 | 4.04 | 0.27 | 6.96 | 2.6x | 0.0 |
| coverage | 55.2 | 52.6 | 52.1 | 8.43 | 10.32 | 10.36 | 4.0x | 0.0 |
| (ceiling: everyone holds) | 59.7 | 58.2 | 59.5 | 2.67 | 2.78 | 44.12 | 1.1x | 0.0 |

(024's observed share off by 9.3 points.)

#### phones, 50 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| hash | 59.5 | 48.9 | 55.7 | 3.59 | 0.41 | 6.63 | 1.8x | 2.7 |
| weighted | 78.5 | 51.4 | 76.7 | 2.21 | 0.67 | 5.73 | 5.0x | 9.7 |
| top | 99.6 | 99.7 | 99.6 | 4.12 | 6.46 | 7.11 | 7.0x | 13.6 |
| s15 | 99.6 | 99.7 | 99.6 | 0.22 | 0.23 | 4.95 | 9.8x | 19.3 |
| s15-noS1cap | 99.6 | 99.7 | 99.6 | 0.22 | 0.23 | 4.95 | 9.8x | 19.3 |
| s15-noS3 | 99.6 | 99.7 | 99.6 | 0.24 | 0.25 | 4.95 | 9.8x | 19.3 |
| s15-noS4 | 87.1 | 52.6 | 86.0 | 1.25 | 0.23 | 5.42 | 6.6x | 13.0 |
| s15-noS5 | 99.6 | 99.7 | 99.6 | 0.79 | 1.16 | 5.11 | 9.5x | 18.7 |
| rec | 99.6 | 99.7 | 99.6 | 0.22 | 0.23 | 4.95 | 9.8x | 19.3 |
| coverage | 99.6 | 99.7 | 99.6 | 1.23 | 1.28 | 5.24 | 9.3x | 18.3 |
| (ceiling: everyone holds) | 99.6 | 99.7 | 99.6 | 2.70 | 2.81 | 45.08 | 1.1x | 2.1 |

(024's observed share off by 9.1 points.)

Ablation: the `s15-no…` rows above are S1–S5 with one part off.

- **S4 is the part that matters** (phones + helper, 50 people: 87 % → 99.6 % with it; friends 50: 92 % → 96 %).
- **S5** halves uploads and cuts moves 2–4x, availability unchanged.
- **S1's cap and S3**: within 0.5 point either way. The cap uses 024's observed hours (both online / owner online),
  which is off by 9–18 points: it overrates holders on the owner's schedule (exactly the ones useless when the owner
  is off) and underrates complementary ones. S3 only matters for newcomers (the 10 % joining late: worst-10 % space
  slightly better with it).
- Weighted alone (S2) is not enough: an always-on device weighs 1 against 0.2 for an evening user, so among 50
  candidates it lands in a space's top 5 only sometimes (helper share 9 % vs 18 % with S4).

## RQ6 What others do

- **Holepunch / Keet blind peers**: operator-run always-on mirrors that store encrypted cores; clients pick 2 by XOR
  distance from a fixed list (above). The "certainty" comes from always-on servers, which is our helpers.
- **Tahoe-LAFS**: erasure coding, 3 of 10 shares by default, uploads need "servers of happiness" (enough *distinct*
  servers); repair is manual or scheduled (`tahoe deep-check --repair`), on servers mostly always on.
- **Storj**: Reed-Solomon 29 of 80 pieces (110 uploaded, the slowest cancelled), repair when pieces fall to a
  threshold (35 in the whitepaper, 52 per a 2020 forum post); nodes are paid and must stay online (audits, suspension).
- **IPFS pinning**: content stays only while someone pins it; pinning services and IPFS Cluster (a replication factor
  min/max over cluster peers) are the always-on helpers of IPFS.
- **Briar Mailbox**: a spare always-on Android phone holds a user's messages while their phone is offline: one
  helper per person, no replication.
- **Secure Scuttlebutt**: everyone replicates friends' feeds (and friends of friends); pubs/rooms are always-on peers
  that help reach others.
- **Papers**: Blake & Rodrigues (HotOS 2003): high availability + scalable storage + dynamic peers, pick two.
  Bhagwan, Savage & Voelker (IPTPS 2003): host availability is time-of-day dependent and correlated. Total Recall
  (NSDI 2004): predict availability, lazy repair. Carbonite (NSDI 2006): reintegrate returning copies, repair below a
  threshold. Rzadca, Datta & Buchegger (ICDCS 2010): availability-optimal placement is NP-hard; selfish peers pick
  similarly available peers and the weakest lose. My3 (Narendula, Papaioannou & Aberer, 2011–12): replicate a
  profile on trusted friends with overlapping online times. Weighted rendezvous: Thaler & Ravishankar (1998),
  Schindelhauer & Schomaker (SPAA 2005).

**Pattern**: every system with real availability has always-on nodes (servers, paid nodes, pubs, mailboxes,
helpers). Pure friend-to-friend designs (My3, FriendStore-like) get high availability only with long online times
or overlapping schedules. Our results say the same: a helper or a PC left on is the certainty; the pick's job is to
**find it and use it** (S4), and to stay quiet (S5).

## Recommended algorithm (D1)

1. **Number**: each holder's self-reported share (`hg/holder.online`, already written daily on 5-point moves), its
   **Wilson lower bound** over the hours since the picker first knew the holder (≤ 720) (S3), **rounded to 10-point
   steps**. **No S1 cap** (dropped: no gain, biased input). The 7-day replacement still uses what the device saw.
2. **Copy 1**: to the holder with the highest number across the member's circles (S4), ties by the 024 hash.
3. **Copies 2–5**: weighted rendezvous hashing (S2), weight = the number (floor 1 %), one device per person, the
   024 split across circles and top-up unchanged, unseen 7 days last.
4. **Stickiness** (S5): a current holder is kept unless its replacement is 2+ steps better.
5. **Extra copy**: same trigger as 024 (no copy online), but **kept** (not deleted when the regulars are back), up to
   5 extras per space; extras are the first dropped when a holder's share is full.
6. **Share-aware** (needed, not simulated): a holder whose share is full can't take copy 1 of everything; the
   record should carry free room (or the pick skips holders that refused/dropped), otherwise S4 concentrates
   everything on a 1 GB share.
7. Percentages only (S6): no hour maps shared; hour coverage isn't worth it.

Changes from S1–S6: S1's cap dropped; extra copy kept instead of deleted; share awareness added.

### Expected availability and cost (D4)

Summary, recommended pick: availability (owner offline) · full uploads per space per week · copies held per space.

| people | friends | friends + helper | global | global + helper | phones | phones + helper |
|---|---|---|---|---|---|---|
| 2 | 14.6 % · 0.00 · 0.80 | 99.0 % · 0.03 · 1.74 | 17.7 % · 0.00 · 1.00 | 99.6 % · 0.00 · 2.00 | 12.3 % · 0.00 · 0.80 | 98.4 % · 0.03 · 1.74 |
| 5 | 32.1 % · 0.02 · 3.39 | 99.2 % · 0.03 · 4.36 | 44.6 % · 0.00 · 3.52 | 99.7 % · 0.00 · 4.52 | 39.7 % · 0.14 · 3.55 | 99.6 % · 0.16 · 4.49 |
| 15 | 66.6 % · 0.40 · 6.74 | 97.9 % · 0.22 · 5.04 | 78.8 % · 0.46 · 8.67 | 99.4 % · 0.39 · 6.25 | 55.5 % · 0.37 · 9.60 | 99.2 % · 0.24 · 5.40 |
| 50 | 96.1 % · 0.40 · 5.48 | 97.7 % · 0.31 · 5.17 | 98.2 % · 0.48 · 6.69 | 99.4 % · 0.33 · 5.76 | 55.3 % · 0.41 · 9.56 | 99.6 % · 0.22 · 5.50 |

Detail, recommended pick vs 024 (`run.js --strategies rec,hash --extra lazy`; the `hash` row there uses kept extras too,
024 itself is in the main table). Availability = share of the owner's offline hours some copy is online.

#### friends, 2 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 14.6 | 11.7 | 11.0 | 0.00 | 0.03 | 0.80 | 0.8x | 0.0 |
| hash | 14.6 | 11.7 | 11.0 | 0.00 | 0.03 | 0.80 | 0.8x | 0.0 |
| (ceiling: everyone holds) | 14.6 | 11.7 | 11.0 | 0.00 | 0.03 | 0.80 | 0.8x | 0.0 |

(024's observed share off by 10.0 points.)

#### friends, 2 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 99.0 | 98.4 | 98.9 | 0.03 | 0.05 | 1.74 | 1.8x | 60.0 |
| hash | 99.0 | 98.4 | 98.9 | 0.03 | 0.05 | 1.74 | 1.8x | 60.0 |
| (ceiling: everyone holds) | 99.0 | 98.4 | 98.9 | 0.03 | 0.05 | 1.74 | 1.8x | 60.0 |

(024's observed share off by 5.3 points.)

#### friends, 5 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 32.1 | 22.8 | 29.3 | 0.02 | 0.05 | 3.39 | 1.2x | 0.0 |
| hash | 32.1 | 22.8 | 29.3 | 0.02 | 0.05 | 3.39 | 1.2x | 0.0 |
| (ceiling: everyone holds) | 32.1 | 22.8 | 29.3 | 0.02 | 0.05 | 3.39 | 1.2x | 0.0 |

(024's observed share off by 19.9 points.)

#### friends, 5 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 99.2 | 98.2 | 99.2 | 0.03 | 0.06 | 4.36 | 1.4x | 22.6 |
| hash | 99.2 | 98.2 | 99.2 | 0.03 | 0.06 | 4.36 | 1.4x | 22.6 |
| (ceiling: everyone holds) | 99.2 | 98.2 | 99.2 | 0.03 | 0.06 | 4.36 | 1.4x | 22.6 |

(024's observed share off by 16.2 points.)

#### friends, 15 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 66.6 | 59.4 | 63.7 | 0.40 | 0.27 | 6.74 | 1.9x | 0.0 |
| hash | 65.5 | 55.7 | 62.5 | 0.48 | 0.49 | 7.04 | 1.8x | 0.0 |
| (ceiling: everyone holds) | 69.3 | 62.6 | 66.9 | 0.43 | 0.62 | 10.97 | 1.2x | 0.0 |

(024's observed share off by 18.0 points.)

#### friends, 15 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 97.9 | 97.8 | 97.9 | 0.22 | 0.25 | 5.04 | 3.0x | 18.8 |
| hash | 94.7 | 78.0 | 94.5 | 0.37 | 0.45 | 5.82 | 2.3x | 14.6 |
| (ceiling: everyone holds) | 98.0 | 97.9 | 97.9 | 0.46 | 0.65 | 11.92 | 1.3x | 8.1 |

(024's observed share off by 16.8 points.)

#### friends, 50 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 96.1 | 95.8 | 95.3 | 0.40 | 0.39 | 5.48 | 8.4x | 0.0 |
| hash | 81.3 | 49.6 | 79.6 | 0.45 | 0.49 | 6.88 | 2.9x | 0.0 |
| (ceiling: everyone holds) | 96.9 | 98.8 | 96.6 | 1.58 | 2.19 | 35.28 | 1.3x | 0.0 |

(024's observed share off by 17.5 points.)

#### friends, 50 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 97.7 | 98.7 | 97.7 | 0.31 | 0.33 | 5.17 | 9.1x | 17.7 |
| hash | 87.4 | 53.1 | 86.3 | 0.40 | 0.47 | 6.46 | 2.7x | 4.8 |
| (ceiling: everyone holds) | 97.9 | 99.9 | 97.9 | 1.60 | 2.22 | 36.23 | 1.3x | 2.6 |

(024's observed share off by 17.2 points.)

#### global, 2 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 17.7 | 12.8 | 11.0 | 0.00 | 0.00 | 1.00 | 1.0x | 0.0 |
| hash | 17.7 | 12.8 | 11.0 | 0.00 | 0.00 | 1.00 | 1.0x | 0.0 |
| (ceiling: everyone holds) | 17.7 | 12.8 | 11.0 | 0.00 | 0.00 | 1.00 | 1.0x | 0.0 |

(024's observed share off by 4.5 points.)

#### global, 2 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 99.6 | 99.6 | 99.4 | 0.00 | 0.00 | 2.00 | 1.5x | 50.0 |
| hash | 99.6 | 99.6 | 99.4 | 0.00 | 0.00 | 2.00 | 1.5x | 50.0 |
| (ceiling: everyone holds) | 99.6 | 99.6 | 99.4 | 0.00 | 0.00 | 2.00 | 1.5x | 50.0 |

(024's observed share off by 2.6 points.)

#### global, 5 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 44.6 | 29.6 | 30.7 | 0.00 | 0.00 | 3.52 | 1.1x | 0.0 |
| hash | 44.6 | 29.6 | 30.7 | 0.00 | 0.00 | 3.52 | 1.1x | 0.0 |
| (ceiling: everyone holds) | 44.6 | 29.6 | 30.7 | 0.00 | 0.00 | 3.52 | 1.1x | 0.0 |

(024's observed share off by 9.9 points.)

#### global, 5 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 99.7 | 99.4 | 99.6 | 0.00 | 0.00 | 4.52 | 1.3x | 22.2 |
| hash | 99.7 | 99.4 | 99.6 | 0.00 | 0.00 | 4.52 | 1.3x | 22.2 |
| (ceiling: everyone holds) | 99.7 | 99.4 | 99.6 | 0.00 | 0.00 | 4.52 | 1.3x | 22.2 |

(024's observed share off by 8.1 points.)

#### global, 15 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 78.8 | 64.3 | 70.9 | 0.46 | 0.57 | 8.67 | 1.5x | 0.0 |
| hash | 78.4 | 63.6 | 69.9 | 0.48 | 0.58 | 8.74 | 1.4x | 0.0 |
| (ceiling: everyone holds) | 85.3 | 75.1 | 77.1 | 0.39 | 0.44 | 11.61 | 1.2x | 0.0 |

(024's observed share off by 12.4 points.)

#### global, 15 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 99.4 | 98.9 | 99.3 | 0.39 | 0.46 | 6.25 | 2.5x | 15.8 |
| hash | 98.7 | 98.6 | 98.6 | 0.41 | 0.53 | 6.68 | 2.4x | 14.7 |
| (ceiling: everyone holds) | 99.6 | 99.6 | 99.5 | 0.41 | 0.45 | 12.60 | 1.3x | 7.9 |

(024's observed share off by 11.6 points.)

#### global, 50 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 98.2 | 96.4 | 97.6 | 0.48 | 0.47 | 6.69 | 7.2x | 0.0 |
| hash | 91.2 | 76.1 | 88.4 | 0.52 | 0.54 | 8.51 | 2.9x | 0.0 |
| (ceiling: everyone holds) | 99.6 | 99.9 | 99.6 | 1.27 | 1.47 | 39.87 | 1.2x | 0.0 |

(024's observed share off by 12.4 points.)

#### global, 50 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 99.4 | 99.6 | 99.4 | 0.33 | 0.37 | 5.76 | 8.5x | 16.7 |
| hash | 93.6 | 79.0 | 91.8 | 0.47 | 0.53 | 7.85 | 2.7x | 5.0 |
| (ceiling: everyone holds) | 99.6 | 100.0 | 99.6 | 1.29 | 1.49 | 40.85 | 1.2x | 2.4 |

(024's observed share off by 12.2 points.)

#### phones, 2 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 12.3 | 12.1 | 8.3 | 0.00 | 0.03 | 0.80 | 0.8x | 0.0 |
| hash | 12.3 | 12.1 | 8.3 | 0.00 | 0.03 | 0.80 | 0.8x | 0.0 |
| (ceiling: everyone holds) | 12.3 | 12.1 | 8.3 | 0.00 | 0.03 | 0.80 | 0.8x | 0.0 |

(024's observed share off by 9.9 points.)

#### phones, 2 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 98.4 | 98.1 | 98.4 | 0.03 | 0.05 | 1.74 | 1.8x | 60.0 |
| hash | 98.4 | 98.1 | 98.4 | 0.03 | 0.05 | 1.74 | 1.8x | 60.0 |
| (ceiling: everyone holds) | 98.4 | 98.1 | 98.4 | 0.03 | 0.05 | 1.74 | 1.8x | 60.0 |

(024's observed share off by 5.4 points.)

#### phones, 5 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 39.7 | 37.4 | 31.1 | 0.14 | 0.15 | 3.55 | 1.1x | 0.0 |
| hash | 39.7 | 37.4 | 31.1 | 0.14 | 0.15 | 3.55 | 1.1x | 0.0 |
| (ceiling: everyone holds) | 39.7 | 37.4 | 31.1 | 0.14 | 0.15 | 3.55 | 1.1x | 0.0 |

(024's observed share off by 9.0 points.)

#### phones, 5 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 99.6 | 99.3 | 99.4 | 0.16 | 0.17 | 4.49 | 1.3x | 21.3 |
| hash | 99.6 | 99.3 | 99.4 | 0.16 | 0.17 | 4.49 | 1.3x | 21.3 |
| (ceiling: everyone holds) | 99.6 | 99.3 | 99.4 | 0.16 | 0.17 | 4.49 | 1.3x | 21.3 |

(024's observed share off by 7.5 points.)

#### phones, 15 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 55.5 | 53.7 | 51.7 | 0.37 | 0.21 | 9.60 | 1.4x | 0.0 |
| hash | 55.2 | 53.3 | 51.5 | 0.47 | 0.32 | 9.57 | 1.3x | 0.0 |
| (ceiling: everyone holds) | 57.3 | 55.9 | 54.8 | 0.68 | 0.70 | 12.65 | 1.1x | 0.0 |

(024's observed share off by 9.6 points.)

#### phones, 15 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 99.2 | 99.2 | 99.2 | 0.24 | 0.20 | 5.40 | 2.8x | 17.8 |
| hash | 96.8 | 85.7 | 96.4 | 0.38 | 0.31 | 6.60 | 2.2x | 14.0 |
| (ceiling: everyone holds) | 99.3 | 99.3 | 99.3 | 0.71 | 0.73 | 13.61 | 1.1x | 7.0 |

(024's observed share off by 9.0 points.)

#### phones, 50 people (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 55.3 | 53.0 | 51.1 | 0.41 | 0.27 | 9.56 | 2.5x | 0.0 |
| hash | 55.4 | 52.6 | 51.3 | 0.54 | 0.41 | 9.71 | 1.7x | 0.0 |
| (ceiling: everyone holds) | 59.7 | 58.2 | 59.5 | 2.67 | 2.78 | 44.12 | 1.1x | 0.0 |

(024's observed share off by 9.3 points.)

#### phones, 50 people + helper (5 seeds, 4 weeks measured)

| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |
|---|---|---|---|---|---|---|---|---|
| rec | 99.6 | 99.7 | 99.6 | 0.22 | 0.23 | 5.50 | 8.9x | 17.4 |
| hash | 72.4 | 53.6 | 69.8 | 0.50 | 0.41 | 8.56 | 2.3x | 4.5 |
| (ceiling: everyone holds) | 99.6 | 99.7 | 99.6 | 2.70 | 2.81 | 45.08 | 1.1x | 2.1 |

(024's observed share off by 9.1 points.)

Read as: with a helper, **97.7–99.7 %** at every size, ~0.2–0.4 uploads per space per week (40–80 MB/week for a
200 MB space), 5–6.3 copies. Without one: 2 people 12–18 %, 5 people 32–45 %, 15 people 55–79 %, 50 people 55–98 %
(phones low, mixed circles high). The rest is set by people's schedules, not by the pick. Circles of 2 and 5 can't
be helped by any pick: with 5 copies everyone already holds everything.

## What this research couldn't check

- No real data: all patterns are made up (D3 collects them: 30 days needed).
- One circle, one device and one space per person; no share limits; uploads counted as full copies only.
- Self-reports assumed honest (a member claiming 100 % would get copy 1 of everything; members are trusted).
- 4 measured weeks: long-term departures (months) and the 7-day rule's long-run value aren't measured.
- Holders sync with each other instantly when both online; real hand-offs take seconds to minutes (024: ≤ 30 s
  fetch rounds) — matters for phones' short bursts.

## Sources

- Blake & Rodrigues, "High Availability, Scalable Storage, Dynamic Peer Networks: Pick Two", HotOS IX, 2003 —
  https://www.usenix.org/conference/hotos-ix/high-availability-scalable-storage-dynamic-peer-networks-pick-two
- Bhagwan, Tati, Cheng, Savage & Voelker, "Total Recall: System Support for Automated Availability Management",
  NSDI 2004 — https://usenix.org/conference/nsdi-04/total-recall-system-support-automated-availability-management
- Chun, Dabek, Haeberlen, Sit, Weatherspoon, Kaashoek, Kubiatowicz & Morris, "Efficient Replica Maintenance for
  Distributed Storage Systems" (Carbonite), NSDI 2006 — https://pdos.csail.mit.edu/papers/carbonite%3Ansdi06/paper.pdf
- Bhagwan, Savage & Voelker, "Understanding Availability", IPTPS 2003.
- Rzadca, Datta & Buchegger, "Replica Placement in P2P Storage: Complexity and Game Theoretic Analyses", ICDCS 2010 —
  https://dblp.org/rec/conf/icdcs/RzadcaDB10.html
- Narendula, Papaioannou & Aberer, My3 (HotPost 2012 study; SocialCom 2012) —
  https://infoscience.epfl.ch/record/175811/files/hotpost.pdf
- Schindelhauer & Schomaker, "Weighted Distributed Hash Tables", SPAA 2005 —
  https://forum.cone.informatik.uni-freiburg.de/pubs/WDHT.pdf ; Thaler & Ravishankar, rendezvous (HRW) hashing, 1998.
- Storj v3 whitepaper — https://static.storj.io/storjv3.pdf ; repair docs — https://storj.dev/learn/concepts/file-repair ;
  thresholds — https://forum.storj.io/t/future-changes-to-reed-solomon-numbers/9921
- Tahoe-LAFS servers of happiness — https://tahoe-lafs.org/trac/tahoe-lafs/ticket/1092
- Briar Mailbox — https://briarproject.org/news/2023-briar-mailbox-released/
- blind-peer, blind-peering, blind-peer-router — https://github.com/holepunchto/blind-peer ,
  https://github.com/holepunchto/blind-peering , https://github.com/holepunchto/blind-peer-router (npm 3.18.3,
  2.14.0, 0.2.4 read 2026-11-17)
