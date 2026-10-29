// Story 6 #1, #5, FR-027: storage policies. A small forum is held entirely by
// every member without anyone choosing anything ("auto"). A forum whose
// creator chose "keep everything": a member whose budget is too small is told
// it is below the forum's policy, and gets everything back once it fits.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account, threeMembers } = require('./_setup.js')
const { eventually, codeOf, sleep } = require('../helpers.js')

const MB = 1e6
const text = (i) => `post ${i} `.padEnd(8000, 'lorem ipsum ')

test('a small forum with default settings is held entirely by every member', async (t) => {
  const { fa, fb, fc, all } = await threeMembers(t)
  const ps = []
  for (const [i, f] of [fa, fb, fc, fa, fb].entries()) ps.push(await forum.post(f, `p${i}`, text(i)))
  t.ok(await eventually(async () => {
    for (const f of all) if ((await forum.latest(f)).length !== 5) return false
    return true
  }, 10000))
  for (const f of all) {
    const s = f.status()
    t.is(s.policy, 'auto')
    t.is(s.held, 'all', 'nothing dropped')
    t.is(s.belowPolicy, false)
    for (const p of ps) t.ok(await testing.holdsBlock(f, p.id))
  }
})

test('keep everything: a member that can\'t is told, answers honestly, and gets everything back once it fits', async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Archive', { keepEverything: true })
  const fb = await forum.join(b, await forum.invite(fa))
  t.is(fb.status().policy, 'everything')
  const events = []
  fb.on('status', (s) => events.push(s.belowPolicy))

  await forum.setAppBudget(b, 1.5 * MB)
  const posts = []
  for (let i = 0; i < 120; i++) posts.push(await forum.post(fa, `p${i}`, text(i)))
  t.ok(await eventually(() => fb.status().belowPolicy, 30000), 'b is below the forum\'s policy')
  t.ok(await eventually(() => events.includes(true), 2000), 'and was told with a status event')
  t.ok(fb.status().warnings.some((w) => w.code === 'BELOW_POLICY'))
  t.ok(await eventually(async () => (await forum.latest(fb, 1))[0]?.id === posts.at(-1).id, 10000))
  const page = await fb.query('post').latest(20)
  t.ok(page.complete, 'its answers are honest: the latest page is complete')

  await forum.setAppBudget(b, null) // the default budget: room again
  t.ok(await eventually(async () => !fb.status().belowPolicy && await testing.holdsBlock(fb, posts[0].id), 30000), 'it gets everything back and is no longer below')
  t.ok(await eventually(() => events.at(-1) === false, 2000), 'told again')
  t.is(fb.status().held, 'all')
})

test('the owner changes the policy for every member; a member can\'t', async (t) => {
  const { fa, fb, fc } = await threeMembers(t)
  await forum.keepEverything(fa)
  t.ok(await eventually(() => fb.status().policy === 'everything' && fc.status().policy === 'everything', 10000), 'every member applies it')
  t.is(await codeOf(forum.keepEverything(fb)), 'NOT_ALLOWED', 'a member can\'t')
  await fa.setPolicy('auto')
  t.ok(await eventually(() => fb.status().policy === 'auto', 10000))
  await t.exception.all(fa.setPolicy('sometimes'), /auto|everything/, 'only auto or everything')
})

test('auto: dropped content isn\'t fetched back when room comes back, only when read', async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Busy')
  const fb = await forum.join(b, await forum.invite(fa))
  await forum.setAppBudget(b, 1.5 * MB)
  const posts = []
  for (let i = 0; i < 120; i++) posts.push(await forum.post(fa, `p${i}`, text(i)))
  t.ok(await eventually(async () => fb.status().held === 'part' && !(await testing.holdsBlock(fb, posts[0].id)), 30000), 'the oldest content is dropped')
  t.is(fb.status().belowPolicy, false, 'auto: not below anything')
  await forum.setAppBudget(b, null)
  await sleep(3000)
  t.absent(await testing.holdsBlock(fb, posts[0].id), 'not fetched back')
  t.is((await fb.get(posts[0].id, { timeout: 5000 })).record.text, posts[0].text, 'until read (opening the post: waits for it)')
  t.ok(await testing.holdsBlock(fb, posts[0].id))
})
