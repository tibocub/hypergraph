// Spec 012 US4 (FR-010-FR-014): every read has an event that says when to
// read again: 'spaces' (a space's name arriving too: SwarmFS H12), 'members',
// 'decisions', 'devices', 'settings', 'status' (with complete).

const test = require('brittle')
const forum = require('../forum/forum.js')
const { account, device } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')

// Counts an emitter's events of `name`, keeping their payloads.
function count (emitter, name) {
  const seen = []
  emitter.on(name, (payload) => seen.push(payload))
  return seen
}

test('\'spaces\' again when a joined space\'s name arrives (H12)', { timeout: 90000 }, async (t) => {
  const laptop = await account(t, 'laptop')
  const fl = await forum.createForum(laptop, 'My files')
  const { code } = await forum.addDevice(laptop)
  const phone = await device(t, 'phone', code)
  const seen = count(phone, 'spaces')
  t.ok(await eventually(() => phone.spaces().find((s) => s.key === fl.key)?.name === 'My files', 15000), 'the phone shows the name')
  t.ok(await eventually(() => seen.some((list) => list.some((s) => s.key === fl.key && s.name === 'My files')), 1000), '\'spaces\' came with it')
})

test('\'spaces\' on another member when a sub-space is made', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Forum')
  await forum.join(b, await forum.invite(fa))
  const seen = count(b, 'spaces')
  const sub = await forum.createSubforum(fa, 'News')
  t.ok(await eventually(() => seen.some((list) => list.some((s) => s.key === sub.key && s.name === 'News')), 15000), 'b got it with its name')
})

test('\'members\' and \'decisions\' when roles change, \'members\' when a member\'s new device arrives', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Forum')
  const fb = await forum.join(b, await forum.invite(fa))
  const members = count(fb, 'members')
  const decisions = count(fb, 'decisions')
  await forum.giveRole(fa, b.identity.publicKey, 'moderator')
  t.ok(await eventually(async () => (await forum.roleOf(fb, b.identity.publicKey)) === 'moderator', 10000), 'b is a moderator')
  t.ok(members.length >= 1, '\'members\' came')
  t.ok(decisions.length >= 1, '\'decisions\' came')

  members.length = 0
  const { code } = await forum.addDevice(a)
  const phone = await device(t, 'phone', code)
  t.ok(await eventually(async () => {
    try { return !!(await forum.post(phone.space(fa.key), 'from a\'s phone', '')) } catch { return false }
  }, 15000), 'a\'s phone writes in the forum')
  const twoDevices = async () => (await fb.members()).find((m) => m.identity === a.identity.publicKey)?.devices.length === 2
  t.ok(await eventually(twoDevices, 10000), 'b lists a\'s two devices')
  t.ok(members.length >= 1, '\'members\' came for it')
})

test('\'devices\' and \'settings\' on the other device', { timeout: 90000 }, async (t) => {
  const laptop = await account(t, 'laptop')
  const devices = count(laptop, 'devices')
  const { code } = await forum.addDevice(laptop)
  const phone = await device(t, 'phone', code)
  t.ok(await eventually(async () => (await forum.devices(laptop)).length === 2, 15000), 'the laptop lists the phone')
  t.ok(await eventually(() => devices.length >= 1, 1000), '\'devices\' came')
  const settings = count(phone, 'settings')
  await forum.setSetting(laptop, 'theme', 'dark')
  t.ok(await eventually(async () => (await forum.setting(phone, 'theme')) === 'dark', 10000), 'the phone has the setting')
  t.ok(await eventually(() => settings.length >= 1, 1000), '\'settings\' came')
})

test('\'status\' with complete: true when the only other holder comes back', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Status')
  const fb = await forum.join(b, await forum.invite(fa))
  await forum.post(fb, 'from b', '')
  t.ok(await eventually(() => fa.status().complete, 10000), 'complete while both are online')
  await a.close()
  await b.close()
  const a2 = await account(t, 'a2', { dir: a.dir })
  const fa2 = a2.space(fa.key)
  t.is(fa2.status().complete, false, 'incomplete: it hasn\'t reached b since opening')
  const seen = count(fa2, 'status')
  await account(t, 'b2', { dir: b.dir })
  t.ok(await eventually(() => seen.some((s) => s.complete), 15000), '\'status\' came with complete: true')
})

test('no event after close()', { timeout: 90000 }, async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Closing')
  const fb = await forum.join(b, await forum.invite(fa))
  const events = []
  for (const name of ['change', 'members', 'decisions', 'status', 'logs']) fa.on(name, () => events.push(name))
  for (const name of ['spaces', 'devices', 'settings']) a.on(name, () => events.push(name))
  await a.close()
  events.length = 0
  await forum.post(fb, 'after a closed', '')
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.alike(events, [], 'nothing')
})
