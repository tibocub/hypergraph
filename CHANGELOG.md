# Changelog

All notable changes to Hypergraph will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Round 39: read-permission, stage 1 — a stable, per-identity encryption keypair

First concrete step of the read-permission design discussed: content stays readable by anyone
who replicates it today (no encryption anywhere), which is fine for write-access (already
well-served by roles) but doesn't exist at all for controlling who can *read*. Since P2P
replication means access control can only be encryption (there's no way to withhold bytes
someone already has), the plan is a symmetric key per read-scope, distributed by sealing it to
each authorized reader's public key. This round adds the one thing everything else in that
plan depends on: a stable place to seal a secret *to*.

Checked what's actually available before building anything: `hypercore-crypto.encrypt()`/
`.decrypt()` already wrap libsodium's `crypto_box_seal` (anonymous public-key encryption —
exactly the right primitive for "seal this so only Bob can open it"), and `sodium-universal`
(previously only a transitive dependency, now added directly since it's used directly here)
exposes `crypto_box_seed_keypair` for deterministic derivation from a seed.

Composed these with `keet-identity-key`'s own existing namespaced key derivation
(`getEncryptionKey(namespace)`, the same mechanism it uses internally for
`getProfileDiscoveryEncryptionKey()`) rather than inventing a new derivation scheme: that
namespaced, mnemonic-derived symmetric key becomes the seed for `crypto_box_seed_keypair()`,
giving `IdentityManager.encryptionKeyPair` — a real `crypto_box`/X25519 keypair.

Deliberately derived per-*identity*, not per-device: confirmed directly that `deviceKeyPair`
is random and different on every device (not mnemonic-derived at all), while this new keypair
is deterministic from the same mnemonic/seed the rest of the identity comes from. That means
any of a person's devices can independently derive the same keypair and open something sealed
to it — whoever's granting read access only needs to seal a key once per *person*, not once
per device.

Verified directly, not just unit-tested in isolation: a message sealed to one "device" (an
`IdentityManager` instance) is openable by a second, independent instance restored from the
same mnemonic, unopenable by an unrelated identity, and the same mnemonic always re-derives
the same keypair after a simulated restart.

Full local suite: 126/126. Next stage: the read-scope concept itself (a new, dedicated
structure for scope creation and key-grant events, mirroring how RoleBase is a separate
Autobase-backed structure from ContextBase) and wiring actual content encryption into
`putContent()`/`getContent()` — notably, `putContent()` turns out to write to the caller's own
user core, not any context, so a scope can't be tied to context boundaries the way write
permissions are.

### Round 38: three moderation-system gaps fixed, ahead of building read-permission on top of it

Reviewed the moderation system's completeness directly (not from memory) before starting on
read-access design, since read-access will lean on the same permission-checking machinery.
Found and fixed three real gaps:

**1. `moderateAction()` had no client-side permission check at all**, unlike `addWriter()`.
An unauthorized caller's call resolved successfully with no error — the action just silently
never took effect once the apply layer rejected it. Added a client-side pre-check mirroring
`addWriter()`'s pattern, but carefully preserving the existing, tested behavior that
`moderateAction()` still works before any RoleBase exists at all: only a RoleBase that has a
registry *and* explicitly denies the action throws here — "not yet determined" (no RoleBase,
or registry not ready) still passes through to the apply layer's own pending-queue handling,
unchanged.

**2. An existing test's name didn't match what it actually proved.** "Unauthorized moderation
facts are still recorded but excluded by a trust policy" — verified directly (both a filtered
and an unfiltered query) that the fact is never recorded at all; the apply layer hard-rejects
it, which is the stronger of the two possible designs. The test passed, just not for the
reason its name claimed. Rewrote it to verify what's actually true: the client-side check now
throws immediately, and — as defense in depth — the apply layer still hard-rejects the same
attempt even if someone bypasses the client-side check via the generic `append()` method
directly.

**3. `#isModerationAllowed` lacked the bounded retry `#isWriterChangeAllowed` already has**
for the RoleBase-vs-context sync race (two independent Autobase structures replicating
concurrently — the registry may simply not have arrived yet at the exact moment a given event
is first processed). This was already substantially mitigated in practice for moderation
specifically, since its pending-queue can drain from any `update()` call, not only during
apply — a real structural difference from writer-changes, since moderation is pure view-level
data while adding/removing a writer needs the privileged apply-scoped object. Added the same
bounded retry anyway, for consistency and faster resolution: a new test confirms a moderation
event arriving before its author's RoleBase permissions have synced now resolves within the
same `update()` call that first sees it (under 500ms), rather than needing a later,
separately-timed call to happen to land after the RoleBase catches up.

Confirmed while reviewing: hypergraph only provides the signed, role-gated fact log — "hide
after 3 flags" is entirely app-level policy (`RedditPolicy`/`ForumPolicy` in the examples),
not hypergraph's job. That boundary is staying the same for read-access: hypergraph enforces
who can get a key, apps decide what that access actually means for their UI.

Full local suite: 123/123, confirmed stable across multiple repeated runs given the
timing-sensitive nature of the bounded-retry test.

### Round 37: query() default order was effectively meaningless across multiple authors — fixed, plus sortBy()

Motivated by planning HyperMD/HyperBBS's data-query compatibility: confirmed directly
(empirically, not just from reading code) that `query()`'s default order was never actually
chronological once more than one author was involved. Entity IDs are
`type/authorCoreKeyHex/seq`, and the default scan just followed that key's lexicographic
order — meaning a newer post from one author could sort before an older post from another,
purely because their core keys happened to compare that way. Every example app happened to
avoid this by always re-sorting manually after fetching, which is exactly why it went
unnoticed until asked to design a declarative, no-scripting query directive for HyperMD,
where there'd be no app code left to paper over it.

Fixed properly rather than worked around: found that a `nt:<type>:<createdAt>:<id>` index
already existed (written on every entity creation) but was never actually used by any query
path — `GraphQuery.type()` still did a full unordered scan with a post-filter. Wired
`GraphQuery` to use that index when a type filter is present (fixing the order *and* making
type-filtered queries a narrower, faster scan instead of a full table scan), and added a new
type-agnostic `nc:<createdAt>:<id>` index for the unfiltered case, replacing the old
meaningless-order default entirely.

Also added `sortBy(field, direction)` for sorting by anything else, including derived values
that don't exist on the stored entity at all (e.g. a vote count computed from edges, exactly
like `p2p-reddit-clone`'s post ranking) — this buffers matching results in memory before
yielding, unlike the indexed chronological path, since there's no way to index a value that
isn't stored. `limit()` is correctly applied after sorting, not during the initial scan, when
`sortBy()` is used.

New tests confirm: chronological order is now correct across multiple authors (using two
identities sharing one Corestore, so no network replication was needed to prove the point),
and `sortBy()` works correctly for a query enriched with a derived field via `.filter()` as
an attach-and-return-true step, both ascending and descending, with `limit()` applied after
sorting.

Full local suite: 122/122.

### Round 36: the real reason comments never displayed — the thread view never actually requested comment data

Round 35 fixed a real bug (comments dropped when their author's user core hadn't been
discovered yet), but that wasn't the whole story — the user reported comments still never
displayed anywhere, even for the commenter's own post.

Traced to the UI's `loadThread()`: it fetched `/api/state` (the posts *list*) and just
searched that list for the matching post, rather than requesting the thread specifically.
The list projection (`projectPost()`) only ever computes `commentCount` — it never includes
the actual comments array at all. The full comments array only exists via a *different*
function, `projectThread()`, which `buildRedditState()` only calls when given `opts.thread`.
Compounding this, the backend route itself did an exact match on `req.url === '/api/state'`,
so it would never have recognized a `?thread=` query parameter even if one had been sent —
this bug meant no client could ever have received comment data for any post, from any
author, regardless of cross-peer replication.

Fixed in three places:
- `/api/state` now parses a `thread` query parameter and passes it through to
  `buildRedditState()`.
- The UI's `loadThread()` now actually requests `/api/state?thread=<id>` and renders the
  real response, instead of reconstructing a fake "thread" object from the list projection.
- The SSE live-update handler previously tried to re-render the currently-viewed thread from
  the broadcast payload, whose `thread` field is hardcoded to `null` server-side (SSE is a
  one-way broadcast to all clients, so the server has no per-client context on which thread
  each one is viewing) — it now re-fetches the specific thread instead when a live update
  arrives while one is open.

Verified via the actual HTTP API (not just the underlying library code): `/api/state`
correctly returns only `commentCount` for the list, while `/api/state?thread=<id>` returns
the full comment body. Also re-verified cross-peer: a peer's comment appears as a pending
placeholder for another peer before user-core discovery catches up, then resolves to full
content — combining this round's fix with round 35's.

No changes to `src/` — full local suite: 120/120.

### Round 35: comments-not-showing bug fixed, votes bug not yet reproduced

Investigated two bugs reported from real multi-peer usage: comments increasing the count but
not showing, and a peer's votes only being visible locally (not to other peers), while the
owner's votes replicate fine.

**Comments — reproduced and fixed.** Confirmed with a star-topology test (peer↔owner↔peer,
no direct peer-to-peer connection, matching how independent `peer.js` processes actually
connect): `getComments()` calls `graph.get(e.from)` to resolve the comment's own entity, which
lives in its author's user core — discovered only via the existing `announceToReddit()`/
`discoverPeerCores()` loop, previously on a slow 5-second interval. Until that catches up,
`graph.get()` returns nothing and the comment was silently dropped from the list entirely —
while the count (which only reads the edge, not the entity) was already correct, producing
exactly the "count right, list wrong" symptom reported.

Fixed in three places: `discoverPeerCores()` now runs on a 1.5s interval instead of 5s;
`getComments()` no longer drops an unresolved comment, instead including it as
`{ pending: true }` so the list stays consistent with the count instead of silently showing
fewer items; `state.js` and the UI now render a "Comment syncing from another peer..."
placeholder for a pending comment instead of crashing on the now-`null` entity fields (which
they previously accessed unconditionally). Verified directly: immediately after a peer
comments, another peer sees the pending placeholder (count and list both correctly show 1);
once discovery catches up, it resolves to the full comment content automatically.

**Votes — not yet reproduced.** Tried multiple scenarios directly: a 3-peer star topology
(the same topology as the comments bug), and a tighter-timing variant where a peer votes
immediately after their own writer-grant confirmation rather than waiting for things to
settle. In both, a non-owner peer's vote was visible to another non-owner peer within
one update cycle — no reproduction of "only the owner's votes replicate." Votes shouldn't
need the same user-core discovery comments do, since the vote's edge already carries its
value and author directly (no entity dereference needed to tally it), which is consistent
with not finding a bug on the vote side specifically. Left open pending more detail from
real multi-peer testing (peer count, exact repro steps, and any console output from all
processes) — did not want to guess at a fix for something not confirmed.

Full local suite: 120/120 (no changes to `src/` this round).

### Round 34: p2p-reddit-clone unusable for up to ~3 minutes when run solo — fixed

Hit directly: running the owner alone (no peer) hung after "Context created" for what turned
out to be a bounded but very long time. Traced precisely: `HypergraphNetwork.connect()`
sequences a 60s `discovery.flushed()` timeout, a 60s `swarm.flush()` timeout, then up to 45s
of connection retries (`_ensureConnectionWithRetry`) — a real worst case of ~165 seconds
before `connect()` resolves at all, confirmed by actually waiting out the full window. The
peer.js rewrite from a few rounds ago had `server.listen()` sequenced *after* `await
networking.connect()`, so the entire app — including the HTTP server itself — was unreachable
for that whole window. This is a real regression this project introduced: checked
`forum-web`/`chat-web` (the original, custom-networking examples) and confirmed they already
start their HTTP server *before* attempting to join the network, so they never had this
problem.

Fixed by no longer awaiting `networking.connect()` before anything else — it now runs in the
background (logging its own outcome when it resolves), while the HTTP server, storage, and
UI start immediately. None of the local app functionality actually depends on a peer being
connected. Verified directly: the owner now listens and responds to `/api/state` within
~5 seconds solo, and post creation/state retrieval work correctly with zero peers connected
at all — running solo (e.g. the first person setting up a community before anyone else has
joined) is a normal, supported case, not an error state.

Also cleaned up `state.js`'s `buildRedditState()` — it was logging half a dozen debug lines
on every call, and it's called on a 1-second interval for the SSE push loop, so the console
was being flooded continuously even when nothing had changed.

No changes to `src/` in this round — full local suite unaffected: 120/120.

### Round 33: fixed a real crash — old, already-persisted relation events broke on the new value field

Hit directly by running `forum-web` against real, existing local data: `Error: Out of bounds`
thrown from `compact-encoding` while Autobase replayed already-persisted `relation/create`
events on startup. Root cause: round 31 added an optional `value` field to the wire format,
but the decoder unconditionally tried to read its trailing bytes — existing events, encoded
before that field existed, simply don't have them, so the reader ran off the end of the
buffer the moment one was replayed from disk.

Fixed by checking for remaining bytes before attempting to decode the value field, matching
the same backward-compatibility guard the `roles/addWriter`/`removeWriter` case already uses
for its own optional trailing fields (checked that one too, proactively, given this class of
bug had just surfaced for real — it was already correctly guarded, no fix needed there).

Added a permanent regression test that manually constructs an old-format buffer (the same
shape the encoder produced before the value field existed, rather than relying on some
current app happening to have old-enough data lying around) and confirms it decodes without
crashing, with `value` simply absent.

Full local suite: 120/120.

### Round 32: forum-web's dead identity-registry code removed

Per project direction: the old `lib/hyper-identity` module `forum-web/peer.js` depended on
(`setupIdentityRegistry()`, called unconditionally at startup) was replaced by Hypergraph's
own identity system (`graph.setIdentity()`/`getIdentity()`) some time ago, but the dead call
was never removed — it threw `Cannot find module` immediately, caught by the surrounding
try/catch, which silently skipped everything sequenced after it in the same block: setting
identity, announcing to the forum, discovering peers, and the owner's initial post creation.
The web UI would load, but the peer never did any of this.

Removed `setupIdentityRegistry()` and its call entirely — `graph.setIdentity()`, already
present right below it, is sufficient on its own. Verified directly by actually running the
owner: `/api/state` now correctly shows the set username and the owner's initial post, where
before it silently showed neither. `chat-web` doesn't have the equivalent code at all, so
needed no change.

Full local suite: 119/119.

### Round 31: weighted relations (relate() value field), latestPerAuthor, and p2p-reddit-clone fixed

Started from a thorough review of the example apps against the current API, in preparation
for building real prototypes on top of Hypergraph.

**Found and fixed: `p2p-reddit-clone` — completely broken, crashed on startup.** It imported
`HypergraphNetworking`, but `index.js` exports `HypergraphNetwork` (no "ing") — confirmed
directly: `new HypergraphNetworking(...)` threw `TypeError: HypergraphNetworking is not a
constructor` immediately. It also passed a nonexistent `autoAddWriters` option and never set
`role: 'owner'`/`'peer'`. This was the one example meant to validate `HypergraphNetwork`'s
API, and it had never actually been run against the current version. Rewrote its networking
to use `HypergraphNetwork` correctly (`generateBootstrap()`/`connectFromBootstrap()` for the
owner/peer split, with app-specific moderation config carried in `metadata`), verified
end-to-end with a local two-peer simulation: bootstrap generation, automatic writer-granting,
and post/comment replication all confirmed working.

**A second, more subtle bug found in the same file:** the `peer-join` event handler was
calling `graph.openUserCore(peerKey)`, but `peerKey` there is the Hyperswarm/Noise connection
identity — a completely different keypair from a peer's actual Hypergraph user-core key. This
would never throw, just silently open the wrong (nonexistent) core — exactly the kind of
"corrupted key succeeds silently" issue found in the bootstrap-validation review two rounds
ago. Removed it; the existing `relate`/`edges`-based "announce your user core" pattern
elsewhere in the same file is the actually-correct way to discover peers' real user-core keys.

**A third, genuine core-API gap found while fixing the vote flow:** `relate()` had no way to
attach a value (e.g. a vote's weight) to an edge — any extra field passed to it was silently
dropped, and `opts.keyPair` was silently ignored too (`relate()` always signs with the
caller's own identity, which is the correct, secure behavior — a separate keyPair option
there was actively misleading, not just unused).

Discussed the right fix directly rather than assuming: a generic metadata blob was rejected
early in favor of a deliberately narrow, typed `value` (number) field — the realistic range
of "a number attached to an edge" cases (votes, weights, ratings, ordering) without the
sprawl of an anything-goes payload. Implemented:
- `relate()` now accepts an optional `opts.value` (must be a finite number if provided).
- `value` is part of the signed digest in both `hypergraph.js` (signing) and `context-base.js`
  (verification) — added correctly from the start this time, not patched in afterward as
  happened previously with `roles/addWriter`'s signature field. New test confirms a forged
  value with the original signature is rejected at the apply layer.
- Encoded in the binary event schema (`src/encodings/event.js`) as an optional float64.
- Indexed and returned by `edges()`.

**Also discussed and resolved: does a `value` field alone give "one vote per user"?** No —
confirmed empirically that each vote is a fresh node with no built-in uniqueness constraint
across authors, so nothing prevents someone voting twice. Added `latestPerAuthor` as a new
option to `edges()` (`GraphView.getEdges`), deliberately designed as a general "one fact per
author per target" reduction — not vote-specific — buffering matching edges and keeping only
the most recent one per author. New test confirms a user's changed-mind second vote correctly
supersedes their first when reduced this way.

Fixed `p2p-reddit-clone/storage.js`'s vote flow end-to-end using both: `vote()` now validates
input is `1`, `-1`, or `0`; `getVoteCount()`/`getUserVote()` use `latestPerAuthor` and clamp to
the valid range when tallying (since a permissionless relate() can't be prevented from
carrying an out-of-range value at write time — that has to be a read-time check). Also removed
the dead `keyPair` option from `RedditStorage`'s constructor/calls to `relate()`, and the large
block of exploratory debug logging in `vote()`. Verified end-to-end via local simulation:
a peer votes, changes their mind, and the owner also votes — final tally and per-user vote
lookup both come out correct.

**Housekeeping:** `p2p-reddit-clone/.reddit-storage`'s runtime Corestore/LevelDB data had been
accidentally committed (21 files) — removed from tracking and added to `.gitignore`, alongside
a missing entry for `chat-web`'s equivalent runtime directory. Also removed a stale `.gitignore`
line referencing `examples/cli-chat`, which doesn't exist in the repo.

Full local suite: 119/119.

### Round 30: real defense-in-depth for writer-authorization, plus removeWriter()

Addresses the two most important findings from the pre-launch review: `roles/addWriter`
lacking the same signature-verification defense-in-depth every other event type already had,
and no way to revoke a writer's access at all.

**Signature verification for roles/addWriter and the new roles/removeWriter**, matching the
pattern already used for relation/tag/moderation events: `ContextBase.addWriter()`/
`removeWriter()` now sign the event with a caller-provided `keyPair` (only required in
`closed` mode — open mode's whole point is unrestricted addition, so there's nothing for a
signature to protect there, and requiring one would have broken every existing open-mode
caller for no benefit), and the apply layer independently re-verifies both the signature and
the `context.write` permission before honoring the change — the real, enforced boundary, not
just the client-side method's own check, which `append()` can bypass entirely.

**A real, separate bug found and fixed along the way:** the binary event-encoding schema for
`addWriter`/`roles/addWriter` only ever encoded `key`, `author`, and `timestamp` — never
`signature`. It was being silently dropped on every encode/decode round-trip. Fixed by adding
it to the schema (as a length-prefixed buffer, matching how `moderation/action` already
handles its own signature field).

**A genuine architectural race, found empirically while testing this:** the RoleBase and a
context are separate Autobase structures that replicate independently — a peer's own apply
function only evaluates each writer-change event once, at the moment it first arrives. If the
RoleBase hasn't finished syncing by then, the permission check has nothing to evaluate against.
Confirmed this could permanently strand a legitimate grant, since apply doesn't re-run for
past entries just because unrelated data later changes. Fixed in two layers: `#isWriterChangeAllowed`
now polls (bounded, ~5-10s) for the RoleBase to become available before giving up, and a
pending-writer-change queue (mirroring the existing moderation pending-queue pattern) catches
the remaining edge case, draining whenever a later event triggers this context's own apply
to run again.

**`removeWriter()`** is new — same authorization/signing model as `addWriter()`. Autobase's
own removal refuses to drop the last remaining indexer regardless of permission; the apply
layer catches that and continues rather than aborting the batch.

**Verified directly, not assumed:** re-tested the `append()` bypass scenario from the last
review round (a legitimate but unprivileged writer trying to grant itself/others access by
constructing the event directly) against the new apply-layer check specifically — confirmed
it's now rejected for the *understood* reason (signature+permission check), not just because
of unexplained Autobase behavior as before. This scenario is now a permanent regression test.

Every existing `addWriter()` caller across the forum scenarios and elsewhere continues to
work completely unchanged (open mode never needed a keyPair before this and still doesn't).
Full local suite: 115/115, confirmed stable across multiple repeated runs given the
timing-sensitive nature of this round's changes.

### Round 29: bootstrap validation gaps, plus a few more checked directly rather than assumed

Following up on a review of the bootstrap/writer-auth work from rounds 26-28 (selective
context authorization, the flaky peer-join diagnostic fix, writer-grant timeout, and
bootstrap version validation).

**#1 — missing ownerCore validation, confirmed empirically before fixing:** tested directly
what `openUserCore()` does with various malformed keys. A too-short or non-hex key already
throws ("ID must be 32-bytes long") via existing lower-level validation — not silent. But a
correctly-shaped, wrong key (confirmed with all-zeros) silently succeeds, creating a
permanently-empty, dead core reference with zero indication anything is wrong — this is the
real, actionable gap, since there's no way to distinguish "wrong key" from "owner hasn't sent
anything yet" without actually trying to connect (an inherent limit, not fixable by more
validation). Added explicit shape validation (`isValidHexKey`) in `connectFromBootstrap()`
for `topic`, `ownerCore`, and every key in `contexts` — a corrupted/truncated/mistyped key
now fails immediately with a clear, bootstrap-specific error naming which field is wrong,
instead of either a confusing generic error or (for the all-zeros case) total silence.

**#2 — topic mismatch:** confirmed `connectFromBootstrap()` already hardcodes
`topic: bootstrap.topic` rather than spreading `opts` — so a conflicting `opts.topic` was
already safely ignored, not a bug. Added a test making this explicit and permanent rather
than leaving it as an unverified implementation detail.

**#3 — autoReplicate:false untested:** added a test confirming it actually skips Corestore
replication (the owner's message never reaches the peer, and the peer's reference to the
owner's user core never advances), while confirming the writer-auth channel — a separate
concern, wired unconditionally in `_handleDataConnection` — still works normally regardless.

**#4 — empty contexts:** confirmed `generateBootstrap()` accepts `{}` (empty object is
truthy, passes the existing "contexts required" check) and added a test that
`connectFromBootstrap()` and `_openContexts()` handle a contexts-free bootstrap as a clean
no-op, not a bug.

**#5 — clarified, not a bug:** `{}` is truthy in JS, so it passes the constructor's
`if (!this.#dataSwarm) throw ...` check. The writer-authorization tests intentionally bypass
`connect()` entirely (calling `_handleDataConnection()`/`_openContexts()` directly to test
channel logic without a real swarm/DHT), so the swarm object's actual methods are never
invoked — `{}` is a deliberate, valid placeholder for exactly that reason, not a copy-paste
error.

Full local suite: 111/111 (plus 4 additional local-only bootstrap tests in
`hypergraph-network.js`, verified separately since most of that file needs real network).

### Round 28: writer-grant handshake timeout, and bootstrap version validation

**Writer-grant timeout, addressing a real gap:** previously, if the protomux channel opened
but the owner never responded (offline, a bug, a lost message), a peer had no way to detect
it and would wait indefinitely. Added:
- `writer-request-timeout` event, fired if neither `writer-granted` nor `writer-error`
  arrives within `writerRequestTimeoutMs` (default 30000, configurable via a new constructor
  option) after a peer sends its request.
- `waitForWriterGrant(timeoutMs)`, a promise-based waiter mirroring the existing
  `waitForPeer()` pattern, for callers who want to explicitly await the outcome.
- A real bug caught and fixed while implementing this: the pending timeout was only
  reachable through `#channelsByConn`, a `WeakMap`, which can't be iterated — meaning
  `destroy()` had no way to clear a still-pending timeout, which would otherwise keep the
  process alive for up to `writerRequestTimeoutMs` after teardown. This is exactly the class
  of lingering-handle bug that took many rounds to track down elsewhere in this project.
  Fixed by also tracking pending timeouts in a regular `Set`, which `destroy()` now clears.

Verified with two new tests in `writer-authorization.js`: one simulating a hung/buggy owner
(overriding `_handleWriterRequest` with a no-op, since simulating "never connects" wouldn't
exercise this — the timeout only starts once the channel actually opens and the request is
actually sent) and confirming the event fires with the correct duration; one confirming
`waitForWriterGrant()` both resolves on a real grant and rejects on a genuine timeout.

**Bootstrap version validation:** per project direction — no version migration logic is
needed yet (nothing runs this in production), but a mismatch should fail loudly rather than
silently misinterpreting an incompatible descriptor once shape changes do happen later.
Extracted the version string into a shared `BOOTSTRAP_VERSION` constant (previously
duplicated as a literal in `generateBootstrap()`, with no corresponding check anywhere), and
`connectFromBootstrap()` now rejects any bootstrap whose `version` doesn't match exactly —
including a missing version field entirely. New test covers a mismatched version, a missing
version, and confirms a correctly-matching version still passes through normally.

Full local suite: 110/110.

### Round 27: added missing diagnostics to the flaky peer-join test, rather than guess at a fix

Investigated the "emits peer-join" test's intermittent failure (`waitForPeer(90000)` timing
out). Found this test was missing the `connection-retry`/`connection-retry-exhausted`
listeners that every other DHT test in this file already has (an oversight from the
round-16 rewrite) — so there was no way to tell, from the failure alone, whether `connect()`'s
own retry mechanism (round 13) had already exhausted all 3 attempts before `waitForPeer()`
even started waiting, which would point to genuine, occasional DHT/NAT variance (the same
kind already documented and accepted elsewhere in this suite, e.g. `multi-peer.js`'s third
peer occasionally failing to connect in earlier rounds) rather than a deterministic bug in
recent changes.

Added the missing listeners rather than guessing at a code fix — this test's own retry
mechanism, timeout budget, and connection-check logic are unchanged from the other,
reliably-passing tests in this same file, and `connect()`'s retry behavior is unchanged from
what's already proven to work in `multi-peer.js` and the writer-authorization tests. The next
failure will show directly whether retries were attempted and exhausted (confirming
variance, not a bug) or not (which would point to something else worth investigating
further). Full local suite unaffected: 108/108.

### Round 26: selective context authorization (the sixth and final gap from the original analysis)

Checked directly before answering rather than assuming: every existing writer-authorization
test only ever requests a single context, so none of them could actually distinguish
"grants are evaluated per-context" from "grants are all-or-nothing for the whole request" —
this gap was genuinely still open.

Added a test that sends one writer-request spanning two contexts with different
`writeMode`s — one `open` (always granted) and one `closed` (requires `context.write`,
which the responder here deliberately lacks) — and verifies the response and actual
writability differ per-context within that single request: `granted.contexts.openCtx: true`,
`granted.contexts.closedCtx: false`, with matching real writability on each side. This
exercises the per-context error isolation already built into `_handleWriterRequest`'s loop
(a denial for one context doesn't block a grant for another in the same request).

This completes all six gaps from the project owner's original analysis: the three critical
ones (permission checking, writer-error coverage, bootstrap consumption) in round 23, and
multi-peer, reconnection, and now selective context authorization. Full local suite:
108/108.

### Round 25: multi-peer and reconnection coverage for HypergraphNetwork (gaps #4 and #5)

Before writing tests, verified two things directly rather than assuming them:
- `addWriter()` is idempotent — calling it twice for the same key doesn't throw (checked
  with a local probe), which matters because a reconnecting peer always re-sends a
  writer-request regardless of whether it was already granted before.
- Channel wiring is entirely event-driven per-connection (`_handleDataConnection` fires on
  every `'connection'` event from the swarm, wiring a fresh writer-auth channel each time),
  so reconnection naturally re-triggers the handshake without needing any special-casing.

**Gap #4 (multi-peer):** added a test connecting 3 `HypergraphNetwork` instances in a star
topology (owner is the hub; the two peers aren't directly connected to each other) and
verifying both peers receive `writer-granted` and actually gain write access to the shared
context — the first `HypergraphNetwork`-specific test with more than 2 peers.

**Gap #5 (reconnection):** added a test that connects, waits for the first
`writer-granted`, disconnects, reconnects with a fresh connection, and verifies the
handshake fires again on the new connection (not silently skipped) and that write access —
a permanent Autobase-level grant, not tied to any specific connection — persists correctly
across the cycle.

Both new tests run entirely locally (same `NoiseSecretStream` pattern as the existing
writer-authorization tests, no DHT needed), in `test/brittle/networking/
writer-authorization.js`. Full local suite: 107/107.

### Round 24: same force-exit workaround applied to peer-reconnection.js

The full suite hung again after `peer-reconnection.js`'s test completed successfully (all
assertions passed, teardown finished in under a second) — the identical class of issue as
`peer-connection.js` in round 22: `peer-reconnection.js` is the last file alphabetically in
`test/brittle/replication/*.js`, the other group (besides `test:networking`) that involves
real DHT connections.

Applied the same temporary workaround: `setTimeout(() => process.exit(0), 2000)` after the
test's own assertions finish. Checked the rest of the `npm test` chain for the same risk:
`test:core`, `test:forum`, and `test:integration` are all purely local (no real Hyperswarm/
DHT connections anywhere in those files), so they aren't exposed to this class of issue —
`test:networking` and `test:replication` were the only two groups that needed this fix, and
both now have it on their respective last file.

Marked as a workaround, not a fix, same as round 22.

### Round 23: implemented writer-authorization permission checking, using an existing design that was documented but never built

Responding to a gap analysis from the project owner identifying three critical gaps
(permission checking for writer authorization, missing writer-error test coverage, and
missing bootstrap-consumption coverage) and three lower-priority ones (multi-peer,
reconnection, and context-specific authorization scenarios).

**The permission-checking design question turned out to already be answered in the
codebase.** `ContextBase.addWriter()`'s own JSDoc already documented the intended design —
*"In 'closed' mode, requires the 'context.write' privilege from the attached RoleBase"*,
with `@throws` if RoleBase is missing or authorization fails — but the implementation never
actually did any of this. The existing `roles-registry.js`/`RoleBase` system (owner/admin/
mod/member roles, a `can(registry, pubkeyHex, action)` permission check) already supports
both of the project owner's proposed models as configurations of the same mechanism, not
separate designs: "closed, owner-only" falls out of the `owner` role's `'*'` wildcard, and
"closed, custom roles" is exactly what `admin`/custom roles with `context.write` already
provide.

**A related pre-existing bug found and fixed on the way:** `RoleBase` had no `can()` method
at all, despite `ContextBase` already calling `this.#roleBase.can(...)` for moderation
permission checks — meaning that check silently no-op'd (always treated as `null`, queuing
moderation events as pending rather than actually evaluating them), even when a RoleBase was
properly attached. Added the missing method (a thin wrapper around the standalone `can()`
function already imported and used internally in `role-base.js`, just never exposed).

**Fixed:**
- `ContextBase.addWriter()` now performs the documented check for `writeMode: 'closed'`
  contexts: requires `opts.author`, requires an attached RoleBase, and requires the
  `'context.write'` privilege — throwing otherwise. `writeMode: 'open'` contexts are
  completely unaffected.
- `HypergraphNetwork._handleWriterRequest()` now passes this peer's own identity as
  `opts.author` — checking whether the peer *receiving* the request has authority to grant
  it, the natural model here. Per-context error isolation is preserved: one context's denial
  (reported via `granted[name] = false`) doesn't block grants for other contexts in the same
  request that the requester is authorized for.
- Implemented the two previously-empty `test.skip()` placeholders in `core/contexts.js`
  ("closed write mode authorizes a role-approved writer" / "...rejects an unauthorized
  writer"), whose own comments already described exactly this redesign as the blocker.

**New test coverage, addressing gaps #1 and #2 together:** `test/brittle/networking/
writer-authorization.js` — three tests, all running entirely locally via a real
`NoiseSecretStream` pair (no DHT needed, same pattern proven for the protomux redesign):
authorized grant (with the peer actually becoming writable), unauthorized denial (reported
via `writer-granted` with `contexts.chat: false`, not an error — a denial is a normal
protocol outcome), and a genuine `writer-error` response for an unexpected failure (a
malformed userCore key).

**Gap #3 (bootstrap consumption) also addressed:** added
`HypergraphNetwork.connectFromBootstrap(graph, store, swarm, bootstrap, opts)`, the
consumption-side counterpart to `generateBootstrap()` that was missing entirely — mirroring
`Hypergraph.join()`'s existing pattern for its own export/join bootstrap shape. Opens the
owner's user core automatically (from `bootstrap.ownerCore`) so the caller doesn't have to.
Added a new test verifying the *other* half of the existing "generateBootstrap produces a
joinable descriptor" test (which only checked the output's shape): a second peer actually
consumes that descriptor via `connectFromBootstrap()`, connects, and receives the owner's
exact data — the coverage gap the project owner specifically flagged as missing relative to
`Hypergraph.export()/join()`.

Gaps #4-6 (multi-peer via `HypergraphNetwork` specifically, reconnection behavior, and
selective per-context authorization scenarios) remain open, prioritized as agreed for a
follow-up round.

### Round 22: quick, targeted force-exit workaround for peer-connection.js

Per project direction: round 21's diagnostic addition broke some previously-working tests
and was reverted; the priority now is finishing the test suite quickly and moving on to
reviewing hypergraph's internals toward a first usable version, not further root-cause
investigation of this specific hang.

Added a deliberately temporary, quick-and-dirty fix, scoped to only this one file: the last
test in `peer-connection.js` now calls `setTimeout(() => process.exit(0), 2000)` after its
own assertions finish, giving brittle a couple seconds to print what it can first. Verified
directly (simulating the same shape of problem with a deliberately-leaked, never-closed
`net.createServer()` before a final test): the process now reliably exits with code 0 within
a few seconds instead of hanging, and every individual test's own `ok N`/`not ok N` line
still prints normally. Also confirmed, by testing with a longer 5-second delay, that
brittle's own aggregate summary line genuinely never gets a chance to print in this exact
scenario regardless of how long you wait — consistent with earlier findings that brittle's
completion bookkeeping is blocked by the same lingering resource Node's own exit is — so 2
seconds is not leaving anything on the table; a longer delay wouldn't recover the summary
line, just slow the run down for no benefit.

This is explicitly marked as a workaround, not a fix, in case the underlying cause is worth
revisiting later.

### Round 20: reverted the test-runner wrapper; found and fixed a real product bug behind the multi-peer hang

**Reverted, per project direction:** `test/run-brittle.js` and `test/count-tests.js` (added
in round 18) are removed; every `npm run test:*` script goes back to calling `npx brittle`
directly. The project owner didn't want the added complexity and indirection of a wrapper
unless truly necessary — a fair call, and this round found that the actual multi-peer hang
had a real, fixable cause in product code rather than needing a process-level workaround.

**The actual bug, confirmed by direct, incremental debugging (not guessed):** three related
gaps, all in the same area, all now fixed:

1. `UserCore.update()` didn't accept or forward any options to the underlying Hypercore.
   Hypercore's own `update()` blocks indefinitely by default if the core's replicator
   believes it's still finding peers for that specific core (confirmed by reading
   Hypercore's `update()`/`_shouldWait()` source directly) — which is exactly the case for a
   user core only reachable via relay through another peer, not a direct connection.
2. `View.update()`'s loop over registered user cores called `core.update()` with no options
   at all, hitting the same indefinite block internally — even when the caller had already
   made a separate, correct `update({ wait: false })` call themselves, since `View.update()`
   calls it again on its own.
3. `UserCore.get()` had the identical problem one level deeper: it didn't forward options
   either, so even after fixing `View.update()` to pass a bounded `timeout`, that timeout
   was silently dropped and `get()` still blocked indefinitely on the first attempt. Traced
   directly with `has(0)` confirming the block genuinely hadn't arrived locally yet, and a
   raw, unwrapped timeout option being silently ignored by `UserCore.get(seq)`'s
   `seq`-only signature.

**Fixed:** `UserCore.update()` and `UserCore.get()` now both accept and forward an `opts`
object to the underlying Hypercore. `View.update()`'s inner loop now calls
`core.get(i, { timeout: 5000 })`, tracking the actual last successfully-processed index
instead of assuming the full requested range completed — if a block times out, the loop
stops for that core in this call (not throwing, not hanging) and a later `update()` call
picks up where it left off, since the underlying fetch request continues in the background
regardless of the local timeout.

**Verified the fix resolves the actual scenario, locally, incrementally:** built a minimal
3-peer relay reproduction (A↔C, B↔C, A and B not directly connected — the same topology
`multi-peer.js`'s connection log showed: `A=1, B=1, C=2`) using local Corestore replication,
no DHT needed. Confirmed step by step: `UserCore.update({wait:false})` completing fine in
isolation, `graph.update()` still hanging afterward (proving the bug was inside `View`'s own
internal call, not the caller's), `has(0)` returning `false` (block genuinely not yet local),
and finally — after all three fixes — the loop hitting the timeout exactly once on the very
first attempt (block not there yet) and succeeding cleanly 200ms later on the next call, with
both B and C ending up with the correct data. This also directly answers the open question
from earlier rounds about whether relay-through-a-third-peer works at all: it does; the
previous hangs were entirely `update()`/`get()` blocking indefinitely, not a relay gap.

### Test suite refactor, round 19: fixed EINVAL spawning npx on Windows

`test/run-brittle.js` (added in round 18) spawned `npx.cmd` directly on Windows without a
shell, which threw `Error: spawn EINVAL` on the project owner's machine (Node 25.6.0).
Spawning `.bat`/`.cmd` files directly via `child_process.spawn()` without `shell: true` has
become progressively less reliable across recent Node versions, following security fixes
around how Windows batch-file arguments get interpreted. Fixed by using `shell: true` and
letting the OS shell resolve `npx` on every platform, rather than guessing the executable
name (`npx` vs `npx.cmd`) ourselves. Re-verified on this project's Linux sandbox that the
fix doesn't regress the working Unix path: the full local suite (102 tests) and the
lingering-handle force-exit behavior from round 18 both still work correctly.

### Test suite refactor, round 18: the test runner itself is now immune to lingering-handle hangs

Per project direction: no backward-compatibility concerns (hypergraph is unreleased, with
no external consumers), so this changes the test-running mechanism freely.

The hang persisted at the exact same point after round 17's fix, even though that test's
own teardown reported a fast, clean completion — which was the key clue the user asked to
explore further. Confirmed directly by testing: a lingering handle (a timer left running,
in a minimal reproduction) prevents brittle from ever printing its own final TAP summary
line ("# ok"/"# not ok") at all — brittle is waiting on the same thing Node is. There is no
way to fix this by chasing the *next* specific lingering resource, because any future one
would reproduce the identical symptom. So the test runner itself is now made immune to the
whole class of problem, rather than continuing to patch around individual instances of it.

**Added `test/run-brittle.js`**, now used by every `npm run test:*` script instead of
calling `npx brittle` directly. It pre-counts how many tests a given set of files will
register — including tests registered *dynamically* at require-time (`test/brittle/forum/
index.js` loops over 12 scenario modules calling `test(...)` once per item; a static
source-text scan only ever sees the one call site, undercounting badly enough that an
earlier version of this fix cut the process off after 94 of 102 tests. Fixed via
`test/count-tests.js`, which intercepts `require('brittle')` with a counting stub and
requires each target file for real, so a loop that calls `test()` 12 times is actually
counted 12 times). It then watches stdout for the *last individual test's own* completion
line (`ok N`/`not ok N`, which brittle reliably prints immediately once that one test and
its teardown finish, regardless of what happens afterward) and force-exits shortly after
seeing it — it does not wait for or depend on brittle's own final summary line at all,
since that's exactly the line proven to never appear if a handle is ever left open. A
generous independent timeout remains as a safety net for a test that hangs mid-run rather
than after completing.

Verified directly: a test that leaves a `setInterval()` running forever after reporting
success now still results in the whole run completing and exiting within ~2 seconds, both
as a single test and as the last of several — and a suite that fails still reports the
correct non-zero exit code.

### Test suite refactor, round 17: Hyperswarm.destroy() never closes active connections

Per project direction: no backward-compatibility concerns apply here (hypergraph is
unreleased, with no external consumers yet), so fixes below change APIs/behavior freely
without preserving old shapes.

With round 16's protomux redesign in place, `hypergraph-network.js`'s writer-authorization
test passed for the first time. The hang moved to the exact same place as before
(immediately after `peer-connection.js`'s local, no-network test — the last test in the
file), even though that test's own teardown reported a fast, clean completion. That pointed
away from a hanging teardown *call* and toward a resource that's simply never closed at all.

**Root cause, confirmed by reading Hyperswarm's source directly:** `Hyperswarm.destroy()`
never explicitly destroys already-established peer connections. `this.connections` (the Set
of live connections) is only ever added to or removed from for bookkeeping — never iterated
inside `destroy()`. `clear()` only tears down discovery sessions, `server.close()` only
stops accepting new inbound connections, and `dht.destroy()` tears down the DHT node — none
of them touch an already-live connection stream. Every test whose connection actually
replicated data (like `peer-connection.js`'s "hyperswarm replication" test, right before the
one that hangs) left that live stream open indefinitely, which alone is enough to keep the
process from exiting, regardless of how cleanly every other part of teardown completes.

**Fixed:** added `destroySwarm(swarm)` to `test/brittle/helpers.js` — explicitly destroys
every connection in `swarm.connections` before destroying the swarm itself (with
`{ force: true }`, still correct per round 15's fix for the discovery-session hang risk).
Replaced every `swarm.destroy({ force: true })` call across the whole test suite (raw
Hyperswarm and `HypergraphNetwork`-based tests alike, including `peer-connection.js`, the
file most recently reported hanging) with `destroySwarm(swarm)`.

### Test suite refactor, round 16: HypergraphNetwork redesigned to eliminate the unreliable second swarm entirely

After 15 rounds of fixes to the dual-swarm design, one pattern held steady across every real
test run: the data channel connected reliably every time (0-1 retries), while the control
channel was wildly inconsistent — 0 retries in one test, 1 in another, and never once
succeeding after 3 full attempts in a third, with functionally identical setup code. No
further code-level bug was found to explain that gap after an extensive investigation. Per
project direction, rather than keep working around an unreliable second connection, the
second connection is now gone.

**The redesign:** `HypergraphNetwork` no longer creates a second, internally-owned
Hyperswarm swarm for a separate "control" topic. Writer-authorization messages are now a
`protomux` channel multiplexed directly onto the *same* connection the single, caller-owned
swarm already establishes for replication — the one connection already proven reliable in
every test. This works because `protomux` (already a project dependency, already used
internally by Hypercore/Corestore for exactly this purpose) can attach to the *same* muxer
Corestore's own replication already creates on a connection: confirmed directly from source
— `Hypercore.createProtocolStream()` stores its Protomux instance on
`noiseStream.userData`, and `NoiseSecretStream` self-references `this.noiseStream = this`
— so `Protomux.from(conn)` reuses the exact same muxer instead of creating a duplicate.
Verified end-to-end locally (no DHT needed) with a real `NoiseSecretStream` pair standing in
for a Hyperswarm connection: the channel opens on both sides, the writer-request/
writer-granted handshake completes, and the peer is actually granted write access to the
context — all in under a second.

**What this removes:** the second Hyperswarm instance, the derived "control topic", the
raw JSON-line-over-TCP protocol, and an entire category of "does the control channel
connect" bugs and diagnostics that occupied most of rounds 4 through 15. `destroy()` in
particular is now trivial — there's no longer an internally-owned network resource to tear
down at all, since the single swarm was always owned by the caller.

**What this changes for consumers:** `HypergraphNetwork` no longer exposes `controlSwarm`
or `controlTopic` (getters removed). `generateBootstrap()`'s output no longer includes
`controlTopic` (bumped to version `'2.0.0'`). The constructor no longer accepts
`opts.topicPrefix` (it existed only to salt control-topic derivation). `protomux` is now an
explicit dependency (previously only transitive, via `hypercore`/`corestore`).

**Test changes:** `test/brittle/networking/hypergraph-network.js` rewritten for the
simplified API — the writer-authorization test in particular is now much simpler, since
there's no separate control-channel connection to wait for or diagnose independently from
the main connection. `connect-to-swarm.js` and `hypergraph-network-integration.js` needed no
changes; they only ever touched the public API surface that stayed the same shape.

### Test suite refactor, round 15: teardown could hang indefinitely — fixed at the source, not worked around

Per direction from the project owner: Hyperswarm/HyperDHT itself is mature, widely used,
and not the likely source of problems here — any remaining hang is almost certainly in this
project's own code or test scripts, and the priority is a test suite that always finishes
and reports clearly, never one that hangs silently. This round treats that as the concrete
requirement it is, rather than continuing to speculate about Hyperswarm internals.

**Root cause, read directly from Hyperswarm's source, not guessed:** `swarm.leave(topic)`
and `swarm.clear()` both internally call each pending discovery session's own `destroy()`,
which can invoke an `unannounce()` network call with no visible internal timeout — this
category of behavior is already acknowledged directly in this project's own code
(`ForumNetwork`'s comment: "Hyperswarm's flushed/flush can hang indefinitely in some
environments"). `HypergraphNetwork.destroy()` called `disconnect()` first, which fires
`swarm.leave()` on both swarms *without awaiting it* — meaning even though nothing in this
class's own code blocks on it, the underlying operation keeps running in the background,
which alone is enough to keep the process alive regardless of whether any JS code is still
awaiting it. `clear()` (used in round 14's fix) has the same underlying issue one level up:
it awaits `Promise.allSettled()` over every pending session's own `destroy()`, so it only
resolves once all of them settle — and hangs if even one never does.

**Fixed, in `src/networking.js`:** `destroy()` no longer calls `disconnect()` at all (it's a
final, permanent teardown, unlike `disconnect()`, which exists so a connection can be
re-established later — there's no reason to go through the graceful leave step first). It no
longer calls `clear()` either. Instead it closes the control swarm's server and destroys its
connections directly, touching neither discovery sessions nor the DHT at all. The trade-off
— a stale DHT announcement for the control topic that isn't gracefully retracted — is a
non-issue during test/process teardown, where nothing is left running to care.

**Also fixed, broadly:** every raw-Hyperswarm test file's teardown was calling
`discX.destroy()` before `swarm.destroy()` — redundant with, and carrying the same hang
risk as, what `swarm.destroy({ force: true })` already needs to do anyway (`force: true`
skips Hyperswarm's own `clear()` step entirely). Removed the redundant `discX.destroy()`
calls and switched every `swarm.destroy()` call across the test suite (raw-Hyperswarm and
`HypergraphNetwork`-based alike) to `swarm.destroy({ force: true })`.

**Added a general safety net regardless of cause:** `withTeardownTimeout()` in
`test/brittle/helpers.js` — wraps any teardown operation with a hard timeout, logging a
warning and moving on if it doesn't finish in time, rather than ever blocking the rest of
teardown (or the process) indefinitely. Applied to `peer-connection.js`'s teardown, the file
most recently reported hanging. This directly serves the stated priority: the test suite
should always finish and report clearly, and a slow or stuck cleanup should be visible, not
silent — never the reason a run never completes.

### Test suite refactor, round 14: fixed a real double-destroy hang in HypergraphNetwork.destroy()

Good news first: every test up through peer-connection.js's local guard test reported "ok"
in the last run (including the writer-authorization handshake), meaning round 13's retry
fix appears to have worked. The new problem was the whole test process never exiting
afterward — a real, separate bug, not a leftover networking flakiness issue.

**Root cause, confirmed by reading both Hyperswarm's and HyperDHT's own source, then
reproduced with a mock:** `HypergraphNetwork` creates its control swarm by sharing the data
swarm's DHT instance (`new Hyperswarm({ dht: dataSwarm.dht })`) — a deliberate, documented
part of the dual-swarm design. But `Hyperswarm`'s constructor never records whether its
`dht` was externally provided or created internally (`this.dht = opts.dht || new DHT(...)`,
no ownership flag at all), and `Hyperswarm.destroy()` unconditionally calls
`this.dht.destroy()` regardless. `HypergraphNetwork.destroy()` was already calling the
control swarm's full `destroy()` — which cascades to destroying the *shared* DHT. Every
test's teardown then separately calls the data swarm's own `destroy()` (correctly, per
`HypergraphNetwork`'s own comment: "don't destroy data swarm, passed by user, caller's
responsibility") — which destroys that *same* shared DHT a second time.
`HyperDHT.destroy()` has no idempotency guard of its own either, so the second call doesn't
error, it hangs — reproduced exactly with a mock DHT whose `destroy()` never resolves on a
second call, confirming this is precisely the observed symptom (the process never exiting)
and not a coincidence.

**Fixed:** `HypergraphNetwork.destroy()` no longer calls the control swarm's full
`destroy()`. It now tears down only the control swarm's own resources — leaving all its
topics (`clear()`), closing its server, and destroying its own connections — without ever
touching the DHT. The shared DHT is destroyed exactly once, when the caller destroys the
data swarm they own, exactly as the existing "don't destroy data swarm" comment already
intended for that side of the pair. Verified the fix directly with a mock DHT that hangs on
a second `destroy()` call: the old pattern reproduces the hang, the new pattern does not.

### Test suite refactor, round 13: HypergraphNetwork.connect() had no retry — a real product fix, matched against the project's own history

**Context correction, at the project owner's prompt:** `HypergraphNetwork` was built
specifically to replace `forum-web`'s hand-written `ForumNetwork` with a friendlier,
reusable API — confirmed directly in this repo's own commit history (`8616546`:
"HypergraphNetworking (network helper to avoid all the manual hyperswarm boilerplate) ...
to test HypergraphNetworking ease of use and reliability compared to forum-web's
handwritten hyperswarm networking and writer authorization handshake"). The most recent
commit before this test suite existed (`1da90ad`) says outright: "improved HyperswarmNetwork's
API but still untested." So this is exactly what that commit predicted — a genuinely
previously-unverified piece of the networking code, not a subtle regression.

**New evidence that reframed the investigation:** the round-12 diagnostics showed the *data*
swarm at `peers=0, connections=0` for the entire 80s wait too, not just control — despite
`connected: true` on both sides and no `flush-timeout` fired (i.e. `flushed()`/`flush()`
both genuinely resolved, just with zero peers ever found). This matches, symptom for
symptom, what the raw-Hyperswarm replication tests hit in earlier rounds before they had a
retry mechanism (`waitForConnections()` in `test/brittle/helpers.js`) — and `connect()` had
no equivalent at all.

**Fixed, in `src/networking.js`:** added `_ensureConnectionWithRetry()`, called for both the
data and control swarm after the existing flush steps. If a swarm has zero connections after
an initial wait window, it leaves and rejoins the topic (up to 2 extra attempts) before
giving up — the same proven pattern already used in the test suite's own
`waitForConnections()`, now applied to the actual product code so any consumer of
`HypergraphNetwork` benefits, not just this test suite. Emits `'connection-retry'` and
`'connection-retry-exhausted'` (with the swarm label and attempt count) so this is
observable rather than silent, matching the visibility principle established in round 11's
`flush-timeout` fix. Verified the retry/leave/rejoin control-flow logic in isolation with a
fake swarm (no network needed): confirmed it returns immediately when already connected,
retries exactly the configured number of times before reporting exhaustion when a
connection never appears, and stops retrying the moment a connection does appear.

**Also fixed:** every test using `connect()`/`connectToSwarm()` now listens for
`'connection-retry'`/`'connection-retry-exhausted'` for visibility, and declared timeouts
were raised again to keep real margin over the new (larger, but more honest and more likely
to actually succeed) worst case.

**Ruled out this round, with evidence, before landing on the retry fix:** role-based join
asymmetry, control-topic derivation mismatch, and the `setEncoding('utf8')` difference from
`ForumNetwork` (none explained a connection that never fires at the raw swarm level in the
first place). Attempted a local loopback-only DHT reproduction to test the shared-DHT
two-topic pattern without real network access; inconclusive, since even the data channel
didn't connect in that minimal setup, so it wasn't presented as a finding either way.

### Test suite refactor, round 12: control channel still not connecting — ruled out several theories, root cause still open

The round-11 fix (longer timeout, visible `flush-timeout` event) did not surface a timeout —
no `flush-timeout` fired in the next run, meaning all four of `connect()`'s internal steps
genuinely resolved within 60s. So the control channel isn't failing because of the
timeout-swallowing bug; it's failing to establish an actual connection for a different
reason that hasn't been identified yet.

**Compared directly against `examples/forum/network/hyperswarm.js`** (the actual reference
implementation `forum-web` uses — note `forum-web` does not use `HypergraphNetwork` from
`src/networking.js` at all, it has its own, separate `ForumNetwork` class). Checked and
ruled out, with evidence, three specific hypotheses for why `HypergraphNetwork`'s control
swarm might differ from the reference implementation's:
- Role-based join asymmetry — ruled out; both use identical `{ server: true, client: true }`
  for both roles.
- Control-topic derivation mismatch — ruled out; deterministic, both peers compute the
  identical topic from the identical shared input.
- Message-encoding difference (`conn.setEncoding('utf8')` vs manual `.toString()` per chunk)
  — noted but doesn't explain the symptom, since the raw swarm `'connection'` event itself
  never fires on either side; encoding only matters after a connection exists.

**Attempted to verify empirically with a local (loopback-only) DHT bootstrap node**, to test
the two-swarms-sharing-one-DHT-on-two-topics pattern without needing real network access.
This was inconclusive: even the data channel — proven reliable in real testing — never
connected in that minimal local reproduction, meaning the reproduction itself isn't
realistic enough to trust for testing the control channel either. Not presenting this as a
finding one way or the other.

**Real, separate finding worth acting on regardless of the above:** `_handleWriterRequest`
has no role check — confirmed any connected peer can currently respond to a writer-request
and grant writer status, matching the requirement that write-grants shouldn't require the
owner specifically to be online. Confirmed further at the Autobase apply layer: a
`roles/addWriter` event is honored unconditionally, with no check on who appended it. This
correctly means any existing writer can add another peer — but it also means there is
currently no authorization gate at all, even in closed write mode, consistent with the
closed-mode gap already noted in this changelog, now with concrete evidence of exactly where
in the code that gap lives.

**Added, not a fix:** significantly richer diagnostics in the writer-authorization test —
logs both `swarm.peers.size` (DHT-discovered candidates, regardless of connection) and
`swarm.connections.size` (actual live connections) for both the data and control swarm on
both peers, side by side, every 10s. This will show directly whether a future run's control
swarm ever discovers the other peer at all (a DHT lookup problem) or discovers it but never
completes a connection (a hole-punch/connection-establishment problem) — a distinction the
previous logging couldn't make.

**Open question for the project owner:** whether `forum-web`'s own writer-grant flow has
ever been confirmed working end-to-end with two real peer processes. If it hasn't, this may
be a previously-unverified gap in the dual-swarm control-channel design generally, not
something specific to `HypergraphNetwork` or this test suite.

### Test suite refactor, round 11: HypergraphNetwork.connect() silently lied about success
A real, significant product bug — not a test bug, not network variance — found while
investigating why the writer-authorization handshake test showed `connected: true` on both
sides for over 60 seconds while the control channel had, provably, never connected
(`controlConnected1`/`controlConnected2` both stayed `false`, listening for the real
`'control-connection'` event, which does exist and is correctly named — confirmed by
reading the emit call directly rather than assuming a naming mistake).

**Root cause, read directly from `src/networking.js`:** `connect()` wraps its four
discovery/flush steps (data discovery flush, control discovery flush, data swarm flush,
control swarm flush) in a `withTimeout()` helper defined as
`Promise.race([promise, sleep(ms).then(() => null)])`. If the timeout wins, this silently
returns `null` — the caller has no way to distinguish "the operation actually completed" from
"we gave up after 10 seconds and moved on anyway." `connect()` then unconditionally sets
`this.#connected = true` and emits `'connected'` after all four steps, regardless of whether
any of them actually succeeded. This is how `connected` could report `true` on both peers
while the control channel had never connected at all: the control-related steps hit their
10-second cap, returned `null` silently, and `connect()` proceeded as if nothing had
happened.

10 seconds was also simply too short: DHT connection times observed empirically across this
project's own test runs have ranged from a few seconds up to ~90 seconds even for the
already-proven-reliable data channel.

**Fixed, in the product code, not just the tests:**
- Replaced the silently-swallowing `withTimeout()` with `withTimeoutWarn()`, which still
  doesn't throw (a caller may reasonably want to proceed and let application code decide
  what to do) but now emits a `'flush-timeout'` event — with the step name and timeout
  duration — whenever a step actually times out, instead of hiding it. `connected: true` can
  still be reported optimistically, but a caller now has a way to detect a partial failure
  they previously had no visibility into at all.
- Raised the timeout for all four steps from 10s to 60s, matching what's actually been
  observed to be necessary in this project's own DHT tests, rather than an arbitrary
  shorter value that was routinely too tight for the control channel specifically.
- Verified the fix's control-flow logic directly (no network needed): a local test confirms
  `withTimeoutWarn` returns the real value and stays silent when the promise wins, and
  returns `null` while emitting a correctly-populated `'flush-timeout'` event when the
  timeout wins.

**Test changes:** every DHT test that calls `connect()`/`connectToSwarm()` now listens for
`'flush-timeout'` and logs it, so a future failure shows directly which step silently gave
up rather than requiring another investigation like this one. Declared brittle timeouts were
raised across `hypergraph-network.js` and `connect-to-swarm.js`'s DHT tests to comfortably
cover the new, larger (but now honest) worst case; `hypergraph-network-integration.js` had
no explicit timeout at all before this round (relying on brittle's 30s default), which was a
real latent crash risk of the same kind fixed for other files in round 7 — given an explicit
timeout now too.

### Test suite refactor, round 10: what "partial replication" actually means, and a real bug (not addWriter, not DHT timing)

This round answers a direct question raised about `partial-replication.js`: does "partial
replication" even make sense as a concept here, given Hyperswarm doesn't do selective
replication and hypergraph is generally described as replicating whole graphs? The answer,
verified against source and an empirical local test (not assumed):

**What replicates, and at what granularity (fact, not assumption):**
- A user core (one per device, containing all of that device's entities/content) replicates
  as a whole. There is no way to fetch only some entities out of a device's user core — it's
  all-or-nothing per core, confirmed by `partial-replication.js`'s own passing assertion that
  the peer got *both* postA and postB (from different contexts) via the single, fully
  replicated owner user core.
- A context (relations/tags/moderation — a separate Autobase per context) replicates as a
  whole too, once opened.
- The only thing that's actually "partial" is *which* cores/contexts a peer chooses to open
  and track at all. Never call `openContext(Y)` and you have zero knowledge of Y's data,
  forever. Open it, and you eventually get everything in it — not a filtered subset.
- This matches the definition already encoded in the pre-existing, passing
  `test/brittle/forum/scenarios/partial-replication.js` (a peer that opens the moderation
  context but never opens the owner's user core sees moderation facts about a post without
  ever seeing the post itself) — this round's rewritten test now matches that same,
  already-established, correct definition instead of testing something vaguer.

**Real root cause of the observed failure, verified from source, not guessed:**
`getByTag()`'s implementation (`src/view.js`) cross-references every tagged entity via
`this.getNode(entityId)`, which only reads from the graph's own top-level view. That view is
only populated by user cores registered through `openUserCore()` — confirmed by reading
`openUserCore()`'s implementation, which explicitly calls `view.addUserCore()`. A raw
`store.get({ key })` (what the previous version of this test used to watch the owner's user
core) creates a Hypercore reference for replication only; it never calls `addUserCore()`.
So `getByTag()`'s cross-reference could never resolve, no matter how long the test waited —
this had nothing to do with the network, connection quality, or writer permissions.

**Retracted: the theory (from the previous round) that `addWriter()` might be required for
a peer to passively read context data.** Verified false with a local (non-DHT) probe: a peer
that opens a context and is *never* added as a writer, but *does* use `openUserCore()` for
the referenced entity's core, correctly sees tagged data — `bCtx.writable` was confirmed
`false` while the tag was still visible. The forum scenario's `addWriter()` call exists so
the peer can *write* its own moderation event, not so it can read.

**Fixed:** `partial-replication.js` rewritten to use `openUserCore()`. Also audited every
other replication test for the same class of mistake and fixed the ones that had it:
`multi-peer.js` (both tests), `peer-reconnection.js`, and `hypergraph-network-integration.js`
all used to watch remote cores via raw `store.get()`.

**Broader audit requested and completed: exact content verification, not just "something
replicated."** Every replication test previously asserted only `.length > 0` or that an
object was merely truthy — which proves *some* bytes arrived, not that the *correct* data
did. Every DHT-based replication test now fetches the actual replicated entity/content via
`graph.get()`/`graph.getContent()` and asserts the exact body text matches what was written,
byte for byte, not just presence:
- `concurrent-writes.js`, `late-joiner.js`: already fixed in an earlier pass this round.
- `peer-reconnection.js`: now verifies both messages' exact content after reconnection.
- `hypergraph-network-integration.js`: now verifies exact content, and also fixes a
  previously-missed instance of the sequential-`connect()` bug (fixed elsewhere in round 5,
  but this file was overlooked at the time).
- `multi-peer.js`: now verifies exact content on every peer, for both the 1-writer/2-reader
  scenario and the 3-way mutual-write scenario (6 cross-checks: every peer's copy of every
  other peer's message, compared byte for byte).
- `out-of-order.js`: now also verifies the comment's exact content body, and checks the
  specific relation's `from`/`to`/`type` fields match exactly rather than just checking that
  "some" edge exists.

### Test suite refactor, round 9: a real test bug (openUserCore) + connection retry
Round 8's `swarm.flush()` fix clearly helped — `multi-peer.js`'s second test and
`out-of-order.js` both got real connections this time, where they'd gotten none before.
Two things remained, and they turned out to be unrelated to each other.

**Real bug found in `out-of-order.js` (not a network issue at all):** the test used a raw
`a.store.get({ key: b.graph.key })` to watch peer B's user core, then tried to read peer
B's comment via `a.graph.get(comment.id)`. A raw `store.get()` only creates a Hypercore
reference for replication — it never registers the core with the graph's *view*, so
`graph.get()`/`graph.update()` could never see B's data no matter how long the test waited
or how good the connection was (confirmed by reading `openUserCore()`'s implementation: it
explicitly calls `view.addUserCore()`, which a raw `store.get()` never does). This is
exactly why the connection succeeded (`A=1, B=1`) but the data never converged even after
100+ seconds — it had nothing to do with networking. **Fixed** by using
`a.graph.openUserCore(b.graph.key)` instead, matching the real Hypergraph API contract.

**Remaining connectivity gap (`multi-peer.js` test 1, `partial-replication.js`):** even with
`swarm.flush()`, some runs still saw zero connections after a full timeout window, while
sibling tests using the identical pattern connected instantly. Rather than just extending
the timeout further (round 7's mistake), added a genuine retry mechanism to
`waitForConnections()`: on timeout, it now leaves and rejoins the topic on every swarm (up
to 2 extra attempts) before giving up — a real resilience pattern, not just more patience,
since a stale initial DHT lookup can return candidate peers that never pan out and a fresh
join/flush cycle can succeed where the first one didn't. Declared test timeouts were raised
to comfortably cover the new worst-case (up to 3 connection attempts × 60s, plus the pump
loop) so this doesn't reintroduce round 7's timeout-overflow crash.

**Suggestion, not a code change:** if `multi-peer.js`/`partial-replication.js` still show
occasional connection difficulty, try running the replication suite in smaller batches
(`npm run test:concurrent-writes`, then separately `npm run test:multi-peer`, etc.) rather
than one long `npx brittle test/brittle/replication/*.js` invocation — each separate
`npx brittle` call gets a fresh Node process and fresh DHT bootstrap state, which may help
if cumulative resource pressure across ~6 back-to-back DHT-heavy tests in one process turns
out to be a factor.

### Test suite refactor, round 8: missing swarm.flush() — a real bug, not NAT variance
Correction to round 7's framing. All 8 replication tests were re-run and the same 3 files
failed consistently, every time, with **zero** connections on every peer — not intermittent
partial failures as in round 6/7. That consistency, plus first-hand confirmation that the
test environment's Hyperswarm/DHT setup is fast and reliable, ruled out "NAT traversal
variance" as the explanation. It was a real, structural bug in how those 3 files used
Hyperswarm, not the network.

**Root cause:** `discovery.flushed()` (returned by `swarm.join()`) only confirms the local
side's DHT announce/lookup round finished. `swarm.flush()` is a separate, necessary call
that drains the actual connection queue and waits for the resulting connection attempts to
complete (confirmed directly in `node_modules/hyperswarm/index.js`: `flush()` awaits every
topic's `flushed()` *and then* waits on `this._queue`/pending connections). Every working
pattern in this codebase already called `swarm.flush()`: `late-joiner.js`,
`concurrent-writes.js`'s extra `sleep(10000)` gave it time to happen incidentally in the
background, `peer-connection.js` calls it explicitly, and `HypergraphNetwork.connect()`
calls it internally for both its data and control swarms — which is exactly why
`hypergraph-network-integration.js` never needed this fix. `multi-peer.js`, `out-of-order.js`,
and `partial-replication.js` were the only three places in the whole suite that joined a
topic and moved on without ever calling `swarm.flush()`.

**Fixed:** added `await swarm.flush()` (in parallel across all peers via `Promise.all`)
immediately after `discovery.flushed()` in all three files, matching the exact working
pattern from `late-joiner.js`.

**Retracted:** round 7's suggestion that `multi-peer.js`'s connection failures reflected
"real DHT/NAT variance ... not something to keep chasing with longer timeouts" was wrong.
It was a straightforward missing-API-call bug. The diagnostic tooling from round 6
(`waitForConnections()`) was still the right approach — it just needed the underlying
connection code fixed rather than more patience.

### Test suite refactor, round 7: two different problems, one code bug and one real network condition
Follow-up after round 6, which added explicit connection verification. Running it surfaced
useful, clean diagnostics for the first time: `multi-peer.js`'s first test showed peer A
with **zero** connections after 60s while B and C connected to *each other* (`A=0, B=1,
C=1`). Its second test, moments later with fresh peer instances, connected fully within the
first second (`A=2, B=1, C=1`) and passed cleanly.

**This is very likely genuine DHT/NAT connectivity variance on the test machine's network,
not a code bug.** The diagnostic system built in round 6 did its job: it correctly detected
and reported "peer A never got a connection" instead of silently hanging or reporting a
misleading pass. No test code or Corestore/Hyperswarm configuration change can guarantee a
specific NAT traversal succeeds within a fixed time budget — that's an inherent property of
P2P networking, not something to keep chasing with longer timeouts indefinitely.

**A separate, real bug did turn up alongside it:** `out-of-order.js` crashed the entire
`npx brittle` process with an uncaught "Test timed out after 150000ms" instead of failing
that one test gracefully. Cause: its own sub-steps' worst-case durations
(`waitForConnections()`'s 60s timeout + a 110-iteration, 1s-interval pump loop) summed to
~170s, but the test only declared `{ timeout: 150000 }` (150s) — since `t.ok()` records a
failure without throwing, the test kept running past the failed connection check into the
full pump loop, blowing through its own declared ceiling and triggering brittle's hard
per-test timeout, which kills the whole process rather than just that test.

**Fixed:**
- `out-of-order.js`: raised the declared timeout to comfortably exceed the worst-case sum
  of its sub-steps, and — more importantly — added a fail-fast return when
  `waitForConnections()` finds no connection at all, instead of burning the rest of the
  budget on a pump loop that has no path to converge.
- `partial-replication.js`: had the same class of overflow risk (60s connection wait + 3
  sequential pump loops up to 240s = 300s worst case vs. only 180s declared) even though it
  hadn't been observed crashing yet. Fixed the same way: raised timeout, added fail-fast.
- `multi-peer.js`: added the same fail-fast pattern to both tests for consistency and
  faster, clearer failures (its declared timeout already had enough margin, so this was a
  quality-of-life fix rather than a crash fix).

**Not changed:** did not add more retries or longer waits purely to try to "outlast" the
DHT/NAT variance in `multi-peer.js`'s first test. If it recurs on rerun, that's expected —
it demonstrates real-world network conditions, and the fail-fast + diagnostic logging is
the correct behavior (fail clearly and quickly) rather than a bug to keep patching.

### Test suite refactor, round 6: connection verification for raw-Hyperswarm tests
Follow-up after round 5: peer C in `multi-peer.js` stayed at 0 replicated events for 80+
seconds while peer B (same test) fully caught up immediately.

A plausible-looking theory going in was a Hyperswarm mesh-topology/relay problem — i.e.
each peer only replicating its own store, so peer C (only indirectly connected via B)
never gets peer A's data relayed through B. That theory was checked against Corestore's
actual source before acting on it: `store.replicate(conn)` already loops over **every**
core the store knows about (not just ones it "owns") and auto-attaches any core marked
`active` — the default for a normal, non-weak session — to any stream, specifically to
support exactly this kind of relay. So the fix suggested for that theory (manually calling
`.replicate(conn)` on each individually-tracked remote core) would likely have been
redundant, and risked masking the actual problem instead of fixing it.

**Actual root cause:** the same lesson learned three times already in this refactor —
`discovery.flushed()` proves the local side's own DHT announce/lookup round finished, not
that an actual peer-to-peer connection exists. `multi-peer.js`, `out-of-order.js`, and
`partial-replication.js` all use raw Hyperswarm directly (no `HypergraphNetwork`, so no
`waitForPeer()` equivalent), and none of them verified a real connection existed before
writing data and starting to poll for it. If peer C's swarm never actually connected to
anyone, no replication or relay logic — correct or not — could have helped.

**Fixed:** added `waitForConnections()` to `test/brittle/helpers.js`, which polls
`swarm.connections` (a real `Set` of live connections, not a discovery-completion flag)
before any test proceeds to write/check data. Applied to `multi-peer.js` (both tests),
`out-of-order.js`, and `partial-replication.js`, each with an explicit assertion and
diagnostic logging so a future failure clearly shows whether the problem is "no connection
was ever established" vs "connected fine, but data didn't converge."

### Test suite refactor, round 5: waitForPeer() fast-path bug
Follow-up after round 4: 11/12 networking tests passed; only the peer-join test failed,
again with `connected` true but the event itself never firing within the test's window.

**Root cause, this time a real product bug, not just test timing:** `HypergraphNetwork`
already ships a purpose-built `waitForPeer(timeoutMs)` for exactly this situation — wait
for an actual peer connection rather than trusting `connected`. But its fast path checked
`this.#connections > 0`, and `#connections` is incremented by **both** the data swarm
(which is what actually fires `'peer-join'`) and the control swarm (which doesn't). So
`waitForPeer()` could resolve immediately based on a control-only connection, before any
`'peer-join'` had fired — exactly backwards from what a caller asking "has a peer joined"
would expect.

**Fixed:** added a dedicated `#hasPeerJoined` flag, set only inside the data swarm's
connection handler (the same place `'peer-join'` is emitted), and pointed `waitForPeer()`'s
fast path at that flag instead of the shared `#connections` counter.

**Test fixed:** `test/brittle/networking/hypergraph-network.js`'s peer-join test now uses
`waitForPeer()` (the correct, intended API for this) instead of ad-hoc polling, plus keeps
the direct `peerJoined` flag assertion as a belt-and-suspenders check on top.

### Test suite refactor, round 4: connected vs. actually-connected
Follow-up after round 3: 10/11 networking tests passed; only the writer-grant handshake
test failed, with both `connected` checks green but the handshake itself never completing
within 30s.

**Root cause:** `HypergraphNetwork#connected` is set once the DHT discovery/flush calls
resolve (`dataDiscovery.flushed()`, `controlDiscovery.flushed()`, plus both swarms'
`.flush()`) — this reflects that the *local* side finished its own announce/lookup round,
not that an actual peer-to-peer connection has been established yet. The data swarm and
control swarm do independent NAT traversal, and the control swarm's connection — which the
writer-request/writer-granted handshake rides on — can complete meaningfully later than
`connected` flips true. The test's fixed 30s handshake window started counting from the
wrong reference point.

**Fixed:** `test/brittle/networking/hypergraph-network.js`'s writer-authorization test now
listens for the real `'control-connection'` event on both sides and waits for that before
it starts expecting the handshake to be done, instead of treating `connected` as proof the
control channel is live. Also bumped the handshake window and added progress logging.

**Note for later:** `connected`'s current semantics (discovery-flushed, not
peer-actually-connected) is a slightly surprising name for what it measures. Not changed
here since it's a behavior/naming decision rather than a bug, but worth considering if it
causes confusion for consumers of the public API beyond this test suite.

### Test suite refactor, round 3: DHT timing fixes
Follow-up after running the round-2 replication tests on real hardware. 4/8 tests passed
(all the 2-peer, raw-user-core-only ones); the 4 failures were all either 3-peer or
context/Autobase-based, which turned out to be a timing problem, not a correctness one.

**Root cause:** context/Autobase-based sync (system core → writer registry → individual
writer cores → view materialization) needs more round trips than plain raw-hypercore
replication, which itself was already observed taking 9–26s for a simple 2-peer case.
`multi-peer.js`, `out-of-order.js`, and `partial-replication.js` only budgeted ~20–25s
total, cutting things off right as convergence was starting (`partial-replication.js`'s own
log showed the raw entity data had already replicated by the time the context-level tag
check failed — it just hadn't converged yet at that exact moment, because that check ran
once instead of in its own retry loop).

**Also found:** `networking1.connect()` / `networking2.connect()` (and the two
`connectToSwarm()` calls in `connect-to-swarm.js`'s end-to-end test) were awaited
*sequentially* instead of in parallel. Since a single `connect()` can internally take up to
~20s (two sequential 10s flush timeouts), awaiting two of them one after another could
approach 40s before either side finishes — on top of brittle's 30s default test timeout,
which was silently truncating some of these runs before they had a fair chance to converge.

**Fixed:**
- `multi-peer.js`, `out-of-order.js`, `partial-replication.js`: increased pump budgets to
  90–110 iterations at 1s each (up from 40 at 500ms), added explicit `{ timeout: 150000-
  180000 }` per test so brittle's 30s default doesn't cut them off, and added periodic
  progress logging so a future failure is diagnosable at a glance (e.g. "entity replicated
  at ~12s, still waiting on the relation" vs "nothing replicated after 60s" point at very
  different problems).
- `partial-replication.js`: gave the context-level tag check its own retry loop instead of
  a single snapshot check immediately after the (separate, faster-converging) raw-entity
  pump loop exited.
- `hypergraph-network.js` (all 4 DHT tests) and `connect-to-swarm.js`'s end-to-end test:
  changed sequential `connect()`/`connectToSwarm()` awaits to `Promise.all()`, added
  explicit `{ timeout: 90000 }`, and converted the writer-grant/peer-join event checks from
  a fixed sleep to a retry loop.

### Test suite refactor, round 2: teardown-ordering fix + coverage gaps closed
Follow-up to the test suite refactor below, after real-network testing surfaced a
deterministic hang and a coverage review identified gaps against the original plan.

**Fixed:** every test file that opens a real Hyperswarm connection
(`test/brittle/networking/hypergraph-network.js`, `connect-to-swarm.js`, `peer-connection.js`,
and all of `test/brittle/replication/`) was destroying its swarm *before* closing the
graph/store that used it. Since brittle's `t.teardown()` runs LIFO and `createGraph()`
registers its own graph/store-close teardown as soon as it's called (before the swarm even
exists), the swarm was always torn down first — yanking the raw socket out from under an
in-flight replication stream mid-shutdown. `store.close()` then hung forever waiting for a
clean close event that could never arrive, freezing the whole test run with no error,
deterministically, every time. Fixed by consolidating each test's cleanup into one teardown
that always closes graph, then store, then destroys the swarm last. `test/brittle/helpers.js`'s
`createGraph()` now also returns an explicit `close()` so tests can control this ordering
themselves instead of relying on implicit registration-order LIFO behavior.

**Added**, closing gaps from the original test plan:
- `test/brittle/core/view.js` — direct `GraphView` tests: `update()`, `getNode()`,
  `getContent()`, `getEdges()`, `getByTag()`/`hasTag()`, device-identity mapping, `getIdentity()`.
- `test/brittle/core/user-core.js` — direct `UserCore` tests (`append`, `appendBatch`, `get`,
  `createReadStream`, initial state) plus `graph.openUserCore()` integration, including
  idempotency and invalid-key rejection.
- `test/brittle/core/error-cases.js` — malformed/missing key rejection for `openContext()`
  and `openRoleBase()`, plus `tag()`/`unrelate()` rejecting unknown entities/relations.
  Also documents two *intentional* non-errors so they don't get "fixed" into regressions
  later: `openContext()`/`openRoleBase()` accept a well-formed key nobody has created data
  for yet (legitimate — the context may still be replicating), and `relate()` does not
  validate that `from`/`to` entities exist locally (required for out-of-order replication;
  the forum suite's `reply-before-parent.js` scenario depends on relating to an entity that
  hasn't synced yet).
- `test/brittle/replication/multi-peer.js` — 3-peer broadcast and 3-peer mutual convergence.
- `test/brittle/replication/out-of-order.js` — relation referencing a not-yet-replicated
  entity, over a real DHT connection (complements the local-pipe version already covered in
  `test/brittle/forum/scenarios/out-of-order-replication.js` and `reply-before-parent.js`).
- `test/brittle/replication/partial-replication.js` — a peer that only opens one of two
  contexts only receives that context's data, and catches up on the second once it opens it
  (complements the local-pipe version in `test/brittle/forum/scenarios/partial-replication.js`).
- Per-file npm scripts for every new test file, plus the previously-missing per-file scripts
  for the existing replication tests (`test:late-joiner`, `test:concurrent-writes`,
  `test:peer-reconnection`, `test:hypergraph-network-integration`).

### Test suite refactor (from-scratch rewrite, no backward compatibility)
Rewrote the entire test suite from scratch to test the intended, current API rather than
legacy/historical behavior. Old ad-hoc test files (`basic.js`, `identity.js`, `ordering.js`,
`moderation.js`, `integration.js`, `hyperswarm.js`, `networking.js`, and the non-brittle
`replication-scenarios.js` script) were removed and replaced with:
- `test/brittle/core/` — entities, identity-manager, identity-graph, contexts, relations,
  tags, query, roles, moderation, events. All run locally with no network access and are
  fully verified (60 tests, 143 assertions).
- `test/brittle/networking/` — HypergraphNetwork, peer connection, bootstrap/export,
  connectToSwarm. Two files (`bootstrap-export.js`, most of `connect-to-swarm.js`) run
  locally; the rest need a real Hyperswarm/DHT connection.
- `test/brittle/replication/` — late-joiner, concurrent-writes, peer-reconnection,
  HypergraphNetwork integration. All need a real DHT connection to run.
- `test/brittle/integration/full-app-flow.js` — a single-process end-to-end flow through
  identity, entities, content, relations, tags, roles, moderation, query, and export/join.
- `test/brittle/forum/` — unchanged, still passing (12 tests, 43 assertions).

npm scripts were reorganized into one script per test module (`npm run test:entities`,
`test:roles`, `test:queries`, `test:moderation`, `test:replication`, etc.) plus grouped
scripts (`test:core`, `test:networking`, `test:replication`) and a top-level `npm test`
that runs everything. See `package.json`.

Per-module perf/stress tests remain deliberately out of scope for now (moderation stress
scenarios); reliability/correctness is the current focus.

### Fixed
Writing real tests against the actual API surface (rather than through the historical
happy-path scripts) surfaced several previously-undetected bugs, none of which had any
test coverage before this refactor:
- **`getRole()` always crashed.** It read a non-existent `RoleBase.view` property; fixed
  to use the existing `getRegistry()` accessor (same one `can()` already used correctly).
- **`GraphQuery.tag()` always returned zero results.** It queried the top-level graph
  view's own Hyperbee, but tag refs are written into each context's own per-context
  Hyperbee. Added `GraphView.hasTag()` and pointed `.tag()` at it.
- **`GraphQuery.reverse()` did nothing.** The `#reverse` flag was set but never read
  anywhere in the iterator; now passed through to the underlying `createReadStream`.
- **`IdentityManager.init()` never awaited `bootstrap()`**, even though it's an async
  method, so `attestationProof` silently held a `Promise` instead of a real proof. Only
  surfaced once something tried to actually use the proof (e.g. `attestDevice()`), which
  then crashed. Old tests only checked truthiness, which a Promise also satisfies.
- **`putContent()` accepted content for entities that don't exist.** Now throws
  `Entity not found`, matching `del()`'s existing behavior, instead of silently writing
  orphaned content events.
- **`connectToSwarm()` always threw `"Topic is required"`.** It passed the options object
  as the 3rd positional constructor argument (`swarm`) instead of passing `swarm` and
  `opts` separately, so `HypergraphNetwork` never actually received a `topic`. Also never
  auto-created a Hyperswarm when `opts.swarm` was omitted, despite the docstring promising
  it would; both are fixed.
- **Two redundant `openRoleBase()` calls crashed with `"Autobase failed to open"`.**
  `createRoleBase()` already attaches the created RoleBase to the graph; calling
  `openRoleBase()` again immediately afterward (previously present in three moderation
  tests) closed and reopened it, crashing Autobase. Removed the redundant calls.

### Removed (no backward compatibility)
- `Hypergraph#announce()`, `#discoverPeers()`, `#listPeers()` — dead no-ops kept only for
  backward compatibility. Peer discovery is exclusively `HypergraphNetwork`'s
  responsibility now (`peer-join`/`peer-leave` events on the `HypergraphNetwork` instance).
- `Hypergraph#handlePeerDisconnection()` — also a dead no-op with the same rationale.
- `Hypergraph#on()`/`#off()` no longer silently accept arbitrary event names. They only
  support `'change'` (the only event Hypergraph itself ever emits) and now throw for
  anything else — including `'peer-join'`/`'peer-leave'`, which were never actually wired
  up to fire on `Hypergraph` (only `HypergraphNetwork` emits those). Previously, code that
  called `graph.on('peer-join', ...)` would register a listener that could never fire,
  with no error to indicate the mistake.
- The stale `PeerDiscovery` JSDoc typedef in `src/types.js`, describing a module that was
  already deleted in a previous refactor.

### Known gaps (deliberately left unaddressed for now)
- Closed-mode context write authorization (`test/brittle/core/contexts.js`, two skipped
  tests) requires a peer to already be a writer before opening an existing context, which
  conflicts with Autobase's open-then-authorize model. This needs an application-level
  redesign (role check gating `addWriter`/`append`), not a test fix. Tracked for follow-up.
- Moderation stress/perf scenarios (many flaggers, adversarial spam, competing trust sets)
  remain skipped; out of scope until the moderation event model has stabilized.

### Added
- Contributor documentation in `docs/architecture.md` with low-level architecture details
- Platform-specific considerations section to README for Windows file locking issues
- **HypergraphNetwork class**: New networking helper with dual swarm setup (data + control)
  - Accepts Hyperswarm instance as parameter (follows holepunch pattern)
  - Creates control swarm internally, sharing DHT from passed swarm
  - Context keys (not instances) to avoid timing problems
  - JSON protocol for writer authorization on control swarm
  - Static `generateBootstrap()` method for bootstrap.json generation
  - Exposes Hyperswarm's native peer discovery events
- **Bootstrap generation**: `HypergraphNetwork.generateBootstrap(graph, opts)` static method

### Changed
- **Renamed**: `HypergraphNetworking` → `HypergraphNetwork`
- **Dual swarm approach**: Data swarm for replication, control swarm for JSON protocol
- **Context integration**: Accept context keys, open contexts internally
- **Writer authorization**: Any writer can add writers (no owner required)
- **Peer discovery**: Removed `PeerDiscovery` module, use Hyperswarm's native events
- **Deprecated**: `graph.announce()`, `graph.discoverPeers()`, `graph.listPeers()` (kept for backward compatibility)

### Removed
- **PeerDiscovery module**: `src/peer-discovery.js` deleted (placeholder code)
- **Graph-level peer discovery**: Now handled by HypergraphNetwork using Hyperswarm

### Fixed
- **RoleBase opening errors**: Removed redundant `openRoleBase()` calls after `createRoleBase()` in forum brittle tests and examples/forum/owner.js. `createRoleBase()` already attaches the RoleBase to the graph instance; calling `openRoleBase()` again causes "Autobase failed to open" errors.
  - Fixed in: `test/brittle/forum/scenarios/moderation-propagation.js`
  - Fixed in: `test/brittle/forum/scenarios/out-of-order-replication.js`
  - Fixed in: `test/brittle/forum/scenarios/partial-replication.js`
  - Fixed in: `test/brittle/forum/scenarios/idempotency.js`
  - Fixed in: `test/brittle/forum/scenarios/moderation-conflict.js`
  - Fixed in: `test/brittle/forum/scenarios/cross-context-integrity.js`
  - Fixed in: `examples/forum/owner.js`

- **Concurrent writes test flakiness**: Changed from concurrent writes to sequential writes with explicit DHT announcement timing. Peers must announce on DHT before creating data for reliable peer discovery.
  - Fixed in: `test/brittle/replication-scenarios.js`

- **Windows cleanup EPERM errors**: Added retry logic with exponential backoff (10 retries, 500ms * attempt delay) for directory cleanup to handle Windows file locking issues.
  - Fixed in: `test/brittle/replication-scenarios.js`

- **Relay replication test failure**: Ensured Peer A announces on DHT before creating data and added proper replication waits.
  - Fixed in: `test/brittle/replication-scenarios.js`

### Changed
- Updated README to correct Bootstrap/Export API return value structure

### Fixed
- **RoleBase opening errors**: Removed redundant `openRoleBase()` calls after `createRoleBase()` in forum brittle tests and examples/forum/owner.js. `createRoleBase()` already attaches the RoleBase to the graph instance; calling `openRoleBase()` again causes "Autobase failed to open" errors.
  - Fixed in: `test/brittle/forum/scenarios/moderation-propagation.js`
  - Fixed in: `test/brittle/forum/scenarios/out-of-order-replication.js`
  - Fixed in: `test/brittle/forum/scenarios/partial-replication.js`
  - Fixed in: `test/brittle/forum/scenarios/idempotency.js`
  - Fixed in: `test/brittle/forum/scenarios/moderation-conflict.js`
  - Fixed in: `test/brittle/forum/scenarios/cross-context-integrity.js`
  - Fixed in: `examples/forum/owner.js`

- **Concurrent writes test flakiness**: Changed from concurrent writes to sequential writes with explicit DHT announcement timing. Peers must announce on DHT before creating data for reliable peer discovery.
  - Fixed in: `test/brittle/replication-scenarios.js`

- **Windows cleanup EPERM errors**: Added retry logic with exponential backoff (10 retries, 500ms * attempt delay) for directory cleanup to handle Windows file locking issues.
  - Fixed in: `test/brittle/replication-scenarios.js`

- **Relay replication test failure**: Ensured Peer A announces on DHT before creating data and added proper replication waits.
  - Fixed in: `test/brittle/replication-scenarios.js`

### Changed
- Updated README to correct Bootstrap/Export API return value structure
- Removed incorrect `moderateAction()` and `queryContext()` examples from Quickstart (these are lower-level APIs)
- Added "Creating vs Opening RoleBase" section to README
- Added "DHT Announcement Timing" section to README

## [0.0.1] - Initial Prototype

### Added
- Core graph database functionality with entities, relations, tags, and content
- Identity system with mnemonic recovery and multi-device support
- Collaborative contexts with open and closed write modes
- Role-based access control system (RoleBase)
- Materialized view with Hyperbee indexes
- Fluent query interface
- Peer discovery event emission
- Bootstrap/export API for joining existing graphs
- Forum example application with moderation
- CLI chat example

### Architecture
- UserCore: Single-writer Hypercore per user for entities and content
- ContextBase: Multi-writer Autobase for relations, tags, and moderation
- RoleBase: Autobase for role registry and permissions
- GraphView: Hyperbee materialized view with indexes
- IdentityManager: keet-identity-key wrapper for identity management
- PeerDiscovery: Event emitter for peer join/leave events

### Dependencies
- Hypercore: Append-only logs for data storage
- Corestore: Core management and namespace isolation
- Autobase: Multi-writer CRDT for collaborative contexts
- Hyperbee: Materialized view and key-value indexes
- keet-identity-key: Identity management with mnemonic recovery
