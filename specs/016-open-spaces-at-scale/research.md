# Research: Open spaces at scale

Read in the code on 2026-11-03 (branch `016-open-spaces-at-scale`, from master 4502f88). Paths are
`lib/` (hypergraph/next).

## R1. A public join needs no new header field

**Today**: block 0 of every device log is a header: `{ version, space, decisions, proof, admitted }`
(`lib/encodings.js` `header`, `lib/log.js` `OwnLog.ready`). `proof` is the device's attestation, on its
identity's behalf, over `hypergraph/log\0 + logKey + space` (`logSignable`). Readers check it in
`lib/gate.js` `checkLog` → `readHeader`, then ask `limitOf(identity, ...)`: Infinity if the identity may
write, 0 if not, a cut length if cut.

**Finding**: that proof already says "this identity writes this log in this space". A separate signed
redemption would prove nothing more: nobody signs the public link (Decision 6), so the only check left
is "is the space public?", which is a decision-log fact.

**Decision**: no header change. In a public space, an identity the decision log doesn't name counts as
role `member` (R3). A newcomer's join is its log's ordinary header. Old logs stay valid byte for byte;
`enc.VERSION` doesn't move.

**Alternatives**: a `join` trailing field signed over the space key (the spec's first wording): more
bytes per log, a second check, same meaning. Rejected.

## R2. "Public" is a one-way setting

**Decision**: `settings/set` gains a trailing field `public` (bool). Apply (`lib/decisions/apply.js`): a
writer allowed to decide (owner, admin) may set it to `true` on the top space or a sub-space (scoped, as
`settings/set` already is); `public: false` on a public scope is ignored (listed as not counted, like any
decision its author couldn't make). Stored in `meta` (and a sub-space's own meta); `State.public` reads it,
a sub-space doesn't inherit it (a public forum may keep a staff sub-space closed).

**Why one-way is deterministic**: a header join counts iff the decision log, as applied, says public. Once
true it never turns false, so every member reaches the same answer for every log however late it sees the
header. A "close" could not be: no order between a header and the decision log (spec Decision 6).

**API**: `space.makePublic()` (owner or admin; `NOT_ALLOWED` otherwise; resolves when recorded);
`space.isPublic`; `space.publicLink()` (R5). Undoing it: no call; `setPublic(false)`-style calls don't
exist, and the decision is refused if forged (FR-001).

## R3. Roles for people the decision log doesn't name

**Today**: `State.roleOf(h)` reads `member:<h>`; `isMember`, `can`, `canWrite`, `limitOf` all go through
it (`lib/decisions/state.js`). `members()` (`lib/space.js`) lists `state.members`, `banned`, `cuts`, and
attaches devices from `directory.logs`.

**Decision**: `roleOf(h)` = the recorded role, else (`public` and not banned) → `'member'`, else null.
Everything built on it (writing, limits, `#redeem`'s early return, `_redeem`'s loop) follows. Removal in
a public space: `member/remove` cuts the person's logs as today; with no `member:` entry they fall back to
`member` and write in a new log (`#openOwnLog` already opens the next generation when the current one is
cut). `mustAdmit`/admission codes (story 9) don't apply to public fallbacks: a public space lets anyone
back in by definition. Bans: `banned:` wins over the fallback.

`members()` adds every identity of a held log (`directory.logs`) whose role is the fallback `member`.
The `members` event already fires on each accepted device log (`accepted`, `lib/space.js` line ~420).
SwarmFS's uses (`lib/drive.js` device → identity, `lib/members.js` "shared?") keep working: its file
spaces aren't public (invite links only).

**Sub-spaces**: a public sub-space of a non-public top space: its fallback applies only within it
(scoped state, `SubState`). A top-space public member reads a closed sub-space only if invited, as today.

## R4. No log for a member before its first record

**Today**: `#onDecisions` accepts this device's own log into the directory as soon as it is a member
(line ~552), so it is announced and listed even if never written; `#log()` (line ~898) also accepts it
before a write.

**Decision**: drop the accept in `#onDecisions` for public and invited members alike; `#log()` keeps it,
so the log is announced at the first write. `OwnLog.ready` still writes the header locally at open (a
local core, never announced: costs others nothing). Exception: a **private** space accepts it at join,
because key holders grant devices they see (`#keyWork` → `#grantState`, `entitled` from accepted logs);
that's the private-spaces revision's cost (scale audit #3), out of scope.

**Risk to check while building**: code that assumed `this.own` is in `directory.logs` once a member
(status, `inspect()`, budget passes, activity). Each one gets a test or the guard `#log()` already has.

## R5. The public link

**Today**: links are `hg:` + z32(an encoded invite [+ root]) (`lib/invites.js` `encodeLink`,
`decodeLink`); `decodeLink` rejects anything that isn't a whole invite.

**Decision**: a public link is `hg:` + z32(space key [+ root key for a sub-space]): 32 or 64 bytes, no
signature (nobody makes it; it opens nothing by itself: a space that isn't public lets no one in with it).
`decodeLink` tells them apart by length (an encoded invite is always longer than 64 bytes). Same for every
member, derivable by anyone holding the space key (already in every member's hands).
`hg.redeemInvite(link)` (and `hg.scope`'s link path): for a public link, open the space, reach one peer,
wait until the decision log is loaded (`state.meta`), then: public → resolved, member at once, nothing
sent; not public → `INVITE_INVALID` "This space isn't public". The `redeem` message is not sent.
`redemptions(publicLink)` lists known public members (from `members()`).

## R6. Logs open only while used

Taken from spec 015's research R4 unchanged (see `specs/015-one-engine/research.md` R4): a directory entry
keeps key, identity, device, limit and indexed length without an open core; a core opens while it is own,
behind (an activity entry or a peer's length says so), read beyond the index, or needed by a budget pass;
closes 30 s after. Corestore serves closed held cores to peers who ask (`_attachMaybe`). Bound: ~20 open
(SC-004). `Replicator.hold` becomes "hold while open"; `#watch` and the download range follow the open
core. The decision log's writer cores stay open (Autobase).

**Risk**: a closed log of a member who writes while this peer is away: learnt from the period's activity
list at next contact (story 9). Fallback if a case is missed: keep logs of authors active in the newest
period open.

## R7. Settling log-list differences by ranges

**Today**: a summary is `{ count, XOR digest, records }`; any difference → `want` → every key, in chunks
of 1,000 (`lib/directory.js` `#onSummary`, `#onWant`). Big spaces for a newcomer skip it (`byActivity`,
`BIG.logs = 300`), but full members of a big space still swap whole lists.

**Decision**: range-based reconciliation (the Negentropy idea, kept minimal): keys are 32 random bytes, so
split by leading bits. A `ranges` message carries, for a range (prefix), 16 sub-ranges' `{ count, XOR
digest }` (16 × 36 B ≈ 580 B). The receiver compares with its own: equal sub-ranges stop; a different one
with ≤ 32 keys on either side is answered with its keys; otherwise recurse with that sub-range. One new log
among L: ⌈log16(L/32)⌉ rounds, each ~600 B: L = 10k → 2-3 rounds ≈ 1.5 KB; L = 1M → 4 rounds ≈ 2.5 KB
(today 320 KB and 32 MB). Per-range digests are computed on demand from a sorted key list kept in memory
(32 B per log, already held as the `logs` Map's keys).

**Spec change**: SC-005 becomes "under 3 KB at 10k logs, flat to 1M" (1 KB isn't reachable with this
scheme; worth nothing extra to chase).

**Alternatives**: sending the whole list after a notice was missed (today); "logs since my n-th" (each
peer's acceptance order differs, needs per-peer state); full Negentropy with fingerprints and a
library (none in the Holepunch stack; rule: thin composition, no new dependency for ~80 lines).

## R8. Helpers' `listed:` entries: deferred (Story 6)

**Finding**: helpers are blind peers: they hold cores by key and don't open the space channel, so they
can't serve a log list or activity lists. `listed:` (`logs/list`, written by a decider's device,
`#listLogs`) is how a newcomer finds logs on a helper with every member offline. Removing it needs a
replacement a blind peer can serve (a plain Hypercore of log keys per decider, or activity periods stored
in a core), which is a design of its own.

**Decision**: Story 6 moves to the helpers follow-up; `listed:` stays. Its cost drops anyway: with R4 a
log exists only once its author wrote, so `listed:` grows with **posters**, not accounts (the audit's
worry was silent accounts). FR-041 leaves this spec.

## R9. Versions: everyone updates together

`settings/set public` and the role fallback are apply-time: a peer without them derives a different
view, and divergent indexers break Autobase's agreement. The range messages are a wire change.

**Decision**: the space channel's protocol name becomes `hypergraph/space/2` (`lib/directory.js`
`PROTOCOL`): old and new peers don't open the channel together (Protomux pairs by name), so nothing is
half-synced; `status()` gains `OTHER_VERSION` when a peer's connection carries the old channel and not
the new (seen from the muxer's unpaired channel). Decision-log replication between versions still flows
(Autobase cores), which is the same situation as spec 015's `types/set`; CHANGELOG and ECOSYSTEM.md say
"update every app together". SwarmFS runs on this checkout, so it moves with it.

## R10. Perf scenarios (perf-on-change rule)

New in `perf/scenarios/` (real flows, `flat` where the cost must not grow):

- `public-join`: a forum with N public members already known (N = 1k, 10k), one more joins and posts:
  time until a third member reads the post; other members' CPU time and memory delta: `flat`.
- `newcomer-first-page`: bytes downloaded before `latest(20)` with N silent public members: `flat`.
- `held-logs-start`: a full member holding L logs (1k, 10k) opens the space: start time and open cores:
  `flat` (R6).
- `list-settle`: two peers with L logs, one new log: bytes until equal: `flat` (R7).

Peers that would be on other machines run in their own processes (`perf/harness.mjs` `child`). The
10k sizes use scripted members writing headers only (fast), not real joins one by one; extrapolation to
1M stated in the results, not claimed as measured.
