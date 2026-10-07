// Experiment 2, the two gaps: (1) rebuilding a member's index from the logs it
// holds (after a crash, a schema change, or a lost index), and (2) live
// queries: a record arrives, the index is flushed, the query re-runs.
//
// N records spread over A author logs (Hypercores in one Corestore). Rebuild =
// read every block of every log and insert it into a fresh HyperDB.
//
//   node bench/experiments/hyperdb/build.js   (once)
//   node bench/experiments/hyperdb/rebuild.js [--records N] [--authors A]

const path = require('path')
const fs = require('fs')
const os = require('os')
const Corestore = require('corestore')
const HyperDB = require('hyperdb')
const def = require('./spec/hyperdb')

const argValue = (name, def) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? def : Number(process.argv[i + 1])
}
const now = () => Number(process.hrtime.bigint()) / 1e6

async function main () {
  const N = argValue('--records', 100000)
  const A = argValue('--authors', 1000)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-rebuild-'))
  const body = Buffer.from('a typical post or comment text of a usual length, about eighty bytes long ok')

  // The logs: each block is a JSON record (the encoding doesn't matter much
  // here; JSON is the pessimistic case).
  let store = new Corestore(path.join(dir, 'logs'))
  const cores = []
  for (let a = 0; a < A; a++) cores.push(store.get({ name: `author${a}` }))
  await Promise.all(cores.map((core) => core.ready()))
  const perAuthor = Math.ceil(N / A)
  let t = 1791000000000
  for (let a = 0; a < A; a++) {
    const blocks = []
    for (let i = 0; i < perAuthor; i++) {
      t += 7
      const type = i % 10 === 0 ? 'post' : (i % 10 <= 6 ? 'comment' : 'vote')
      const on = type === 'post' ? [] : [`author${(a * 31 + i) % A}:${i - (i % 10)}`]
      blocks.push(Buffer.from(JSON.stringify({ type, t, links: on, body: body.toString('base64') })))
    }
    await cores[a].append(blocks)
  }
  const keys = cores.map((core) => core.key)
  await store.close()

  // (1) Rebuild: reopen the logs, read everything, index it.
  store = new Corestore(path.join(dir, 'logs'))
  const t0 = now()
  const reopened = keys.map((key) => store.get({ key }))
  await Promise.all(reopened.map((core) => core.ready()))
  const openMs = now() - t0
  const t1 = now()
  let read = 0
  const all = []
  for (let a = 0; a < A; a++) {
    const core = reopened[a]
    for await (const block of core.createReadStream()) {
      all.push({ a, seq: read++, block })
    }
  }
  const readMs = now() - t1

  const db = HyperDB.rocks(path.join(dir, 'index'), def)
  const t2 = now()
  const perAuthorSeq = new Array(A).fill(0)
  for (let i = 0; i < all.length; i++) {
    const { a, block } = all[i]
    const r = JSON.parse(block)
    const seq = perAuthorSeq[a]++
    await db.insert('@hg/records', {
      id: `author${a}:${seq}`,
      type: r.type,
      author: `author${a}`,
      t: r.t,
      links: r.links,
      ix: [],
      body: Buffer.from(r.body, 'base64')
    })
    if (i % 10000 === 9999) await db.flush()
  }
  await db.flush()
  const indexMs = now() - t2

  // (2) Live: one record at a time, flush, watcher re-runs "latest 20 posts".
  const latest = () => db.find('@hg/by-type', { gte: { type: 'post' }, lte: { type: 'post' } }, { reverse: true, limit: 20 }).toArray()
  const lags = []
  let pending = null
  db.watch(async () => {
    if (!pending) return
    const { start, resolve } = pending
    pending = null
    const page = await latest()
    resolve({ ms: now() - start, top: page[0] && page[0].id })
  })
  for (let i = 0; i < 50; i++) {
    t += 7
    const id = `live:${i}`
    const done = new Promise((resolve) => { pending = { start: now(), resolve } })
    await db.insert('@hg/records', { id, type: 'post', author: 'live', t, links: [], ix: [], body })
    await db.flush()
    const { ms, top } = await done
    if (top !== id) throw new Error('live query missed the new record')
    lags.push(ms)
  }
  lags.sort((x, y) => x - y)

  await db.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
  console.log(JSON.stringify({
    records: all.length,
    authors: A,
    reopenLogsMs: Math.round(openMs),
    readAllMs: Math.round(readMs),
    readPerSec: Math.round(all.length / (readMs / 1000)),
    indexMs: Math.round(indexMs),
    indexPerSec: Math.round(all.length / (indexMs / 1000)),
    rebuildTotalS: +((openMs + readMs + indexMs) / 1000).toFixed(1),
    liveInsertToResultMs: { median: +lags[25].toFixed(2), max: +lags[49].toFixed(2) }
  }))
}

main().catch((err) => { console.error(err); process.exit(1) })
