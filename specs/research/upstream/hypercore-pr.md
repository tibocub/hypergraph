# Hypercore PR (draft, not posted)

Branch `fix-clear-remote-contiguous` in Tibo's local clone `E:\Code\P2P\hypercore`, commit `e33e633`, on top of
11.39.0 (`9c9cc3d`). Hypercore's suite with both fixes: 434/434 on Node and on Bare 1.35.0.

## Title

Fix two replicator bugs that stall reads after a clear or a timed-out get (fixes #891)

## Body

Fixes #891, plus a second bug that the regression test for #891 surfaced.

**1. `onrange` forgets blocks after a dropped range (#891).** When a peer lowers `_remoteContiguousLength` on a
`drop` message, the blocks after the dropped range were only known through the contiguous length, so the peer then
believes the remote lacks them. Fix as suggested in #891: keep `[end, oldContiguousLength)` as set bits in
`remoteBitfield` / `missingBlocks` before lowering it.

**2. A stale block-queue entry can swallow a peer's update.** When a `get()` times out, its block is unref'd
(`queued = false`) but stays in `_queued`. In `_updatePeer`, a stale entry was dequeued and the method returned `true`
as if it had sent a request. With one peer, `updateAll` calls `_updatePeer` once (`tried >= limit`), so if the
`RandomIterator` picks the stale entry first, a live request is left unsent and nothing triggers another round: the
read times out although the peer has the block. Stale entries are now skipped and the loop continues.

This one doesn't need `clear()`: in 11.39.0, a timed-out `get()` of a block that doesn't exist yet makes the next
`get()` of an existing block fail about half the time.

**Tests**

- `test/clear.js`, "clear + replication, peer still requests blocks after the cleared range": fails every time without
  fix 1, about half the time without fix 2.
- `test/replicate.js`, "a timed out get does not swallow the next block request" (no clear): fails about half the time
  without fix 2.

Full suite passes on Node (434/434) and on Bare 1.35 (434/434). Found while building on Hypercore + Hyperswarm; standalone repro (plain Hypercore) with
expected output available if useful.
