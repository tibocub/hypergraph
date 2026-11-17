# 027 build: renewing a space, truncation (after research, grilled with Tibo 2026-11-17)

Replaces spec.md's D3, D4, D6, D7 with research.md's design. Tibo's answers to research.md's open questions:
1 yes (old content stays under the old key) · 2 yes (truncation its own action, public spaces too) · 3 **now**
("Secure this place" can also delete history before now) · 4 yes, **with care** (below) · 5 yes (newcomers follow
the `history` setting) · 6 yes (renewing a top space renews its sub-spaces).

## Requirements

- **FR-001 Renew (forward only)**: owners and admins; new decision log, new logs, new disk key sealed to each current
  device; old logs become read-only history read with the old key; record ids unchanged across the move; the "moved
  to" pointer sealed to current devices only; a device switches once the decision is final; two renews at once: the
  first decided wins, the other is told. Sub-spaces renewed with their top space.
- **FR-002 Secure this place**: one call: `rotateKey()` at once, then renew; option `forget: true` also truncates
  everything before the renew point (FR-003).
- **FR-003 Truncation**: own action (owners/admins), private and public spaces: "keep the last N days" or "before
  this point"; a signed trim decision every member's device **and every holder (023/024)** follows (`clear()`), so
  the history stops being served, not only on the deciding device. Test that a holder stops serving trimmed blocks
  and that kept blocks still verify. Members told that copies others already took can't be recalled (docs).
- **FR-004 Writes landing in the old log after the move** (research Q4): the author's own app re-posts its own records
  into the new space with new ids, and only when **all** hold:
  - the record is the device's own (signed by it; never anyone else's: no one re-posts for others);
  - its person is a current member of the renewed space with write rights (a removed person's late writes are dropped,
    never re-posted);
  - it was written after the move decision (earlier ones are history, already readable);
  - not re-posted already (a `from` link to the old id, so a retry or a second device doesn't duplicate; readers show
    only the new one);
  - sealed with the new space's keys (never the old disk key or epoch).
  Readers ignore old-log records written after the move unless re-posted. Tests for each rule, including a removed
  member writing to the old log after the move (dropped everywhere) and two devices of one person (one re-post).
- **FR-005** Newcomers after a renew: the space's `history` setting decides whether they get the old logs (and their
  old disk key, sealed) or start from the move.
- **FR-006** Holders (023/024): hold the new space's cores; drop the old space's 30 days after the move unless it is
  still history someone may read (members keep the history; holders keep it as long as the space's history setting
  needs it — research to state the rule, tested).
- **FR-007** Docs (api, what removed people/holders can still see after `rotateKey()` alone vs after a renew), the
  forum scenario tests, perf (`perf/scenarios`: renew time and bytes at 100 and 1000 devices; trim), regression tests.
  Hypergraph suite Node and Bare, SwarmFS's suite.

## Not in 027

HyperBrowser's UI (HyperBrowser spec 023).

## Design changes after reading the code (approved by Tibo, 2026-11-17)

1. **Hand-over needs a second decider device.** Autobase writer keys are per device, so the renewer can't add other
   deciders up front; they claim with the existing `writer/add` ask once they switch. Any owner or admin device that
   comes online completes the hand-over. The engine exposes whether a renew still waits for another decider device
   (none needed when the renewer is the only decider).
2. **"After the move" = past the cut** recorded in the snapshot (not by time): a record written before the move but
   unseen by the renewer is past the cut too, and its author re-posts it (FR-004's rules otherwise as written).
3. **Sub-spaces get new keys** (remapped in the snapshot): a removed member must not find their topic. Record ids
   (log key + seq) are unchanged.
4. **Holders get trims by a `clear { core, below }` request** (they are blind peers and can't read the trim decision).
   Only a member who handed that space to the holder may send it (024's `delete-core` rule); anyone else is refused
   and the holder keeps serving (tested).
5. **FR-006 rule**: the old decision log (and its topic) is kept and served 30 days after the move; the old message
   logs are history logs of the new space, held and handed with it until a trim clears them.
6. **Snapshot** = the old decision view (minus old Autobase writer keys) copied into the new Autobase as chunked
   `renew/state` decisions by its first writer, before anything else; `space/moved` in the old log carries its hash,
   checked by every switching device.
7. **Each device re-indexes history under the new key** (local work only).
8. **Re-post dedupe**: a re-posted record carries `from` (the old id) in a new record flag (inside the disk-encrypted
   block); only the authoring device re-posts its own log, after checking its new log for that `from`.
