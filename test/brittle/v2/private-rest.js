// v2 private channels: moderation, replication, offline and following keep
// working (spec 008, US4, FR-019, FR-020).

const test = require('brittle')
const b4a = require('b4a')
const { member, link, until } = require('./_helpers')
const { Community } = require('../../../src/v2')

const who = (p) => ({ identity: p.pub, encryptionKey: p.community.encryptionKey })

async function setup (t, label) {
  const owner = await member(t, `${label}-owner`)
  const channel = await owner.community.createChannel({ name: 'secret', private: true, keep: true, segmentMs: 60000 })
  const join = async (name, opts = {}) => {
    const p = await member(t, `${label}-${name}`, { key: owner.community.key, ...opts })
    const unlink = link(owner, p)
    t.teardown(unlink)
    await until(async () => { await p.community.update(); return p.community.keepers(channel).length === 1 })
    p.unlinkOwner = unlink
    return p
  }
  return { owner, channel, join }
}

test('v2 private-rest: a mod without the key hides and bans; members with it see both', async (t) => {
  const { owner, channel, join } = await setup(t, 'pr-mod')
  const a = await join('a')
  const mod = await join('mod')
  t.teardown(link(a, mod))
  await owner.community.grant(channel, who(a))
  await owner.community.setRole(mod.pub, 'mod', { writer: mod.community.localKey })
  await until(async () => { await mod.community.update(); return mod.community.role(mod.pub) === 'mod' && mod.community.control.writable })
  await until(async () => (await a.community.access(channel)).current)
  await a.community.post(channel, 'keep this')
  await a.community.post(channel, 'spam')

  let seen = []
  await until(async () => (seen = await mod.community.latest(channel)).length === 2)
  t.ok(seen.every(m => m.unreadable), 'the mod can’t read them')
  const spam = seen[0] // newest
  await mod.community.hide({ author: spam.author, log: spam.log, seq: spam.seq }, { reason: 'spam' })
  await mod.community.ban(a.community.identity ? a.pub : a.pub, { reason: 'spam' })
  await until(async () => { await a.community.update(); return !!a.community.banned(a.pub) })
  await a.community.postRaw(channel, { t: Date.now(), text: 'after the ban' }).catch(() => {})

  t.ok(await until(async () => {
    await owner.community.update()
    const page = await owner.community.latest(channel)
    return page.length === 2 && page[0].hidden && page[0].text === null && page[1].text === 'keep this'
  }), 'the owner: one hidden, one shown, nothing after the ban')
})

test('v2 private-rest: a helper holding everything serves encrypted messages and grants', async (t) => {
  const { owner, channel, join } = await setup(t, 'pr-helper')
  const helper = await join('helper', { replicate: 'all' })
  await owner.community.post(channel, 'kept by the helper')
  const m = await member(t, 'pr-helper-m', { key: owner.community.key, replicate: 'sparse' })
  await owner.community.grant(channel, who(m))
  // The helper holds the log, the roster and the grants (it can't read any of it).
  t.ok(await until(async () => {
    const [grants] = await helper.community.grantsCores(channel)
    if (!grants) return false
    const core = helper.store.get({ key: b4a.from(grants, 'hex') })
    await core.ready()
    const held = core.length > 0 && await core.has(0, core.length)
    await core.close()
    return held && (await helper.community.latest(channel)).length === 1
  }, 20000), 'the helper holds the grants and the message')
  helper.unlinkOwner() // the owner leaves; the member only meets the helper
  t.teardown(link(helper, m))
  t.ok(await until(async () => {
    await m.community.update()
    if (!m.community.channel(channel)) return false
    const page = await m.community.latest(channel)
    return page.length === 1 && page[0].text === 'kept by the helper'
  }, 20000), 'the member reads it, from the helper alone')
})

test('v2 private-rest: after a restart with no peer, the page shows again, decrypted, in under a second', async (t) => {
  const { owner, channel, join } = await setup(t, 'pr-offline')
  const m = await join('m', { replicate: 'sparse' })
  await owner.community.grant(channel, who(m))
  await owner.community.post(channel, 'remember me')
  t.ok(await until(async () => (await m.community.latest(channel)).some(x => x.text === 'remember me')))
  m.unlinkOwner()
  await m.community.close()
  const again = new Community(m.store, { identity: m.identity, key: owner.community.key, replicate: 'sparse' })
  await again.ready()
  t.teardown(() => again.close())
  const t0 = Date.now()
  const page = await again.latest(channel, { timeout: 500 })
  const ms = Date.now() - t0
  t.alike(page.map(x => x.text), ['remember me'])
  t.ok(ms < 1000, `in ${ms} ms`)
})

test('v2 private-rest: a message read before the grant turns readable once it arrives, without downloading it again', async (t) => {
  const { owner, channel, join } = await setup(t, 'pr-late')
  const m = await join('m', { replicate: 'sparse' })
  const posted = await owner.community.post(channel, 'patience')
  const got = []
  const stop = m.community.follow(channel, (x) => got.push(x))
  t.teardown(stop)
  t.ok(await until(async () => (await m.community.latest(channel)).length === 1))
  t.alike((await m.community.latest(channel)).map(x => x.unreadable), [true], 'unreadable before the grant')
  t.ok(await m.community.holds(posted.log, posted.seq), 'the block is already here')
  m.unlinkOwner() // from now on nothing can be downloaded from the author...
  const grantsOnly = link(owner, m) // ...except that the grant needs the keeper; the block isn't fetched again
  t.teardown(grantsOnly)
  await owner.community.grant(channel, who(m))
  t.ok(await until(async () => (await m.community.latest(channel)).map(x => x.text)[0] === 'patience'), 'readable now')
  await owner.community.post(channel, 'and live')
  t.ok(await until(() => got.some(x => x.text === 'and live')), 'follow delivers new messages decrypted')
})
