// SC-004 (story 9, research.md A14): a newcomer's first page — the latest 20
// posts — in a space of N records, over a local DHT: time from opening the
// invite to a complete page, and bytes received. Records are forum-shaped (10%
// posts, 60% comments, 30% votes) spread over the last `hours`, written by
// `writers` members, then held by the owner alone (the writers go offline).
//
//   node bench/next/first-page.js                 # 10,000 records, 2 writers (quick)
//   node bench/next/first-page.js 100000
//   node bench/next/first-page.js 1000000         # SC-004's big size: ask first, run it alone
//   options: --writers n (default 2)  --hours h  --slices (each writer writes one stretch of
//            time only)  --by-activity (the newcomer reads by activity lists whatever the
//            number of logs)  --full (the newcomer reads everything, as before story 9)
//            --dir path (where the instances' folders go; default the OS temp folder)
//
// Also reports the setup time, the disk used by each instance and the process's
// peak memory. It stops by itself (and says so) when the setup passes
// --max-minutes (default 30) or memory passes --max-gb (default 6): the dev
// machine rebooted once under a long all-core run.
//
// The owner and the newcomer run in this process, each writer in its own
// (bench/next/_writer.js, below-normal priority). With every instance in one
// process, the writers indexing and serving their big logs shared one thread
// with the owner: at 1,000,000 records the owner held ~250 records/s (an
// hour of setup), against ~8,000/s for one instance indexing alone.
//
// SC-004: within 2 s and 1 MB at 10,000 and 1,000,000 records, the 1,000,000
// figure at most 1.5 times the 10,000 one.

const fs = require('fs')
const os = require('os')
const path = require('path')
const createTestnet = require('hyperdht/testnet')
const { Hypergraph } = require('../../lib/index.js')
const testing = require('../../lib/testing.js')
const { writerProcess } = require('./_procs.js')
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
const DIR = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : os.tmpdir()
const MAX_MS = opt('max-minutes', 30) * 60000
const MAX_RSS = opt('max-gb', 6) * 1024 ** 3

// Peak memory, sampled every second; `guard()` throws past the limits.
let peak = 0
let began = Date.now()
const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 1000)
let peakChildren = 0
function guard (children = 0) {
  const rss = process.memoryUsage().rss
  peak = Math.max(peak, rss)
  if (rss + children > MAX_RSS) throw new Error(`stopped: memory ${gb(rss + children)} GB (writer processes included) is past ${gb(MAX_RSS)} GB`)
  if (Date.now() - began > MAX_MS) throw new Error(`stopped: the setup took more than ${MAX_MS / 60000} minutes`)
}
const gb = (n) => (n / 1024 ** 3).toFixed(2)
const du = (d) => {
  if (!fs.existsSync(d)) return 0
  return fs.readdirSync(d).reduce((n, f) => { const p = path.join(d, f); const st = fs.statSync(p); return n + (st.isDirectory() ? du(p) : st.size) }, 0)
}

const types = {
  post: { fields: { title: 'string', text: 'text' } },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } },
  vote: { fields: { value: 'int', on: 'link' }, links: { on: ['post', 'comment'] }, onePerMember: true }
} // as bench/next/_writer.js's

async function main () {
  const root = fs.mkdtempSync(path.join(DIR, 'hg-bench-first-page-'))
  const teardown = []
  const testnet = await createTestnet(3, (fn) => teardown.push(fn))
  const opened = []
  const writers = []
  const open = async (name, opts = {}) => {
    const hg = await Hypergraph.open(path.join(root, name), { types, bootstrap: testnet.bootstrap, readTimeout: 10000, ...opts })
    opened.push(hg)
    return hg
  }
  try {
    const t0 = began = Date.now()
    const start = Date.now() - HOURS * PERIOD_MS
    const owner = await open('owner')
    testing.setClock(owner, start - Date.now() - 1000, { decisions: true })
    const space = await owner.createSpace({ name: 'bench' })
    testing.setClock(owner, 0, { decisions: true })
    await owner.connectToSwarm()

    // writers (in their own processes: bench/next/_writer.js) join, write
    // their share, and go
    const step = HOURS * PERIOD_MS / N
    for (let w = 0; w < WRITERS; w++) {
      if (w && w % 10 === 0) console.log(`  (${w} writers joined)`)
      const proc = writerProcess()
      writers.push(proc)
      await proc.call('open', { dir: path.join(root, 'w' + w), bootstrap: testnet.bootstrap, count: 1 })
      const { again } = await proc.call('join', { links: [await space.createInvite({ role: 'member' })] })
      if (again) console.log(`  (writer ${w}: joining tried again ${again} time(s): no member answered within 30 s)`)
    }
    await Promise.all(writers.map((proc, w) => proc.call('fill', { n: N, writers: WRITERS, w, start, step, slices: SLICES })))
    const written = Date.now()
    let shown = 0
    let childMem = 0
    while (testing.indexedBlocks(space) < N) {
      await sleep(100)
      guard(childMem)
      if (Date.now() - shown > 10000) {
        shown = Date.now()
        childMem = (await Promise.all(writers.map((proc) => proc.call('mem')))).reduce((n, m) => n + m.rss, 0)
        peakChildren = Math.max(peakChildren, childMem)
        console.log(`  (the owner indexed ${testing.indexedBlocks(space)} of ${N}, holds ${[...space.directory.logs.values()].reduce((n, l) => n + l.core.contiguousLength, 0)} blocks; logs ${testing.logs(space).length}; memory ${gb(process.memoryUsage().rss)} GB writer processes ${gb(childMem)} GB)`)
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
    const setupMs = Date.now() - t0
    console.log(`setup: ${(setupMs / 60000).toFixed(1)} min; disk: owner ${(du(path.join(root, 'owner')) / 1024 ** 2).toFixed(0)} MB, writers ${writers.map((w, i) => (du(path.join(root, 'w' + i)) / 1024 ** 2).toFixed(0) + ' MB').join(', ')}; peak memory so far ${gb(peak)} GB (writer processes ${gb(peakChildren)} GB)`)
    for (const proc of writers) await proc.close()

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
    console.log(`newcomer disk: ${(du(path.join(root, 'newcomer')) / 1024 ** 2).toFixed(1)} MB; peak memory ${gb(peak)} GB`)
    restore()
    await d.close()
    await owner.close()
  } finally {
    clearInterval(sampler)
    for (const proc of writers) await proc.close()
    for (const hg of opened) await Promise.race([hg.close().catch(() => {}), sleep(10000)]) // closed twice is fine
    for (const fn of teardown.reverse()) await fn()
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(root, { recursive: true, force: true })
        break
      } catch {
        await sleep(500)
      }
    }
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
  process.exit(1) // a benchmark stopped on the way: don't wait for what's still open
})
