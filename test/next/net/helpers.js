// Spec 013: helpers (blind peers) keep a space's data available while its
// members are offline, and are never required.

const test = require('brittle')
const b4a = require('b4a')
const z32 = require('z32')
const crypto = require('hypercore-crypto')
const forum = require('../forum/forum.js')
const { account } = require('../forum/_setup.js')
const { helper, heldBy } = require('./_helper.js')
const { eventually, codeOf } = require('../helpers.js')

test('a member away reads the owner\'s posts and those of a member it never met, through the helper alone', { timeout: 120000 }, async (t) => {
  const server = await helper(t)
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Kept')
  await fa.setHelpers([server.key])
  const fb = await forum.join(b, await forum.invite(fa))
  t.ok(await eventually(() => fb.helpers.length === 1, 10000), 'b knows the helper')
  await b.close()

  const d = await account(t, 'd') // joins while b is away: b never meets d
  const fd = await forum.join(d, await forum.invite(fa))
  await forum.post(fa, 'from a', '')
  await forum.post(fd, 'from d', '')
  t.ok(await eventually(() => heldBy(server, fd), 20000), 'the helper holds d\'s part')
  const dlog = b4a.toString(fd.own.key, 'hex')
  t.ok(await eventually(() => fa.state.listed.has(dlog), 20000), 'a listed d\'s log in the decisions')
  t.ok(await eventually(() => heldBy(server, fa), 20000), 'the helper holds a\'s part, that decision included')
  await d.close()
  await a.close()

  const b2 = await account(t, 'b2', { dir: b.dir })
  const fb2 = b2.space(fa.key)
  const titles = async () => (await forum.latest(fb2)).map((p) => p.title).sort().join()
  t.ok(await eventually(async () => (await titles()) === 'from a,from d', 30000), 'b reads both')
  t.is(await titles(), 'from a,from d')
})

test('a dead or bogus helper: open, post and read don\'t wait or fail', { timeout: 60000 }, async (t) => {
  const down = await helper(t)
  const a = await account(t, 'a')
  const fa = await forum.createForum(a, 'Unkept')
  await fa.setHelpers([z32.encode(crypto.randomBytes(32)), down.key])
  await down.close()
  await forum.post(fa, 'before', '')
  await a.close()

  let t0 = Date.now()
  const a2 = await account(t, 'a2', { dir: a.dir })
  const fa2 = a2.space(fa.key)
  t.comment(`reopened in ${Date.now() - t0} ms`)
  t.is(fa2.helpers.length, 2)
  t0 = Date.now()
  await forum.post(fa2, 'after', '')
  const titles = (await forum.latest(fa2)).map((p) => p.title).sort()
  const ms = Date.now() - t0
  t.alike(titles, ['after', 'before'])
  t.ok(ms < 1000, `post + read in ${ms} ms`)
})

test('only the owner lists helpers', { timeout: 60000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Owned')
  const fb = await forum.join(b, await forum.invite(fa))
  await forum.giveRole(fa, b.identity.publicKey, 'admin')
  t.ok(await eventually(async () => (await forum.roleOf(fb, b.identity.publicKey)) === 'admin', 10000), 'b is an admin')
  t.is(await codeOf(fb.setHelpers([z32.encode(crypto.randomBytes(32))])), 'NOT_ALLOWED', 'the API refuses')
  t.ok(await codeOf(fa.setHelpers(['not a key'])), 'a bad key is refused')

  // b writes the decision by hand: nobody counts it
  t.ok(await eventually(() => fb.decisionLog.writable, 10000), 'b records decisions')
  const before = (await fa.decisions()).items.length
  await fb.decisionLog.append({ type: 'settings/set', policy: null, writeLimit: null, rules: null, history: null, helpers: [b4a.toString(crypto.randomBytes(32), 'hex')] })
  t.ok(await eventually(async () => (await fa.decisions()).items.length > before, 10000), 'a got it')
  t.alike(fa.helpers, [], 'the owner\'s list is unchanged')
  t.alike(fb.helpers, [])

  const key = z32.encode(crypto.randomBytes(32))
  await fa.setHelpers([key])
  t.ok(await eventually(() => fb.helpers[0] === key, 10000), 'the owner\'s list reaches members')
  await fa.setHelpers([])
  t.ok(await eventually(() => fb.helpers.length === 0, 10000), 'and clearing it')
})

test('a private space: the helper holds blocks it can\'t read; a member away reads them', { timeout: 120000 }, async (t) => {
  const server = await helper(t)
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Secret', { private: true })
  await fa.setHelpers([server.key])
  const fb = await forum.join(b, await forum.invite(fa))
  t.ok(await eventually(() => fb.helpers.length === 1, 10000), 'b knows the helper')
  await b.close()

  await forum.post(fa, 'hush-title-4242', 'hush-text-4242')
  t.ok(await eventually(() => heldBy(server, fa), 20000), 'the helper holds it')
  const copy = server.store.get({ key: fa.own.key })
  await copy.ready()
  let plain = false
  for (let i = 0; i < copy.length; i++) {
    if (b4a.toString(await copy.get(i)).includes('hush-')) plain = true
  }
  await copy.close()
  t.absent(plain, 'no plaintext on the helper')
  await a.close()

  const b2 = await account(t, 'b2', { dir: b.dir })
  const fb2 = b2.space(fa.key)
  t.ok(await eventually(async () => (await forum.latest(fb2)).some((p) => p.title === 'hush-title-4242'), 30000), 'b reads it')
})
