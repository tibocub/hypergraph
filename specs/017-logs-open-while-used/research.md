# Research: Logs open only while used

## R0 The two assumptions, checked first (2026-11-06)

- **Closed cores are served** (`test/next/unit/closed-serve.js`): yes, closed before or after the peer connected,
  and after the author grew it. Found: closing a session frees the core only when it's idle: hypercore keeps a
  peer's channel while either side downloads (an active session, a live range) and closes it 20–40 s after both
  stopped (`NOT_DOWNLOADING_SLACK`); corestore then closes the core ~8 s later. So a log closed here stays in
  memory while a peer still downloads it, which is right (it is serving).
- **Helper hand-off then close** (`test/next/net/handoff.js`, real blind peer): `await peering.addCore(core)`
  resolves once the helper's connection is up, and the request was then written (`info.flushed === peer.connects`
  on every blind peer it goes to: our `sent()` check). Closing right after: the helper still mirrors all blocks,
  the core is freed here while the helper stays connected, and a second `addCore` after growth sends the new length.
  While a helper is down `addCore` never resolves: the hand-off is bounded (R6).

## R1 Entries without cores

Decision: `log.core` is null while closed. `directory.open(log)` (counted uses, one open at a time per log),
`release(log)` (close `IDLE_MS` = 30 s after the last), `use(log, fn)`, `get(log, seq, opts)`, `has(log, ...)`.
`log.length`/`log.byteLength` are cached: set at open and on `append`/`download`/`truncate` while open, saved in
the log's counters on close and on space close. Alternatives: a proxy object standing in for the core (hides when
I/O happens: rejected); keeping `log.core` and closing only Corestore's core (impossible: sessions hold it).

## R2 Lengths in the summary and the ranges

Decision: an entry's item is `hash(key ‖ uint(length))`, `length` = `min(log.length, log.limit)` (what counts for
readers). `ranges.Keys` keeps the length per key and the XOR of items per sub-range and in total; the directory
summary digest is that total. `keys` messages carry `lengths` next to `keys`. "Lack" means: no entry with that key,
or a shorter one. Cost stays per difference (SC-004). Alternative: hashing only keys and sending lengths in
activity entries (rejected by Tibo, spec Decisions 1).

## R3 When a closed log counts as heard

Decision: per channel, `ch.settledOn` = the peer's summary digest at which this member last agreed with it (equal
digests, or an exchange about that summary that finished and whose logs were all looked at). The directory is
settled when every open channel's latest summary digest equals its `settledOn`. A closed log is unheard (1)
while the directory isn't settled; plus any claim beyond its length. Open logs keep today's rule (hypercore peers'
lengths) plus claims. Our own digest changing doesn't unsettle: gaining blocks never makes us lack what an unchanged
peer has. No channel: settled (today's rule for a member alone or offline: `known` and the lone-member rule apply).

## R4 Claims

A settled exchange's entries longer than ours are claims: `log.claim = max(claim, length)`, the log is opened and
downloaded while `log.length < min(claim, limit)`. A claim not met within `CLAIM_MS` (60 s) of opening is dropped
and the status warns `UNSERVED_LENGTH` with the peer and log (spec edge case), so a lie can't keep a reader
incomplete for ever.

## R5 Reads

Every block read is `directory.get/has/use`. The indexer's run of one log holds a use for the run. Budget passes
use cached sizes; cutting (clearBlocks) opens the log for the cut.

## R6 Helpers

`hold(log)`: open, `addCore` bounded by `HAND_MS` (10 s), check `sent()`, release. Not sent: kept in a list tried
again every minute and when the helpers list changes. A log's length at the last hand-off is kept on the entry;
after a download the replicator hands it again when its length grew. Start: logs handed one at a time in the
background.

## R7 Opening a space

Rows only: the cached length/size/admitted from the counters; own and identity logs open. A row without cached
values (data from before 017) opens its core once to read them.

## R8 Not closing: readers by activity

A newcomer to a big space that reads by activity lists (story 9) doesn't run range exchanges, so R3 has nothing to
settle with: its logs stay open as today (it holds only the logs of the periods it read). Recorded in tasks.md
"Built differently".
