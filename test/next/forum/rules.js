// Story 2 #5, #7, FR-018: an app rule (a title is at most 300 characters)
// rejects a record on every member before it is kept, indexed or passed on;
// a non-member's records are never kept.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { account, threeMembers } = require('./_setup.js')
const { eventually, sleep } = require('../helpers.js')

const long = 'x'.repeat(301)
const shownEverywhere = (all, id) => eventually(async () => {
  for (const f of all) if (!(await forum.latest(f)).some((p) => p.id === id)) return false
  return true
}, 5000)

test('an app rule rejects a record everywhere, before it is kept', async (t) => {
  const { fa, fb, fc, all } = await threeMembers(t)
  try {
    await forum.post(fb, long, '')
    t.fail('should be refused')
  } catch (err) {
    t.is(err.code, 'RULE_REJECTED', 'b\'s app refuses it')
    t.ok(/title-length/.test(err.message), 'naming the rule')
  }

  // b writes it anyway, then a post everyone must see.
  const bad = await testing.writeRaw(fb, { kind: 'put', type: 'post', fields: { title: long, text: 'spam' } })
  const marker = await forum.post(fb, 'fine', '')
  t.ok(await shownEverywhere(all, marker.id), 'b\'s later post arrived everywhere')
  for (const f of all) {
    t.absent((await forum.latest(f)).some((p) => p.id === bad), 'the rejected record is not shown')
    t.is((await f.get(bad)).record, null, 'nor indexed')
  }
  for (const f of [fa, fc]) t.ok(await eventually(async () => !(await testing.holdsBlock(f, bad)), 10000), 'nor kept by the others (so not passed on)') // 10 s: under a full suite's load the clearing took over 3 s
  t.ok(await testing.holdsBlock(fb, bad), 'its author keeps its own log whole (FR-027)')

  // A newcomer fetches it from its author, checks it, drops it, and is complete.
  const d = await account(t, 'newcomer')
  const fd = await forum.join(d, await forum.invite(fa))
  t.ok(await shownEverywhere([fd], marker.id))
  const { items, complete } = await fd.query('post').latest(20, { timeout: 3000 })
  t.absent(items.some((p) => p.id === bad), 'the newcomer does not show it')
  t.ok(complete, 'nor waits for it')
  t.ok(await eventually(async () => !(await testing.holdsBlock(fd, bad)), 3000), 'nor keeps it')

  // An edit breaking the rule is ignored too.
  await testing.writeRaw(fb, { kind: 'edit', type: 'post', target: marker.id, fields: { title: long, text: '' } })
  const later = await forum.post(fb, 'later', '')
  t.ok(await shownEverywhere(all, later.id))
  for (const f of [fa, fc]) t.is((await f.get(marker.id)).record.title, 'fine', 'the rejected edit is ignored')
  await t.exception(forum.edit(fb, marker, { title: long }), /RULE_REJECTED|title-length/, 'and refused locally')
})

test('a non-member\'s records are never kept', async (t) => {
  const { fa, fb } = await threeMembers(t)
  const e = await account(t, 'stranger')
  const fe = await testing.openSpace(e, fa.key)
  await testing.writeRaw(fe, { kind: 'put', type: 'post', fields: { title: 'spam', text: '' } })
  const marker = await forum.post(fb, 'real', '')
  await shownEverywhere([fa, fb], marker.id)
  await sleep(1500)
  for (const f of [fa, fb]) {
    t.absent(testing.logs(f).includes(testing.ownLog(fe)), 'its log is neither kept nor passed on')
    t.absent((await forum.latest(f)).some((p) => p.title === 'spam'))
  }
})

test('app rules are code: the space records which are active, and members on other rules are warned', async (t) => {
  // b runs a newer app with one more rule; c an older one with none.
  const noEmpty = { id: 'no-empty-text', validate: (r) => r.type !== 'post' || !!r.text }
  const a = await account(t, 'a')
  const b = await account(t, 'b', { rules: [...forum.rules, noEmpty] })
  const c = await account(t, 'c', { rules: [] })
  const fa = await forum.createForum(a, 'Rules')
  const fb = await forum.join(b, await forum.invite(fa))
  const fc = await forum.join(c, await forum.invite(fa))
  const warning = (f) => f.status().warnings.find((w) => w.code === 'RULES_DIFFER')

  t.absent(warning(fa), 'the creator\'s rules are the space\'s')
  t.ok(await eventually(() => warning(fb) && warning(fc), 10000), 'members on other rules are warned')
  t.ok(/no-empty-text/.test(warning(fb).message), 'naming the rule the space doesn\'t have')
  t.ok(/title-length/.test(warning(fc).message), 'naming the rule this app doesn\'t have')

  // b's app is the forum's next version: an admin records its rules.
  await forum.giveRole(fa, b.identity.publicKey, 'admin')
  const told = new Promise((resolve) => fa.on('status', (s) => { if (s.warnings.some((w) => w.code === 'RULES_DIFFER')) resolve() }))
  await eventually(async () => {
    try { await fb.setRules(); return true } catch { return false }
  }, 10000)
  t.absent(warning(fb), 'recorded: b runs the space\'s rules')
  t.ok(await eventually(() => warning(fa), 10000), 'the owner, on the older rules, is warned now')
  await told
  t.pass('with a status event')
  t.ok(/no-empty-text/.test(warning(fa).message))
  t.is((await fc.setRules().then(() => null, (e) => e)).code, 'NOT_ALLOWED', 'a member may not record them')
})
