// v2 private channels: giving and taking away access (spec 008, US2, FR-006..012).

const test = require('brittle')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { member, link, until } = require('./_helpers')
const { seal, newEpochKey } = require('../../../src/v2/crypto')

async function setup (t, label, opts = {}) {
  const owner = await member(t, `${label}-owner`)
  const channel = await owner.community.createChannel({ name: 'secret', private: true, keep: true, segmentMs: 60000, ...opts })
  const join = async (name) => {
    const p = await member(t, `${label}-${name}`, { key: owner.community.key })
    t.teardown(link(owner, p))
    await until(async () => { await p.community.update(); return p.community.keepers(channel).length === 1 })
    return p
  }
  return { owner, channel, join }
}

const who = (p) => ({ identity: p.pub, encryptionKey: p.community.encryptionKey })
const texts = (page) => page.map(m => m.text)
const readsAll = (p, channel, n) => until(async () => {
  const page = await p.community.latest(channel)
  return page.length === n && page.every(m => m.text !== null)
}, 10000)

test('v2 grants: an admin grants a member, who then reads old and new messages', async (t) => {
  const { owner, channel, join } = await setup(t, 'gr-basic')
  await owner.community.post(channel, 'before')
  const m = await join('m')
  t.alike(texts(await m.community.latest(channel)), [null], 'unreadable before the grant')
  await owner.community.grant(channel, who(m))
  t.ok(await readsAll(m, channel, 1), 'reads the message from before the grant')
  t.alike((await m.community.access(channel)).epochs, [0])
  await owner.community.post(channel, 'after')
  t.ok(await readsAll(m, channel, 2), 'and the one after')
  await m.community.post(channel, 'mine')
  t.ok(await readsAll(owner, channel, 3), 'the owner reads the member’s post')
})

test('v2 grants: only admins grant; forged and mismatched grants are ignored', async (t) => {
  const { owner, channel, join } = await setup(t, 'gr-forge')
  await owner.community.post(channel, 'secret')
  const a = await join('a')
  const b = await join('b')
  await t.exception(a.community.grant(channel, who(b)), /not allowed|key/, 'a member without the right can’t grant')

  // A stranger's grant, even written straight into the keeper's bee: ignored.
  const stranger = { keyPair: hcrypto.keyPair() }
  await owner.community.writeGrantUnchecked(channel, { recipient: b.community.encryptionKey, identity: b.pub, epoch: 0, sealed: seal(newEpochKey(), b4a.from(b.community.encryptionKey, 'hex')), granterKeyPair: stranger.keyPair })
  // An admin's grant with the wrong key for the epoch: ignored too.
  await owner.community.writeGrantUnchecked(channel, { recipient: a.community.encryptionKey, identity: a.pub, epoch: 0, sealed: seal(newEpochKey(), b4a.from(a.community.encryptionKey, 'hex')), granterKeyPair: owner.identity.keyPair })
  await new Promise(resolve => setTimeout(resolve, 500))
  t.alike((await b.community.access(channel)).epochs, [], 'a stranger’s grant gives nothing')
  t.alike((await a.community.access(channel)).epochs, [], 'a key that doesn’t match the epoch gives nothing')
  t.alike(texts(await b.community.latest(channel)), [null])
})

test('v2 grants: a channel can let key holders grant', async (t) => {
  const { owner, channel, join } = await setup(t, 'gr-members', { memberGrants: true })
  await owner.community.post(channel, 'hi')
  const a = await join('a')
  const b = await join('b')
  t.teardown(link(a, b))
  await owner.community.grant(channel, who(a))
  await until(async () => (await a.community.access(channel)).epochs.length === 1)
  await a.community.grant(channel, who(b))
  t.ok(await readsAll(b, channel, 1), 'a key holder’s grant works when the channel allows it')
})

test('v2 grants: a member fetches its own grant, not everyone’s', async (t) => {
  const { owner, channel, join } = await setup(t, 'gr-own')
  await owner.community.post(channel, 'hi')
  for (let i = 0; i < 40; i++) {
    const other = { keyPair: hcrypto.keyPair(), seed: hcrypto.randomBytes(32) }
    const { boxKeyPair } = require('../../../src/v2/crypto')
    await owner.community.grant(channel, { identity: b4a.toString(other.keyPair.publicKey, 'hex'), encryptionKey: b4a.toString(boxKeyPair(other).publicKey, 'hex') })
  }
  const m = await join('m')
  await owner.community.grant(channel, who(m))
  t.ok(await readsAll(m, channel, 1))
  const [grantsKey] = await m.community.grantsCores(channel)
  const core = m.store.get({ key: b4a.from(grantsKey, 'hex') })
  await core.ready()
  let held = 0
  const length = core.length
  for (let i = 0; i < length; i++) if (await core.has(i)) held++
  await core.close()
  t.ok(held < length / 3, `${held} of ${length} grant blocks fetched (a fraction, not everyone’s)`)
})

test('v2 grants: a revoked member reads nothing posted after, and keeps what it had', async (t) => {
  const { owner, channel, join } = await setup(t, 'gr-revoke')
  const a = await join('a')
  const b = await join('b')
  await owner.community.grant(channel, who(a))
  await owner.community.grant(channel, who(b))
  await owner.community.post(channel, 'old')
  t.ok(await readsAll(a, channel, 1))

  const result = await owner.community.revoke(channel, a.pub)
  t.is(result.epoch, 1, 'a new epoch')
  t.ok(result.granted >= 2, `re-granted to the members left (${result.granted})`)
  t.ok(owner.community.revoked(channel, a.pub))
  await owner.community.post(channel, 'new')

  t.ok(await readsAll(b, channel, 2), 'a member still in reads both')
  await until(async () => { await a.community.update(); return a.community.epoch(channel) === 1 })
  const page = await a.community.latest(channel)
  t.alike(page.map(m => m.text), [null, 'old'], 'the revoked member: the old message, not the new one')
  t.alike((await a.community.access(channel)).epochs, [0])
  await t.exception(a.community.post(channel, 'still here?'), /key/, 'and can’t post with the new epoch')
})

test('v2 grants: two admins rotating at once end on one epoch everyone holds', async (t) => {
  const { owner, channel, join } = await setup(t, 'gr-race')
  const admin = await join('admin')
  const m = await join('m')
  t.teardown(link(admin, m))
  await owner.community.setRole(admin.pub, 'admin', { writer: admin.community.localKey })
  await until(async () => { await admin.community.update(); return admin.community.role(admin.pub) === 'admin' && admin.community.control.writable })
  await owner.community.grant(channel, who(admin))
  await owner.community.grant(channel, who(m))
  await until(async () => (await admin.community.access(channel)).current)

  await Promise.all([owner.community.rotate(channel), admin.community.rotate(channel)])
  t.ok(await until(async () => {
    for (const p of [owner, admin, m]) await p.community.update()
    const e = owner.community.epoch(channel)
    return e === admin.community.epoch(channel) && e === m.community.epoch(channel) &&
      (await owner.community.access(channel)).current && (await admin.community.access(channel)).current && (await m.community.access(channel)).current
  }, 20000), 'every member holds the same current epoch')
  await owner.community.post(channel, 'from owner')
  await admin.community.post(channel, 'from admin')
  t.ok(await readsAll(m, channel, 2), 'and reads both admins’ posts')
})

test('v2 grants: a member offline during a rotation gets the new epoch when back', async (t) => {
  const { owner, channel, join } = await setup(t, 'gr-offline')
  const a = await join('a')
  const c = await member(t, 'gr-offline-c', { key: owner.community.key })
  let unlink = link(owner, c)
  await until(async () => { await c.community.update(); return c.community.keepers(channel).length === 1 })
  await owner.community.grant(channel, who(a))
  await owner.community.grant(channel, who(c))
  await until(async () => (await c.community.access(channel)).current)
  unlink()

  await owner.community.revoke(channel, a.pub)
  await owner.community.post(channel, 'while you were away')
  unlink = link(owner, c)
  t.teardown(unlink)
  t.ok(await readsAll(c, channel, 1), 'back online, it reads the message from the new epoch')
})
