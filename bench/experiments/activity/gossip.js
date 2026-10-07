// Experiment 1 (design brief, point 5): activity lists passed between members.
//
// Each member keeps, per time period, the list of authors active in it (one
// entry per author, signed by the author) and passes it on. This measures, on
// real Hyperswarm connections over a local DHT (127.0.0.1):
//
//   newcomer: M members hold a period's list of N entries; a newcomer joins and
//             gets it. Time from join to holding the whole list, bytes it
//             received (including duplicates when several members answer).
//   spread:   P members with a limited number of connections each (so most
//             pairs are several hops apart); authors announce new entries and
//             every member passes them on. Time until every member holds an
//             entry, and how many copies each member receives.
//
//   node bench/experiments/activity/gossip.js newcomer [--entries N] [--members M] [--verify]
//   node bench/experiments/activity/gossip.js spread [--peers P] [--degree D] [--announces A] [--lazy]
//
// --lazy: members pass on a short notice (author, period, start: ~42 B) instead
// of the entry (~135 B); a member that lacks it asks the first one that told
// it (as Scuttlebutt's epidemic broadcast trees / Plumtree do, simplified).

const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')
const Protomux = require('protomux')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')

const argValue = (name, def) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? def : Number(process.argv[i + 1])
}
const flag = (name) => process.argv.includes(name)
const now = () => Number(process.hrtime.bigint()) / 1e6
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PERIOD = 1
const CHUNK = 1000 // entries per message (~135 KB)

// --- entries -----------------------------------------------------------------

const entryEnc = {
  preencode (state, e) {
    c.fixed32.preencode(state, e.author)
    c.fixed32.preencode(state, e.log)
    c.uint.preencode(state, e.start)
    c.uint.preencode(state, e.period)
    c.fixed64.preencode(state, e.sig)
  },
  encode (state, e) {
    c.fixed32.encode(state, e.author)
    c.fixed32.encode(state, e.log)
    c.uint.encode(state, e.start)
    c.uint.encode(state, e.period)
    c.fixed64.encode(state, e.sig)
  },
  decode (state) {
    return {
      author: c.fixed32.decode(state),
      log: c.fixed32.decode(state),
      start: c.uint.decode(state),
      period: c.uint.decode(state),
      sig: c.fixed64.decode(state)
    }
  }
}
const summaryEnc = c.array({
  preencode (state, s) { c.uint.preencode(state, s.period); c.uint.preencode(state, s.count); c.fixed32.preencode(state, s.digest) },
  encode (state, s) { c.uint.encode(state, s.period); c.uint.encode(state, s.count); c.fixed32.encode(state, s.digest) },
  decode (state) { return { period: c.uint.decode(state), count: c.uint.decode(state), digest: c.fixed32.decode(state) } }
})
const entriesEnc = c.array(entryEnc)
const refEnc = {
  preencode (state, r) { c.fixed32.preencode(state, r.author); c.uint.preencode(state, r.period); c.uint.preencode(state, r.start) },
  encode (state, r) { c.fixed32.encode(state, r.author); c.uint.encode(state, r.period); c.uint.encode(state, r.start) },
  decode (state) { return { author: c.fixed32.decode(state), period: c.uint.decode(state), start: c.uint.decode(state) } }
}

function signable (e) {
  const b = Buffer.alloc(32 + 32 + 16)
  e.author.copy(b, 0)
  e.log.copy(b, 32)
  b.writeBigUInt64BE(BigInt(e.start), 64)
  b.writeBigUInt64BE(BigInt(e.period), 72)
  return b
}

function makeEntry (keyPair, period, start) {
  const e = { author: keyPair.publicKey, log: crypto.randomBytes(32), start, period, sig: null }
  e.sig = crypto.sign(signable(e), keyPair.secretKey)
  return e
}

const verifyEntry = (e) => crypto.verify(signable(e), e.sig, e.author)
const entryHash = (e) => crypto.hash(Buffer.concat([e.author, e.log, Buffer.from(String(e.start))]))

// --- a member ----------------------------------------------------------------

class Member {
  constructor (bootstrap, { verify = false, maxPeers, lazy = false } = {}) {
    this.swarm = new Hyperswarm({ bootstrap, maxPeers })
    this.verify = verify
    this.lazy = lazy
    this.asked = new Set() // author hex + start, asked for already
    this.lists = new Map() // period -> Map(authorHex -> entry)
    this.digests = new Map() // period -> xor of entry hashes
    this.channels = new Set()
    this.wanting = new Set() // periods with a request in flight
    this.received = { bytes: 0, entries: 0, duplicates: 0 }
    this.onEntry = null
    this.swarm.on('connection', (conn) => this.#connect(conn))
  }

  #connect (conn) {
    conn.on('error', () => {})
    const mux = Protomux.from(conn)
    const ch = mux.createChannel({ protocol: 'hg-activity-exp', onclose: () => this.channels.delete(ch) })
    if (!ch) return
    ch.peerKey = conn.remotePublicKey
    ch.summary = ch.addMessage({ encoding: summaryEnc, onmessage: (m) => this.#onSummary(ch, m) })
    ch.want = ch.addMessage({ encoding: c.uint, onmessage: (p) => this.#onWant(ch, p) })
    ch.entries = ch.addMessage({ encoding: entriesEnc, onmessage: (m) => this.#onEntries(ch, m) })
    ch.announce = ch.addMessage({ encoding: entryEnc, onmessage: (e) => this.#onAnnounce(ch, e) })
    ch.have = ch.addMessage({ encoding: refEnc, onmessage: (r) => this.#onHave(ch, r) })
    ch.get = ch.addMessage({ encoding: refEnc, onmessage: (r) => this.#onGet(ch, r) })
    ch.open()
    this.channels.add(ch)
    ch.summary.send(this.summary())
  }

  summary () {
    return [...this.lists].map(([period, list]) => ({ period, count: list.size, digest: this.digests.get(period) }))
  }

  #onSummary (ch, theirs) {
    for (const s of theirs) {
      const mine = this.lists.get(s.period)
      const same = mine && mine.size === s.count && this.digests.get(s.period).equals(s.digest)
      if (same || this.wanting.has(s.period)) continue
      // Ask one member at a time; once its answer arrives, compare again with
      // the others (their summaries are re-sent after every answer).
      this.wanting.add(s.period)
      ch.want.send(s.period)
    }
  }

  #onWant (ch, period) {
    const list = [...(this.lists.get(period) || new Map()).values()]
    for (let i = 0; i < list.length; i += CHUNK) ch.entries.send(list.slice(i, i + CHUNK))
    ch.entries.send([]) // empty batch = end of the list
  }

  #onEntries (ch, entries) {
    this.received.bytes += c.encode(entriesEnc, entries).byteLength
    if (entries.length === 0) {
      for (const p of [...this.wanting]) this.wanting.delete(p)
      for (const other of this.channels) if (other !== ch) other.summary.send(this.summary())
      if (this.onEntry) this.onEntry(null)
      return
    }
    for (const e of entries) this.add(e)
  }

  #onAnnounce (ch, e) {
    this.received.bytes += c.encode(entryEnc, e).byteLength
    if (this.add(e)) this.#passOn(e, ch)
  }

  #passOn (e, from) {
    const ref = { author: e.author, period: e.period, start: e.start }
    for (const other of this.channels) {
      if (other === from) continue
      if (this.lazy) other.have.send(ref)
      else other.announce.send(e)
    }
  }

  #onHave (ch, r) {
    this.received.bytes += c.encode(refEnc, r).byteLength
    this.received.entries++
    const held = (this.lists.get(r.period) || new Map()).get(r.author.toString('hex'))
    if (held && held.start >= r.start) { this.received.duplicates++; return }
    const id = r.author.toString('hex') + r.start
    if (this.asked.has(id)) return
    this.asked.add(id)
    ch.get.send(r)
  }

  #onGet (ch, r) {
    const held = (this.lists.get(r.period) || new Map()).get(r.author.toString('hex'))
    if (held) ch.announce.send(held)
  }

  // Returns true if the entry was new (or newer than the one held).
  add (e) {
    this.received.entries++
    const key = e.author.toString('hex')
    let list = this.lists.get(e.period)
    if (!list) {
      list = new Map()
      this.lists.set(e.period, list)
      this.digests.set(e.period, Buffer.alloc(32))
    }
    const held = list.get(key)
    if (held && held.start <= e.start) { this.received.duplicates++; return false }
    if (this.verify && !verifyEntry(e)) return false
    const digest = this.digests.get(e.period)
    if (held) xorInto(digest, entryHash(held))
    xorInto(digest, entryHash(e))
    list.set(key, e)
    if (this.onEntry) this.onEntry(e)
    return true
  }

  announce (e) {
    this.add(e)
    this.#passOn(e, null)
  }

  has (period, author) {
    const list = this.lists.get(period)
    return !!list && list.has(author.toString('hex'))
  }

  size (period) { return (this.lists.get(period) || new Map()).size }
}

function xorInto (a, b) { for (let i = 0; i < 32; i++) a[i] ^= b[i] }

// One after another, as members come online over time. (All at the same
// moment, nobody finds anybody: each looks before the others have announced,
// and Hyperswarm looks again only every 10 minutes. v1's networking re-looks
// with a random delay for exactly this; the new core keeps that.)
async function join (members, topic) {
  for (const m of members) {
    m.swarm.join(topic, { server: true, client: true })
    await m.swarm.flush()
  }
}

async function destroy (members, testnet) {
  await Promise.all(members.map((m) => m.swarm.destroy()))
  await testnet.destroy()
}

// --- scenarios ---------------------------------------------------------------

async function newcomer () {
  const N = argValue('--entries', 1000)
  const M = argValue('--members', 1)
  const verify = flag('--verify')
  const testnet = await createTestnet(3)
  const topic = crypto.randomBytes(32)

  const entries = []
  for (let i = 0; i < N; i++) entries.push(makeEntry(crypto.keyPair(), PERIOD, i))
  const members = []
  for (let i = 0; i < M; i++) {
    const m = new Member(testnet.bootstrap)
    for (const e of entries) m.add(e)
    members.push(m)
  }
  await join(members, topic)

  const fresh = new Member(testnet.bootstrap, { verify })
  const t0 = now()
  let firstConnection = null
  fresh.swarm.once('connection', () => { firstConnection = now() - t0 })
  const done = new Promise((resolve) => {
    fresh.onEntry = () => { if (fresh.size(PERIOD) === N) resolve() }
  })
  fresh.swarm.join(topic, { server: true, client: true })
  const ok = await Promise.race([done.then(() => true), sleep(60000).then(() => false)])
  const totalMs = now() - t0
  const result = {
    scenario: 'newcomer',
    entries: N,
    members: M,
    verify,
    complete: ok,
    firstConnectionMs: Math.round(firstConnection),
    listMs: Math.round(totalMs - firstConnection),
    totalMs: Math.round(totalMs),
    receivedKB: Math.round(fresh.received.bytes / 1000),
    listKB: Math.round(c.encode(entriesEnc, entries).byteLength / 1000)
  }
  // Let late answers from other members arrive, to count duplicates.
  await sleep(1000)
  result.receivedKBAfter1s = Math.round(fresh.received.bytes / 1000)
  console.log(JSON.stringify(result))
  await destroy([...members, fresh], testnet)
}

async function spread () {
  const P = argValue('--peers', 20)
  const D = argValue('--degree', 4)
  const A = argValue('--announces', 20)
  const lazy = flag('--lazy')
  const testnet = await createTestnet(3)
  const topic = crypto.randomBytes(32)
  const members = []
  for (let i = 0; i < P; i++) members.push(new Member(testnet.bootstrap, { maxPeers: D, lazy }))
  await join(members, topic)
  // Wait until connections settle (no change for 2 s, at most 30 s).
  let last = -1
  const t0 = now()
  for (;;) {
    await sleep(2000)
    const total = members.reduce((n, m) => n + m.channels.size, 0)
    if (total === last || now() - t0 > 30000) break
    last = total
  }
  const graph = members.map((m) => new Set([...m.channels].map((ch) => ch.peerKey.toString('hex'))))
  const ids = members.map((m) => m.swarm.keyPair.publicKey.toString('hex'))
  const hops = bfs(ids, graph, 0)
  const degrees = members.map((m) => m.channels.size)

  const times = []
  for (let a = 0; a < A; a++) {
    const from = members[(a * 7) % P]
    const e = makeEntry(crypto.keyPair(), PERIOD, a)
    const start = now()
    const reached = new Promise((resolve) => {
      const check = () => { if (members.every((m) => m.has(PERIOD, e.author))) resolve(true) }
      for (const m of members) m.onEntry = check
    })
    from.announce(e)
    const ok = await Promise.race([reached, sleep(10000).then(() => false)])
    times.push(ok ? now() - start : null)
  }
  const reachedAll = times.filter((t) => t !== null).sort((x, y) => x - y)
  const copies = members.reduce((n, m) => n + m.received.entries, 0) / (P * A)
  const bytes = members.reduce((n, m) => n + m.received.bytes, 0) / (P * A)
  console.log(JSON.stringify({
    scenario: 'spread',
    peers: P,
    maxPeers: D,
    lazy,
    connectionsPerPeer: { min: Math.min(...degrees), avg: +(degrees.reduce((x, y) => x + y, 0) / P).toFixed(1), max: Math.max(...degrees) },
    hopsFromPeer0: { reachable: hops.filter((h) => h >= 0).length, max: Math.max(...hops) },
    announces: A,
    reachedEveryone: reachedAll.length,
    msToEveryone: reachedAll.length ? { median: +reachedAll[Math.floor(reachedAll.length / 2)].toFixed(1), max: +reachedAll[reachedAll.length - 1].toFixed(1) } : null,
    copiesPerMemberPerEntry: +copies.toFixed(2),
    bytesPerMemberPerEntry: Math.round(bytes)
  }))
  await destroy(members, testnet)
}

function bfs (ids, graph, from) {
  const index = new Map(ids.map((id, i) => [id, i]))
  const dist = ids.map(() => -1)
  dist[from] = 0
  const queue = [from]
  while (queue.length) {
    const i = queue.shift()
    for (const peer of graph[i]) {
      const j = index.get(peer)
      if (j !== undefined && dist[j] === -1) { dist[j] = dist[i] + 1; queue.push(j) }
    }
  }
  return dist
}

const scenario = process.argv[2]
const run = scenario === 'spread' ? spread : newcomer
run().catch((err) => { console.error(err); process.exit(1) })
