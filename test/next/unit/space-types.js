// Spec 015 (US1): each space carries its own types. createSpace records them
// (the app's, or `types`); a decider's app adding to them records the next
// version when it opens the space, keeping the space's types it lacks (spec
// 019); a decider adds a space's own with space.declareTypes() (spec 019); an app whose types break a space's gets
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

// Two deciders of one space: a owns it, b is an admin; both closed after.
async function twoDeciders (t) {
  const { testBootstrap, eventually } = require('../helpers.js')
  const bootstrap = await testBootstrap(t)
  const dirs = [tmpDir(t, 'a'), tmpDir(t, 'b')]
  const a = await Hypergraph.open(dirs[0], { types: v1, bootstrap })
  const b = await Hypergraph.open(dirs[1], { types: v1, bootstrap })
  await a.connectToSwarm()
  await b.connectToSwarm()
  const sa = await a.createSpace({ name: 'shared' })
  const sb = await b.redeemInvite(await sa.createInvite())
  await sa.setRole(b.identity.publicKey, 'admin')
  t.ok(await eventually(() => testing.settlers(sa).includes(testing.ownSettlerKey(sb)) && testing.settlers(sb).includes(testing.ownSettlerKey(sb)), 15000), 'b decides')
  const key = sa.key
  await a.close()
  await b.close()
  // reopens device i (0: a, 1: b) with this app's types, connected or not
  const reopenOne = async (i, types, { connect = true } = {}) => {
    const hg = await Hypergraph.open(dirs[i], { types, bootstrap })
    t.teardown(() => hg.close(), { order: 0 })
    if (connect) await hg.connectToSwarm()
    return { hg, s: hg.space(key) }
  }
  const reopen = async (typesA, typesB, opts) => [await reopenOne(0, typesA, opts), await reopenOne(1, typesB, opts)]
  return { reopen, reopenOne, eventually }
}

const withComment = { ...v1, comment: { fields: { on: 'link' }, links: { on: ['post'] } } }
const withPoll = { ...v1, poll: { fields: { question: 'string' } } }
const withBoth = { ...withComment, poll: withPoll.poll }
const own = (s) => Object.keys(s.types()).filter((n) => !n.startsWith('hg/')).sort().join()

test('an admin whose app lacks types another admin\'s app added records its own on top (spec 019)', async (t) => {
  const { reopenOne, eventually } = await twoDeciders(t)
  const x = await reopenOne(0, withComment)
  await x.s.ready()
  t.ok(await eventually(() => x.s.typesVersion === 2, 10000), 'a\'s app recorded comment')
  const old = await reopenOne(1, v1) // b's old app first: receives version 2 (else b would race a)
  await old.s.ready()
  t.ok(await eventually(() => old.s.typesVersion === 2, 15000), 'b received version 2')
  await old.hg.close()
  const y = await reopenOne(1, withPoll)
  await y.s.ready()
  t.ok(await eventually(() => y.s.typesVersion === 3 && own(y.s) === 'comment,poll,post', 15000), 'b recorded poll, comment kept')
  await y.s.put('poll', { question: 'q' })
  t.absent(y.s.status().warnings.some((w) => w.code === 'TYPES_BEHIND'), 'nobody is behind')
})

test('two deciders record the next version at once: the one refused records again on top of the other', { timeout: 120000 }, async (t) => {
  // Which of two concurrent versions counts depends on the writers' keys, so
  // two rounds with the same devices, each time the other app declaring more:
  // in one of them the app with more loses, and must record again.
  const { reopen, eventually } = await twoDeciders(t)
  let version = 1
  const round = async (typesA, typesB, expected) => {
    const pair = await reopen(typesA, typesB, { connect: false })
    for (const { s } of pair) await s.ready()
    const next = version + 1
    t.ok(await eventually(() => pair.every(({ s }) => s.typesVersion === next), 10000), `each recorded version ${next} apart`)
    for (const { hg } of pair) await hg.connectToSwarm()
    t.ok(await eventually(() => pair.every(({ s }) => own(s) === expected), 20000), `both end with ${expected}`)
    const sets = (await pair[0].s.decisions({ limit: 50 })).items.filter((d) => d.type === 'types/set')
    version = pair[0].s.typesVersion
    for (const { hg } of pair) await hg.close()
    return sets
  }
  await round(withComment, withBoth, 'comment,poll,post')
  const note = { fields: { text: 'text' } }
  const tag = { fields: { name: 'string' } }
  const sets = await round({ ...withBoth, note, tag }, { ...withBoth, note }, 'comment,note,poll,post,tag')
  t.is(sets.filter((d) => !d.counted).length, 2, 'two versions counted for nothing: both rounds raced')
  t.ok(sets.filter((d) => d.counted).length >= 4, 'and a loser recorded again (the space\'s first, then 2 or 3 per round)')
})

// --- spec 019: space.declareTypes() ---

const site = { post: { fields: { title: 'string', file: 'link' }, links: { file: ['file'] } }, vote: { fields: { on: 'link', value: 'int' }, links: { on: ['post'] }, onePerMember: true } }
const engine = { file: { fields: { path: 'string' } } } // an engine's own types, none of the site's

test('declareTypes: a decider adds a site\'s types to one space, kept with the space\'s; additions only', async (t) => {
  const hg = await open(t, tmpDir(t), { types: engine })
  const s = await hg.createSpace({ name: 'site' })
  const other = await hg.createSpace({ name: 'other' })
  t.is(await codeOf(s.put('post', { title: 'x' })), 'INVALID_TYPE', 'not a type of the space yet')
  await s.declareTypes(site)
  t.is(s.typesVersion, 2)
  t.is(own(s), 'file,post,vote', 'the engine\'s types kept, the site\'s added')
  const f = await s.put('file', { path: '/a' })
  const p = await s.put('post', { title: 'hello', file: f.id })
  await s.put('vote', { on: p.id, value: 1 })
  t.is((await s.query('post').latest(5)).items[0].title, 'hello', 'written at once')
  t.is(own(other), 'file', 'another space unchanged')

  await s.declareTypes(site)
  t.is(s.typesVersion, 2, 'the same declaration again records nothing')
  await s.declareTypes({ post: { fields: { title: 'string', file: 'link', body: 'text' }, links: { file: ['file'] } } })
  t.is(s.typesVersion, 3, 'a field added at the end: recorded')
  await s.put('post', { title: 'two', body: 'b' })

  t.is(await codeOf(s.declareTypes({ post: { fields: { title: 'text' } } })), 'INCOMPATIBLE_TYPES', 'a field retyped')
  t.is(await codeOf(s.declareTypes({ vote: { fields: { on: 'link', value: 'int' }, links: { on: ['post'] } } })), 'INCOMPATIBLE_TYPES', 'onePerMember changed')
  t.is(await codeOf(s.declareTypes({ 'hg/x': { fields: { a: 'string' } } })), 'INVALID_TYPE', 'hypergraph\'s own names')
  t.is(await codeOf(s.declareTypes({ c: { fields: { on: 'link' }, links: { on: ['nope'] } } })), 'INVALID_TYPE', 'a link to an unknown type')
  t.is(s.typesVersion, 3, 'nothing recorded by the refusals')

  const sub = await s.createSubspace({ name: 'pages' })
  t.is(await codeOf(sub.declareTypes(site)), 'NOT_ALLOWED', 'a sub-space has its top space\'s types')
})

test('declareTypes: the engine\'s updated app keeps a space\'s declared types', async (t) => {
  const { eventually } = require('../helpers.js')
  const dir = tmpDir(t)
  let hg = await Hypergraph.open(dir, { types: engine })
  const s = await hg.createSpace({ name: 'site' })
  await s.declareTypes(site)
  await s.put('post', { title: 'kept' })
  const key = s.key
  await hg.close()

  hg = await open(t, dir, { types: { file: { fields: { path: 'string', size: 'uint' } } } })
  const r = hg.space(key)
  await r.ready()
  t.ok(await eventually(() => r.typesVersion === 3, 10000), 'the update recorded')
  t.is(own(r), 'file,post,vote')
  t.alike(Object.keys(r.types().file.fields), ['path', 'size'])
  t.is((await r.query('post').latest(5)).items[0].title, 'kept')
})

test('declareTypes on a live space: a second peer accepts the new types; a member is refused', { timeout: 60000 }, async (t) => {
  const { testBootstrap, eventually } = require('../helpers.js')
  const bootstrap = await testBootstrap(t)
  const a = await open(t, tmpDir(t, 'a'), { types: engine, bootstrap })
  const b = await open(t, tmpDir(t, 'b'), { types: engine, bootstrap })
  await a.connectToSwarm()
  await b.connectToSwarm()
  const sa = await a.createSpace({ name: 'site' })
  const sb = await b.redeemInvite(await sa.createInvite())

  t.is(await codeOf(sb.declareTypes(site)), 'NOT_ALLOWED', 'a member may not add types')
  await sa.declareTypes(site)
  const p = await sa.put('post', { title: 'from the owner' })
  t.ok(await eventually(async () => sb.typesVersion === 2 && (await sb.query('post').latest(5)).items.some((r) => r.title === 'from the owner'), 15000), 'b reads the owner\'s post')
  t.is(own(sb), 'file,post,vote', 'b reads with the space\'s types')
  await sb.put('vote', { on: p.id, value: 1 })
  t.ok(await eventually(async () => (await sa.count('vote', { on: p.id })).value === 1, 15000), 'b\'s vote, a type b\'s app never declared, counts at a')
})
