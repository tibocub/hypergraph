// Sub-forums (story 8, US8 #1, #3–5): seen inside their forum without joining;
// write-restricted; guests of a sub-forum only; a ban in the forum applies in
// its sub-forums, whatever arrived first; a removal takes sub-forum roles
// away; shortcuts to other forums. Sub-forum decisions live in the forum's
// decision log (research.md A13).

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account, threeMembers } = require('./_setup.js')
const { eventually, codeOf } = require('../helpers.js')

// The sub-forum `key` on `hg`, once its device opened it (members of the
// forum open it by themselves).
const opened = (hg, key, ms = 10000) => eventually(() => { try { return hg.space(key) } catch { return null } }, ms)
const shows = async (f, id) => (await forum.latest(f)).some((p) => p.id === id)

test('a sub-forum is seen inside its forum without joining; only admins create one; it reopens', async (t) => {
  const { b, c, fa, fb } = await threeMembers(t)
  const general = await forum.createSubforum(fa, 'General')
  t.alike(forum.subforums(fa), [{ key: general.key, name: 'General', private: false }])
  t.is(general.parent, fa.key, 'its parent is the forum')
  const gb = await opened(b, general.key)
  const gc = await opened(c, general.key)
  t.ok(gb && gc, 'b and c have it without joining')
  t.ok(forum.forums(b).some((s) => s.key === general.key && s.parent === fa.key), 'listed with its parent')
  const p = await forum.post(gc, 'in General', 'hi')
  t.ok(await eventually(async () => await shows(general, p.id) && await shows(gb, p.id), 5000), 'everyone sees c\'s post there')
  t.absent(await shows(fa, p.id), 'not in the forum itself')
  t.is(await codeOf(forum.createSubforum(fb, 'Mine')), 'NOT_ALLOWED', 'a member can\'t create one')
  const deep = await forum.createSubforum(general, 'Deep')
  const db = await opened(b, deep.key)
  t.ok(db && db.parent === general.key, 'a sub-forum of the sub-forum, there too')
  t.alike(forum.subforums(general).map((s) => s.name), ['Deep'])

  await b.close()
  const b2 = await account(t, 'b2', { dir: b.dir })
  const again = await opened(b2, general.key)
  t.ok(again && await eventually(() => shows(again, p.id), 5000), 'after a restart it is there, with its posts')
})

test('a write-restricted sub-forum: only moderators post; a forced post is ignored by everyone', async (t) => {
  const { b, c, fa, fb } = await threeMembers(t)
  await forum.giveRole(fa, c.identity.publicKey, 'moderator')
  const news = await forum.createSubforum(fa, 'News', { onlyRoles: ['moderator'] })
  const nb = await opened(b, news.key)
  const nc = await opened(c, news.key)
  t.is(await codeOf(forum.post(nb, 'not news', '')), 'NOT_ALLOWED', 'a member is refused by its own app')
  await testing.writeRaw(nb, { kind: 'put', type: 'post', fields: { title: 'forced', text: '' } })
  const p = await forum.post(nc, 'news', 'from a moderator')
  t.ok(await eventually(async () => await shows(news, p.id) && await shows(nb, p.id), 5000), 'the moderator\'s post shows')
  for (const f of [news, nc]) t.absent((await forum.latest(f)).some((x) => x.title === 'forced'), 'the forced post doesn\'t')
  t.ok(await forum.post(news, 'from the owner', ''), 'the owner always may')
  t.is(await forum.roleOf(fb, b.identity.publicKey), 'member')
})

test('a guest of a sub-forum only: reads and writes there, nothing in the forum', async (t) => {
  const { a, b, fa } = await threeMembers(t)
  const guests = await forum.createSubforum(fa, 'Guests')
  const pa = await forum.post(guests, 'welcome', '')
  const g = await account(t, 'guest')
  const gs = await forum.join(g, await forum.inviteGuest(guests))
  t.is(gs.key, guests.key)
  t.is(await forum.roleOf(gs, g.identity.publicKey), 'guest')
  t.ok(await eventually(() => shows(gs, pa.id), 5000), 'the guest reads the sub-forum')
  const pg = await forum.post(gs, 'hello from a guest', '')
  const gb = await opened(b, guests.key)
  t.ok(await eventually(async () => await shows(guests, pg.id) && await shows(gb, pg.id), 5000), 'and writes there')
  t.alike(forum.forums(g).map((s) => s.key), [guests.key], 'the guest holds the sub-forum only')
  t.is(await codeOf((async () => g.space(fa.key))()), 'NOT_FOUND', 'not the forum')
  t.is(await forum.roleOf(fa, g.identity.publicKey), null, 'nor a member of it')
  const fg = await testing.openSpace(g, fa.key)
  await testing.writeRaw(fg, { kind: 'put', type: 'post', fields: { title: 'guest in the forum', text: '' } })
  const marker = await forum.post(fa, 'marker', '')
  t.ok(await eventually(() => shows(b.space(fa.key), marker.id), 5000))
  t.absent((await forum.latest(fa)).some((x) => x.title === 'guest in the forum'), 'its post in the forum is ignored')
  t.ok(a)

  await g.close()
  const g2 = await account(t, 'guest2', { dir: g.dir })
  const again = await opened(g2, guests.key)
  t.ok(again && await eventually(() => shows(again, pg.id), 10000), 'after a restart the guest has the sub-forum again')
})

test('a ban in the forum applies in the sub-forum that invited the member, whatever arrived first', async (t) => {
  const { a, b, c, fa } = await threeMembers(t)
  const guests = await forum.createSubforum(fa, 'Guests')
  const g = await account(t, 'guest')
  const gs = await forum.join(g, await forum.inviteGuest(guests))
  const spam = await forum.post(gs, 'spam', 'buy now')
  const gc = await opened(c, guests.key)
  const gb = await opened(b, guests.key)
  t.ok(await eventually(async () => await shows(gc, spam.id) && await shows(gb, spam.id) && await shows(guests, spam.id), 5000), 'everyone shows the spam first')

  await c.close() // c showed it, and is offline while the ban is decided
  await forum.ban(fa, g.identity.publicKey, { reason: 'spam', from: spam })
  t.ok(await eventually(async () => !(await shows(guests, spam.id)) && !(await shows(gb, spam.id)), 5000), 'gone for a and b')
  t.is(await codeOf(forum.post(gs, 'more', '')), 'NOT_ALLOWED', 'the guest\'s app refuses to write')
  await testing.writeRaw(gs, { kind: 'put', type: 'post', fields: { title: 'after the ban', text: '' } })
  const marker = await forum.post(guests, 'marker', '')

  const c2 = await account(t, 'c2', { dir: c.dir })
  const gc2 = await opened(c2, guests.key)
  t.ok(await eventually(async () => await shows(gc2, marker.id) && !(await shows(gc2, spam.id)), 10000), 'c, back, drops what it had shown')
  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  const gd = await opened(d, guests.key)
  t.ok(fd && await eventually(() => shows(gd, marker.id), 10000), 'a newcomer gets everything at once')
  for (const f of [guests, gb, gc2, gd]) {
    const titles = (await forum.latest(f)).map((p) => p.title)
    t.alike(titles, ['marker'], 'every member shows the same: none of the banned guest\'s posts')
  }
  t.ok(a)
})

test('a removal from the forum takes the member\'s sub-forum roles away', async (t) => {
  const { b, c, fa } = await threeMembers(t)
  const staff = await forum.createSubforum(fa, 'Help')
  await forum.giveRole(staff, c.identity.publicKey, 'moderator')
  const hb = await opened(b, staff.key)
  t.ok(await eventually(async () => (await forum.roleOf(hb, c.identity.publicKey)) === 'moderator', 5000), 'a moderator of the sub-forum only')
  t.is(await forum.roleOf(fa, c.identity.publicKey), 'member', 'a member in the forum')
  await forum.removeMember(fa, c.identity.publicKey)
  t.ok(await eventually(async () => (await forum.roleOf(hb, c.identity.publicKey)) === null, 5000), 'out of the sub-forum too')
  t.is(await forum.roleOf(staff, c.identity.publicKey), null)
})

test('a shortcut to a sub-forum: members follow it; to a forum they aren\'t in: NOT_FOUND until invited', async (t) => {
  const { a, b, fa, fb } = await threeMembers(t)
  const linked = await forum.createSubforum(fa, 'Linked')
  const other = await forum.createForum(a, 'Other forum')
  await forum.shortcut(fa, 'see the sub-forum', linked)
  await forum.shortcut(fa, 'see the other forum', other.key)
  const items = await eventually(async () => {
    const { items } = await fb.query('shortcut').latest(10)
    return items.length === 2 && items
  }, 5000)
  t.ok(items, 'b reads both shortcuts')
  const toSub = items.find((s) => s.to === linked.key)
  const toOther = items.find((s) => s.to === other.key)
  t.ok(await eventually(() => { try { return forum.follow(b, toSub).key === linked.key } catch { return false } }, 10000), 'b reaches the sub-forum')
  t.is(await codeOf((async () => forum.follow(b, toOther))()), 'NOT_FOUND', 'not a forum b is in')
  await forum.join(b, await forum.invite(other))
  t.is(forum.follow(b, toOther).key, other.key, 'once invited, it does')
})
