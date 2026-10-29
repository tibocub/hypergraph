// A child process holding writers for the benchmarks (bench/next/first-page.js,
// bench/next/writers.js): with every instance in one process, writers indexing
// and serving big logs starve each other (one thread), which measures the
// harness, not hypergraph. Commands come as JSON lines on stdin, answers go as
// JSON lines on stdout ({ id, ok, ...result } or { id, error }). Runs at
// below-normal priority.
//
//   { cmd: 'open', dir, bootstrap, count }       count instances (one identity each), online
//   { cmd: 'join', links }                       instance i redeems links[i]
//   { cmd: 'fill', n, writers, w, start, step, slices }
//                                                instance 0 writes its share of first-page.js's records
//   { cmd: 'post', rounds, every }               every instance puts `rounds` posts, `every` ms apart,
//                                                each carrying when it was sent
//   { cmd: 'mem' }                               this process's memory: { rss }
//   { cmd: 'close' }

const os = require('os')
const path = require('path')
const readline = require('readline')
const { Hypergraph } = require('../../lib/index.js')
const enc = require('../../lib/encodings.js')

const types = {
  post: { fields: { title: 'string', text: 'text' } },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } },
  vote: { fields: { value: 'int', on: 'link' }, links: { on: ['post', 'comment'] }, onePerMember: true }
}

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}

const hgs = []
const spaces = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const commands = {
  async open ({ dir, bootstrap, count }) {
    for (let i = 0; i < count; i++) {
      const hg = await Hypergraph.open(path.join(dir, 'a' + i), { types, bootstrap })
      await hg.connectToSwarm()
      hgs.push(hg)
    }
  },

  // Joins one instance at a time, and a join that no member answered within
  // 30 s is tried again: across processes on the local DHT, a newcomer
  // sometimes keeps a connection the other side already dropped (two peers
  // dialling each other at once; plain Hyperswarm does it too, research.md
  // A15). `tries`: attempts per instance; `skip`: an instance that still
  // can't join is left out (its index is listed in `failed`) instead of
  // failing the whole command. Returns { again, failed }.
  async join ({ links, tries = 3, skip = false }) {
    let again = 0
    const failed = []
    for (const [i, hg] of hgs.entries()) {
      for (let attempt = 1; ; attempt++) {
        try {
          spaces[i] = await hg.redeemInvite(links[i])
          break
        } catch (err) {
          if (err.code !== 'INVITE_INVALID') throw err
          if (attempt === tries) {
            if (!skip) throw err
            failed.push(i)
            break
          }
          again++
        }
      }
    }
    return { again, failed }
  },

  // first-page.js's records (10% posts, 60% comments, 30% votes), the ones of
  // writer `w`, written straight into its log a thousand blocks per append;
  // comments and votes point at this writer's own recent posts.
  async fill ({ n, writers, w, start, step, slices }) {
    const s = spaces[0]
    const posts = []
    let pending = []
    const flush = async () => {
      if (pending.length) await s.own.core.append(pending)
      pending = []
    }
    let j = 0 // this writer's own count: the mix is the same for every writer
    for (let i = 0; i < n; i++) {
      if ((slices ? Math.floor(i * writers / n) : i % writers) !== w) continue
      const stamp = Math.floor(start + i * step)
      const r = j % 10
      const seq = s.own.core.length + pending.length
      let type = 'vote'
      let fields = { value: 1, on: posts[posts.length - 1 - (j++ % Math.min(5, posts.length || 1))] }
      if (r === 0 || posts.length < 5) {
        type = 'post'
        fields = { title: `post ${i}`, text: 'a post of about eighty bytes, like the ones experiment 2 measured' }
        posts.push(enc.idToString({ log: s.own.key, seq }))
      } else if (r <= 6) {
        type = 'comment'
        fields = { text: `comment ${i} on a recent post`, on: fields.on }
      }
      const e = s.types.encode(type, fields)
      pending.push(enc.encodeRecord({ kind: enc.PUT, type, stamp, target: null, links: e.links, fields: e.fields }))
      if (pending.length === 1000) await flush()
    }
    await flush()
    return { length: s.own.core.length }
  },

  async post ({ rounds, every }) {
    const ids = []
    await Promise.all(spaces.map(async (s, a) => {
      if (!s) return // never let in
      for (let r = 0; r < rounds; r++) {
        const p = await s.put('post', { title: `author ${a} round ${r}`, text: JSON.stringify({ sent: Date.now() }) })
        ids.push(p.id)
        await sleep(every)
      }
    }))
    return { ids }
  },

  async debug ({ peer = null } = {}) {
    return {
      owner: peer ? hgs.map((hg) => {
        const sw = hg._network.swarm
        const info = sw && sw.peers.get(peer)
        const connected = sw && [...sw.connections].some((c) => c.remotePublicKey.toString('hex') === peer)
        return info ? { connected, banned: info.banned, attempts: info.attempts, queued: info.queued, tried: info.tried, reconnecting: info.reconnecting, proven: info.proven, explicit: info.explicit, topics: info.topics.length } : { connected, known: false }
      }) : null,
      spaces: hgs.map((hg) => [...hg._spaces.values()].map((s) => ({
        member: s.state ? s.state.isMember(hg._identity.publicKey) : null,
        decisions: s.decisionLog ? s.decisionLog.base.length : null,
        system: s.decisionLog ? s.decisionLog.base.system && s.decisionLog.base.system.core.length : null,
        reached: s.directory ? s.directory.reached : null,
        peers: s.directory ? s.directory.channels.size : null,
        conns: hg._network ? hg._network.swarm.connections.size : null
      })))
    }
  },

  async mem () {
    return { rss: process.memoryUsage().rss }
  },

  async close () {
    for (const hg of hgs) await hg.close()
    setImmediate(() => process.exit(0))
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const msg = JSON.parse(line)
  try {
    const result = await commands[msg.cmd](msg)
    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, ...result }) + '\n')
  } catch (err) {
    process.stdout.write(JSON.stringify({ id: msg.id, error: err.stack || String(err) }) + '\n')
  }
})
rl.on('close', () => commands.close())
