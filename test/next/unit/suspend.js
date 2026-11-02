// Spec 015 (US7): a phone app goes to the background and comes back.
// suspend(): topics paused, connections suspended, spaces not in use closed;
// a call on a closed space fails with SUSPENDED. resume(): the space in use
// is still there, the seeded set opens again. On Node and Bare.

const test = require('brittle')
const { Hypergraph } = require('../../../lib/index.js')
const { tmpDir, codeOf, eventually, testBootstrap } = require('../helpers.js')

const types = { post: { fields: { title: 'string' } } }

test('suspend closes what is not in use; resume brings the seeded set back', async (t) => {
  const dir = tmpDir(t, 'suspend')
  const hg = await Hypergraph.open(dir, { types, bootstrap: await testBootstrap(t), maxAnnounced: 2 })
  t.teardown(() => hg.close(), { order: 0 })
  await hg.connectToSwarm()
  const spaces = []
  for (let i = 0; i < 4; i++) {
    const s = await hg.createSpace({ name: 'S' + i })
    await s.put('post', { title: 'p' + i })
    spaces.push(s)
  }
  const shown = spaces[0]
  const release = await shown.hold() // the page on screen
  const before = await shown.query('post').latest(5)

  await hg.suspend()
  t.ok(hg.suspended)
  t.ok(shown.opened, 'the space in use stays open')
  t.ok(spaces.slice(1).every((s) => !s.opened), 'the others closed')
  t.is(await codeOf(spaces[1].query('post').latest(5)), 'SUSPENDED', 'a closed space waits for resume()')
  t.alike((await shown.query('post').latest(5)).items, before.items, 'the space in use still reads')

  await hg.resume()
  t.absent(hg.suspended)
  t.ok(await eventually(() => spaces[3].opened && spaces[2].opened, 5000), 'the seeded set open again')
  t.is((await spaces[1].query('post').latest(5)).items.length, 1, 'any space opens on use')
  release()
})
