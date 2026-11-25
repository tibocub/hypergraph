// The DHT inside I2P against a real router (HG_I2P_SAM=<SAM port on 127.0.0.1>), on demand and in the soak: real
// destinations (keys where the code expects them), datagrams through real tunnels, a lookup across three nodes.
// Skipped without HG_I2P_SAM. Slow: each session builds its tunnels (tens of seconds).

const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const sam = require('../../../lib/i2p/sam.js')
const { I2PDHT } = require('../../../lib/i2p/dht.js')
const { addressOf } = require('../../../lib/i2p/address.js')

const PORT = Number(require('process').env.HG_I2P_SAM) || 0

test('i2p router: datagrams between two fresh destinations; a lookup across three nodes', { skip: !PORT, timeout: 600000 }, async (t) => {
  const got = []
  const a = await sam.datagrams({ sam: { port: PORT }, ondatagram: (data, from) => got.push({ data, from }) })
  const b = await sam.datagrams({ sam: { port: PORT } })
  t.teardown(() => { a.close(); b.close() })
  t.not(a.identity.address, b.identity.address, 'a fresh destination per session')
  for (let i = 0; i < 20 && !got.length; i++) {
    b.send(a.identity.address, b4a.from('hello'))
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  t.ok(got.length, 'a datagram arrived')
  t.is(addressOf(got[0].from), b.identity.address, 'from the sender, as the router signed it')

  const boot = await I2PDHT.open({ sam: { port: PORT }, ephemeral: false, firewalled: false })
  const announcer = await I2PDHT.open({ sam: { port: PORT }, bootstrap: [boot.bootstrapAddress], ephemeral: false, firewalled: false })
  const client = await I2PDHT.open({ sam: { port: PORT }, bootstrap: [boot.bootstrapAddress], ephemeral: true })
  t.teardown(() => Promise.all([boot.destroy(), announcer.destroy(), client.destroy()]))
  await Promise.all([boot.ready(), announcer.ready(), client.ready()])
  const topic = b4a.alloc(32)
  sodium.randombytes_buf(topic)
  await announcer.announce(topic)
  const t0 = Date.now()
  const found = await client.lookup(topic)
  t.comment('lookup ' + (Date.now() - t0) + ' ms')
  t.ok(found.some((f) => f.address === announcer.identity.address), 'the announcer found over I2P')
})
