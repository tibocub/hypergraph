// Story 5 #1-3: v1's graph vocabulary on the new core, with v1's meanings
// (test/brittle/core/relations.js, tags.js, query.js): relations with a type,
// a number and data, edges in and out with counts, tags, queries by type,
// author, link, tag and time, paging without gaps or repeats. Every member
// agrees, one who was offline meanwhile too.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { threeMembers, account } = require('./_setup.js')
const { eventually, codeOf, open, sleep } = require('../helpers.js')

const agree = (spaces, fn, expected, ms = 10000) => eventually(async () => {
  for (const f of spaces) if (JSON.stringify(await fn(f)) !== JSON.stringify(expected)) return false
  return true
}, ms)

// The edges of `record` as one string: "from>to:type=value", sorted.
const edgesOf = (record, opts) => async (f) => {
  const { items, count } = await f.edges(record, opts)
  return { count, edges: items.map((e) => `${e.from}>${e.to}:${e.type}=${e.value}`).sort() }
}

test('relate: an edge out of one record and into the other, on every member, with counts', async (t) => {
  const { fa, fb, all } = await threeMembers(t)
  const mine = await forum.post(fa, 'Mine', '')
  const yours = await forum.post(fb, 'Yours', '')
  const other = await forum.post(fa, 'Other', '')
  const edge = await fa.relate(mine, yours, 'cites', { value: 2, data: 'see section 3' })
  t.is(edge.from, mine.id)
  t.is(edge.to, yours.id)
  t.is(edge.type, 'cites')
  t.is(edge.value, 2)
  t.is(edge.data, 'see section 3')
  await fa.relate(mine, other, 'likes')

  t.ok(await agree(all, edgesOf(mine, { direction: 'out', type: 'cites' }), { count: 1, edges: [`${mine.id}>${yours.id}:cites=2`] }), 'the out-edge, everywhere')
  t.ok(await agree(all, edgesOf(yours, { direction: 'in', type: 'cites' }), { count: 1, edges: [`${mine.id}>${yours.id}:cites=2`] }), 'the in-edge, everywhere')
  t.ok(await agree(all, async (f) => (await f.edges(yours, { direction: 'in', type: 'likes' })).count, 0), 'no likes')
  t.ok(await agree(all, async (f) => (await f.edges(mine, { direction: 'out' })).count, 2), 'both types without a filter')
  const { items: [data] } = await fb.edges(yours, { direction: 'in' })
  t.is(data.data, 'see section 3', 'the data reaches the other side')
  t.is(data.author, fa.hg.identity.publicKey, 'and who said it')
  const newest = await fb.edges(mine, { direction: 'out', order: 'desc', limit: 1 })
  t.is(newest.items.length, 1, 'limit')
  t.is(newest.items[0].type, 'likes', 'desc: the newest first')
  t.is(newest.count, 2, 'count is before the limit')
  const oldest = await fb.edges(mine, { direction: 'out', limit: 1 })
  t.is(oldest.items[0].type, 'cites', 'asc by default: the oldest first')
})

test('relating twice keeps one edge; unrelate removes it everywhere; relating again brings the new value', async (t) => {
  const { fa, fb, all } = await threeMembers(t)
  const p = await forum.post(fa, 'P', '')
  const q = await forum.post(fb, 'Q', '')
  await forum.seeAlso(fa, p, q, 'first')
  await forum.seeAlso(fa, p, q, 'second')
  const refs = (f) => forum.referencedBy(f, q)
  t.ok(await agree(all, refs, { from: [p.id], count: 1 }), 'one edge, not two')
  t.is((await fb.edges(q, { direction: 'in' })).items[0].data, 'second', 'the latest relate wins')

  await forum.unlink(fa, p, q)
  t.ok(await agree(all, refs, { from: [], count: 0 }), 'unrelated: gone everywhere')
  t.is(await codeOf(forum.unlink(fa, p, q)), 'NOT_FOUND', 'nothing left to unrelate')
  t.is(await codeOf(fa.unrelate(p, q, 'never')), 'NOT_FOUND', 'nor a relation never made')

  await fa.relate(p, q, 'see-also', { value: 5 })
  t.ok(await agree(all, refs, { from: [p.id], count: 1 }), 'related again: one edge')
  t.is((await fb.edges(q, { direction: 'in' })).items[0].value, 5, 'the new one, not the old')
})

test('values must be numbers and data at most 4 KB of text', async (t) => {
  const a = await account(t, 'a')
  const f = await forum.createForum(a, 'Limits')
  const p = await forum.post(f, 'P', '')
  const q = await forum.post(f, 'Q', '')
  t.is(await codeOf(f.relate(p, q, 'vote', { value: 'up' })), 'INVALID_RECORD', 'a string value')
  t.is(await codeOf(f.relate(p, q, 'vote', { value: NaN })), 'INVALID_RECORD', 'NaN')
  t.is(await codeOf(f.relate(p, q, 'vote', { value: Infinity })), 'INVALID_RECORD', 'Infinity')
  t.is(await codeOf(f.relate(p, q, 'in', { data: 42 })), 'INVALID_RECORD', 'data that is not text')
  t.is(await codeOf(f.relate(p, q, 'in', { data: 'é'.repeat(2049) })), 'INVALID_RECORD', 'over 4,096 bytes')
  t.is(await codeOf(f.relate(p, q, '')), 'INVALID_RECORD', 'no type')
  await f.relate(p, q, 'in', { data: 'x'.repeat(4096) })
  t.is((await f.edges(q)).items[0].data.length, 4096, '4,096 bytes are fine')
  t.is(await codeOf(f.put('hg/relation', { from: p.id, to: q.id, rel: 'x' })), 'INVALID_TYPE', 'not written as a plain record')
})

test('a relation from someone else\'s record is refused here and ignored everywhere (v1: the author of `from` says it)', async (t) => {
  const { fa, fb, all } = await threeMembers(t)
  const theirs = await forum.post(fa, 'By a', '')
  const mine = await forum.post(fb, 'By b', '')
  await eventually(async () => (await fb.get(theirs.id)).record, 5000)
  t.is(await codeOf(fb.relate(theirs, mine, 'endorses')), 'NOT_ALLOWED', 'refused by b\'s app')
  await testing.writeRaw(fb, { kind: 'put', type: 'hg/relation', fields: { from: theirs.id, to: mine.id, rel: 'endorses' } })
  await fb.relate(mine, theirs, 'reply')
  t.ok(await agree(all, async (f) => (await f.edges(theirs, { direction: 'in', type: 'reply' })).count, 1), 'b\'s own edge reaches everyone')
  for (const f of all) {
    t.is((await f.edges(theirs, { direction: 'out', type: 'endorses' })).count, 0, 'the forged edge is not out of a\'s post')
    t.is((await f.edges(mine, { direction: 'in', type: 'endorses' })).count, 0, 'nor into b\'s')
  }
})

test('tags: newest first, page by page; untag; an unused tag is empty; tags by someone else ignored', async (t) => {
  const { fa, fb, fc, all } = await threeMembers(t)
  const posts = []
  for (let i = 0; i < 5; i++) posts.push(await forum.post(fa, `post ${i}`, ''))
  for (const p of posts.slice(0, 4)) await forum.tag(fa, p, 'rust')
  const titles = (xs) => xs.map((x) => x.title)
  t.ok(await agree(all, async (f) => titles(await forum.tagged(f, 'rust')), ['post 3', 'post 2', 'post 1', 'post 0']), 'newest first, everywhere')
  const first = await forum.tagged(fc, 'rust', { limit: 3 })
  const second = await forum.tagged(fc, 'rust', { limit: 3, after: first.at(-1) })
  t.alike(titles(first), ['post 3', 'post 2', 'post 1'])
  t.alike(titles(second), ['post 0'], 'the next page, no gap, no repeat')
  t.alike(await forum.tagged(fc, 'nope'), [], 'a tag nobody used')
  t.alike(titles((await fc.query('post').tag('rust').latest(2)).items), ['post 3', 'post 2'], 'query(type).tag()')

  await forum.untag(fa, posts[2], 'rust')
  t.ok(await agree(all, async (f) => titles(await forum.tagged(f, 'rust')), ['post 3', 'post 1', 'post 0']), 'untagged, everywhere')
  t.is(await codeOf(forum.untag(fa, posts[2], 'rust')), 'NOT_FOUND', 'not tagged any more')
  await forum.tag(fa, posts[2], 'rust')
  t.ok(await agree(all, async (f) => titles(await forum.tagged(f, 'rust')).length, 4), 'tagged again')

  t.is(await codeOf(forum.tag(fb, posts[4], 'spam')), 'NOT_ALLOWED', 'b can\'t tag a\'s post')
  await testing.writeRaw(fb, { kind: 'put', type: 'hg/tag', fields: { on: posts[4].id, tag: 'spam' } })
  const marker = await forum.post(fb, 'marker', '')
  t.ok(await agree(all, async (f) => !!(await f.get(marker.id)).record, true))
  for (const f of all) t.alike(await forum.tagged(f, 'spam'), [], 'ignored everywhere')
})

test('queries by type, author, link, tag and time compose; linked() leaves hypergraph\'s own records out', async (t) => {
  const { fa, fb, fc } = await threeMembers(t)
  const p = await forum.post(fa, 'P', '')
  const q = await forum.post(fb, 'Q', '')
  await forum.tag(fa, p, 'news')
  await fa.relate(p, q, 'cites')
  const c1 = await forum.comment(fb, p, 'b on p')
  await sleep(5)
  const c2 = await forum.comment(fc, p, 'c on p')
  await sleep(5)
  const c3 = await forum.comment(fb, q, 'b on q')
  const ids = (r) => r.items.map((x) => x.id)
  await eventually(async () => (await fc.query('comment').latest(10)).items.length === 3, 10000)

  t.alike(ids(await fc.query('comment').on(p).latest(10)), [c2.id, c1.id], 'by link, newest first')
  t.alike(ids(await fc.query('comment').on(p).by(fb.hg.identity.publicKey).latest(10)), [c1.id], 'link and author')
  t.alike(ids(await fc.query('comment').since(c2.stamp).latest(10)), [c3.id, c2.id], 'since a time (inclusive)')
  t.alike(ids(await fc.query('comment').until(c2.stamp).latest(10)), [c1.id], 'until a time (exclusive)')
  t.alike(ids(await fc.query('post').tag('news').by(fa.hg.identity.publicKey).latest(10)), [p.id], 'tag and author')
  t.alike(ids(await fc.query('post').tag('news').by(fb.hg.identity.publicKey).latest(10)), [], 'and nothing else')
  t.alike((await fc.linked(p)).items.map((x) => x.type).sort(), ['comment', 'comment'], 'linked(): no relations or tags')
})

test('paging through posts by three members never skips or repeats, equal stamps included', async (t) => {
  const { fa, fb, fc, all } = await threeMembers(t)
  const written = []
  const base = Date.now() - 60000
  for (let i = 0; i < 8; i++) {
    for (const f of all) {
      written.push(await testing.writeRaw(f, { kind: 'put', type: 'post', stamp: base + i, fields: { title: `${i}`, text: '' } }))
    }
  }
  written.push((await forum.post(fa, 'last', '')).id)
  await eventually(async () => (await fc.query('post').latest(50)).items.length === 25, 10000)
  const seen = []
  let after
  for (;;) {
    const page = await forum.postsPage(fb, 7, after)
    if (!page.length) break
    t.ok(page.length <= 7)
    seen.push(...page)
    after = page.at(-1)
  }
  t.is(seen.length, 25, 'every post once')
  t.alike(seen.map((p) => p.id).sort(), written.sort(), 'no gap, no repeat')
  t.ok(seen.every((p, i) => i === 0 || p.stamp <= seen[i - 1].stamp), 'newest first throughout')
})

test('a member offline meanwhile shows the same edges and tags', async (t) => {
  const { c, fa, fb, fc } = await threeMembers(t)
  const p = await forum.post(fa, 'P', '')
  const q = await forum.post(fb, 'Q', '')
  const r = await forum.post(fa, 'R', '')
  await eventually(async () => (await forum.latest(fc)).length === 3, 10000)
  await c.close()
  await forum.seeAlso(fa, p, q, 'one')
  await forum.seeAlso(fa, r, q, 'two')
  await forum.unlink(fa, p, q)
  await forum.tag(fa, p, 'a')
  await forum.tag(fa, r, 'a')
  await forum.untag(fa, r, 'a')
  const c2 = await open(t, { dir: c.dir, types: forum.types, rules: forum.rules })
  await c2.connectToSwarm()
  const fc2 = c2.space(fc.key)
  const expected = { refs: { from: [r.id], count: 1 }, tagged: [p.id] }
  const state = async (f) => ({ refs: await forum.referencedBy(f, q), tagged: (await forum.tagged(f, 'a')).map((x) => x.id) })
  t.ok(await agree([fa, fb, fc2], state, expected), 'the same everywhere')
  const n = await account(t, 'newcomer')
  const fn = await forum.join(n, await forum.invite(fa))
  t.ok(await agree([fn], state, expected), 'for a newcomer too')
})
