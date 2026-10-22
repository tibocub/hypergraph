# Hypercore: after a peer clears a block, others can't fetch the blocks after it

2026-10-15, branch `deps-and-upstream`. **Nothing posted**: Tibo decides. Versions: hypercore 11.37.2 (latest on npm and
on `main`, which has only `count()` added since), Node 26.4, Windows 10.

## Verdict

**Theirs.** Reproduced with plain Hypercore, no hypergraph code. Still there on the latest version. Our workaround
(`clearBlocks()` in `lib/replication.js`, which calls `core.replicator.onhave`) stays until Hypercore ships a fix.
Nothing similar on their tracker.

## What happens

Peer A holds blocks 0..9; peer B is connected to A. A clears block 5 (`a.clear(5, 6)`). A still has blocks 6..9, but B
now believes A only has 0..4. Whether B can still fetch block 7 from A depends on history:

- if B never sent A a "want" message, B's `get(7)` sends one now, A answers with its bitfield, and B gets block 7
  (this is what the lead's script `hypercore-clear-repro.js` showed: "nothing stalls");
- if B had **already** sent A a want, for any block in the first 2,097,152 blocks (for example a `get()` of a block
  A didn't have yet), B never asks again, and `get(7)` waits forever (or times out). A stall.

Reproduction, plain Hypercore only: [`hypercore-clear-stall.js`](hypercore-clear-stall.js)

```
node specs/research/upstream/hypercore-clear-stall.js plain    # B.get(7): block 7
node specs/research/upstream/hypercore-clear-stall.js wanted   # B.get(7): REQUEST_TIMEOUT
```

## Exact cause (hypercore 11.37.2, `lib/replicator.js`)

Logged from an instrumented copy (B's side, `wanted` mode):

```
[B] onrange drop=false start=0 length=10   -> contiguous length 10; remoteBitfield bit 7: false
[B] _requestBlock(12): remote has it? false
[B] _maybeWant(12): want sent                       (A answers "range 0..10" again)
[B] onrange drop=true start=5 length=1     -> contiguous length 5; remoteBitfield bit 7: false
[B] _requestBlock(7): remote has it? false
[B] _maybeWant(7): batch already wanted before: nothing sent
```

1. A peer tells others what it holds as a **contiguous length** when it can (`_onwant` and the sync answer with
   `range { start: 0, length: contig }`); the receiver records it in `_remoteContiguousLength` and sets **no** per-block
   bits (`onrange`, lines 1415–1424).
2. A clear is announced as `range { drop: true, start: k, length }`. `onrange` (lines 1411–1413) lowers
   `_remoteContiguousLength` to `k` without first turning the blocks between `k + length` and the old contiguous length
   into bits. So B forgets that A holds them: `_remoteHasBlock(i)` (line 1635) is false for every `i > k`.
3. To relearn, B relies on wants. `_requestBlock` (line 1650) calls `_maybeWant`, which calls `LocalWants.add`
   (`lib/wants.js`, `addBatch`): a want covers a batch of 2,097,152 blocks and is sent **once per batch per peer**: a
   batch wanted before, still active or kept in `free`, returns `null` and nothing is sent. A doesn't resend anything
   either (its blocks didn't change). So B is stuck until it reconnects.

## Suggested fix

In `onrange`, keep what the contiguous length said about the blocks after the dropped range:

```diff
     if (drop === true && start < this._remoteContiguousLength) {
+      // the blocks after the dropped range were only known through the
+      // contiguous length: keep them as bits before lowering it
+      const end = start + length
+      if (end < this._remoteContiguousLength) {
+        this.remoteBitfield.setRange(end, this._remoteContiguousLength, true)
+        this.missingBlocks.setRange(end, this._remoteContiguousLength, true)
+        this._clearLocalRange(end, this._remoteContiguousLength - end)
+      }
       this._remoteContiguousLength = start
     }
```

Tested on a clone of `holepunchto/hypercore` at v11.37.2: a new test in `test/clear.js` ("clear + replication, blocks
after a cleared one stay known after a want", the `wanted` scenario) fails before and passes after; the whole suite
passes with the patch (`test/all.js`: 421/421, was 420/420). With the patched copy, both our scripts get block 7, and
our `test/next/unit/clear-blocks.js` passes without our workaround.

## What we ruled out on our side

- The reproduction uses only Hypercore. With our re-announce disabled (`clearBlocks` returning after `core.clear`), all
  of `npm run test:next` passes except the unit test that checks the bookkeeping: none of our forum tests stalls today,
  also at the commit that introduced the workaround (story 2, `4cdb574`), and 5 runs in a row of every test touching
  clears (rules, moderation, cuts, wipes, budgets, policies, leave, readmitted, adversarial). The stall that story 2 saw
  depends on timing; our app does the triggering step all the time (any read of a record a peer doesn't hold yet sends
  a want), so the workaround stays.
- `test/next/unit/clear-blocks.js` now also tests the stall itself (a reader that already asked for a missing block
  still gets block 3 after block 1 is cleared): fails without the workaround, passes with it, Node and Bare.

## Related upstream

Searched issues and PRs, open and closed: nothing on this. Neighbours: #879 (merged, in 11.37.2: clear deleted tree
nodes of siblings left of the cleared range), #849 (open: emit `clear`), #758 (merged: smaller want batches, but
`COMPAT` keeps 2M-block batches), #403 (open: gossip `onhave(0, contig)`).

## Draft issue (holepunchto/hypercore)

> **After a peer clears a block, others that already sent it a want can't fetch the blocks after it**
>
> hypercore 11.37.2. A holds 0..9, B is connected. If B has sent A a want before (e.g. `b.get(12, { timeout: 300 })`
> while A's length is 10), then after `a.clear(5, 6)`, `b.get(7)` never resolves, though A still has block 7.
> `onrange({ drop: true, start: 5 })` lowers `_remoteContiguousLength` from 10 to 5 without setting bits for 6..9, so B
> forgets them; `_maybeWant(7)` sends nothing because the batch was already wanted (`LocalWants.addBatch`), and A
> sends nothing new. Without the earlier want, B's first `get(7)` sends one and recovers, which hides the bug.
> Repro (one file, hypercore only): [link]. Suggested fix: in `onrange`, before lowering the contiguous length, set
> `remoteBitfield`/`missingBlocks` for `[start + length, oldContiguousLength)` (diff above; with a test in
> `test/clear.js`, the suite passes, 421/421). Happy to open a PR.
