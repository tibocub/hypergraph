// Spec 015 (US1, US6): one engine for many apps. An engine declaring no types
// (a browser, HyperBrowser) holds a forum, a wiki and a file share, each with
// the types it was created with; another engine reads each with that space's
// types. A wiki app's update records new types in the wiki only, and only the
// wiki is indexed again.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { open } = require('../helpers.js')
const { eventually, codeOf } = require('../helpers.js')

const wikiTypes = { article: { fields: { title: 'string', body: 'text' }, editable: 'members' } }
const wikiV2 = { article: { fields: { title: 'string', body: 'text' }, editable: 'members', index: [['title', 'stamp']] } }
// SwarmFS-like: its own types, prefixed where they meet others (spec 015 FR-062)
const fileTypes = { 'swarmfs/file': { fields: { name: 'string', size: 'uint' } } }

test('one engine, no types of its own: a forum, a wiki and a file share, each with its types', async (t) => {
  const a = await open(t, { label: 'a' })
  const b = await open(t, { label: 'b' })
  await a.connectToSwarm()
  await b.connectToSwarm()
  const fa = await a.createSpace({ name: 'Forum', types: forum.types })
  const wa = await a.createSpace({ name: 'Wiki', types: wikiTypes })
  const sa = await a.createSpace({ name: 'Files', types: fileTypes })
  const fb = await b.redeemInvite(await fa.createInvite())
  const wb = await b.redeemInvite(await wa.createInvite())
  const sb = await b.redeemInvite(await sa.createInvite())

  const p = await forum.post(fb, 'Hello', 'from an engine without types', 'meta')
  await wb.put('article', { title: 'Home', body: 'welcome' })
  await sb.put('swarmfs/file', { name: 'a.txt', size: 3 })
  t.ok(await eventually(async () => (await forum.latest(fa)).some((x) => x.id === p.id && x.topic === 'meta'), 10000), 'the forum\'s posts, read with its types')
  t.ok(await eventually(async () => (await wa.query('article').latest(5)).items.length === 1, 10000), 'the wiki\'s articles')
  t.ok(await eventually(async () => (await sa.query('swarmfs/file').latest(5)).items[0]?.size === 3, 10000), 'the file share\'s files')
  t.is(await codeOf(wb.put('post', { title: 'x' })), 'INVALID_TYPE', 'a forum type is not a wiki type')
  t.alike(Object.keys(wb.types()).filter((n) => !n.startsWith('hg/')), ['article'])

  const sub = await fa.createSubspace({ name: 'General' })
  const q = await forum.post(sub, 'In General', '', 'meta')
  t.is(q.topic, 'meta', 'a sub-forum has its forum\'s types')

  // The wiki's app is updated (an index): opened by its owner, recorded in the wiki only.
  const wiki = wa.key
  const files = sa.key
  await a.close()
  const a2 = await open(t, { dir: a.dir, types: wikiV2 })
  await a2.connectToSwarm()
  const w2 = a2.space(wiki)
  t.ok(await eventually(async () => {
    const page = await w2.query('article').where({ title: 'Home' }).latest(5).catch(() => null)
    return w2.typesVersion === 2 && page && page.items.length === 1
  }, 15000), 'the wiki has version 2; its articles are found by the new index')
  t.ok(await eventually(() => wb.typesVersion === 2, 15000), 'the other engine has it too')
  t.ok(await eventually(async () => {
    const page = await wb.query('article').where({ title: 'Home' }).latest(5).catch(() => null)
    return page && page.items.length === 1
  }, 15000), 'and indexed the wiki again')
  const f2 = a2.space(fa.key)
  await f2.ready()
  t.is(f2.typesVersion, 1, 'the forum keeps its types')
  t.is(testing.indexedBlocks(f2), 0, 'and was not indexed again')
  t.is(a2.space(files).typesVersion, 1, 'the file share too')
})
