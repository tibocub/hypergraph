// SC-012 (T073): the design brief's measurements (specs/research/design-brief.md)
// re-run on the real core. One process; the index part on one member's own log.
//
//   node bench/next/brief.js            # 100,000 records for the index part
//   node bench/next/brief.js 20000      # quicker
//
// The rebuild (experiment 2, gaps) is bench/next/rebuild.js; the newcomer's
// first page and the cost of opening a log, bench/next/first-page.js.

const fs = require('fs')
const os = require('os')
const path = require('path')
const b4a = require('b4a')
const c = require('compact-encoding')
const createTestnet = require('hyperdht/testnet')
const { Hypergraph } = require('../../lib/index.js')
const { Identity } = require('../../lib/identity.js')
const testing = require('../../lib/testing.js')
const enc = require('../../lib/encodings.js')
const activity = require('../../lib/activity.js')

const N = Number(process.argv[2]) || 100000
const types = {
  post: { fields: { title: 'string', text: 'text' } },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } },
  vote: { fields: { value: 'int', on: 'link' }, links: { on: ['post', 'comment'] }, onePerMember: true }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const du = (d) => fs.readdirSync(d).reduce((n, f) => { const p = path.join(d, f); const s = fs.statSync(p); return n + (s.isDirectory() ? du(p) : s.size) }, 0)
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const ms = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6 }
const time = async (fn, n = 50) => {
  const out = []
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint()
    await fn(i)
    out.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  return median(out).toFixed(2) + ' ms'
}

async function main () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-bench-brief-'))
  const teardown = []
  try {
    const hg = await Hypergraph.open(path.join(root, 'a'), { types, bootstrap: [] })
    const s = await hg.createSpace({ name: 'brief' })

    // 6. encoding sizes (the brief: tagged post 113 B, comment 116 B, vote 40 B, with its own sample values)
    const post = { title: 'Hello world, a first post', text: 'a post of about eighty bytes, like the ones experiment 2 measured' }
    const someId = enc.idToString({ log: s.own.key, seq: 1234 })
    const record = (type, fields) => {
      const e = s.types.encode(type, fields)
      return { fields: e.fields.byteLength, record: enc.encodeRecord({ kind: enc.PUT, type, stamp: Date.now(), target: null, links: e.links, fields: e.fields }).byteLength }
    }
    const sizes = { post: record('post', post), comment: record('comment', { text: 'Welcome! A comment of about forty bytes', on: someId }), vote: record('vote', { value: 1, on: someId }) }
    console.log('encoding (fields / whole record):', Object.entries(sizes).map(([k, v]) => `${k} ${v.fields} B / ${v.record} B`).join(', '))

    // 4. a device's proof: its size, the time to check it
    const proof = hg._identity.proof
    const header = await s.own.core.get(0)
    const check = []
    for (let i = 0; i < 1000; i++) check.push(ms(() => Identity.verifyDevice(proof)))
    console.log(`device proof: ${proof.byteLength} B (log header ${header.byteLength} B); checking it ${median(check).toFixed(3)} ms`)

    // 1. activity entries: size, a period's list
    const entry = c.encode(activity.entry, { log: s.own.key, period: activity.periodOf(Date.now()), start: 123456 })
    const listOf = (n) => c.encode(activity.list, { from: 1, entries: Array.from({ length: n }, (_, i) => ({ log: b4a.alloc(32, i % 256), period: activity.periodOf(Date.now()), start: i * 10 + 1 })), done: true }).byteLength
    console.log(`activity entry: ${entry.byteLength} B; a period's list of 1,000 / 10,000 / 50,000 logs: ${(listOf(1000) / 1024).toFixed(0)} KB / ${(listOf(10000) / 1024).toFixed(0)} KB / ${(listOf(50000) / 1024 / 1024).toFixed(2)} MB; checking an entry: two block reads, no signature`)

    // 2. the local index: writing, disk, queries (10% posts, 60% comments, 30% votes, one log)
    const before = du(path.join(root, 'a'))
    const t0 = Date.now() - N * 1000
    const posts = []
    let pending = []
    const written = Date.now()
    for (let i = 0; i < N; i++) {
      const r = i % 10
      const seq = s.own.core.length + pending.length
      let type = 'vote'
      let fields = { value: 1, on: posts[posts.length - 1 - (i % Math.min(5, posts.length || 1))] }
      if (r === 0 || posts.length < 5) {
        type = 'post'
        fields = post
        posts.push(enc.idToString({ log: s.own.key, seq }))
      } else if (r <= 6) {
        type = 'comment'
        fields = { text: `comment ${i} on a recent post`, on: fields.on }
      }
      const e = s.types.encode(type, fields)
      pending.push(enc.encodeRecord({ kind: enc.PUT, type, stamp: t0 + i * 1000, target: null, links: e.links, fields: e.fields }))
      if (pending.length === 1000) {
        await s.own.core.append(pending)
        pending = []
      }
    }
    if (pending.length) await s.own.core.append(pending)
    while (testing.indexedBlocks(s) < N) await sleep(50)
    const secs = (Date.now() - written) / 1000
    await testing.compact(hg)
    const disk = du(path.join(root, 'a')) - before
    console.log(`index: ${N} records written and indexed in ${secs.toFixed(1)} s (${Math.round(N / secs)} records/s); disk ${(disk / 1024 / 1024).toFixed(0)} MB (${Math.round(disk / N)} B per record: log + index)`)
    const someone = hg.identity.publicKey
    const target = posts[Math.floor(posts.length / 2)]
    console.log('queries (median of 50):',
      'latest 50 posts', await time(() => s.query('post').latest(50)),
      '| comments on a post', await time(() => s.query('comment').on(target).latest(50)),
      '| an author\'s latest 50 posts', await time(() => s.query('post').by(someone).latest(50)),
      '| one record by id', await time((i) => s.get(posts[i * 7 % posts.length])),
      '| a post\'s score', await time(() => s.sum('vote', 'value', { on: target })))

    // live: a put to the callback of a live "latest 20 posts"
    const lat = []
    let resolve = null
    let expect = null
    const stop = s.query('post').live(({ items }) => { if (resolve && items[0] && items[0].id === expect) resolve() }, { limit: 20 })
    await sleep(200)
    for (let i = 0; i < 50; i++) {
      const done = new Promise((r) => { resolve = r })
      const t = process.hrtime.bigint()
      expect = (await s.put('post', { title: 'live ' + i, text: '' })).id
      await done
      lat.push(Number(process.hrtime.bigint() - t) / 1e6)
    }
    stop()
    lat.sort((a, b) => a - b)
    console.log(`live query: a put to the update of a live "latest 20": median ${median(lat).toFixed(1)} ms, worst ${lat.at(-1).toFixed(1)} ms (the put included)`)
    await hg.close()

    // the spike: every member agrees within (three members, local DHT)
    const testnet = await createTestnet(3, (fn) => teardown.push(fn))
    const open = async (name) => {
      const x = await Hypergraph.open(path.join(root, name), { types, bootstrap: testnet.bootstrap })
      await x.connectToSwarm()
      return x
    }
    const a = await open('m0')
    const fa = await a.createSpace({ name: 'agree' })
    const members = []
    for (const name of ['m1', 'm2']) {
      const m = await open(name)
      members.push(await m.redeemInvite(await fa.createInvite({ role: 'member' })))
    }
    await sleep(2000)
    const agree = []
    for (let i = 0; i < 20; i++) {
      const t = Date.now()
      const p = await fa.put('post', { title: 'agree ' + i, text: '' })
      for (;;) {
        const seen = await Promise.all(members.map((f) => f.get(p.id, { timeout: 0 })))
        if (seen.every((r) => r.record)) break
        await sleep(2)
      }
      agree.push(Date.now() - t)
    }
    console.log(`three members agree on a write: median ${median(agree)} ms, worst ${Math.max(...agree)} ms`)
    for (const f of [fa, ...members]) await f.hg.close()
  } finally {
    for (const fn of teardown.reverse()) await fn()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
