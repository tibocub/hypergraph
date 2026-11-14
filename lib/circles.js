// Specs 023 and 024: circles, the logic that needs no network
// (test/next/unit/circles.js, copies.js). The holding itself (a blind peer in
// the instance, handing) is lib/holding.js.

const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const MAX_MEMBERS = 50 // a circle's members, at most (FR-002)
const MEMBER_BYTES = 200e6 // what a holder keeps of one member, at most (FR-006)
const SHARE_BYTES = 1e9 // a device's share for all its circles, by default (FR-004)
const COPIES = 5 // copies of each space a member hands, in all (spec 024 FR-001)
const UNSEEN_MS = 7 * 24 * 3600 * 1000 // a holder unseen this long is replaced (FR-006)
const HOUR_MS = 3600 * 1000
const HOURS = 30 * 24 // online hours are counted over the last 30 days (FR-007)
const LOOKED_HOURS = 24 // hours this device was online since it last saw a holder, at least, before replacing it

// keys hex -> a 32-byte hash both sides compute the same
const score = (...keys) => crypto.hash(b4a.concat(keys.map((k) => b4a.from(k, 'hex'))))
const byScore = (key) => (a, b) => b4a.compare(score(key, a), score(key, b))

// How many copies of a space each circle keeps (spec 024 FR-001): COPIES as
// evenly as possible, at least 1 each; the larger parts go to the circles
// first by a hash of (space, circle). circles: [key hex] -> [count], aligned.
function split (space, circles) {
  const order = [...circles].sort(byScore(space))
  const base = Math.max(1, Math.floor(COPIES / circles.length))
  const more = Math.max(0, COPIES - base * circles.length)
  return circles.map((c) => base + (order.indexOf(c) < more ? 1 : 0))
}

// The holders of a space (FR-002): in each circle (its part, FR-001) its
// holding devices ranked by a hash of (space, device), the top ones, one
// device per person in all; `stale` ones (unseen 7 days, FR-006) only after
// everyone else. A circle short of its part (too few holding, or its people
// already picked in another): the rest from the next ranked of the others,
// in the same circle order, up to the parts' total. Three passes, each in
// that circle order: fresh devices up to each part, fresh ones for the
// rest, then stale ones if still short.
// circles: [{ key, devices: [{ device, identity }] }] -> [device hex]
function holdersOf (space, circles, stale = new Set()) {
  const parts = split(space, circles.map((c) => c.key))
  const order = [...circles.keys()].sort((i, j) => byScore(space)(circles[i].key, circles[j].key))
  const ranked = circles.map((c) => c.devices.map((d) => d.device).sort(byScore(space)))
  const identity = new Map(circles.flatMap((c) => c.devices.map((d) => [d.device, d.identity])))
  const wanted = parts.reduce((a, b) => a + b, 0)
  const out = []
  const people = new Set()
  const pick = (i, max, stalePass) => {
    let n = 0
    for (const d of ranked[i]) {
      if (n === max || out.length === wanted) break
      if (stale.has(d) !== stalePass || people.has(identity.get(d))) continue
      people.add(identity.get(d))
      out.push(d)
      n++
    }
  }
  for (const i of order) pick(i, parts[i], false)
  for (const i of order) pick(i, Infinity, false) // the top-up
  for (const i of order) pick(i, Infinity, true) // stale ones, if still short
  return out
}

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

// The extra copy of a space (FR-005): none while 2 of its regular holders
// are online; with none online, `prev` if still online, else the first
// online of `candidates` (the next ranked); kept meanwhile (1 online).
function extraFor ({ prev, regular, candidates, online }) {
  const n = regular.filter(online).length
  if (n >= 2) return null
  if (n === 1 || (prev && online(prev))) return prev
  return candidates.find(online) || null
}

// The fewest copies online first (FR-004); ties keep their order.
function rarest (items) {
  return [...items].sort((a, b) => a.online - b.online)
}

// Whether a holder last seen at `seenAt` (ms) is replaced (FR-006): unseen
// 7 days, and this device online itself (its own `hours`, FR-007) at least
// LOOKED_HOURS since then, so a device back after a long time off doesn't
// replace every holder it hasn't had the time to see yet.
function unseen (seenAt, hours, now) {
  if (now - seenAt <= UNSEEN_MS) return false
  const from = Math.floor(seenAt / HOUR_MS)
  let n = 0
  for (const h of hours) if (h > from) n++
  return n >= LOOKED_HOURS
}

// Online hours (FR-007, FR-008): `hours`, a Set of hour numbers (since
// 1970), gets the one of `now`; older than 30 days ago are dropped.
function markHour (hours, now) {
  const hour = Math.floor(now / HOUR_MS)
  hours.add(hour)
  for (const h of hours) if (h <= hour - HOURS) hours.delete(h)
}

// The share of the last 30 days' hours in `hours`, a whole percent.
function onlineShare (hours, now) {
  const hour = Math.floor(now / HOUR_MS)
  let n = 0
  for (const h of hours) if (h > hour - HOURS && h <= hour) n++
  return Math.round(100 * n / HOURS)
}

// Online hours as saved (R4): { hour, bits }, bit i of the 90 bytes (hex)
// set when online `i` hours before `hour`.
function packHours (hours, now) {
  const hour = Math.floor(now / HOUR_MS)
  const bits = b4a.alloc(HOURS / 8)
  for (const h of hours) {
    const i = hour - h
    if (i >= 0 && i < HOURS) bits[i >> 3] |= 1 << (i & 7)
  }
  return { hour, bits: b4a.toString(bits, 'hex') }
}

function unpackHours ({ hour, bits }) {
  const buf = b4a.from(bits, 'hex')
  const out = new Set()
  for (let i = 0; i < buf.byteLength * 8; i++) if (buf[i >> 3] & (1 << (i & 7))) out.add(hour - i)
  return out
}

module.exports = { MAX_MEMBERS, MEMBER_BYTES, SHARE_BYTES, COPIES, UNSEEN_MS, plan, uncovered, split, holdersOf, extraFor, rarest, unseen, markHour, onlineShare, packHours, unpackHours }
