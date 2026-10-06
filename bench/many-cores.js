// What does it cost a reader to follow many authors' logs?
//
//   node --expose-gc bench/many-cores.js <C> [--blocks B]
//
// The question behind scaling v2 (specs/research/scaling-v2.md): if channel
// messages live in each author's own log instead of one shared, ordered
// context, showing the latest page means reading the tail of every recently
// active author. One process holds C author logs of B blocks each; a fresh
// reader process opens all C by key and measures:
//   - time until the last block of every log is read, bytes downloaded
//   - memory with C logs open
//   - live: an author appends; how long until the reader has it
//
// Two processes only, below-normal priority (see CLAUDE.md on machine load).

const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const { spawn } = require('child_process')
const Corestore = require('corestore')

const argValue = (name, def) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? def : process.argv[i + 1]
}
const now = () => process.hrtime.bigint()
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6
const sleep = (t) => new Promise(resolve => setTimeout(resolve, t))
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }
const body = (i) => Buffer.from(`message ${i}: the quick brown fox jumps over the lazy dog, again and again`)

// ── authors: C logs, served on a port; appends on request ────────────────────
async function authors (dir, c, b) {
  const store = new Corestore(dir)
  const cores = []
  for (let i = 0; i < c; i++) {
    const core = store.get({ name: `author-${i}` })
    await core.ready()
    const blocks = []
    for (let j = 0; j < b; j++) blocks.push(body(j))
    await core.append(blocks)
    cores.push(core)
  }
  const server = net.createServer((socket) => {
    const s = store.replicate(false)
    s.pipe(socket).pipe(s)
    s.on('error', () => {})
    socket.on('error', () => {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  process.stdout.write(JSON.stringify({ type: 'ready', port: server.address().port, keys: cores.map(k => k.key.toString('hex')) }) + '\n')

  let buf = ''
  process.stdin.on('data', async (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const cmd = JSON.parse(line)
      if (cmd.type === 'append') {
        await cores[cmd.core].append(Buffer.from(`live ${cmd.k} ${Date.now()}`))
      } else if (cmd.type === 'exit') {
        server.close()
        await store.close()
        process.exit(0)
      }
    }
  })
}

// ── reader: a fresh store opening every author log ──────────────────────────
async function reader (dir, port, keys, live) {
  const store = new Corestore(dir)
  await store.ready()
  // update() should wait for the author side, not answer "length 0" before
  // the connection is up.
  const found = store.findingPeers()
  let bytesIn = 0
  const socket = net.connect(port, '127.0.0.1')
  socket.once('connect', () => setTimeout(found, 500))
  socket.on('data', (d) => { bytesIn += d.length })
  const s = store.replicate(true)
  s.pipe(socket).pipe(s)
  s.on('error', () => {})
  socket.on('error', () => {})

  global.gc(); global.gc()
  const rssBefore = process.memoryUsage().rss
  const t0 = now()
  const cores = []
  for (const key of keys) {
    const core = store.get({ key: Buffer.from(key, 'hex') })
    cores.push(core)
  }
  await Promise.all(cores.map(c => c.ready()))
  const openMs = ms(t0)

  // The tail of every log: the latest block of each.
  await Promise.all(cores.map(async (c) => {
    while (c.length === 0) await c.update({ wait: true })
    await c.get(c.length - 1)
  }))
  const tailMs = ms(t0)
  const tailBytes = bytesIn
  global.gc(); global.gc()
  const rssOpen = process.memoryUsage().rss

  // Follow them live, as a channel reader would.
  const ranges = cores.map(c => c.download({ start: c.length, end: -1 }))
  const arrivals = new Map()
  cores.forEach((c, i) => c.on('append', async () => {
    const block = await c.get(c.length - 1)
    const m = /^live (\d+) (\d+)$/.exec(block.toString())
    if (m) arrivals.set(Number(m[1]), Date.now() - Number(m[2]))
  }))
  process.stdout.write(JSON.stringify({ type: 'following' }) + '\n')

  const waitFor = async (k) => {
    const deadline = Date.now() + 20000
    while (!arrivals.has(k) && Date.now() < deadline) await sleep(2)
    return arrivals.has(k) ? arrivals.get(k) : Infinity
  }
  // The orchestrator tells the author side to append; we report arrivals.
  let buf = ''
  const done = new Promise((resolve) => {
    process.stdin.on('data', async (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const cmd = JSON.parse(line)
        if (cmd.type === 'wait') process.stdout.write(JSON.stringify({ type: 'arrived', k: cmd.k, ms: await waitFor(cmd.k) }) + '\n')
        if (cmd.type === 'finish') resolve()
      }
    })
  })
  await done
  for (const r of ranges) r.destroy()
  const result = {
    logs: cores.length,
    openMs: Math.round(openMs),
    tailMs: Math.round(tailMs),
    tailBytes,
    bytesPerLog: Math.round(tailBytes / cores.length),
    rssBeforeMB: Math.round(rssBefore / 1e6),
    rssOpenMB: Math.round(rssOpen / 1e6),
    kbPerOpenLog: Math.round((rssOpen - rssBefore) / cores.length / 1000)
  }
  socket.destroy()
  await store.close()
  process.stdout.write(JSON.stringify({ type: 'result', result }) + '\n')
  process.exit(0)
}

// ── orchestration ────────────────────────────────────────────────────────────
function proc (args) {
  const p = spawn(process.execPath, ['--expose-gc', __filename, ...args], { stdio: ['pipe', 'pipe', 'inherit'] })
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
  const queue = []
  const waiters = []
  let buf = ''
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      const w = waiters.findIndex(x => x.type === msg.type)
      if (w !== -1) waiters.splice(w, 1)[0].resolve(msg)
      else queue.push(msg)
    }
  })
  return {
    send: (m) => p.stdin.write(JSON.stringify(m) + '\n'),
    next: (type) => {
      const i = queue.findIndex(m => m.type === type)
      if (i !== -1) return Promise.resolve(queue.splice(i, 1)[0])
      return new Promise(resolve => waiters.push({ type, resolve }))
    },
    exited: new Promise(resolve => p.on('exit', resolve))
  }
}

async function main () {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'authors') return authors(rest[0], Number(rest[1]), Number(rest[2]))
  if (cmd === 'reader') return reader(rest[0], Number(rest[1]), JSON.parse(fs.readFileSync(rest[2], 'utf-8')), Number(rest[3]))

  const c = Number(cmd)
  if (!c) throw new Error('usage: node --expose-gc bench/many-cores.js <C> [--blocks B]')
  const b = Number(argValue('--blocks', 100))
  const live = 20
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hg-cores-${c}-`))
  try {
    const t0 = now()
    const a = proc(['authors', path.join(root, 'authors'), String(c), String(b)])
    const ready = await a.next('ready')
    const prepareMs = ms(t0)
    const keysFile = path.join(root, 'keys.json')
    fs.writeFileSync(keysFile, JSON.stringify(ready.keys))
    const r = proc(['reader', path.join(root, 'reader'), String(ready.port), keysFile, String(live)])
    await r.next('following')
    const lat = []
    for (let k = 0; k < live; k++) {
      a.send({ type: 'append', core: Math.floor(Math.random() * c), k })
      r.send({ type: 'wait', k })
      lat.push((await r.next('arrived')).ms)
      await sleep(50)
    }
    r.send({ type: 'finish' })
    const { result } = await r.next('result')
    a.send({ type: 'exit' })
    await Promise.all([a.exited, r.exited])
    result.blocksPerLog = b
    result.authorsPrepareMs = Math.round(prepareMs)
    const arrived = lat.filter(x => x !== Infinity)
    result.live = { sent: live, lost: live - arrived.length, p50: Math.round(pct(arrived, 0.5)), p95: Math.round(pct(arrived, 0.95)) }
    const out = path.join(__dirname, 'results')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, `many-cores-${c}.json`), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
