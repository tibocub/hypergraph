// Self-check, no router needed: dht-rpc over the udx shim, with an in-memory
// stand-in for SAM datagrams. Checks that a node far from the bootstrap is
// found through closer nodes (the prefix path), for both styles.

const assert = require('assert')
const crypto = require('crypto')
const DHT = require('dht-rpc')
const { I2PUDX } = require('./udx-shim.js')
const sam = require('./sam.js')

function fakeNet () {
  const byName = new Map()
  return (style, { onmessage }) => {
    const dest = crypto.randomBytes(391).toString('base64').replace(/\+/g, '-').replace(/\//g, '~')
    const hash = sam.destHash(dest)
    byName.set(dest, onmessage)
    const send = (to, payload) => {
      const target = byName.get(to)
      if (target) setImmediate(() => target(payload, { dest: style === 'RAW' ? null : dest }))
    }
    return { dest, hash, send, close () {} }
  }
}

async function run (style) {
  const datagrams = fakeNet()
  const udxs = []
  const nodes = []
  const mk = async (bootstrap) => {
    const udx = await I2PUDX.open({ style, datagrams })
    udxs.push(udx)
    for (const b of bootstrap) udx.learn(b.dest)
    const node = new DHT({ udx, ephemeral: false, firewalled: false, bootstrap: bootstrap.map((b) => b.addr) })
    await node.ready()
    nodes.push(node)
    return { node, dest: udx.dest, addr: `${udx.host}:${node.address().port}` }
  }
  const boot = await mk([])
  for (let i = 0; i < 12; i++) await mk([boot])
  // The last node knows only the bootstrap; every other address must come from closer-node prefixes.
  const last = nodes[nodes.length - 1]
  const target = nodes[3].id
  let found = false
  for await (const r of last.findNode(target)) if (r.from.id && r.from.id.equals(target)) found = true
  assert.ok(found, `${style}: target found through closer nodes`)
  assert.ok(udxs.every((u) => u.stats.unknownHost === 0), 'no send to an unmapped address')
  await Promise.all(nodes.map((n) => n.destroy()))
  console.log(`ok ${style}`)
}

run('DATAGRAM').then(() => run('RAW')).catch((err) => { console.error(err); process.exitCode = 1 })
