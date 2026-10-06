// v2 prototype: the community control log (spec 007, FR-001..003).

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { member, link, until } = require('./_helpers')

async function community (t) {
  const owner = await member(t, 'ctl-owner')
  const other = await member(t, 'ctl-other', { key: owner.community.key })
  t.teardown(link(owner, other))
  return { owner, other }
}

test('v2 control: the creator is owner; channels are created and listed on every peer', async (t) => {
  const { owner, other } = await community(t)
  t.is(owner.community.role(owner.pub), 'owner')
  const id = await owner.community.createChannel({ name: 'general', segmentMs: 60000 })
  t.ok(await until(async () => { await other.community.update(); return other.community.channels().length === 1 }), 'the other peer lists it')
  t.alike(other.community.channels(), [{ id, name: 'general', segmentMs: 60000 }])
  t.is(other.community.role(owner.pub), 'owner')
})

test('v2 control: roles follow the rules; an appointment without the right is ignored everywhere', async (t) => {
  const { owner, other } = await community(t)
  const admin = crypto.keyPair()
  const mod = crypto.keyPair()
  const hex = (kp) => kp.publicKey.toString('hex')
  await owner.community.setRole(hex(admin), 'admin')
  t.is(owner.community.role(hex(admin)), 'admin', 'owner appoints an admin')

  // An admin may appoint a mod but not another admin; a mod may appoint nobody.
  await owner.community.appendAs(admin, { type: 'role', member: hex(mod), role: 'mod' })
  await owner.community.appendAs(admin, { type: 'role', member: hex(crypto.keyPair()), role: 'admin' })
  await owner.community.appendAs(mod, { type: 'role', member: hex(crypto.keyPair()), role: 'keeper' })
  t.is(owner.community.role(hex(mod)), 'mod', 'admin appoints a mod')
  t.is(Object.values(owner.community.roles()).filter(r => r === 'admin').length, 1, 'but no second admin')
  t.is(Object.values(owner.community.roles()).filter(r => r === 'keeper').length, 0, 'and the mod appointed nobody')

  t.ok(await until(async () => { await other.community.update(); return JSON.stringify(other.community.roles()) === JSON.stringify(owner.community.roles()) }), 'the other peer reaches the same roles')
  await t.exception(other.community.setRole(hex(crypto.keyPair()), 'mod'), /not allowed|not a writer/i, 'a member without a role cannot appoint')
})

test('v2 control: bans, unbans and hides; a forged signature changes nothing', async (t) => {
  const { owner, other } = await community(t)
  const target = crypto.keyPair().publicKey.toString('hex')
  await owner.community.ban(target, { reason: 'spam' })
  t.ok(owner.community.banned(target), 'banned')
  await owner.community.hide({ author: target, log: 'ab'.repeat(32), seq: 3 }, { reason: 'rude' })
  t.ok(owner.community.hidden(target, 'ab'.repeat(32), 3), 'hidden')
  t.absent(owner.community.hidden(target, 'ab'.repeat(32), 4), 'only that message')
  await owner.community.unban(target)
  t.absent(owner.community.banned(target), 'unbanned')

  // An event claiming the owner as author but signed by someone else.
  await owner.community.appendForged({ type: 'ban', member: target, reason: 'forged' }, owner.pub, crypto.keyPair())
  t.absent(owner.community.banned(target), 'a forged ban is ignored')
  t.ok(await until(async () => { await other.community.update(); return other.community.hidden(target, 'ab'.repeat(32), 3) }), 'the hide reaches the other peer')
  t.absent(other.community.banned(target), 'and the ban state matches')
})

test('v2 control: only keepers register rosters', async (t) => {
  const { owner } = await community(t)
  const id = await owner.community.createChannel({ name: 'general' })
  const keeper = crypto.keyPair()
  await owner.community.setRole(keeper.publicKey.toString('hex'), 'keeper')
  await owner.community.appendAs(keeper, { type: 'keeper', channel: id, rosterKey: 'cd'.repeat(32) })
  await owner.community.appendAs(crypto.keyPair(), { type: 'keeper', channel: id, rosterKey: 'ef'.repeat(32) })
  t.alike(owner.community.keepers(id).map(k => k.rosterKey), ['cd'.repeat(32)], 'only the keeper is listed')
})
