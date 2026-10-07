// Experiment 2: HyperDB (RocksDB engine) as a member's local index of a
// forum: N records (10% posts, 60% comments on posts, 30% votes on posts or
// comments) from 1,000 authors in 20 forums. Measures writing, disk, and the
// queries a reddit clone needs.
//
//   node bench/experiments/hyperdb/build.js   (once)
//   node bench/experiments/hyperdb/run.js [--records N]

const path = require('path')
const fs = require('fs')
const os = require('os')
const HyperDB = require('hyperdb')
const def = require('./spec/hyperdb')

const argValue = (name, def) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? def : Number(process.argv[i + 1])
}
const pad = (t) => String(t).padStart(15, '0')

function dirSize (dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size
  }
  return total
}

async function timeIt (n, fn) {
  const t0 = process.hrtime.bigint()
  let got = 0
  for (let i = 0; i < n; i++) got += await fn(i)
  return { avgMs: +(Number(process.hrtime.bigint() - t0) / 1e6 / n).toFixed(3), avgResults: +(got / n).toFixed(1) }
}

async function main () {
  const N = argValue('--records', 100000)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-hyperdb-'))
  const db = HyperDB.rocks(dir, def)
  const AUTHORS = 1000
  const FORUMS = 20
  const posts = []
  const targets = []
  const body = Buffer.from('a typical post or comment text of a usual length, about eighty bytes long ok')
  let t = 1791000000000
  const t0 = Date.now()
  for (let i = 0; i < N; i++) {
    t += 7
    const author = `author${i % AUTHORS}`
    const id = `${author}:${i}`
    const r = i % 10
    let rec
    if (r === 0 || posts.length === 0) {
      const forum = `forum${Math.floor(i / 10) % FORUMS}`
      rec = { id, type: 'post', author, t, links: [], ix: [`post|forum=${forum}|${pad(t)}`], body }
      posts.push(id)
      targets.push(id)
    } else if (r <= 6) {
      const on = posts[(i * 7919) % posts.length]
      rec = { id, type: 'comment', author, t, links: [on], ix: [], body }
      targets.push(id)
    } else {
      const on = targets[(i * 104729) % targets.length]
      rec = { id, type: 'vote', author, t, links: [on], ix: [], body: Buffer.from([1]) }
    }
    await db.insert('@hg/records', rec)
    if (i % 10000 === 9999) await db.flush()
  }
  await db.flush()
  const writeMs = Date.now() - t0

  const sample = (i) => posts[(i * 31) % posts.length]
  const results = {
    records: N,
    writeMs,
    recordsPerSec: Math.round(N / (writeMs / 1000)),
    diskMB: +(dirSize(dir) / 1e6).toFixed(1),
    latestPosts: await timeIt(100, async () => (await db.find('@hg/by-type', { gte: { type: 'post' }, lte: { type: 'post' } }, { reverse: true, limit: 50 }).toArray()).length),
    commentsOnPost: await timeIt(100, async (i) => {
      const p = sample(i)
      return (await db.find('@hg/by-link', { gte: `${p}|`, lt: `${p}|~` }).toArray()).length
    }),
    postsInForum: await timeIt(100, async (i) => {
      const f = `forum${i % FORUMS}`
      return (await db.find('@hg/by-ix', { gte: `post|forum=${f}|`, lt: `post|forum=${f}|~` }, { reverse: true, limit: 50 }).toArray()).length
    }),
    byAuthor: await timeIt(100, async (i) => (await db.find('@hg/by-author', { gte: { author: `author${i}` }, lte: { author: `author${i}` } }, { reverse: true, limit: 50 }).toArray()).length),
    getById: await timeIt(1000, async (i) => (await db.get('@hg/records', { id: sample(i) })) ? 1 : 0)
  }
  await db.close()
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
  console.log(JSON.stringify(results))
}

main().catch((err) => { console.error(err); process.exit(1) })
