// Spec 023: circles, the logic that needs no network (test/next/unit/circles.js).
// The holding itself (a blind peer in the instance, handing) is lib/holding.js.

const MAX_MEMBERS = 50 // a circle's members, at most (FR-002)
const MEMBER_BYTES = 200e6 // what a holder keeps of one member, at most (FR-006)
const SHARE_BYTES = 1e9 // a device's share for all its circles, by default (FR-004)

// What a member hands, in order: private spaces first, then the rest, the
// newest activity first in each; stops before the first one that would pass
// `cap` bytes (the rest waits: their oldest activity goes first, FR-006).
// spaces: [{ private, activity, bytes, ... }] -> { hand, skip }
function plan (spaces, cap) {
  const sorted = [...spaces].sort((a, b) => (b.private ? 1 : 0) - (a.private ? 1 : 0) || b.activity - a.activity)
  let used = 0
  let i = 0
  for (; i < sorted.length && used + sorted[i].bytes <= cap; i++) used += sorted[i].bytes
  return { hand: sorted.slice(0, i), skip: sorted.slice(i) }
}

// A holder's cores no member still sharing a circle with it covers (FR-009,
// FR-010). held: Map core -> Set of members who handed it, updated in place
// (uncovered members forgotten, cores returned forgotten); covered: Set of
// members still sharing a circle with this holder.
function uncovered (held, covered) {
  const out = []
  for (const [core, by] of held) {
    for (const who of by) if (!covered.has(who)) by.delete(who)
    if (by.size) continue
    held.delete(core)
    out.push(core)
  }
  return out
}

module.exports = { MAX_MEMBERS, MEMBER_BYTES, SHARE_BYTES, plan, uncovered }
