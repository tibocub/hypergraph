// Spec 027 (build.md FR-001, FR-002, FR-005): renewing a private space. A new
// decision log, new logs and a new disk key; the old logs are the new space's
// history (same record ids), read with the old key; the "moved to" pointer is
// sealed to current devices only; removed people are left behind; sub-spaces
// get new keys; two renews at once: the first decided wins.

const test = require('brittle')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually, codeOf } = require('../helpers.js')

const titles = async (f) => (await forum.latest(f, 50)).map((p) => p.title)
const shows = async (f, title) => (await titles(f)).includes(title)
const spaceOf = (hg, key) => { try { return hg.space(key) } catch { return null } }

test('renew: members move with their history and ids; a removed member is left behind', { timeout: 180000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const c = await account(t, 'c')
  const fa = await forum.createForum(a, 'Club-2701', { private: true })
  const fb = await forum.join(b, await forum.invite(fa))
  await forum.join(c, await forum.invite(fa))
  const room = await forum.createSubforum(fa, 'Room')
  const p1 = await forum.post(fa, 'before-a', 'from a')
  const p2 = await forum.post(fb, 'before-b', 'from b')
  const inRoom = await forum.post(room, 'in-room', '')
  const oldLink = await forum.invite(fa)
  t.ok(await eventually(() => shows(fa, 'before-b'), 20000), 'a reads b before')
  await forum.removeMember(fa, c.identity.publicKey)

  const fresh = await fa.renew()
  t.not(fresh.key, fa.key, 'a new key')
  t.is(fa.movedTo, fresh.key, 'the old space points at it')
  t.is(fresh.name, 'Club-2701', 'its name carried')
  t.is(fresh.renewal.from, fa.key, 'it says where it came from')
  t.not(testing.diskKey(fresh), testing.diskKey(fa), 'a new disk key')
  t.is(a.space(fa.key), fresh, 'the old key leads to it')
  t.absent(a.spaces().some((s) => s.key === fa.key), 'the old one is no longer listed')

  const ids = (await forum.latest(fresh, 50)).map((p) => p.id)
  t.ok(ids.includes(p1.id) && ids.includes(p2.id), 'the history, same ids')

  const onB = await eventually(() => { const s = spaceOf(b, fa.key); return s && s.key === fresh.key ? s : null }, 40000)
  t.ok(onB, 'b moved by itself')
  t.ok(await eventually(() => shows(onB, 'before-a'), 30000), 'b reads the history there')
  t.is(await forum.roleOf(onB, b.identity.publicKey), 'member', 'b keeps its role')
  await forum.post(onB, 'after-b', '')
  t.ok(await eventually(() => shows(fresh, 'after-b'), 30000), 'and writes for a')

  const rooms = forum.subforums(fresh)
  t.is(rooms.length, 1, 'the sub-space came along')
  t.not(rooms[0].key, room.key, 'with a new key')
  const freshRoom = a.space(rooms[0].key)
  t.ok(await eventually(async () => (await forum.latest(freshRoom)).some((p) => p.id === inRoom.id), 20000), 'its history too, same ids')

  const oldOnC = c.space(fa.key)
  t.ok(await eventually(() => oldOnC.moved, 30000), 'c sees the space moved')
  t.is(oldOnC.movedTo, null, 'but not where')
  t.is(spaceOf(c, fresh.key), null, 'and has nothing of it')
  t.absent([...c._diskKeys.values()].some((k) => k.equals(testing.diskKey(fresh))), 'nor its disk key')
  t.is(await codeOf(forum.post(oldOnC, 'late-c', '')), 'MOVED', 'the old space is read-only')

  const d = await account(t, 'd')
  t.ok(['INVITE_INVALID', 'NOT_ALLOWED', 'INVITE_REVOKED'].includes(await codeOf(forum.join(d, oldLink, { timeout: 8000 }))), 'an old invite link no longer works')
})

test('renew is for owners and admins of a private top space', { timeout: 120000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Rules-2702', { private: true })
  const fb = await forum.join(b, await forum.invite(fa))
  t.is(await codeOf(fb.renew()), 'NOT_ALLOWED', 'a member may not')
  const room = await forum.createSubforum(fa, 'Room')
  t.is(await codeOf(room.renew()), 'NOT_ALLOWED', 'a sub-space renews with its top space')
  const open = await forum.createForum(a, 'Open-2702')
  t.is(await codeOf(open.renew()), 'NOT_ALLOWED', 'a public or closed space has no disk key to renew')
})

test('two renews at once: the first decided wins, the other is told', { timeout: 180000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Race-2703', { private: true })
  const fb = await forum.join(b, await fa.createInvite({ role: 'admin' }))
  t.ok(await eventually(() => fb.decisionLog.writable, 20000), 'b records decisions')
  const [x, y] = await Promise.allSettled([fa.renew(), fb.renew()])
  const won = [x, y].filter((r) => r.status === 'fulfilled')
  const lost = [x, y].filter((r) => r.status === 'rejected')
  t.is(won.length, 1, 'one renew wins')
  t.is(lost.length, 1, 'the other does not')
  t.is(lost[0].reason.code, 'ALREADY_RENEWED', 'and is told')
  const to = won[0].value.key
  t.ok(await eventually(() => fa.movedTo === to && fb.movedTo === to, 30000), 'both follow the winner')
})

test('secure(): a new content key at once, then the renew; forget drops the history', { timeout: 180000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Safe-2704', { private: true })
  await forum.join(b, await forum.invite(fa))
  await forum.post(fa, 'old-2704', '')
  const epoch = fa.state.keys.current
  const fresh = await fa.secure()
  t.ok(fa.state.keys.current > epoch, 'the old space\'s key changed first')
  t.ok(await eventually(() => shows(fresh, 'old-2704'), 20000), 'history kept by default')

  const fa2 = await forum.createForum(a, 'Gone-2704', { private: true })
  await forum.post(fa2, 'old-gone', '')
  const fresh2 = await fa2.secure({ forget: true })
  await forum.post(fresh2, 'new-kept', '')
  t.ok(await eventually(() => shows(fresh2, 'new-kept'), 20000), 'new posts read')
  t.absent(await shows(fresh2, 'old-gone'), 'everything before now is gone')
})

test('newcomers after a renew follow the history setting', { timeout: 180000 }, async (t) => {
  const a = await account(t, 'a')
  const n = await account(t, 'n')
  const h = await account(t, 'h')
  const fa = await forum.createForum(a, 'Hist-2705', { private: true })
  await forum.post(fa, 'kept-2705', '')
  const fresh = await fa.renew()
  const fn = await forum.join(n, await forum.invite(fresh))
  t.ok(await eventually(() => shows(fn, 'kept-2705'), 30000), 'visible history: the newcomer reads it')

  const fb = await forum.createForum(a, 'Hidden-2705', { private: true })
  await fb.setHistory('hidden')
  await forum.post(fb, 'secret-2705', '')
  const fresh2 = await fb.renew()
  const fh = await forum.join(h, await forum.invite(fresh2))
  await forum.post(fresh2, 'new-2705', '')
  t.ok(await eventually(() => shows(fh, 'new-2705'), 30000), 'hidden history: reads from its join on')
  t.absent(await shows(fh, 'secret-2705'), 'not before')
  t.absent(h._diskKeys.has(fb.hex), 'never got the old disk key')
})

test('the hand-over: a renew waits for another decider device, and says so', { timeout: 180000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const solo = await forum.createForum(a, 'Solo-2706', { private: true })
  const freshSolo = await solo.renew()
  t.is(freshSolo.renewal.waiting, false, 'the only decider: nothing to wait for')

  const fa = await forum.createForum(a, 'Pair-2706', { private: true })
  const fb = await forum.join(b, await fa.createInvite({ role: 'admin' }))
  t.ok(await eventually(() => fb.decisionLog.writable, 20000), 'b records decisions')
  await b.close()
  const fresh = await fa.renew()
  t.is(fresh.renewal.waiting, true, 'waits while no other admin device took over')
  t.ok(fresh.status().warnings.some((w) => w.code === 'RENEW_WAITING'), 'a status warning says so')
  const b2 = await account(t, 'b2', { dir: b.dir })
  const onB = await eventually(() => { const s = spaceOf(b2, fa.key); return s && s.key === fresh.key ? s : null }, 40000)
  t.ok(onB, 'b moves when it comes back')
  t.ok(await eventually(() => fresh.renewal.waiting === false, 40000), 'and completes the hand-over')
  t.ok(await eventually(() => onB.decisionLog.writable, 20000), 'b records decisions in the new space')
})
