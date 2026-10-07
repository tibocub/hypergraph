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

test('v2 control: a channel created to be kept by its creator is one event, not two', async (t) => {
  // Two control events per channel (the channel, then its keeper): a member
  // of a 500-channel community applied 2,003 events, and its memory with the
  // same 5 channels open was ~20-40 MB higher than with half of them.
  const { owner, other } = await community(t)
  const length = async () => (await owner.community.stats()).controlLength
  let before = await length()
  await owner.community.createChannel({ name: 'plain' })
  const plain = await length() - before
  before = await length()
  const id = await owner.community.createChannel({ name: 'general', segmentMs: 60000, keep: true })
  t.is(await length() - before, plain, 'the control log grows as for a channel alone')
  t.ok(await until(async () => { await other.community.update(); return other.community.keepers(id).length === 1 }), 'the other peer sees the keeper')
  t.is(other.community.keepers(id)[0].keeper, owner.pub)
  const post = await other.community.post(id, 'listed?')
  t.ok(await until(async () => (await owner.community.rosterEntries(id, Math.floor(post.t / 60000))).some(e => e.author === other.pub)), 'and the roster lists posts')
})

test('v2 control: a private channel starts at epoch 0; rotations go one up, from admins only', async (t) => {
  const { owner, other } = await community(t)
  const b4a = require('b4a')
  const commit = (n) => b4a.toString(b4a.alloc(32, n), 'hex')
  const id = 'private-1'
  await owner.community.appendAs(owner.identity.keyPair, { type: 'channel', id, name: 'secret', private: true, commit: commit(0) })
  t.is(owner.community.channel(id).private, true)
  t.is(owner.community.epoch(id), 0)
  t.is(owner.community.epochCommit(id, 0), commit(0))

  await owner.community.appendAs(owner.identity.keyPair, { type: 'rotate', channel: id, epoch: 2, commit: commit(2) })
  t.is(owner.community.epoch(id), 0, 'skipping an epoch is ignored')
  const stranger = crypto.keyPair()
  await owner.community.appendAs(stranger, { type: 'rotate', channel: id, epoch: 1, commit: commit(9) })
  t.is(owner.community.epoch(id), 0, 'a rotation by someone without the role is ignored')
  await owner.community.appendAs(owner.identity.keyPair, { type: 'rotate', channel: id, epoch: 1, commit: commit(1) })
  await owner.community.appendAs(owner.identity.keyPair, { type: 'rotate', channel: id, epoch: 1, commit: commit(5) })
  t.is(owner.community.epoch(id), 1)
  t.is(owner.community.epochCommit(id, 1), commit(1), 'the first rotation to an epoch wins; a second one to it is ignored')

  await owner.community.appendAs(stranger, { type: 'revoke', channel: id, member: other.pub })
  t.absent(owner.community.revoked(id, other.pub), 'a revocation by someone without the role is ignored')
  await owner.community.appendAs(owner.identity.keyPair, { type: 'revoke', channel: id, member: other.pub })
  t.ok(owner.community.revoked(id, other.pub))

  // Both: the revocation comes after the rotation in the owner's log, and
  // under load the other peer can be between the two.
  t.ok(await until(async () => { await other.community.update(); return other.community.epoch(id) === 1 && !!other.community.revoked(id, other.pub) }), 'the other peer agrees on the epoch')
  t.is(other.community.epochCommit(id, 1), commit(1))
  t.ok(other.community.revoked(id, other.pub))
})

test('v2 control: concurrent rotations by two admins converge on the same epoch key everywhere', async (t) => {
  const b4a = require('b4a')
  const commit = (n) => b4a.toString(b4a.alloc(32, n), 'hex')
  const { owner, other } = await community(t)
  const id = 'private-2'
  await owner.community.appendAs(owner.identity.keyPair, { type: 'channel', id, name: 'secret', private: true, commit: commit(0) })
  await owner.community.setRole(other.pub, 'admin', { writer: other.community.localKey })
  await until(async () => { await other.community.update(); return other.community.role(other.pub) === 'admin' && other.community.control.writable && other.community.epoch(id) === 0 })
  // Both rotate to epoch 1 at once, each with its own key.
  await Promise.all([
    owner.community.appendAs(owner.identity.keyPair, { type: 'rotate', channel: id, epoch: 1, commit: commit(11) }),
    other.community.appendAs(other.identity.keyPair, { type: 'rotate', channel: id, epoch: 1, commit: commit(22) })
  ])
  t.ok(await until(async () => {
    await owner.community.update()
    await other.community.update()
    const a = owner.community.epochCommit(id, 1)
    return a && a === other.community.epochCommit(id, 1)
  }), 'both peers name the same commit for epoch 1')
  t.ok([commit(11), commit(22)].includes(owner.community.epochCommit(id, 1)))
})
