// SC-005 (T072, research.md A15): with many authors writing at once, how long
// until every member sees every author's records (local network)? The authors
// run in separate processes (bench/next/_writer.js, below-normal priority):
// in one process, many writers catching up stall in Hypercore's replication
// (research.md A14). The owner and one more member watch, in this process,
// with a live query; each post carries when it was sent.
//
//   node bench/next/writers.js                      # 5 processes x 10 authors, 3 posts each, 1 s apart
//   options: --procs n  --authors n (per process)  --rounds n  --every ms
//
// SC-005: every member sees every author's records within 2 seconds.

const fs = require('fs')
const os = require('os')
const path = require('path')
const createTestnet = require('hyperdht/testnet')
const { Hypergraph } = require('../../lib/index.js')
const { writerProcess } = require('./_procs.js')

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i === -1 ? def : Number(args[i + 1])
}
const PROCS = opt('procs', 5)
const AUTHORS = opt('authors', 10)
const ROUNDS = opt('rounds', 3)
const EVERY = opt('every', 1000)

const types = {
  post: { fields: { title: 'string', text: 'text' } },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } },
  vote: { fields: { value: 'int', on: 'link' }, links: { on: ['post', 'comment'] }, onePerMember: true }
} // as bench/next/_writer.js's

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-bench-writers-'))
  const teardown = []
  const testnet = await createTestnet(3, (fn) => teardown.push(fn))
  const opened = []
  const procs = []
  const open = async (name) => {
    const hg = await Hypergraph.open(path.join(root, name), { types, bootstrap: testnet.bootstrap })
    opened.push(hg)
    await hg.connectToSwarm()
    return hg
  }
  try {
    const owner = await open('owner')
    const space = await owner.createSpace({ name: 'bench' })
    const watcher = await open('watcher')
    const ws = await watcher.redeemInvite(await space.createInvite({ role: 'member' }))
    const members = [['owner', space], ['member', ws]]

    const t0 = Date.now()
    let again = 0
    let failed = 0
    for (let p = 0; p < PROCS; p++) {
      const proc = writerProcess()
      procs.push(proc)
      await proc.call('open', { dir: path.join(root, 'p' + p), bootstrap: testnet.bootstrap, count: AUTHORS })
    }
    // joined a process at a time: every invite needs the owner (the only one who lets people in)
    for (const proc of procs) {
      const links = []
      for (let a = 0; a < AUTHORS; a++) links.push(await space.createInvite({ role: 'member' }))
      const res = await proc.call('join', { links, tries: 2, skip: true })
      again += res.again
      failed += res.failed.length
    }
    const authors = PROCS * AUTHORS - failed
    console.log(`${authors} of ${PROCS * AUTHORS} authors in ${PROCS} processes joined in ${((Date.now() - t0) / 1000).toFixed(1)} s${again ? ` (${again} joins tried again: no member answered within 30 s)` : ''}${failed ? `; ${failed} never let in after two tries (left out)` : ''}`)
    for (const [name, s] of members) {
      const ok = await waitFor(() => s.directory.logs.size >= authors + 2, 60000)
      console.log(`  ${name}: ${s.directory.logs.size} logs known${ok ? '' : ' (NOT every author\'s within 60 s)'}`)
    }

    // every member watches the posts, noting when each first shows
    const seen = members.map(() => new Map()) // id -> ms after it was sent
    const stops = members.map(([, s], m) => s.query('post').live(({ items }) => {
      const now = Date.now()
      for (const x of items) {
        if (seen[m].has(x.id)) continue
        let sent = null
        try { sent = JSON.parse(x.text).sent } catch {}
        if (sent) seen[m].set(x.id, now - sent)
      }
    }, { limit: authors * ROUNDS + 10 }))

    const t1 = Date.now()
    const sent = (await Promise.all(procs.map((proc) => proc.call('post', { rounds: ROUNDS, every: EVERY })))).flatMap((r) => r.ids)
    console.log(`${sent.length} posts sent in ${((Date.now() - t1) / 1000).toFixed(1)} s (${ROUNDS} per author, ${EVERY} ms apart, all authors at once)`)
    await waitFor(() => seen.every((m) => sent.every((id) => m.has(id))), 30000)
    for (const stop of stops) stop()

    let met = true
    for (const [m, [name]] of members.entries()) {
      const delays = sent.map((id) => seen[m].get(id)).filter((d) => d !== undefined).sort((a, b) => a - b)
      const missing = sent.length - delays.length
      const q = (f) => delays.length ? delays[Math.min(delays.length - 1, Math.floor(f * delays.length))] : NaN
      const within = delays.filter((d) => d <= 2000).length
      if (missing || within < sent.length) met = false
      console.log(`  ${name}: seen ${delays.length}/${sent.length}; median ${q(0.5)} ms, 95% ${q(0.95)} ms, slowest ${delays.at(-1)} ms; within 2 s: ${within}/${sent.length}${missing ? `; ${missing} never seen within 30 s` : ''}`)
    }
    console.log(`SC-005 (${authors} authors, every member sees every record within 2 s): ${met ? 'met' : 'NOT met'}`)
  } finally {
    for (const proc of procs) await proc.close()
    for (const hg of opened) await Promise.race([hg.close().catch(() => {}), sleep(10000)])
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

async function waitFor (fn, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fn()) return true
    await sleep(50)
  }
  return fn()
}

main().catch((err) => {
  console.error(err)
  process.exit(1) // a benchmark stopped on the way: don't wait for what's still open
})
