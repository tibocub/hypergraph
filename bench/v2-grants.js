// v2 private channel grants benchmark (spec 008, T013, SC-002, SC-003).
//
//   node bench/v2-grants.js [--members M] [--revoke R]
//
// Host (admin, keeper): a private channel with M members granted in one
// batch. Member, in its own process: one of them, fetching its own grant
// (bytes, time). Then the host revokes another member of a channel with R
// members (re-granting the new epoch to the rest): how long that takes, and
// how long until the online member holds the new epoch.
// Two processes, below-normal priority (CLAUDE.md on machine load).

const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const crypto = require('crypto')
const hcrypto = require('hypercore-crypto')
const { spawn } = require('child_process')
const Corestore = require('corestore')
const b4a = require('b4a')
const { Community } = require('../src/v2')
const { boxKeyPair } = require('../src/v2/crypto')

const argValue = (name, def) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? def : Number(process.argv[i + 1])
}
const now = () => process.hrtime.bigint()
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6
const sleep = (t) => new Promise(resolve => setTimeout(resolve, t))
const say = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const seedOf = (i) => crypto.createHash('sha256').update(`v2-grants-member-${i}`).digest()
const identityOf = (i) => ({ keyPair: hcrypto.keyPair(seedOf(i)), seed: seedOf(i) })
const memberOf = (i) => {
  const id = identityOf(i)
  return { identity: id.keyPair.publicKey, encryptionKey: boxKeyPair(id).publicKey }
}

function stdinReader () {
  const queue = []
  const waiters = []
  let buf = ''
  process.stdin.on('data', (d) => {
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
  return (type) => {
    const i = queue.findIndex(m => m.type === type)
    if (i !== -1) return Promise.resolve(queue.splice(i, 1)[0])
    return new Promise(resolve => waiters.push({ type, resolve }))
  }
}

// ── host ─────────────────────────────────────────────────────────────────────
async function host (dir, members) {
  const next = stdinReader()
  const store = new Corestore(dir)
  const community = new Community(store, { identity: identityOf('owner'), replicate: 'sparse' })
  await community.ready()
  const channel = await community.createChannel({ name: 'secret', private: true, keep: true })
  const t0 = now()
  for (let i = 0; i < members; i += 5000) {
    const batch = []
    for (let k = i; k < Math.min(members, i + 5000); k++) batch.push(memberOf(k))
    await community.grantMany(channel, batch)
  }
  const grantMs = Math.round(ms(t0))
  const server = net.createServer((socket) => {
    const s = community.replicate(false)
    s.pipe(socket).pipe(s)
    s.on('error', () => {})
    socket.on('error', () => {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  say({ type: 'ready', port: server.address().port, key: b4a.toString(community.key, 'hex'), channel, grantMs })

  await next('revoke')
  const t1 = now()
  const result = await community.revoke(channel, memberOf(1).identity) // member 0 is the one measuring
  say({ type: 'revoked', ms: Math.round(ms(t1)), ...result })
}

// ── member ───────────────────────────────────────────────────────────────────
async function memberRun (dir, port, key, channel) {
  const next = stdinReader()
  const store = new Corestore(dir)
  const community = new Community(store, { identity: identityOf(0), key, replicate: 'sparse' })
  await community.ready()
  let bytes = 0
  const socket = net.connect(port, '127.0.0.1')
  socket.on('data', (d) => { bytes += d.length })
  const s = community.replicate(true)
  s.pipe(socket).pipe(s)
  s.on('error', () => {})
  socket.on('error', () => {})
  while (!community.channel(channel) || community.keepers(channel).length === 0) { await community.update(); await sleep(10) }
  // From here: all it takes to obtain access (roster header, grants bee
  // lookup), nothing else read yet.
  await sleep(300)
  const b0 = bytes
  const t0 = now()
  let access = await community.access(channel)
  while (!access.current && ms(t0) < 30000) { await sleep(50); access = await community.access(channel) }
  const own = { ms: Math.round(ms(t0)), bytes: bytes - b0, epochs: access.epochs }

  say({ type: 'revoke' })
  const t1 = Date.now()
  while (community.epoch(channel) !== 1 && Date.now() - t1 < 120000) { await community.update(); await sleep(50) }
  const sawRotation = Date.now()
  access = await community.access(channel)
  while (!access.current && Date.now() - sawRotation < 60000) { await sleep(100); access = await community.access(channel) }
  const newEpoch = { afterRotationMs: Date.now() - sawRotation, current: access.current }
  say({ type: 'result', result: { own, newEpoch } })
  await next('done')
}

// ── orchestration ────────────────────────────────────────────────────────────
function proc (args) {
  const p = spawn(process.execPath, ['--max-old-space-size=4096', __filename, ...args], { stdio: ['pipe', 'pipe', 'inherit'] })
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
    kill: () => p.kill(),
    exited: new Promise(resolve => p.on('exit', resolve))
  }
}

async function main () {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'host') return host(rest[0], Number(rest[1]))
  if (cmd === 'member') return memberRun(rest[0], Number(rest[1]), rest[2], rest[3])

  const members = argValue('--members', 1000)
  const root = fs.mkdtempSync(path.join(process.env.BENCH_DIR || os.tmpdir(), `hg-v2grants-${members}-`))
  const result = { members }
  let ok = false
  try {
    const h = proc(['host', path.join(root, 'host'), String(members)])
    const ready = await h.next('ready')
    result.grantMs = ready.grantMs
    const m = proc(['member', path.join(root, 'member'), String(ready.port), ready.key, ready.channel])
    await m.next('revoke')
    h.send({ type: 'revoke' })
    const revoked = await h.next('revoked')
    result.revoke = { ms: revoked.ms, granted: revoked.granted }
    Object.assign(result, (await m.next('result')).result)
    m.send({ type: 'done' })
    h.kill()
    m.kill()
    await Promise.all([h.exited, m.exited])
    const out = path.join(__dirname, 'results')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, `v2-grants-${members}.json`), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
    ok = true
  } finally {
    if (process.env.KEEP || !ok) console.error('kept', root)
    else fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
