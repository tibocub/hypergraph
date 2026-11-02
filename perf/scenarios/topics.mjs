// Spec 015 (research.md R1): an engine holding N spaces going online. A DHT node sends at
// most 80 requests per 750 ms; the topic queue keeps the space being visited from waiting
// behind every other space's join. Size = spaces held. Local DHT of 20 nodes (on 3, the step
// comes only past ~25 topics at once).
//   topics.visit      a space created (its topic joined at once) right after connectToSwarm
//                     started joining the N others (ms)
//   topics.idle       the same on an engine with nothing else joining (ms)
//   topics.announced  topics announced once settled (at most maxAnnounced)
//   topics.requests   DHT requests sent from connectToSwarm until settled (one visit included)

import { context, time, record } from '../harness.mjs'
import createTestnet from 'hyperdht/testnet.js'
import helpers from '../../test/next/helpers.js'
import next from '../../lib/index.js'

const { Hypergraph } = next
const types = { post: { fields: { title: 'string' } } }

for (const n of [40, 100]) {
  const t = context()
  try {
    const testnet = await createTestnet(20, t.teardown)
    const bootstrap = testnet.bootstrap
    const dir = helpers.tmpDir(t, 'topics')
    let hg = await Hypergraph.open(dir, { types, bootstrap })
    for (let i = 0; i < n; i++) await hg.createSpace({ name: 'Space ' + i })
    await hg.close()

    const visits = []
    const idles = []
    let announced = 0
    let requests = 0
    for (let r = 0; r < 3; r++) {
      hg = await Hypergraph.open(dir, { types, bootstrap })
      try {
        const online = hg.connectToSwarm() // the N joins queued
        await new Promise((resolve) => setImmediate(resolve))
        visits.push((await time(() => hg.createSpace({ name: 'visit' }), 1))[0])
        await online
        await hg._network.swarm.flush()
        requests += hg._network.swarm.dht.stats.requests.total // since connectToSwarm
        idles.push((await time(() => hg.createSpace({ name: 'visit' }), 1))[0])
        announced = hg._network.announced.size
      } finally {
        await hg.close()
      }
    }
    record('topics.visit', n, 'ms', visits)
    record('topics.idle', n, 'ms', idles)
    record('topics.announced', n, 'topics', [announced])
    record('topics.requests', n, 'requests', [Math.round(requests / 3)])
  } finally {
    await t.close()
  }
}
