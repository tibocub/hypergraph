// Lookups in the DHT inside I2P, over a real router (HG_I2P_SAM=<SAM port>); prints nothing without one.
// Three nodes on that router (a bootstrap node, an announcer, a client-only node): their datagrams go through
// real tunnels, but the DHT is small, so this tracks the I2P round trips, not a big network's hop count.
//   i2p.lookup   one lookup by the client-only node, until the announcer is found (ms), 20 runs
import b4a from 'b4a'
import sodium from 'sodium-universal'
import dht from '../../lib/i2p/dht.js'
import process from 'process'
import { record } from '../harness.mjs'

const PORT = Number(process.env.HG_I2P_SAM) || 0
if (PORT) {
  const sam = { port: PORT }
  const boot = await dht.I2PDHT.open({ sam, ephemeral: false, firewalled: false })
  const announcer = await dht.I2PDHT.open({ sam, bootstrap: [boot.bootstrapAddress], ephemeral: false, firewalled: false })
  const client = await dht.I2PDHT.open({ sam, bootstrap: [boot.bootstrapAddress], ephemeral: true })
  try {
    await Promise.all([boot.ready(), announcer.ready(), client.ready()])
    const samples = []
    for (let i = 0; i < 20; i++) {
      const topic = b4a.alloc(32)
      sodium.randombytes_buf(topic)
      await announcer.announce(topic)
      const t0 = Date.now()
      const found = await client.lookup(topic)
      if (found.some((f) => f.address === announcer.identity.address)) samples.push(Date.now() - t0)
    }
    record('i2p.lookup', 3, 'ms', samples)
  } finally {
    await Promise.all([boot.destroy(), announcer.destroy(), client.destroy()])
  }
}
