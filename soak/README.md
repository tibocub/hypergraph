# Soak run

A few scripted forum members on the real network for hours: they post, comment, vote, edit and
delete at random on a slow timer, go offline at random and come back, and each keeps a delivery
log. It replaces the week-long human trial (ROADMAP Now item 7): it catches replication bugs (a
record that never arrives, an edit or delete that never lands) and measures delays.

Members use the forum app's own helpers (`test/next/forum/forum.js`), through the public API only.
Member 0 creates the forum and makes it public (`openLink`, spec 016); the others join with its link.

## Run

```bash
npm run soak                                   # 4 members, 2 hours, public DHT, then 5 min settle
npm run soak -- --members 3 --hours 0.25       # shorter
npm run soak -- --local --hours 0.05 --gap 2,5 --offline 5,15 --settle 30   # quick check, local DHT
npm run soak -- --report <run dir>             # the report again, for an existing run
npm run soak:check                             # self-check: 3 members, local DHT, ~2 min, must lose nothing
```

Options: `--members` (2 to 6: keep the machine's load low), `--hours`, `--local` (a 3-node DHT on
127.0.0.1 instead of the public one), `--gap min,max` (seconds between a member's actions, default
20,60), `--offline min,max` (seconds offline, default 30,600), `--offline-chance` (chance, at each
action, to go offline instead; default 0.08), `--settle` (seconds with everyone online at the end,
default 300), `--dir` (where runs go; default `E:\Code\P2P\.tmp` when it exists, else the temp folder).

Going offline is one of two, at random: the member closes its Hypergraph and reopens it in the same
process, or its process exits and `run.js` starts it again on the same storage later.

Each run is a folder `soak-<time>/`: `m<i>/` (the member's storage), `m<i>.jsonl` (its delivery log),
`m<i>.err` (its stderr), `config.json`, `report.json`. Delete it when done.

## The report

```
member written  lost  stale     p50     p95      max  offline crashes errors  warnings
m0          15     0      0   0.00s   5.76s    7.74s        1       0      0   SINGLE_SETTLER
```

- **written**: records the member wrote (posts, comments, votes).
- **lost**: records (anyone's, not deleted) this member doesn't hold at the end, after the settle
  period. Should be 0.
- **stale**: records it holds in an old version: an edit or a delete that didn't arrive. Should be 0.
- **p50 / p95 / max**: delivery delay of others' records: when it first showed up here (a `change`
  event) minus when its author started the `put`. All members share one clock (one machine), so a
  record seen before it was written is a bug: it is not counted as a delay but shown in warnings as
  `SEEN_BEFORE_WRITTEN(n)`. A record written while this member was offline
  counts its whole wait, so the max is mostly offline time.
- **offline**: offline periods. **crashes**: the process died unexpectedly (see `m<i>.err`; run.js
  restarts it). **errors**: actions that failed (in the log as `{ ev: 'error' }`).
- **warnings**: `status()` warning codes seen. `SINGLE_SETTLER` is expected: the owner is the only
  member that settles decisions.

Exit code 1 if anything is lost or stale, or a member wrote no final snapshot.

Not measured: edit and delete delays (only that they arrived by the end: a record's `seen` lines
after its first one are not used), sub-forums, moderation, invites
beyond the public link, more than one device per member.
