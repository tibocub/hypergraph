// Spec 017's assumption (a): a log closed here is still served. Corestore
// opens a core that isn't open when a peer asks for its discovery key
// (`_attachMaybe`), as lib/network.js replicates the whole store.
// Found here: closing our session frees the core only once it is idle, i.e.
// no peer channel is open for it. A channel stays while either side
// downloads (an active session, a live range) and closes 20-40 s after both
// stopped (hypercore's NOT_DOWNLOADING_SLACK); corestore then closes the core
// ~8 s later. So a log closed here stays in memory while a peer still wants it.

const test = require('brittle')
const Corestore = require('corestore')
const b4a = require('b4a')
const { tmpDir, eventually } = require('../helpers.js')

// Corestore closes a core with no session left once it is idle (~8 s).
const closedIn = (store, core) => eventually(() => !store.cores.opened(b4a.toString(core.discoveryKey, 'hex')), 15000, 200)

async function pair (t) {
  const a = new Corestore(tmpDir(t, 'a'))
  const b = new Corestore(tmpDir(t, 'b'))
  t.teardown(() => Promise.all([a.close(), b.close()]))
  const core = a.namespace('space').get({ name: 'log' }) // a space's store is a namespace
  await core.append(['header', 'one', 'two'])
  return { a, b, core }
}

function connect (a, b) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  return () => { s1.destroy(); s2.destroy() }
}

test('closed before the peer connects: served', { timeout: 60000 }, async (t) => {
  const { a, b, core } = await pair(t)
  const key = core.key
  await core.close()
  t.ok(await closedIn(a, core), 'not open here')
  connect(a, b)
  const copy = b.get({ key })
  t.is((await copy.get(2, { timeout: 5000 })).toString(), 'two')
})

test('closed while the peer is connected: blocks it asks for later are served', { timeout: 120000 }, async (t) => {
  const { a, b, core } = await pair(t)
  connect(a, b)
  const copy = b.get({ key: core.key })
  t.is((await copy.get(0, { timeout: 5000 })).toString(), 'header')
  await core.close()
  t.is((await copy.get(2, { timeout: 5000 })).toString(), 'two', 'asked after the close')
  t.ok(a.cores.opened(b4a.toString(core.discoveryKey, 'hex')), 'still in memory: the peer still downloads it')
  await copy.close()
  t.ok(await eventually(() => !a.cores.opened(b4a.toString(core.discoveryKey, 'hex')), 60000, 500), 'closed here once neither side wants it')
  const later = b.get({ key: core.key })
  t.is((await later.get(1, { timeout: 5000 })).toString(), 'one', 'and asked again: served')
})

test('closed while the peer is connected, then grown by its author: the peer gets the new block', { timeout: 60000 }, async (t) => {
  const { a, b, core } = await pair(t)
  connect(a, b)
  const copy = b.get({ key: core.key })
  await copy.get(2, { timeout: 5000 })
  await core.close()
  const again = a.namespace('space').get({ name: 'log' })
  await again.append('three')
  t.ok(await eventually(() => copy.length === 4, 5000), 'length heard')
  t.is((await copy.get(3, { timeout: 5000 })).toString(), 'three')
})
