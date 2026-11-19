// On the network: a private space's disk key reaches a newcomer's
// device sealed to it, from the decider that records its redemption, never
// in the link; a refused redemption gets nothing; the person's other devices
// open it from the personal space; epoch keys and removals work on top of it;
// rotateKey() is for who may decide or moderate; a blind peer keeps and
// serves it without the key.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account, device } = require('../forum/_setup.js')
const { helper, heldBy } = require('./_helper.js')
const { eventually, codeOf } = require('../helpers.js')

const shows = async (f, title) => (await forum.latest(f)).some((p) => p.title === title)

const plainIn = async (store, keys, needle) => testing.inClear(await testing.rawBlocks(store, keys), needle)
const spaceCores = (s) => testing.coreKeys(s)

test('a newcomer gets the disk key from the decider that lets it in, and reads and writes', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Secret-8812', { private: true })
  await forum.post(fa, 'before-8812', 'from a')
  const link = await forum.invite(fa)
  const fb = await forum.join(b, link)
  t.alike(testing.diskKey(fb), testing.diskKey(fa), 'b holds the same disk key')
  t.is(fb.name, 'Secret-8812', 'reads the name')
  t.ok(await eventually(() => shows(fb, 'before-8812'), 15000), 'reads what came before')
  await forum.post(fb, 'reply-8812', 'from b')
  t.ok(await eventually(() => shows(fa, 'reply-8812'), 15000), 'and writes for the others')
  t.absent(await plainIn(b.store, await spaceCores(fb), 'reply-8812'), 'b\'s copy is sealed on disk')
  t.absent(await plainIn(b.store, await spaceCores(fb), 'Secret-8812'), 'its decision log too')
})

test('a refused redemption gets its refusal code at once, never the key: used up, revoked, banned', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const c = await account(t, 'c')
  const fa = await forum.createForum(a, 'Once', { private: true })
  const link = await forum.invite(fa) // one use
  await forum.join(b, link)
  const refused = async (p) => {
    const start = Date.now()
    const code = await codeOf(p)
    return { code, fast: Date.now() - start < 10000 }
  }
  t.alike(await refused(forum.join(c, link, { timeout: 20000 })), { code: 'INVITE_USED_UP', fast: true }, 'used up, told at once')
  const revoked = await forum.invite(fa)
  await fa.revokeInvite(revoked)
  t.alike(await refused(forum.join(c, revoked, { timeout: 20000 })), { code: 'INVITE_REVOKED', fast: true }, 'revoked')
  await forum.ban(fa, c.identity.publicKey, { reason: 'no' })
  t.alike(await refused(forum.join(c, await forum.invite(fa), { timeout: 20000 })), { code: 'NOT_ALLOWED', fast: true }, 'banned')
  t.is(c._diskKeys.size, 0, 'never got the key')
  t.exception(() => c.space(fa.key), 'nor the space: nothing of it readable')
})

test('a second device opens it from the personal space; a restart reopens it', { timeout: 120000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Family', { private: true })
  await forum.post(fa, 'hello-4410', '')
  await forum.join(b, await forum.invite(fa))
  const { code } = await forum.addDevice(b)
  const phone = await device(t, 'phone', code)
  const onPhone = await eventually(() => { try { return phone.space(fa.key) } catch { return null } }, 30000)
  t.ok(onPhone, 'the phone has it, nobody asked')
  await onPhone.ready()
  t.alike(testing.diskKey(onPhone), testing.diskKey(fa), 'with its disk key')
  t.ok(await eventually(() => shows(onPhone, 'hello-4410'), 20000), 'and reads it')

  await phone.close()
  const again = await account(t, 'phone2', { dir: phone.dir })
  const s = again.space(fa.key)
  await s.ready()
  t.ok(await eventually(() => shows(s, 'hello-4410'), 20000), 'after a restart too')
})

test('removal changes the content key on top of the disk key; rotateKey() is for who may decide or moderate', { timeout: 120000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const m = await account(t, 'm')
  const fa = await forum.createForum(a, 'Club', { private: true })
  const fb = await forum.join(b, await forum.invite(fa))
  const fm = await forum.join(m, await fa.createInvite({ role: 'moderator' }))
  t.is(await codeOf(fb.rotateKey()), 'NOT_ALLOWED', 'a member may not')
  const epoch = fa.state.keys.current
  await fm.rotateKey()
  t.ok(fm.state.keys.current > epoch, 'a moderator may: recorded when it resolves')
  await forum.post(fa, 'after-rotate', '')
  t.ok(await eventually(() => shows(fb, 'after-rotate'), 20000), 'members get the new key')

  await forum.removeMember(fa, b.identity.publicKey)
  await forum.post(fa, 'after-removal', '')
  t.ok(await eventually(() => shows(fm, 'after-removal'), 20000), 'the others read on')
  t.ok(await eventually(async () => fb.status().access === 'none', 20000), 'b is told it is out')
  t.absent(await shows(fb, 'after-removal'), 'b holds the disk key, not the new content key')
})

test('a blind peer keeps and serves it without the key; a member offline the whole time reads it from the helper', { timeout: 150000 }, async (t) => {
  const server = await helper(t)
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Kept-6630', { private: true })
  await fa.setHelpers([server.key])
  const fb = await forum.join(b, await forum.invite(fa))
  t.ok(await eventually(() => fb.helpers.length === 1, 10000), 'b knows the helper')
  await b.close() // b is away from here on

  await forum.post(fa, 'away-6630', 'kept for b')
  t.ok(await eventually(() => heldBy(server, fa), 30000), 'the helper holds it')
  t.absent(await plainIn(server.store, await spaceCores(fa), 'away-6630'), 'no plaintext on the helper')
  t.absent(await plainIn(server.store, await spaceCores(fa), 'Kept-6630'), 'not even the space\'s name')
  await a.close()

  const b2 = await account(t, 'b2', { dir: b.dir })
  const fb2 = b2.space(fa.key)
  t.ok(await eventually(() => shows(fb2, 'away-6630'), 40000), 'b reads it from the helper alone')
})

test('a guest of a sub-space of a private space gets the key and reads the sub-space only', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const g = await account(t, 'g')
  const fa = await forum.createForum(a, 'Top', { private: true })
  const room = await forum.createSubforum(fa, 'Room')
  await forum.post(room, 'in-the-room', '')
  const sg = await forum.join(g, await forum.inviteGuest(room))
  t.is(sg.key, room.key)
  t.ok(await eventually(() => shows(sg, 'in-the-room'), 20000), 'the guest reads the sub-space')
  t.exception(() => g.space(fa.key), 'not the top space')
})
