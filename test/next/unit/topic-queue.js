// Spec 015 (US3, research.md R1): topic joins go through one queue, paced
// under the DHT node's request window: one background join at a time, a
// space in use at once, at most `maxAnnounced` topics announced, a left
// space's topic kept for a grace period. Against a fake swarm: what is asked
// of Hyperswarm, in what order.

const test = require('brittle')
const b4a = require('b4a')
const { Network } = require('../../../lib/network.js')

function fakeSwarm () {
  const swarm = {
    joins: [], // [{ hex, server, client }] in order
    refreshes: [],
    destroyed: [],
    sessions: new Map(),
    keyPair: { publicKey: b4a.alloc(32, 1) },
    on () {},
    join (topic, opts) {
      const hex = b4a.toString(topic, 'hex')
      let release
      const flushed = new Promise((resolve) => { release = resolve })
      const session = {
        hex,
        opts,
        release,
        destroyed: false,
        flushed: () => flushed,
        refresh: async (o) => { swarm.refreshes.push({ hex, ...(o || {}) }) },
        destroy: async () => { session.destroyed = true; swarm.destroyed.push(hex) }
      }
      swarm.joins.push({ hex, server: opts.server, client: opts.client })
      swarm.sessions.set(hex, session)
      return session
    },
    async destroy () {}
  }
  return swarm
}

let n = 0
function fakeSpace ({ own = false, pinned = false, used = 0 } = {}) {
  const key = b4a.alloc(32)
  key.writeUInt32BE(++n)
  return {
    hex: b4a.toString(key, 'hex'),
    discoveryKey: key,
    opened: true,
    closed: false,
    _uses: 0,
    _own: own,
    _pinned: pinned,
    _used: used,
    directory: { attach () {}, peers: 0 }
  }
}

function network (opts = {}) {
  const swarm = fakeSwarm()
  const hg = { _spaces: new Map(), emit () {}, store: { replicate () {} } }
  const net = new Network(hg, { swarm, maxAnnounced: 2, graceMs: 50, ...opts })
  return { net, swarm, hg }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('one background join at a time; the next after the first flushed', async (t) => {
  const { net, swarm } = network()
  await net.connect()
  const a = fakeSpace()
  const b = fakeSpace()
  net.join(a)
  net.join(b)
  await tick()
  t.is(swarm.joins.length, 1, 'only the first is asked')
  swarm.sessions.get(a.hex).release()
  await tick()
  await tick()
  t.is(swarm.joins.length, 2, 'the second after the first flushed')
  swarm.sessions.get(b.hex).release()
  await net.close()
})

test('a space in use joins at once, past the queue', async (t) => {
  const { net, swarm } = network()
  await net.connect()
  const spaces = [fakeSpace(), fakeSpace(), fakeSpace()]
  for (const s of spaces) net.join(s)
  const visited = fakeSpace()
  net.join(visited, { now: true })
  await tick()
  t.alike(swarm.joins.map((j) => j.hex), [spaces[0].hex, visited.hex], 'the visit does not wait for the background')
  for (const s of swarm.sessions.values()) s.release()
  await net.close()
})

test('queued joins run by priority: pinned, own, then recent, then age', async (t) => {
  const { net, swarm } = network({ maxAnnounced: 10 })
  await net.connect()
  const first = fakeSpace()
  net.join(first) // takes the slot
  const recent = fakeSpace({ used: 5 })
  const older = fakeSpace({ used: 1 })
  const pinned = fakeSpace({ pinned: true })
  const own = fakeSpace({ own: true })
  for (const s of [older, recent, pinned, own]) net.join(s)
  for (let i = 0; i < 6; i++) {
    for (const s of swarm.sessions.values()) s.release()
    await tick()
    await tick()
  }
  t.alike(swarm.joins.map((j) => j.hex), [first, pinned, own, recent, older].map((s) => s.hex))
  await net.close()
})

test('at most maxAnnounced topics announced; the rest only look', async (t) => {
  const { net, swarm } = network({ maxAnnounced: 2 })
  await net.connect()
  const spaces = [fakeSpace(), fakeSpace(), fakeSpace()]
  const done = spaces.map((s) => net.join(s))
  for (let i = 0; i < 4; i++) {
    for (const s of swarm.sessions.values()) s.release()
    await tick()
  }
  await Promise.all(done)
  t.alike(swarm.joins.map((j) => j.server), [true, true, false])
  t.ok(swarm.joins.every((j) => j.client), 'every one looks for peers')
  t.is(net.announced.size, 2)
  await net.close()
})

test('an own space takes an announce slot from a space that is not', async (t) => {
  const { net, swarm, hg } = network({ maxAnnounced: 1 })
  await net.connect()
  const other = fakeSpace()
  const own = fakeSpace({ own: true })
  for (const s of [other, own]) hg._spaces.set(s.hex, s)
  const first = net.join(other)
  swarm.sessions.get(other.hex).release()
  await first
  const second = net.join(own)
  for (let i = 0; i < 4; i++) {
    for (const s of swarm.sessions.values()) s.release()
    await tick()
  }
  await second
  t.ok(net.announced.has(own.hex), 'own announced')
  t.absent(net.announced.has(other.hex), 'the other no longer')
  t.alike(swarm.refreshes.filter((r) => r.hex === other.hex).map((r) => r.server), [false], 'the other asked to stop announcing')
  await net.close()
})

test('leaving with a grace period: kept a while, a join meanwhile keeps it', async (t) => {
  const { net, swarm } = network({ graceMs: 40 })
  await net.connect()
  const a = fakeSpace()
  const b = fakeSpace()
  for (const s of [a, b]) {
    const p = net.join(s, { now: true })
    swarm.sessions.get(s.hex).release()
    await p
  }
  net.leave(a, { grace: true })
  net.leave(b, { grace: true })
  await net.join(b, { now: true }) // back within the grace period
  t.is(swarm.destroyed.length, 0, 'nothing left at once')
  await new Promise((resolve) => setTimeout(resolve, 80))
  t.alike(swarm.destroyed, [a.hex], 'only the one not used again')
  t.absent(net.topics.has(a.hex))
  t.ok(net.topics.has(b.hex))
  await net.close()
})

test('leaving at once (a space left or dropped) drops its queued join', async (t) => {
  const { net, swarm } = network()
  await net.connect()
  const a = fakeSpace()
  const b = fakeSpace()
  net.join(a)
  const queued = net.join(b)
  await net.leave(b)
  swarm.sessions.get(a.hex).release()
  await queued
  await tick()
  t.alike(swarm.joins.map((j) => j.hex), [a.hex], 'b never joined')
  await net.close()
})
