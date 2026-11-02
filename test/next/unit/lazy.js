// Spec 015 (US2): an engine holding many spaces keeps only some open. The
// seeded set (own, pinned, then recently used, up to maxAnnounced) opens with
// the engine and stays open; any other space opens on its first call, closes
// after idleMs unused, and at most maxOpen are open (the least recently used
// closes first). A space in use (a call, a live view, a listener, a hold) is
// never closed.

const test = require('brittle')
const { Hypergraph } = require('../../../lib/index.js')
const { tmpDir, eventually, sleep } = require('../helpers.js')

const types = { post: { fields: { title: 'string' } } }

// An engine folder holding `n` spaces with one post each, created in order
// (the last ones are the most recently used).
async function folder (t, n) {
  const dir = tmpDir(t, 'lazy')
  const hg = await Hypergraph.open(dir, { types })
  const keys = []
  for (let i = 0; i < n; i++) {
    const s = await hg.createSpace({ name: 'Space ' + i })
    await s.put('post', { title: 'post ' + i })
    keys.push(s.key)
    await sleep(2) // distinct last-use times
  }
  await hg.close()
  return { dir, keys }
}

async function open (t, dir, opts = {}) {
  const hg = await Hypergraph.open(dir, { types, ...opts })
  t.teardown(() => hg.close(), { order: 0 })
  return hg
}

const openCount = (hg) => hg.spaces().filter((s) => s.opened).length

test('only the seeded set opens with the engine; the rest open on their first call', async (t) => {
  const { dir, keys } = await folder(t, 10)
  const hg = await open(t, dir, { maxAnnounced: 3, maxOpen: 6 })
  t.is(hg.spaces().length, 10, 'every space held is listed')
  t.is(openCount(hg), 3, 'three open')
  t.alike(hg.spaces().filter((s) => s.opened).map((s) => s.key).sort(), keys.slice(-3).sort(), 'the most recently used')
  t.ok(hg.spaces().every((s) => s.own && s.pinned === false), 'own, not pinned')
  const first = hg.space(keys[0])
  t.absent(first.opened, 'closed until used')
  t.is(first.name, 'Space 0', 'its name without opening it')
  t.alike(first.peers(), [], 'no peers while closed')
  t.exception(() => first.subspaces(), /ready/, 'a sync getter needing its decisions says to wait for ready()')
  const page = await first.query('post').latest(5)
  t.alike(page.items.map((p) => p.title), ['post 0'], 'a query opens it')
  t.ok(first.opened)
  t.ok(Array.isArray(first.peers()), 'then sync getters work')
})

test('ready() opens a space; idle spaces close after idleMs; seeded ones stay', async (t) => {
  const { dir, keys } = await folder(t, 4)
  const hg = await open(t, dir, { maxAnnounced: 1, idleMs: 150 })
  const s = hg.space(keys[0])
  await s.ready()
  t.ok(s.opened)
  t.ok(await eventually(() => !s.opened, 3000), 'closed once idle')
  t.ok(hg.space(keys[3]).opened, 'the seeded one stays open')
  await s.put('post', { title: 'again' })
  t.ok(s.opened, 'a write opens it again')
  t.is((await s.query('post').latest(5)).items.length, 2, 'with what it held')
})

test('a live view, a listener or a hold keeps a space open', async (t) => {
  const { dir, keys } = await folder(t, 4)
  const hg = await open(t, dir, { maxAnnounced: 1, idleMs: 100 })
  const live = hg.space(keys[0])
  let seen = null
  const stop = live.query('post').live((page) => { seen = page })
  const held = hg.space(keys[1])
  const release = await held.hold()
  const listened = hg.space(keys[2])
  const onchange = () => {}
  listened.on('change', onchange)
  await listened.ready()
  t.ok(await eventually(() => seen && seen.items.length === 1, 3000), 'the live view answers (it opened the space)')
  await sleep(400)
  t.ok(live.opened && held.opened && listened.opened, 'all three still open')
  stop()
  release()
  listened.off('change', onchange)
  t.ok(await eventually(() => !live.opened && !held.opened && !listened.opened, 3000), 'closed once let go')
})

test('at most maxOpen open: the least recently used closes first', async (t) => {
  const { dir, keys } = await folder(t, 8)
  const hg = await open(t, dir, { maxAnnounced: 1, maxOpen: 3 })
  for (const k of keys.slice(0, 5)) {
    await hg.space(k).query('post').latest(1)
    await sleep(2)
  }
  t.ok(openCount(hg) <= 3, 'never above maxOpen')
  t.ok(hg.space(keys[7]).opened, 'the seeded one stays')
  t.ok(hg.space(keys[4]).opened && hg.space(keys[3]).opened, 'the last two visited are open')
  t.absent(hg.space(keys[0]).opened, 'the first visited was closed')
})

test('pins: seeded, kept open, remembered, listed', async (t) => {
  const { dir, keys } = await folder(t, 5)
  let hg = await Hypergraph.open(dir, { types, maxAnnounced: 1 })
  await hg.pin(keys[0])
  t.alike(hg.pinned(), [keys[0]])
  t.ok(hg.space(keys[0]).opened, 'a pinned space opens')
  t.ok(hg.spaces().find((s) => s.key === keys[0]).pinned)
  await hg.close()
  hg = await open(t, dir, { maxAnnounced: 1 })
  t.alike(hg.pinned(), [keys[0]], 'remembered')
  t.ok(hg.space(keys[0]).opened, 'opened with the engine, before the recently used ones')
  t.absent(hg.space(keys[4]).opened, 'the seeded set is full')
  await hg.unpin(keys[0])
  t.alike(hg.pinned(), [])
})

test('a write in flight finishes before its space closes; a call meanwhile opens it again', async (t) => {
  const { dir, keys } = await folder(t, 3)
  const hg = await open(t, dir, { maxAnnounced: 1, idleMs: 50 })
  const s = hg.space(keys[0])
  const writes = []
  for (let i = 0; i < 20; i++) writes.push(s.put('post', { title: 'w' + i }))
  await Promise.all(writes)
  t.ok(await eventually(() => !s.opened, 3000), 'closed once idle')
  const page = await s.query('post').latest(50)
  t.is(page.items.length, 21, 'every write kept, read after it opened again')
})

test('a sub-space opens with its top space\'s decision log, top closed or not', async (t) => {
  const dir = tmpDir(t, 'lazy-sub')
  let hg = await Hypergraph.open(dir, { types })
  const top = await hg.createSpace({ name: 'top' })
  const sub = await top.createSubspace({ name: 'sub' })
  await sub.put('post', { title: 'in sub' })
  for (let i = 0; i < 3; i++) await hg.createSpace({ name: 'other ' + i }) // more recent: the seeded set
  const subKey = sub.key
  const topKey = top.key
  await hg.close()
  hg = await open(t, dir, { maxAnnounced: 2 })
  t.absent(hg.space(topKey).opened, 'the top space is closed')
  const s = hg.space(subKey)
  t.is(s.parent, topKey, 'its parent without opening it')
  t.alike((await s.query('post').latest(5)).items.map((p) => p.title), ['in sub'])
  t.ok(hg.space(topKey).opened, 'its top space opened with it')
})

test('a call while the space is closing opens it again (not CLOSED)', async (t) => {
  const { dir, keys } = await folder(t, 3)
  const hg = await open(t, dir, { maxAnnounced: 1 })
  const s = hg.space(keys[0])
  await s.ready()
  const closing = hg._closeIdle(s)
  const page = await s.query('post').latest(5)
  await closing
  t.is(page.items.length, 1, 'answered once it opened again')
  t.ok(s.opened)
})

test('a space whose closing failed half-way opens again on its next use (not CLOSED for good)', async (t) => {
  const { dir, keys } = await folder(t, 3)
  const hg = await open(t, dir, { maxAnnounced: 1 })
  const s = hg.space(keys[0])
  await s.ready()
  s.replicator.close = () => { throw new Error('teardown failed') } // once: the next opening makes a new one
  await hg._closeIdle(s)
  t.absent(s.opened, 'closed')
  t.is((await s.query('post').latest(5)).items.length, 1, 'a call opens it again')
  t.ok(s.opened)
})
