// What does it cost a control log to hear from M members who are not its
// writers? (Scaling v2, spec 007, research R1.)
//
//   node --expose-gc bench/roster.js <M>
//
// v1 makes every member an Autobase writer, measured at ~70 KB of memory per
// member on every peer that applies the context (bench/members.js). The v2
// control log has a few writers (admins); members only announce "I am active
// in this channel segment, my log is K" as one Autobase optimistic block,
// which the indexer acknowledges (host.ackWriter) without adding the member
// as a writer (the mechanism spec 006 invites use). Measured: the indexer's
// memory as M grows, and a fresh reader's memory and time to read the roster.
//
// Three processes: indexer, members (all M in one process), reader.

const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const { spawn } = require('child_process')
const Corestore = require('corestore')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const ProtomuxWakeup = require('protomux-wakeup')
const b4a = require('b4a')

const now = () => process.hrtime.bigint()
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6
const sleep = (t) => new Promise(resolve => setTimeout(resolve, t))
const rss = () => { global.gc(); global.gc(); return Math.round(process.memoryUsage().rss / 1e6) }
const say = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

function open (store, bootstrap, wakeup, keyPair = null) {
  return new Autobase(store, bootstrap, {
    valueEncoding: 'json',
    optimistic: true,
    ...(keyPair ? { keyPair } : {}),
    ackInterval: 1000,
    wakeup,
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false }),
    apply: async (nodes, view, host) => {
      for (const { value, from, optimistic } of nodes) {
        if (!value) continue
        if (value.type === 'roster') {
          if (optimistic) await host.ackWriter(from.key)
          await view.put(`roster:${b4a.toString(from.key, 'hex')}`, { channel: value.channel, segment: value.segment, log: value.log })
        }
      }
    }
  })
}

function serve (store, wakeup, onPort) {
  const server = net.createServer((socket) => {
    const s = store.replicate(false)
    wakeup.addStream(s)
    s.pipe(socket).pipe(s)
    s.on('error', () => {})
    socket.on('error', () => {})
  })
  server.listen(0, '127.0.0.1', () => onPort(server.address().port))
  return server
}

function connect (store, wakeup, port) {
  const socket = net.connect(port, '127.0.0.1')
  const s = store.replicate(true)
  wakeup.addStream(s)
  s.pipe(socket).pipe(s)
  s.on('error', () => {})
  socket.on('error', () => {})
  return socket
}

async function indexer (dir) {
  const store = new Corestore(dir)
  const wakeup = new ProtomuxWakeup()
  const base = open(store, null, wakeup)
  await base.ready()
  await base.append({ type: 'init' })
  const before = rss()
  serve(store, wakeup, (port) => say({ type: 'ready', port, key: b4a.toString(base.key, 'hex'), rss: before }))
  const count = async () => { let n = 0; for await (const _ of base.view.createReadStream({ gte: 'roster:', lt: 'roster;' })) n++; return n }
  process.stdin.on('data', async () => {
    await base.update()
    say({ type: 'status', roster: await count(), rss: rss(), length: base.length, signed: base.signedLength })
  })
}

async function members (dir, port, key, m) {
  // One member at a time: several Autobases for the same bootstrap in one
  // process, sharing one stream and wakeup, block each other (a harness
  // limit, not a real-world one: real members are separate peers). Each
  // member closes once the indexer has acknowledged it (told on stdin).
  // Each member also gets its own connection and wakeup, as a separate peer
  // would: on a reused one the indexer never heard of the second member.
  const store = new Corestore(dir)
  const lines = []
  let wake = null
  let buf = ''
  process.stdin.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1) }
    if (wake) { wake(); wake = null }
  })
  const nextLine = async () => { while (!lines.length) await new Promise(resolve => { wake = resolve }); return lines.shift() }
  const t = now()
  for (let i = 0; i < m; i++) {
    const wakeup = new ProtomuxWakeup()
    const socket = connect(store, wakeup, port)
    // Its own key pair: Autobase's local log key otherwise comes out the same
    // for every member opened from one store.
    const base = open(store.namespace(`member-${i}`), b4a.from(key, 'hex'), wakeup, require('hypercore-crypto').keyPair())
    if (process.env.ROSTERLOG) console.error('[member]', i, 'opening')
    await base.ready()
    if (process.env.ROSTERLOG) console.error('[member]', i, 'ready')
    await base.append({ type: 'roster', channel: 'general', segment: 0, log: b4a.toString(base.local.key, 'hex') }, { optimistic: true })
    if (process.env.ROSTERLOG) console.error('[member]', i, 'appended')
    say({ type: 'posted', i })
    await nextLine() // acknowledged
    await base.close()
    socket.destroy()
    wakeup.destroy()
  }
  say({ type: 'appended', ms: Math.round(ms(t)) })
  await nextLine()
  await store.close()
  process.exit(0)
}

async function reader (dir, port, key) {
  const store = new Corestore(dir)
  const wakeup = new ProtomuxWakeup()
  const before = rss()
  const found = store.findingPeers()
  const socket = connect(store, wakeup, port)
  socket.once('connect', () => setTimeout(found, 500))
  const t = now()
  const base = open(store, b4a.from(key, 'hex'), wakeup)
  await base.ready()
  let n = 0
  const target = Number(process.argv[process.argv.length - 1])
  while (n < target) {
    await base.update()
    n = 0
    for await (const _ of base.view.createReadStream({ gte: 'roster:', lt: 'roster;' })) n++
    if (n < target) await sleep(50)
  }
  say({ type: 'read', ms: Math.round(ms(t)), roster: n, rssBefore: before, rss: rss() })
  socket.destroy()
  await base.close()
  await store.close()
  process.exit(0)
}

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
    poke: () => p.stdin.write('x\n'),
    next: (type) => {
      const i = queue.findIndex(m => m.type === type)
      if (i !== -1) return Promise.resolve(queue.splice(i, 1)[0])
      return new Promise(resolve => waiters.push({ type, resolve }))
    },
    kill: () => p.kill(),
    exited: new Promise(resolve => p.on('exit', resolve))
  }
}

async function main () {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'indexer') return indexer(rest[0])
  if (cmd === 'members') return members(rest[0], Number(rest[1]), rest[2], Number(rest[3]))
  if (cmd === 'reader') return reader(rest[0], Number(rest[1]), rest[2])

  const m = Number(cmd)
  if (!m && m !== 0) throw new Error('usage: node --expose-gc bench/roster.js <M>')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hg-roster-${m}-`))
  const result = { members: m }
  try {
    const ix = proc(['indexer', path.join(root, 'indexer')])
    const ready = await ix.next('ready')
    result.indexerRssEmpty = ready.rss
    const mem = proc(['members', path.join(root, 'members'), String(ready.port), ready.key, String(m)])
    if (process.env.ROSTERLOG) console.error('[roster] indexer ready', JSON.stringify(ready))
    for (let i = 0; i < m; i++) {
      await mem.next('posted')
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        ix.poke()
        const st = await ix.next('status')
        if (process.env.ROSTERLOG) console.error('[roster] after member', i, JSON.stringify(st))
        if (st.roster >= i + 1) break
        await sleep(20)
      }
      mem.poke()
    }
    result.membersAppendMs = (await mem.next('appended')).ms
    if (process.env.ROSTERLOG) console.error('[roster] members appended', result.membersAppendMs)
    const t = now()
    let status
    while (true) {
      ix.poke()
      status = await ix.next('status')
      if (process.env.ROSTERLOG) console.error('[roster] indexer status', JSON.stringify(status))
      if (status.roster >= m || ms(t) > 600000) break
      await sleep(500)
    }
    result.indexerAckedAllMs = Math.round(ms(t))
    result.indexerRoster = status.roster
    result.indexerRss = status.rss
    result.indexerKbPerMember = m ? Math.round((status.rss - ready.rss) * 1000 / m) : 0
    // Again after a minute idle: Autobase closes idle writers and Corestore
    // releases idle cores on its own schedule, so the first figure may be
    // transient.
    if (process.env.ROSTER_SETTLE !== '0') {
      await sleep(Number(process.env.ROSTER_SETTLE || 60000))
      ix.poke()
      const later = await ix.next('status')
      result.indexerRssAfterIdle = later.rss
      result.indexerKbPerMemberAfterIdle = m ? Math.round((later.rss - ready.rss) * 1000 / m) : 0
    }
    const rd = proc(['reader', path.join(root, 'reader'), String(ready.port), ready.key, String(m)])
    const read = await rd.next('read')
    result.readerMs = read.ms
    result.readerRss = read.rss
    result.readerKbPerMember = m ? Math.round((read.rss - read.rssBefore) * 1000 / m) : 0
    mem.poke()
    await mem.exited
    ix.kill()
    await ix.exited
    console.log(JSON.stringify(result))
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
