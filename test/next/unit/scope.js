// Spec 015 (US5): a site's handle reaches its space and that space's
// sub-spaces only. The default (a key of the site's own) is not built yet:
// NOT_SUPPORTED, never the main identity silently.

const test = require('brittle')
const { Hypergraph } = require('../../../lib/index.js')
const { tmpDir, codeOf, eventually } = require('../helpers.js')

const types = { post: { fields: { title: 'string' } } }

async function engine (t) {
  const hg = await Hypergraph.open(tmpDir(t), { types, bootstrap: null, maxAnnounced: 1, idleMs: 100 })
  t.teardown(() => hg.close(), { order: 0 })
  return hg
}

test('without the person\'s yes: NOT_SUPPORTED until sites have keys of their own', async (t) => {
  const hg = await engine(t)
  const a = await hg.createSpace({ name: 'a' })
  t.is(await codeOf(hg.scope(a.key)), 'NOT_SUPPORTED')
  t.is(await codeOf(hg.scope(a.key, { identity: 'site' })), 'NOT_SUPPORTED')
})

test('a handle reaches its space and its sub-spaces, nothing else', async (t) => {
  const hg = await engine(t)
  const a = await hg.createSpace({ name: 'a' })
  const b = await hg.createSpace({ name: 'b' })
  const subA = await a.createSubspace({ name: 'a/sub' })
  const subB = await b.createSubspace({ name: 'b/sub' })
  const site = await hg.scope(a.key, { identity: 'main' })
  t.alike(site.identity, hg.identity, 'acting as the person')
  t.is(site.key, a.key)
  const p = await site.put('post', { title: 'from the site' })
  t.is((await site.query('post').latest(5)).items[0].id, p.id)
  const sub = site.subspace(subA.key)
  await sub.put('post', { title: 'in its sub-space' })
  t.is(await codeOf(Promise.resolve().then(() => site.subspace(subB.key))), 'NOT_ALLOWED', 'another space\'s sub-space')
  t.is(await codeOf(Promise.resolve().then(() => site.subspace(b.key))), 'NOT_ALLOWED', 'another space')
  for (const name of ['setBudget', 'inspect', 'setRules', 'setHelpers', 'personal', 'recoveryPhrase', 'devices', 'spaces', 'space', 'hg', '_hg', '_space', 'decisionLog']) {
    t.is(site[name], undefined, `no ${name}`)
  }
  t.is(await codeOf(hg.scope(subA.key, { identity: 'main' })), 'NOT_ALLOWED', 'a sub-space is reached through its site')
})

test('events of its space only; the handle keeps it open until closed', async (t) => {
  const hg = await engine(t)
  const a = await hg.createSpace({ name: 'a' })
  const b = await hg.createSpace({ name: 'b' })
  await hg.createSpace({ name: 'c' }) // the seeded one (the most recent)
  const site = await hg.scope(a.key, { identity: 'main' })
  const seen = []
  site.on('change', ({ types }) => seen.push(types))
  await b.put('post', { title: 'elsewhere' })
  await site.put('post', { title: 'here' })
  t.ok(await eventually(() => seen.length === 1, 3000), 'one change: its own')
  t.exception(() => site.on('_decided', () => {}), /may listen/)
  await new Promise((resolve) => setTimeout(resolve, 400))
  t.ok(a.opened, 'kept open while the handle lives')
  await site.close()
  t.ok(await eventually(() => !a.opened, 3000), 'closes once let go')
  t.is(await codeOf(Promise.resolve().then(() => site.put('post', { title: 'x' }))), 'CLOSED')
})
