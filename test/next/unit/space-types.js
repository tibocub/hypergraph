// Spec 015 (US1): each space carries its own types. createSpace records them
// (the app's, or `types`); a decider's app adding to them records the next
// version when it opens the space; an app whose types break a space's gets
// INCOMPATIBLE_TYPES from that space only; a space whose types gained an
// index is indexed again, the others are not.

const test = require('brittle')
const { Hypergraph } = require('../../../lib/index.js')
const { Types } = require('../../../lib/types.js')
const testing = require('../../../lib/testing.js')
const { tmpDir, codeOf } = require('../helpers.js')

const v1 = { post: { fields: { title: 'string' } } }
const v2 = { post: { fields: { title: 'string', text: 'text' } }, comment: { fields: { on: 'link' }, links: { on: ['post'] } } }
const wiki = { page: { fields: { title: 'string', body: 'text' } } }

async function open (t, dir, opts) {
  const hg = await Hypergraph.open(dir, opts)
  t.teardown(() => hg.close(), { order: 0 })
  return hg
}

test('Types.from(describe()) gives the same types back, built-ins included', (t) => {
  const types = new Types({ ...v2, note: { fields: { text: 'text', column: 'string' }, editable: 'members', put: { permission: 'decide' }, index: [['column', 'stamp']], onePerMember: false } })
  const back = Types.from(types.describe())
  t.alike(back.describe(), types.describe())
  t.ok(back.has('hg/relation'))
})

test('conflict(): an older declaration agrees, a changed one does not', (t) => {
  const space = new Types(v2).describe()
  new Types(v1).conflict(space) // fewer types and fields
  t.exception(() => new Types({ post: { fields: { title: 'text' } } }).conflict(space), /title/)
  t.exception(() => new Types({ post: { fields: { text: 'text', title: 'string' } } }).conflict(space), /title/)
})

test('a space records the types it was created with; an engine holds spaces of other types', async (t) => {
  const hg = await open(t, tmpDir(t), { types: v1 })
  const forum = await hg.createSpace({ name: 'forum' })
  t.is(forum.typesVersion, 1)
  t.alike(Object.keys(forum.types()).filter((n) => !n.startsWith('hg/')), ['post'])
  const w = await hg.createSpace({ name: 'wiki', types: wiki })
  t.alike(Object.keys(w.types()).filter((n) => !n.startsWith('hg/')), ['page'], 'its own types')
  await w.put('page', { title: 'Home', body: 'hi' })
  t.is((await w.query('page').latest(5)).items[0].title, 'Home')
  t.is(await codeOf(w.put('post', { title: 'x' })), 'INCOMPATIBLE_TYPES', 'not a type of this space')
})

test('the owner\'s updated app records the next version at open; an older app reads with the space\'s', async (t) => {
  const dir = tmpDir(t)
  let hg = await Hypergraph.open(dir, { types: v1 })
  const key = (await hg.createSpace({ name: 'forum' })).key
  await hg.close()
  hg = await Hypergraph.open(dir, { types: v2 })
  const s = hg.space(key)
  await s.ready()
  const recorded = await new Promise((resolve) => {
    const check = () => { if (s.typesVersion === 2) resolve(true) }
    check()
    s.on('decisions', check)
  })
  t.ok(recorded, 'version 2 recorded')
  const p = await s.put('post', { title: 't', text: 'new field' })
  await s.put('comment', { on: p.id })
  await hg.close()

  hg = await open(t, dir, { types: v1 }) // the older app again
  const old = hg.space(key)
  const [read] = (await old.query('post').latest(5)).items
  t.is(read.text, 'new field', 'the older app reads the field it doesn\'t declare (the space has it)')
  t.is(old.typesVersion, 2, 'and records nothing')
})

test('an app whose types break a space\'s: that space refuses its calls, the engine and other spaces work', async (t) => {
  const dir = tmpDir(t)
  let hg = await Hypergraph.open(dir, { types: v1 })
  const a = await hg.createSpace({ name: 'a' })
  await a.put('post', { title: 'kept' })
  const w = await hg.createSpace({ name: 'wiki', types: wiki })
  await w.put('page', { title: 'Home', body: '' })
  const keys = [a.key, w.key]
  await hg.close()

  hg = await open(t, dir, { types: { post: { fields: { title: 'text' } } } })
  const err = await hg.space(keys[0]).query('post').latest(5).catch((e) => e)
  t.is(err.code, 'INCOMPATIBLE_TYPES')
  t.ok(/post/.test(err.message) && /title/.test(err.message), 'naming the type and field')
  t.is((await hg.space(keys[1]).query('page').latest(5)).items.length, 1, 'the wiki works')
})

test('a space whose types gained an index is indexed again; another space is not', async (t) => {
  const dir = tmpDir(t)
  let hg = await Hypergraph.open(dir, { types: v1 })
  const a = await hg.createSpace({ name: 'a' })
  for (let i = 0; i < 5; i++) await a.put('post', { title: 'p' + i })
  const w = await hg.createSpace({ name: 'wiki', types: wiki })
  for (let i = 0; i < 5; i++) await w.put('page', { title: 'w' + i, body: '' })
  const keys = [a.key, w.key]
  await hg.close()

  hg = await open(t, dir, { types: { post: { fields: { title: 'string' }, index: [['title', 'stamp']] } } })
  const s = hg.space(keys[0])
  await s.ready()
  const indexed = await new Promise((resolve) => {
    const check = async () => {
      if (s.typesVersion !== 2) return
      const page = await s.query('post').where({ title: 'p3' }).latest(5).catch(() => null)
      if (page && page.items.length === 1) resolve(true)
    }
    check()
    const timer = setInterval(check, 50)
    t.teardown(() => clearInterval(timer))
  })
  t.ok(indexed, 'the new index finds the posts written before it')
  const wk = hg.space(keys[1])
  await wk.ready()
  t.is(testing.indexedBlocks(wk), 0, 'the wiki was not indexed again')
})
