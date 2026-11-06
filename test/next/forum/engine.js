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

test('a web view\'s handle: the wiki site reaches the wiki only', async (t) => {
  const hg = await open(t, { label: 'browser' })
  const f = await hg.createSpace({ name: 'Forum', types: forum.types })
  const w = await hg.createSpace({ name: 'Wiki', types: wikiTypes })
  t.is(await codeOf(hg.scope(w.key)), 'NOT_SUPPORTED', 'a site\'s own key is not built yet: no silent fallback')
  const site = await hg.scope(w.key, { identity: 'main' }) // the person said yes to this site
  t.alike(site.identity, hg.identity)
  await site.put('article', { title: 'Home', body: '' })
  t.is((await site.query('article').latest(5)).items.length, 1)
  t.is(await codeOf(Promise.resolve().then(() => site.subspace(f.key))), 'NOT_ALLOWED', 'not the forum')
  t.is(site.personal, undefined, 'not the personal space')
  t.is(site.spaces, undefined, 'not the list of spaces')
  await site.close()
})

test('a visitor reads a public site before its types arrive: not complete yet, not INVALID_TYPE', async (t) => {
  const a = await open(t, { label: 'owner' })
  const b = await open(t, { label: 'visitor' }) // HyperBrowser: no types of its own
  await a.connectToSwarm()
  await b.connectToSwarm()
  const fa = await a.createSpace({ name: 'Forum', types: forum.types })
  await forum.post(fa, 'Hello', 'from the owner', 'meta')
  await fa.makePublic()
  const site = await b.scope(fa.key, { identity: 'main' })
  let early = false // complete before its decisions arrived: happened every time before the fix (~30 ms)
  const watch = setInterval(() => { if (site.typesVersion === 0 && site.isComplete()) early = true }, 2)
  t.teardown(() => clearInterval(watch))
  const first = await site.query('post').latest(5) // its types haven't arrived: found by the HyperBrowser spike
  t.is(first.complete, false, 'not complete yet')
  t.is(first.items.length, 0)
  t.is((await site.query('post').where({ topic: 'meta' }).latest(5)).complete, false, 'an index of its types too')
  t.ok(await eventually(async () => (await site.query('post').latest(5)).items.length === 1, 15000), 'then its post')
  t.ok(await eventually(() => site.isComplete(), 15000))
  clearInterval(watch)
  t.absent(early, 'never complete before its decisions arrived')
  t.is(await codeOf(Promise.resolve().then(() => site.query('nope'))), 'INVALID_TYPE', 'a type the space really lacks still throws')
  await site.close()
})
