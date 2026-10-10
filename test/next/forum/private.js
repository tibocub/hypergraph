// Private sub-forums (story 8, US8 #2; spec 008's scenarios, research.md
// A13): read by the people given a role in them plus the forum's owner and
// admins; whoever relays or stores the blocks without a key reads nothing; an
// invite gives access once a key holder is online; removing someone (or a ban
// in the forum) changes the key: they read what came before, not after; a
// record written in the clear is shown as unreadable; no key ever shows.

const test = require('brittle')
const b4a = require('b4a')
const z32 = require('z32')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account, threeMembers } = require('./_setup.js')
const { eventually, codeOf } = require('../helpers.js')

const opened = (hg, key, ms = 10000) => eventually(() => { try { return hg.space(key) } catch { return null } }, ms)
const titles = async (f) => (await forum.latest(f)).map((p) => p.title)
const shows = async (f, id) => (await forum.latest(f)).some((p) => p.id === id)

// A private sub-forum of `fa`, with b as an admin of the forum (so in it).
async function staffRoom (t) {
  const m = await threeMembers(t)
  await forum.giveRole(m.fa, m.b.identity.publicKey, 'admin')
  const staff = await forum.createSubforum(m.fa, 'Staff', { private: true })
  const sb = await opened(m.b, staff.key)
  return { ...m, staff, sb }
}

test('a private sub-forum: its members read it; a plain member doesn\'t have it; whoever holds its blocks without a key reads nothing', async (t) => {
  const { b, c, fa, fc, staff, sb } = await staffRoom(t)
  t.ok(staff.private, 'private')
  t.ok(sb, 'an admin of the forum has it')
  const p = await forum.post(sb, 'secret plan', 'meet at noon')
  t.ok(await eventually(() => shows(staff, p.id), 10000), 'the owner reads the admin\'s post')
  t.alike(forum.subforums(fc), [{ key: staff.key, name: 'Staff', private: true }], 'a plain member sees it exists')
  t.is(await codeOf((async () => c.space(staff.key))()), 'NOT_FOUND', 'but doesn\'t have it')

  // c opens it anyway (a relay, a storer): it gets the blocks, not the content.
  const rc = await testing.openSpace(c, staff.key, { root: fa.key })
  t.ok(await eventually(() => testing.holdsBlock(rc, p.id), 10000), 'it holds the block')
  const raw = await testing.rawBlock(rc, p.id)
  t.absent(b4a.includes(raw, b4a.from('secret plan')) || b4a.includes(raw, b4a.from('meet at noon')), 'no plaintext in it')
  t.alike(await titles(rc), [], 'nothing readable')
  t.is((await rc.get(p.id, { timeout: 0 })).record, null)

  // Keys live in memory only: after a restart they come back from the grants.
  await b.close()
  const b2 = await account(t, 'b2', { dir: b.dir })
  const again = await opened(b2, staff.key)
  t.ok(again && await eventually(() => shows(again, p.id), 10000), 'after a restart the admin reads it again')
  const q = await forum.post(again, 'still here', '')
  t.ok(await eventually(() => shows(staff, q.id), 10000), 'and writes')
})

test('an invite to the private sub-forum gives access once a key holder is online, the inviter offline', async (t) => {
  const { b, staff, sb } = await staffRoom(t)
  const before = await forum.post(staff, 'agenda', 'from the owner')
  const link = await forum.invite(sb)
  await b.close() // the inviter goes offline; the owner (a key holder) is online
  const d = await account(t, 'd')
  const sd = await forum.join(d, link)
  t.is(sd.key, staff.key)
  t.ok(await eventually(() => shows(sd, before.id), 10000), 'd reads what was posted before it came')
  const reply = await forum.post(sd, 'thanks', 'from d')
  t.ok(await eventually(() => shows(staff, reply.id), 10000), 'and writes for the others')
})

test('removing someone changes the key: they read what came before, not what comes after', async (t) => {
  const { staff, sb } = await staffRoom(t)
  const g = await account(t, 'g')
  const sg = await forum.join(g, await forum.invite(staff))
  const p1 = await forum.post(staff, 'before', '')
  t.ok(await eventually(() => shows(sg, p1.id), 10000), 'g reads it')
  await forum.removeMember(staff, g.identity.publicKey)
  const p2 = await forum.post(staff, 'after', '')
  t.ok(await eventually(() => shows(sb, p2.id), 10000), 'the others read the new post')
  t.ok(await eventually(() => testing.holdsBlock(sg, p2.id), 10000), 'g holds its block')
  t.absent(await shows(sg, p2.id), 'and can\'t read it')
  t.ok(await shows(sg, p1.id), 'what came before stays readable for g')
})

test('a ban in the forum changes the private sub-forum\'s key too', async (t) => {
  const { c, fa, staff, sb } = await staffRoom(t)
  await forum.giveRole(staff, c.identity.publicKey, 'member') // c given a role in the room
  const sc = await opened(c, staff.key)
  const p1 = await forum.post(staff, 'before the ban', '')
  t.ok(await eventually(() => shows(sc, p1.id), 10000), 'c reads it')
  await forum.ban(fa, c.identity.publicKey, { reason: 'leaks' })
  const p2 = await forum.post(staff, 'after the ban', '') // by the owner, who decided it
  t.ok(await eventually(() => shows(sb, p2.id), 10000), 'the admin reads the new post')
  t.ok(await eventually(() => testing.holdsBlock(sc, p2.id), 10000), 'c holds its block')
  t.absent(await shows(sc, p2.id), 'c can\'t read it')
})

test('a record written in the clear is shown as unreadable, never as content; no key ever shows', async (t) => {
  const { staff, sb } = await staffRoom(t)
  const id = await testing.writeRaw(sb, { kind: 'put', type: 'post', fields: { title: 'in the clear', text: 'oops' } })
  const shown = await eventually(async () => (await forum.latest(staff)).find((p) => p.id === id), 10000)
  t.ok(shown && shown.unreadable, 'listed as unreadable')
  t.absent(shown.title || shown.text, 'without its content')

  const keys = testing.epochKeys(staff)
  t.ok(keys.length > 0, 'the owner holds the key')
  const out = JSON.stringify([await staff.inspect(), staff.status(), await staff.decisions(), await staff.inspect({ records: { type: 'post' } })])
  for (const k of keys) {
    for (const form of [b4a.toString(k, 'hex'), z32.encode(k), b4a.toString(k, 'base64')]) t.absent(out.includes(form), 'no key in inspect(), status() or decisions()')
  }
  const err = await sb.put('post', { title: 'big', text: 'x'.repeat(70000) }).catch((e) => e)
  t.is(err.code, 'INVALID_RECORD')
  for (const k of keys) t.absent((err.message + err.stack).includes(b4a.toString(k, 'hex')), 'nor in errors')
})

test('a private forum: its members read it, whoever holds its blocks without a key doesn\'t', async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const c = await account(t, 'c')
  const club = await forum.createForum(a, 'Club', { private: true })
  t.ok(club.private)
  const p = await forum.post(club, 'members only', '')
  const fb = await forum.join(b, await forum.invite(club))
  t.ok(await eventually(() => shows(fb, p.id), 10000), 'a member reads it')
  const q = await forum.post(fb, 'hello', '')
  t.ok(await eventually(() => shows(club, q.id), 10000), 'and writes')
  const rc = await testing.openSpace(c, club.key)
  t.ok(await eventually(() => testing.holdsBlock(rc, p.id), 10000), 'a stranger holds the block')
  t.absent(b4a.includes(await testing.rawBlock(rc, p.id), b4a.from('members only')), 'no plaintext in it')
  t.alike(await titles(rc), [], 'and reads nothing')
})
