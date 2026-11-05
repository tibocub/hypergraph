// One soak-run member (started by soak/run.js, in its own process): a forum
// member written with the forum app's own helpers (test/next/forum/forum.js),
// doing random actions on a slow timer and going offline at random. Every
// record it writes and every record it sees arrive goes to its delivery log
// (<run>/m<i>.jsonl, read by soak/report.js).
//
//   node soak/member.js <run dir> <index>
//
// Steered by files in the run dir: link.txt (member 0 writes the public link),
// settle (stop acting and going offline), stop (write the final snapshot, exit).
// Exit code 75: offline as a stopped process; the last stdout line says for how
// long (SOAK-OFFLINE <ms>), and run.js starts it again on the same storage.

const fs = require('fs')
const path = require('path')
const forum = require('../test/next/forum/forum.js')

const [runDir, index] = [process.argv[2], Number(process.argv[3])]
const config = JSON.parse(fs.readFileSync(path.join(runDir, 'config.json'), 'utf-8'))
const name = 'm' + index
const dir = path.join(runDir, name)
const logFile = path.join(runDir, name + '.jsonl')
const stateFile = path.join(dir, 'soak-state.json') // { key } once in the forum
const opts = { deviceName: name, ...(config.bootstrap ? { bootstrap: config.bootstrap } : {}) }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const has = (f) => fs.existsSync(path.join(runDir, f))
const rand = (min, max) => min + Math.random() * (max - min)
const pick = (list) => list[Math.floor(Math.random() * list.length)]
const log = (e) => fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), ...e }) + '\n')

// Sleeps up to `ms`, waking early once `file` appears (1 s checks).
async function nap (ms, file) {
  const until = Date.now() + ms
  while (Date.now() < until && !has(file)) await sleep(Math.min(1000, until - Date.now()))
}

// What this member wrote, edited, deleted and voted on, from its own log
// (it survives the restarts).
const mine = new Map() // id -> { id, type }
const voted = new Set()
if (fs.existsSync(logFile)) {
  for (const l of fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean)) {
    let e
    try { e = JSON.parse(l) } catch { continue }
    if (e.ev === 'put') mine.set(e.id, { id: e.id, type: e.type })
    if (e.ev === 'put' && e.type === 'vote') voted.add(e.on)
    if (e.ev === 'delete') mine.delete(e.id)
  }
}

let hg = null
let f = null
let lastWarnings = ''

async function goOnline () {
  fs.mkdirSync(dir, { recursive: true })
  hg = await forum.signUp(dir, opts)
  if (fs.existsSync(stateFile)) {
    f = hg.space(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).key)
  } else if (index === 0) {
    f = await forum.createForum(hg, 'Soak run')
    fs.writeFileSync(path.join(runDir, 'link.txt'), await forum.openLink(f))
  } else {
    while (!has('link.txt')) await sleep(1000)
    const link = fs.readFileSync(path.join(runDir, 'link.txt'), 'utf-8')
    for (;;) {
      try { f = await forum.join(hg, link); break } catch (err) { log({ ev: 'error', msg: 'join: ' + (err.code || err.message) }); await sleep(10000) }
    }
  }
  fs.writeFileSync(stateFile, JSON.stringify({ key: f.key }))
  await forum.bookmark(hg, f) // the app keeps its forum open, as a forum screen would
  f.on('change', ({ records }) => {
    const at = Date.now()
    for (const r of records) if (!mine.has(r.id)) log({ ev: 'seen', id: r.id, type: r.type, deleted: !!r.deleted, at })
  })
  f.on('status', (s) => {
    const codes = s.warnings.map((w) => w.code).sort().join(',')
    if (codes === lastWarnings) return
    lastWarnings = codes
    for (const w of s.warnings) log({ ev: 'warning', code: w.code })
  })
  log({ ev: 'online' })
}

async function act () {
  const posts = await forum.latest(f, 20)
  const comments = (await f.query('comment').latest(20)).items
  const targets = [...posts, ...comments]
  const own = [...mine.values()].filter((r) => r.type !== 'vote')
  const roll = Math.random()
  if (roll < 0.25 || !targets.length) {
    const text = `post by ${name} at ${new Date().toISOString()}`
    const r = await forum.post(f, `soak ${name}`, text)
    record(r, text)
  } else if (roll < 0.55) {
    const text = `comment by ${name}`
    const r = await forum.comment(f, pick(targets), text)
    record(r, text)
  } else if (roll < 0.8) {
    const open = targets.filter((t) => !voted.has(t.id))
    if (!open.length) return
    const on = pick(open)
    const value = Math.random() < 0.8 ? 1 : -1
    const r = await forum.vote(f, on, value)
    voted.add(on.id)
    record(r, value, on.id)
  } else if (roll < 0.9 || own.length < 3) {
    if (!own.length) return
    const r = pick(own)
    const text = `edit by ${name} at ${new Date().toISOString()}`
    await f.edit(r.id, { text })
    log({ ev: 'edit', id: r.id, v: text })
  } else {
    const r = pick(own)
    await f.del(r.id)
    mine.delete(r.id)
    log({ ev: 'delete', id: r.id })
  }
}

function record (r, v, on) {
  mine.set(r.id, { id: r.id, type: r.type })
  log({ ev: 'put', id: r.id, type: r.type, v, ...(on ? { on } : {}) })
}

// Everything this member holds of the types it writes, each with its text or value.
async function snapshot () {
  const records = []
  for (const type of ['post', 'comment', 'vote']) {
    let after
    for (;;) {
      const page = (await f.query(type).latest(100, { after })).items
      for (const r of page) records.push({ id: r.id, type, v: type === 'vote' ? r.value : r.text })
      if (page.length < 100) break
      after = page[page.length - 1]
    }
  }
  return records
}

async function main () {
  await goOnline()
  while (!has('stop')) {
    if (!has('settle') && Math.random() < config.offlineChance) {
      const ms = rand(config.offline[0], config.offline[1]) * 1000
      const mode = Math.random() < 0.5 ? 'close' : 'restart'
      log({ ev: 'offline', mode, ms: Math.round(ms) })
      await hg.close()
      if (mode === 'restart') {
        console.log('SOAK-OFFLINE ' + Math.round(ms))
        process.exit(75)
      }
      await nap(ms, 'settle')
      await goOnline()
      continue
    }
    if (!has('settle')) {
      try { await act() } catch (err) { log({ ev: 'error', msg: err.code || err.message }) }
    }
    await nap(rand(config.gap[0], config.gap[1]) * 1000, has('settle') ? 'stop' : 'settle')
  }
  log({ ev: 'held', records: await snapshot() })
  await hg.close()
}

main().then(() => process.exit(0), (err) => {
  try { log({ ev: 'error', msg: 'fatal: ' + (err.stack || err.message) }) } catch { /* the log itself failed */ }
  console.error(err)
  process.exit(1)
})
