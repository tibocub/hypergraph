// A fixed number of copies, the logic that needs no network
// (lib/circles.js): the split across a member's circles, the ranking of
// holders, the extra copy, rarest first, 7-day replacement, online hours.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { COPIES, UNSEEN_MS, split, holdersOf, extraFor, rarest, unseen, markHour, onlineShare, packHours, unpackHours } = require('../../../lib/circles.js')

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
  t.is(holdersOf(space, [{ key: c.key, devices: devices.slice(0, 3) }]).length, 2, 'fewer holders than the part: all of them (2 people)')
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

test('a circle short of its part: the missing copies from the other circles', (t) => {
  const inBoth = (two, c) => two.filter((d) => c.devices.some((x) => x.device === d)).length
  for (let i = 0; i < 20; i++) { // whichever circle the hash gives the 3
    const space = key()
    const c1 = { key: key(), devices: people(6) }
    const c2 = { key: key(), devices: people(1) }
    const two = holdersOf(space, [c1, c2])
    t.is(two.length, 5, '5 copies')
    t.is(inBoth(two, c1), 4, '4 in the first circle')
    t.ok(two.includes(c2.devices[0].device), 'the second circle\'s one device')
    t.alike(holdersOf(space, [c2, c1]), two, 'the same whatever the order given')
  }
  // stale ones still last in the top-up
  const space = key()
  const c1 = { key: key(), devices: people(5) }
  const c2 = { key: key(), devices: people(1) }
  const all = holdersOf(space, [c1, c2])
  const left = c1.devices.map((d) => d.device).find((d) => !all.includes(d))
  const stale = new Set(all.filter((d) => d !== c2.devices[0].device).slice(0, 1))
  const again = holdersOf(space, [c1, c2], stale)
  t.is(again.length, 5)
  t.ok(again.includes(left), 'the one left out comes in before the stale one')
  t.absent(again.includes([...stale][0]))
})

test('stale devices after every fresh one of every circle: within a part, and in the top-up', (t) => {
  for (let i = 0; i < 20; i++) {
    // a 3 + 2 split: the 3-circle has 2 fresh and 1 stale, the other a spare fresh one
    const space = key()
    const keys = [key(), key()]
    const three = split(space, keys).indexOf(3)
    const big = { key: keys[three], devices: people(3) }
    const small = { key: keys[1 - three], devices: people(3) }
    const stale = new Set([big.devices[0].device])
    const circles = three === 0 ? [big, small] : [small, big]
    const out = holdersOf(space, circles, stale)
    t.is(out.length, 5)
    t.absent(out.includes(big.devices[0].device), 'the stale one left out: the other circle\'s spare instead')
  }
  for (let i = 0; i < 20; i++) {
    // three circles, the third empty: the top-up takes the fresh spares, whichever circle comes first
    const space = key()
    const keys = [key(), key(), key()]
    const parts = split(space, keys)
    const x = { key: keys[0], devices: people(parts[0] + 1) } // its spare is stale
    const y = { key: keys[1], devices: people(parts[1] + 2) } // two fresh spares
    const z = { key: keys[2], devices: [] }
    const stale = new Set(x.devices.map((d) => d.device))
    const out = holdersOf(space, [x, y, z], new Set([...stale].slice(0, 1)))
    t.is(out.length, 5)
    t.absent(out.includes([...stale][0]), 'a stale device in one circle after a fresh spare in another')
  }
})

test('the same person in two circles counts once, the top-up included', (t) => {
  const space = key()
  const shared = people(1)[0]
  const c1 = { key: key(), devices: [shared, ...people(1)] }
  const c2 = { key: key(), devices: [shared, ...people(1)] }
  const two = holdersOf(space, [c1, c2])
  t.is(two.length, 3, 'three people, three copies (never the shared one twice)')
  t.is(new Set(two).size, 3)
  const deviceTwo = { device: key(), identity: shared.identity } // the shared person's other device
  t.is(holdersOf(space, [c1, { key: c2.key, devices: [...c2.devices, deviceTwo] }]).length, 3, 'nor two of their devices')
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

test('unseen: 7 days, and this device online 24 hours itself since', (t) => {
  const H = 3600 * 1000
  const seenAt = 1000 * 720 * H
  const now = seenAt + 10 * 24 * H // 10 days later
  const online = (n) => new Set(Array.from({ length: n }, (_, i) => Math.floor(now / H) - i))
  t.ok(unseen(seenAt, online(24), now), 'online a day since: replaced')
  t.absent(unseen(seenAt, online(1), now), 'off 10 days, back 10 minutes: not replaced')
  t.absent(unseen(seenAt, new Set(), now), 'never online since')
  t.absent(unseen(seenAt, online(48), seenAt + 6 * 24 * H), 'under 7 days: never')
  const before = new Set(Array.from({ length: 48 }, (_, i) => Math.floor(seenAt / H) - i))
  t.absent(unseen(seenAt, before, now), 'hours before it was last seen don\'t count')
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
