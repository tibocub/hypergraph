// B4 (HyperBrowser spec 012): a space whose decisions aren't all held here
// (a device just added, a process killed while they downloaded) waits for
// peers to open. Hypergraph.open() doesn't wait for it, close() stops it,
// and it opens once a peer holding them is reached.

const test = require('brittle')
const path = require('path')
const Corestore = require('corestore')
const createTestnet = require('hyperdht/testnet')
const { open, within, testBootstrap } = require('../helpers.js')

// Drops the downloaded blocks of `key` past the first in `dir`, as a process
// killed while fetching them leaves it: the length known, the blocks not held.
async function dropBlocks (dir, key) {
  const store = new Corestore(path.join(dir, 'cores'))
  const core = store.get({ key })
  await core.ready()
  await core.clear(1, core.length)
  const held = core.contiguousLength
  await store.close()
  return held
}

test('a space whose decisions are partly held: open and close return, it opens once a peer is reached', { timeout: 90000 }, async (t) => {
  const bootstrap = await testBootstrap(t)
  const a = await open(t, { label: 'a', bootstrap })
  const sa = await a.createSpace({ name: 'site' })
  for (let i = 0; i < 6; i++) await sa.createInvite()
  await a.connectToSwarm()

  let b = await open(t, { label: 'b', bootstrap })
  await b.connectToSwarm()
  const sb = await b.redeemInvite(await sa.createInvite())
  const view = sb.decisionLog.base.view.core
  t.ok(await within(new Promise((resolve) => { const check = () => (view.contiguousLength >= view.length && view.length > 1 ? resolve() : setTimeout(check, 100)); check() }), 15000, false) !== false, 'b holds the decisions')
  const key = view.key
  const dir = b.dir
  await b.close()
  t.is(await dropBlocks(dir, key), 1, 'its view blocks dropped')

  let started = Date.now()
  b = await within(open(t, { dir, bootstrap }), 10000, null)
  t.ok(b, `open() returns, not connected (${Date.now() - started} ms)`)
  if (!b) return
  started = Date.now()
  t.is(await within(b.close().then(() => 'closed'), 10000, 'hung'), 'closed', `close() returns while the space waits for peers (${Date.now() - started} ms)`)

  // A new DHT that never heard of b, and a peer that never met it: b finds
  // it on the space's topic, joined while the space opens.
  await a.close()
  const testnet = await createTestnet(3)
  t.teardown(() => testnet.destroy(), { order: 1 })
  const fresh = testnet.bootstrap
  const a2 = await open(t, { dir: a.dir, bootstrap: fresh })
  await a2.connectToSwarm()
  b = await within(open(t, { dir, bootstrap: fresh }), 10000, null)
  t.ok(b, 'opens again after that close')
  if (!b) return
  await b.connectToSwarm()
  const again = b.space(sa.key)
  t.is(await within(again.ready().then(() => 'open'), 20000, 'waiting'), 'open', 'the space opens once a peer holding its decisions is reached')
})

test('close() returns while an open space reads decisions it doesn\'t hold', async (t) => {
  const a = await open(t, { label: 'a' })
  const space = await a.createSpace({ name: 'site' })
  for (let i = 0; i < 6; i++) await space.createInvite()
  // Forces the race seen on the public DHT: its state read again from view
  // blocks not held here (fast-forwarded, not downloaded yet), which wait
  // for peers. A block past the view's end waits the same way.
  const log = space.decisionLog
  const read = log._read.bind(log)
  log._read = async () => {
    await log.base.view.core.get(log.base.view.core.length + 10)
    return read()
  }
  log.reload().catch(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  t.ok(log._reloading, 'a read waits')
  const started = Date.now()
  t.is(await within(a.close().then(() => 'closed'), 10000, 'hung'), 'closed', `close() returned (${Date.now() - started} ms)`)
})
