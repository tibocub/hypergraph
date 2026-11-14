// Spec 024: a fixed number of copies, the logic that needs no network
// (lib/circles.js): the split across a member's circles, the ranking of
// holders, the extra copy, rarest first, 7-day replacement, online hours.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { COPIES, UNSEEN_MS, split, holdersOf, extraFor, rarest, markHour, onlineShare, packHours, unpackHours } = require('../../../lib/circles.js')

const key = () => crypto.randomBytes(32).toString('hex')
// `n` people, `per` devices each: [{ device, identity }]
const people = (n, per = 1) => Array.from({ length: n }, () => key()).flatMap((identity) => Array.from({ length: per }, () => ({ device: key(), identity })))

test('the split: 5 copies across the member\'s circles, at least 1 each', (t) => {
  t.is(COPIES, 5)
  const sorted = (parts) => [...parts].sort((a, b) => b - a).join('+')
  for (const [n, want] of [[1, '5'], [2, '3+2'], [3, '2+2+1'], [4, '2+1+1+1'], [5, '1+1+1+1+1'], [7, '1+1+1+1+1+1+1']]) {
    const circles = Array.from({ length: n }, key)
    t.is(sorted(split(key(), circles)), want, n + ' circles')
  }
  const circles = [key(), key()]
  const bigger = new Set()
  for (let i = 0; i < 40; i++) bigger.add(split(key(), circles).indexOf(3))
  t.alike([...bigger].sort(), [0, 1], 'which circle gets the larger part changes from space to space')
  const space = key()
  t.alike(split(space, circles), split(space, [...circles]), 'the same for everyone')
})

test('holders: ranked by hash, stable, one device per person, at most its part per circle', (t) => {
  const space = key()
  const devices = people(8, 2)
  const c = { key: key(), devices }
  const holders = holdersOf(space, [c])
  t.is(holders.length, 5)
  t.is(new Set(holders.map((d) => devices.find((x) => x.device === d).identity)).size, 5, 'five people')
  t.alike(holdersOf(space, [{ key: c.key, devices: [...devices].reverse() }]), holders, 'any order in, the same out')
  t.alike(holdersOf(space, [{ key: c.key, devices: devices.slice(0, 3) }]).length, 2, 'fewer holders than the part: all of them (2 people)')
  t.not(holdersOf(key(), [c]).join(), holders.join(), 'another space, other holders')

  // a holder leaving: the others stay, the next takes over
  const gone = holders[0]
  const after = holdersOf(space, [{ key: c.key, devices: devices.filter((d) => d.identity !== devices.find((x) => x.device === gone).identity) }])
  t.is(after.length, 5)
  t.ok(holders.slice(1).every((d) => after.includes(d)), 'only the one who left is replaced')

  // two circles: 3 + 2, never one person twice
  const shared = people(1)[0]
  const c1 = { key: key(), devices: [shared, ...people(4)] }
  const c2 = { key: key(), devices: [shared, ...people(4)] }
  const two = holdersOf(space, [c1, c2])
  t.is(two.length, 5)
  const inC1 = two.filter((d) => c1.devices.some((x) => x.device === d)).length
  t.ok(inC1 === 3 || inC1 === 2 || (inC1 === 4 && two.includes(shared.device)), 'split 3+2 (the shared person counts once)')
  t.is(new Set(two).size, 5)
})

test('7 days unseen: ranked after everyone seen, until needed again', (t) => {
  const space = key()
  const devices = people(7)
  const c = { key: key(), devices }
  const holders = holdersOf(space, [c])
  const stale = new Set([holders[1]])
  const replaced = holdersOf(space, [c], stale)
  t.absent(replaced.includes(holders[1]), 'replaced')
  t.is(replaced.length, 5)
  t.ok(holders.filter((d) => d !== holders[1]).every((d) => replaced.includes(d)), 'by the next ranked one only')
  const few = { key: c.key, devices: devices.filter((d) => holders.includes(d.device)) }
  t.ok(holdersOf(space, [few], stale).includes(holders[1]), 'a regular holder again when there is nobody else')
  t.is(UNSEEN_MS, 7 * 24 * 3600 * 1000)
})

test('the extra copy: when no copy is online, on the next ranked online holder; dropped at 2 online', (t) => {
  const regular = ['r1', 'r2', 'r3', 'r4', 'r5']
  const candidates = ['s1', 's2']
  const online = (on) => (d) => on.includes(d)
  t.is(extraFor({ prev: null, regular, candidates, online: online(['r1']) }), null, 'one online: none')
  t.is(extraFor({ prev: null, regular, candidates, online: online(['s2']) }), 's2', 'none online: the next online one')
  t.is(extraFor({ prev: 's2', regular, candidates, online: online(['s2', 'r1']) }), 's2', 'kept at 1 online')
  t.is(extraFor({ prev: 's2', regular, candidates, online: online(['s2', 'r1', 'r2']) }), null, 'dropped at 2 online')
  t.is(extraFor({ prev: 's2', regular, candidates, online: online(['s1']) }), 's1', 'moved when it went offline too')
  t.is(extraFor({ prev: null, regular, candidates, online: online([]) }), null, 'nobody online: none')
})

test('rarest first: the fewest copies online first, ties in the given order', (t) => {
  const items = [{ n: 'a', online: 3 }, { n: 'b', online: 0 }, { n: 'c', online: 5 }, { n: 'd', online: 0 }, { n: 'e', online: 1 }]
  t.alike(rarest(items).map((i) => i.n), ['b', 'd', 'e', 'a', 'c'])
})

test('online hours: the last 30 days, as a whole percent', (t) => {
  const H = 3600 * 1000
  const hours = new Set()
  const now = 1000 * 720 * H
  t.is(onlineShare(hours, now), 0)
  for (let i = 0; i < 360; i++) markHour(hours, now - i * H)
  markHour(hours, now) // twice the same hour counts once
  t.is(onlineShare(hours, now), 50)
  markHour(hours, now + 400 * H) // 400 hours later: those older than 30 days go
  t.ok(hours.size < 361, 'old hours dropped')
  t.is(onlineShare(hours, now + 400 * H), Math.round(100 * hours.size / 720))
  const packed = packHours(hours, now + 400 * H)
  t.is(packed.bits.length, 180, 'saved in 90 bytes')
  t.alike([...unpackHours(packed)].sort(), [...hours].sort(), 'and back')
})
