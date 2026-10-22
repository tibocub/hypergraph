// Follow-ups of story 5's review (ROADMAP 2026-10-09): a space lists its roles
// with their permissions (`space.roles()`), so an app defines its own role
// once instead of every time it gives it; a member just promoted to record
// decisions does so at once (its device waits, within the bound, to become a
// writer of the decision log) instead of failing.

const test = require('brittle')
const forum = require('./forum.js')
const { account, threeMembers } = require('./_setup.js')
const { eventually } = require('../helpers.js')

test('a space lists its built-in roles and its own, with their permissions, on every member', async (t) => {
  const { b, c, fa, fb } = await threeMembers(t)
  const builtIn = await forum.roles(fa)
  t.alike(builtIn.map((r) => r.name), ['owner', 'admin', 'moderator', 'member', 'guest'], 'built-in roles, highest first')
  t.alike(builtIn.find((r) => r.name === 'member').permissions, ['post'])
  t.alike(builtIn.find((r) => r.name === 'moderator').permissions, ['moderate', 'post'])
  t.ok(builtIn.every((r) => r.custom === false))

  // makeEditor defines 'editor' the first time only.
  let defined = 0
  const define = fa.defineRole.bind(fa)
  fa.defineRole = (...args) => { defined++; return define(...args) }
  await forum.makeEditor(fa, b.identity.publicKey)
  await forum.makeEditor(fa, c.identity.publicKey)
  t.is(defined, 1, 'the role is defined once')

  const editor = (f) => forum.roles(f).then((rs) => rs.filter((r) => r.name === 'editor'))
  t.alike(await editor(fa), [{ name: 'editor', permissions: ['post', 'edit-pages'], custom: true }])
  t.ok(await eventually(async () => (await editor(fb)).length === 1, 10000), 'every member lists it')
})

test('a member just made moderator moderates at once, no retry', async (t) => {
  const { b, fa, fb, fc } = await threeMembers(t)
  const p = await forum.post(fc, 'rude', '')
  t.ok(await eventually(async () => (await fb.get(p.id)).record, 10000))
  await forum.giveRole(fa, b.identity.publicKey, 'moderator')
  t.ok(await eventually(async () => (await forum.roleOf(fb, b.identity.publicKey)) === 'moderator', 10000))
  await forum.hide(fb, p, 'rude') // no retry: b's device waits to become a decision writer
  t.ok(await eventually(async () => !(await forum.latest(fa)).some((x) => x.id === p.id), 10000), 'hidden for everyone')
})

test('a phone joining an owner\'s account records decisions right away', async (t) => {
  const laptop = await account(t, 'laptop')
  const c = await account(t, 'c')
  const fl = await forum.createForum(laptop, 'Fans')
  const fc = await forum.join(c, await forum.invite(fl))
  const rude = await forum.post(fc, 'rude', '')
  const { code } = await forum.addDevice(laptop)
  const { device } = require('./_setup.js')
  const phone = await device(t, 'phone', code)
  const fp = await eventually(async () => {
    try { const f = phone.space(fl.key); return (await f.get(rude.id)).record ? f : null } catch { return null }
  }, 15000)
  t.ok(fp, 'the phone holds the forum')
  await forum.hide(fp, rude, 'rude') // no retry
  t.ok(await eventually(async () => !(await forum.latest(fc)).some((x) => x.id === rude.id), 10000), 'everyone applies its hide')
})
