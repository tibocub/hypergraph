// I2P over a real router (HG_I2P_SAM=<SAM port>; HG_PERF_TIMEOUT_MS=1500000: it takes 10 to 20 min); prints nothing
// without one. One router, so datagrams and streams
// go through real tunnels, but the DHT is small (a bootstrap node and the peers): this tracks I2P's round trips,
// not a big network's hop count.
//   i2p.lookup      a lookup by a client-only node, until it brings the announcer (ms), 20 runs
//   i2p.lookup.p95  their 95th percentile (ms)
//   i2p.join        an I2P-only person joining a forum over I2P, from redeemInvite to reading its first post (ms)
//   i2p.post        a post, until the other I2P-only member reads it (ms), 10 runs
//   i2p.bulk        1 MB replicated between them (MB/s)
import fs from 'fs'
import os from 'os'
import path from 'path'
import b4a from 'b4a'
import process from 'process'
import sodium from 'sodium-universal'
import dht from '../../lib/i2p/dht.js'
import next from '../../lib/index.js'
import forum from '../../test/next/forum/forum.js'
import { record } from '../harness.mjs'

const PORT = Number(process.env.HG_I2P_SAM) || 0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** @param {() => Promise<boolean>} fn */
async function until (fn) { for (;;) { if (await fn()) return; await sleep(100) } }

if (PORT) {
  const sam = { port: PORT }
  const boot = await dht.I2PDHT.open({ sam, ephemeral: false, firewalled: false })
  await boot.ready()
  const bootstrap = [boot.bootstrapAddress]
  const announcer = await dht.I2PDHT.open({ sam, bootstrap, ephemeral: false, firewalled: false })
  const client = await dht.I2PDHT.open({ sam, bootstrap, ephemeral: true })
  try {
    await Promise.all([announcer.ready(), client.ready()])
    const samples = []
    for (let i = 0; i < 20; i++) {
      const topic = b4a.alloc(32)
      sodium.randombytes_buf(topic)
      await announcer.announce(topic)
      const t0 = Date.now()
      let at = 0 // when the announcer came in: what a join waits for, not the whole lookup
      await client.lookup(topic, { onfound: (f) => { if (f.address === announcer.identity.address) at = Date.now() - t0 } })
      if (at) samples.push(at)
    }
    record('i2p.lookup', 3, 'ms', samples)
    const sorted = samples.slice().sort((a, b) => a - b)
    record('i2p.lookup.p95', 3, 'ms', [sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]])
  } finally {
    await Promise.all([announcer.destroy(), client.destroy()])
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-perf-i2p-'))
  const open = (name) => forum.signUp(path.join(tmp, name), { transport: 'i2p', sam: { port: PORT, bootstrap } })
  const [ana, eve] = await Promise.all([open('ana'), open('eve')])
  try {
    const fa = await forum.createForum(ana, 'Perf')
    await forum.post(fa, 'first', 'x')
    const t0 = Date.now()
    const fe = await forum.join(eve, await forum.invite(fa), { timeout: 120000 })
    await until(async () => (await forum.latest(fe)).some((p) => p.title === 'first'))
    record('i2p.join', 2, 'ms', [Date.now() - t0])

    const posts = []
    for (let i = 0; i < 10; i++) {
      const t1 = Date.now()
      await forum.post(fa, 'p' + i, 'x')
      await until(async () => (await forum.latest(fe)).some((p) => p.title === 'p' + i))
      posts.push(Date.now() - t1)
    }
    record('i2p.post', 2, 'ms', posts)

    const core = ana.store.get({ name: 'perf-bulk' })
    await core.ready()
    for (let i = 0; i < 16; i++) await core.append(b4a.alloc(65536, i))
    const copy = eve.store.get({ key: core.key })
    await copy.ready()
    const t2 = Date.now()
    await copy.download({ start: 0, end: core.length }).done()
    record('i2p.bulk', 1, 'MB/s', [1048576 / 1e6 / ((Date.now() - t2) / 1000)], { better: 'higher' })
  } finally {
    await Promise.all([ana.close(), eve.close()])
    await boot.destroy()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 })
  }
}
