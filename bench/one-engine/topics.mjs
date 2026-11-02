// Spec 015: why does joining Hyperswarm topics slow down past ~25? (perf-habit measured 20 topics
// 22 ms, 30 → 767 ms, 80 → 2.3 s.) Joins N new topics at once on one Hyperswarm and times until
// every one is flushed (announced / looked up), counting the DHT requests it sent.
//
//   node bench/one-engine/topics.mjs [nodes=3,20] [sizes=10,20,25,30,40,80,160]
//
// Variants:
//   both       server + client (what lib/network.js does)
//   server     announce only
//   client     lookup only
//   window     both, HyperDHT `maxWindow` 1000 (dht-rpc's default: 80 requests per 750 ms slot)
//   batch20    both, 20 topics at a time, each batch flushed before the next
//
// Local DHT (hyperdht/testnet.js on 127.0.0.1), no disk. Results: specs/015-one-engine/research.md.

import Hyperswarm from 'hyperswarm'
import HyperDHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import crypto from 'hypercore-crypto'

const nodeSizes = (process.argv[2] || '3,20').split(',').map(Number)
const sizes = (process.argv[3] || '10,20,25,30,40,80,160').split(',').map(Number)

const VARIANTS = {
  both: { server: true, client: true },
  server: { server: true, client: false },
  client: { server: false, client: true },
  window: { server: true, client: true, dht: { maxWindow: 1000 } },
  batch20: { server: true, client: true, batch: 20 }
}

async function run (bootstrap, n, v) {
  const dht = new HyperDHT({ bootstrap, ...(v.dht || {}) })
  await dht.fullyBootstrapped()
  const swarm = new Hyperswarm({ dht })
  const before = dht.stats.requests.total
  const topics = Array.from({ length: n }, () => crypto.randomBytes(32))
  const start = performance.now()
  const step = v.batch || n
  for (let i = 0; i < n; i += step) {
    const joins = topics.slice(i, i + step).map((t) => swarm.join(t, { server: v.server, client: v.client }))
    await Promise.all(joins.map((d) => d.flushed()))
  }
  const ms = performance.now() - start
  const requests = dht.stats.requests.total - before
  await swarm.destroy({ force: true })
  await dht.destroy()
  return { ms, requests }
}

for (const nodes of nodeSizes) {
  const testnet = await createTestnet(nodes)
  console.log(`\n## local DHT of ${nodes} nodes\n`)
  console.log('| variant | ' + sizes.join(' | ') + ' |')
  console.log('|---|' + sizes.map(() => '---').join('|') + '|')
  for (const [name, v] of Object.entries(VARIANTS)) {
    const cells = []
    for (const n of sizes) {
      const { ms, requests } = await run(testnet.bootstrap, n, v)
      cells.push(`${Math.round(ms)} ms / ${requests} req`)
    }
    console.log(`| ${name} | ${cells.join(' | ')} |`)
  }
  await testnet.destroy()
}
