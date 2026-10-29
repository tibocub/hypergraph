// Spec 012 US1 (FR-001-FR-005): reads answer at once from what this device
// holds, with `complete`; a read waits only when given { timeout }. What a
// read needs (dropped content, a big space's older part) still starts, and
// `change` says when it is here. bounded.js covers reads given a timeout.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')

// a holds 1,000 of its own posts and b's post p; b is offline and wrote
// more meanwhile. Returns a reopened, before it reached b.
async function holderOffline (t) {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Offline')
  const fb = await forum.join(b, await forum.invite(fa))
  const p = await forum.post(fb, 'from b', '')
  await forum.tag(fb, p, 'news')
  for (let i = 0; i < 1000; i++) await testing.writeRaw(fa, { kind: 'put', type: 'post', fields: { title: `a${i}`, text: '' } })
  t.ok(await eventually(async () => (await fa.get(p.id)).record, 10000), 'a holds b\'s post')
  await a.close()
  await b.close()
  const b2 = await account(t, 'b2', { dir: b.dir })
  const later = await forum.post(b2.space(fa.key), 'written while a was away', '')
  await b2.close()
  const a2 = await account(t, 'a2', { dir: a.dir })
  return { a2, fa2: a2.space(fa.key), p, later, bdir: b.dir }
}

test('the only other member offline: every read answers at once, incomplete', { timeout: 120000 }, async (t) => {
  const { fa2, p } = await holderOffline(t)
  const reads = {
    query: () => fa2.query('post').latest(20),
    get: () => fa2.get(p.id),
    linked: () => fa2.linked(p, 'comment'),
    count: () => fa2.count('comment', { on: p }),
    sum: () => fa2.sum('vote', 'value', { on: p }),
    tags: () => fa2.tags(p),
    edges: () => fa2.edges(p),
    getByTag: () => fa2.getByTag('news', { type: 'post' })
  }
  for (const [name, read] of Object.entries(reads)) {
    const t0 = Date.now()
    const r = await read()
    const ms = Date.now() - t0
    t.ok(ms < 250, `${name}: at once (${ms} ms; it waited 5 s before spec 012)`)
    t.is(r.complete, false, `${name}: incomplete`)
  }
  t.is((await fa2.get(p.id)).record.title, 'from b', 'with what it holds')
})

test('{ timeout }: waits while incomplete, answers once complete', { timeout: 120000 }, async (t) => {
  const { fa2, later, bdir } = await holderOffline(t)
  setTimeout(() => account(t, 'b3', { dir: bdir }).catch(() => {}), 1000)
  const t0 = Date.now()
  const r = await fa2.query('post').latest(20, { timeout: 20000 })
  const ms = Date.now() - t0
  t.ok(r.complete, 'complete')
  t.ok(ms >= 900 && ms < 20000, `answered once complete (${ms} ms), not at the end of its timeout`)
  // shortcut: `complete` can turn true as a reaches b, a moment before a hears b's log grew
  // (an older gap, not spec 012's: see its research.md R13); read again until it shows.
  t.ok(await eventually(async () => (await fa2.query('post').latest(20)).items[0]?.id === later.id, 10000), 'then with what b wrote while a was away')
})

test('dropped content read at once: left out, fetched, and change names it once back', { timeout: 120000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Dropped')
  const fb = await forum.join(b, await forum.invite(fa))
  await b.setBudget(1.5e6)
  const posts = []
  for (let i = 0; i < 120; i++) posts.push(await forum.post(fa, `p${i}`, `post ${i} `.padEnd(8000, 'lorem ipsum ')))
  t.ok(await eventually(async () => (await fb.query('post').latest(1)).items[0]?.id === posts.at(-1).id && !(await testing.holdsBlock(fb, posts[0].id)), 30000), 'b dropped the oldest content')
  await a.close()

  const t0 = Date.now()
  const gone = await fb.get(posts[0].id)
  t.ok(Date.now() - t0 < 250, 'at once')
  t.is(gone.record, null, 'left out')
  t.is(gone.complete, false, 'incomplete')

  await account(t, 'a2', { dir: a.dir })
  const back = new Promise((resolve) => fb.on('change', ({ records }) => { if (records.some((r) => r.id === posts[0].id)) resolve() }))
  // An app re-reads (here: until a is reachable); each read starts the fetch.
  t.ok(await eventually(async () => { await fb.get(posts[0].id); return testing.holdsBlock(fb, posts[0].id) }, 20000), 'fetched in the background')
  await back
  t.pass('change named it once back')
  t.is((await fb.get(posts[0].id)).record.title, 'p0', 'and a read shows it')
})

test('a newcomer to a big space: its live first page goes from what it holds to complete', { timeout: 120000 }, async (t) => {
  t.teardown(testing.bigSpaces({ records: 20 })) // a "big" space for this test: more than 20 records
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'Big')
  const posts = []
  for (let i = 0; i < 60; i++) posts.push(await forum.post(fa, `p${i}`, ''))
  const c = await account(t, 'c')
  const fc = await forum.join(c, await forum.invite(fa))
  const answers = []
  const stop = fc.query('post').live((r) => answers.push(r), { limit: 10 })
  t.teardown(stop)
  t.ok(await eventually(() => answers.at(-1)?.complete, 20000), 'complete with no further call')
  t.alike(answers.at(-1).items.map((p) => p.title), posts.slice(-10).reverse().map((p) => p.title), 'the 10 newest')
  t.ok(answers.length >= 1)
})
