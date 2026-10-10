// SC-004 (story 9, research.md A14): a newcomer's first page — the latest 20
// posts — in a space of N records, over a local DHT: time from opening the
// invite to a complete page, and bytes received. Records are forum-shaped (10%
// posts, 60% comments, 30% votes) spread over the last `hours`, written by
// `writers` members, then held by the owner alone (the writers go offline).
//
//   node bench/next/first-page.js                 # 10,000 records, 10 writers (quick)
//   node bench/next/first-page.js 100000
//   node bench/next/first-page.js 1000000         # SC-004's big size: ask first, run it alone
//   options: --writers n (default 2)  --hours h  --slices (each writer writes one stretch of
//            time only)  --by-activity (the newcomer reads by activity lists whatever the
//            number of logs)  --full (the newcomer reads everything, as before story 9)
//
// All instances run in this one process: with many writers, catching up is
// slowed by Hypercore's replication work (findFirst, batches), not by indexing.
//
// SC-004: within 2 s and 1 MB at 10,000 and 1,000,000 records, the 1,000,000
// figure at most 1.5 times the 10,000 one.

const fs = require('fs')
const os = require('os')
const path = require('path')
const createTestnet = require('hyperdht/testnet')
const { Hypergraph } = require('../../lib/index.js')
const testing = require('../../lib/testing.js')
const enc = require('../../lib/encodings.js')
const { PERIOD_MS, periodOf } = require('../../lib/activity.js')

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i === -1 ? def : Number(args[i + 1])
}
const N = Number(args.find((a) => /^\d+$/.test(a))) || 10000
const WRITERS = opt('writers', 2)
const HOURS = opt('hours', Math.max(24, Math.ceil(N / 400))) // ~40 posts an hour
const BY_ACTIVITY = args.includes('--by-activity')
const FULL = args.includes('--full')
const SLICES = args.includes('--slices') // each writer writes one stretch of time only (most logs inactive lately)

const types = {
  post: { fields: { title: 'string', text: 'text' } },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } },
  vote: { fields: { value: 'int', on: 'link' }, links: { on: ['post', 'comment'] }, onePerMember: true }
}

async function main () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-bench-first-page-'))
  const teardown = []
  const testnet = await createTestnet(3, (fn) => teardown.push(fn))
  const open = (name, opts = {}) => Hypergraph.open(path.join(root, name), { types, bootstrap: testnet.bootstrap, readTimeout: 10000, ...opts })
  try {
    const t0 = Date.now()
    const start = Date.now() - HOURS * PERIOD_MS
    const owner = await open('owner')
    testing.setClock(owner, start - Date.now() - 1000, { decisions: true })
    const space = await owner.createSpace({ name: 'bench' })
    testing.setClock(owner, 0, { decisions: true })
    await owner.connectToSwarm()

    // writers join, write their share, and go
    const step = HOURS * PERIOD_MS / N
    const writers = []
    for (let w = 0; w < WRITERS; w++) {
      if (w && w % 10 === 0) console.log(`  (${w} writers joined)`)
      const hg = await open('w' + w)
      const s = await hg.redeemInvite(await space.createInvite({ role: 'member' }))
      writers.push({ hg, s })
    }
    // Written straight into each writer's log, a thousand blocks per append
    // (one append per record takes ~10 ms here: hours at 1,000,000).
    const posts = []
    const pending = writers.map(() => [])
    const flush = async (w) => {
      if (pending[w].length) await writers[w].s.own.core.append(pending[w].splice(0))
    }
    for (let i = 0; i < N; i++) {
      const w = SLICES ? Math.floor(i * WRITERS / N) : i % WRITERS
      const { s } = writers[w]
      const stamp = Math.floor(start + i * step)
      const r = i % 10
      const seq = s.own.core.length + pending[w].length
      let type = 'vote'
      let fields = { value: 1, on: posts[posts.length - 1 - (i % Math.min(5, posts.length || 1))] }
      if (r === 0 || posts.length < 5) {
        type = 'post'
        fields = { title: `post ${i}`, text: 'a post of about eighty bytes, like the ones experiment 2 measured' }
        posts.push(enc.idToString({ log: s.own.key, seq }))
      } else if (r <= 6) {
        type = 'comment'
        fields = { text: `comment ${i} on a recent post`, on: fields.on }
      }
      const e = s.types.encode(type, fields)
      pending[w].push(enc.encodeRecord({ kind: enc.PUT, type, stamp, target: null, links: e.links, fields: e.fields }))
      if (pending[w].length === 1000) await flush(w)
    }
    for (let w = 0; w < WRITERS; w++) await flush(w)
    const written = Date.now()
    let shown = 0
    while (testing.indexedBlocks(space) < N) {
      await sleep(100)
      if (Date.now() - shown > 10000) {
        shown = Date.now()
        console.log(`  (the owner indexed ${testing.indexedBlocks(space)} of ${N}; logs ${testing.logs(space).length})`)
      }
    }
    console.log(`(written in ${((written - t0) / 1000).toFixed(1)} s, held by the owner ${((Date.now() - written) / 1000).toFixed(1)} s later)`)
    while ((await testing.activity(space, periodOf(Date.now()) - 1)).length === 0) await sleep(100)
    const entries = await testing.activity(space)
    const perPeriod = new Map()
    for (const e of entries) perPeriod.set(e.period, (perPeriod.get(e.period) || 0) + 1)
    const counts = [...perPeriod.values()]
    console.log(`space: ${N} records by ${WRITERS} writers over ${HOURS} h, written and held by its owner in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    console.log(`activity: ${entries.length} entries; per period ${Math.min(...counts)}–${Math.max(...counts)} (an entry ~40 B: the newest period's list is ~${(perPeriod.get(Math.max(...perPeriod.keys())) * 41)} B)`)
    for (const { hg } of writers) await hg.close()

    // the newcomer
    const restore = testing.bigSpaces(FULL ? { logs: Infinity, records: Infinity } : BY_ACTIVITY ? { logs: 1 } : {})
    const d = await open('newcomer')
    const link = await space.createInvite({ role: 'member' })
    const t1 = Date.now()
    const fd = await d.redeemInvite(link)
    const joined = Date.now() - t1
    let page = null
    let tries = 0
    do {
      page = await fd.query('post').latest(20)
      tries++
    } while (!page.complete && Date.now() - t1 < 60000)
    const ms = Date.now() - t1
    const bytes = received(d)
    const full = await space.query('post').latest(20)
    const same = JSON.stringify(page.items.map((p) => p.id)) === JSON.stringify(full.items.map((p) => p.id))
    const reading = testing.reading(fd)
    console.log(`newcomer (${FULL ? 'reads everything' : reading.horizon === null ? 'reads everything (small space)' : reading.byActivity ? 'reads by activity lists' : 'reads newest first'}): joined in ${joined} ms; first page ${page.complete ? 'complete' : 'NOT complete'} after ${ms} ms (${tries} read${tries > 1 ? 's' : ''}), ${(bytes / 1024).toFixed(0)} KB received; ${page.items.length} posts, ${same ? 'the same as the owner\'s' : 'NOT the same as the owner\'s'}`)
    console.log(`  logs opened: ${testing.logs(fd).length} of ${WRITERS + 2}; ${(await fd.inspect()).logs.reduce((n, l) => n + l.held, 0)} blocks held`)
    console.log(`SC-004 (2 s, 1 MB): ${ms <= 2000 && bytes <= 1024 * 1024 ? 'met' : 'NOT met'} at ${N}`)
    restore()
    await d.close()
    await owner.close()
  } finally {
    for (const fn of teardown.reverse()) await fn()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// Bytes this instance received on its connections.
function received (hg) {
  let n = 0
  for (const conn of hg._network.swarm.connections) n += conn.rawBytesRead || 0
  return n
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
