// v2 prototype: moderation on partial data (spec 007, US3, FR-016, FR-017, SC-006).
// Hides and bans live in the control log, which every member holds in full;
// they must apply the same way to a member holding everything, one holding
// only what it read, and one who joined after the decision.

const test = require('brittle')
const { member, link, until, sleep } = require('./_helpers')

const SEG = 60000

// owner (mod, keeper), author `a`, early reader `b`; `late()` adds a reader
// who joins later.
async function setup (t, label) {
  const owner = await member(t, `${label}-owner`)
  const channel = await owner.community.createChannel({ name: 'general', segmentMs: SEG })
  await owner.community.keep(channel)
  const join = async (name) => {
    const p = await member(t, `${label}-${name}`, { key: owner.community.key })
    t.teardown(link(owner, p))
    await until(async () => { await p.community.update(); return p.community.keepers(channel).length === 1 })
    return p
  }
  const a = await join('a')
  const b = await join('b')
  t.teardown(link(a, b))
  return { owner, a, b, channel, join }
}

// The page as `peer` sees it once the control log has caught up with the owner.
async function pageOf (peer, owner, channel, expectCount) {
  let page = []
  await until(async () => {
    await peer.community.update()
    if (peer.community.control.length < owner.community.control.length) return false
    page = await peer.community.latest(channel, { limit: 50, timeout: 2000 })
    return expectCount === undefined || page.length === expectCount
  })
  return page
}

const summary = (page) => page.map(m => m.hidden ? `(${m.seq} hidden)` : m.text).reverse()

test('v2 moderation: a hidden message is hidden for the author, an early reader and a late joiner', async (t) => {
  const { owner, a, b, channel, join } = await setup(t, 'mod-hide')
  for (const text of ['one', 'two', 'three']) await a.community.post(channel, text)
  t.alike(summary(await pageOf(b, owner, channel, 3)), ['one', 'two', 'three'], 'b read the page before the hide')

  const two = (await pageOf(owner, owner, channel, 3)).find(m => m.text === 'two')
  await owner.community.hide({ author: a.identity.keyPair.publicKey, log: two.log, seq: two.seq }, { reason: 'spam' })

  const expected = ['one', `(${two.seq} hidden)`, 'three']
  t.alike(summary(await pageOf(owner, owner, channel, 3)), expected, 'the mod (keeper) sees it hidden')
  t.alike(summary(await pageOf(a, owner, channel, 3)), expected, 'the author, holding everything, too')
  t.alike(summary(await pageOf(b, owner, channel, 3)), expected, 'the early reader too')
  const c = await join('c')
  t.teardown(link(a, c))
  t.alike(summary(await pageOf(c, owner, channel, 3)), expected, 'and a member who joined after the hide')
  const hidden = (await pageOf(c, owner, channel, 3)).find(m => m.hidden)
  t.is(hidden.text, null, 'no text for a hidden message')
})

test('v2 moderation: a ban leaves out posts after it, including ones dated before it', async (t) => {
  const { owner, a, b, channel, join } = await setup(t, 'mod-ban')
  const before = await a.community.post(channel, 'before')
  await pageOf(b, owner, channel, 1)
  await pageOf(owner, owner, channel, 1)

  await owner.community.ban(a.identity.keyPair.publicKey, { reason: 'spam' })
  // The author keeps posting: once with the honest time, once dated like
  // its last post (before the ban), which a rule on claimed times lets through.
  await sleep(10)
  await a.community.postRaw(channel, { t: Date.now(), text: 'after' })
  await a.community.postRaw(channel, { t: before.t, text: 'backdated' })

  const c = await join('c')
  t.teardown(link(a, c))
  for (const [name, peer] of [['the mod', owner], ['an early reader', b], ['a late joiner', c]]) {
    // Holding all three of the author's messages, so "not shown" means
    // filtered, not "not arrived yet".
    t.ok(await until(async () => (await peer.community.logLength(before.log)) >= before.seq + 3), `${name} holds the three posts`)
    t.alike(summary(await pageOf(peer, owner, channel, 1)), ['before'], `${name}: only the post before the ban`)
  }

  await owner.community.unban(a.identity.keyPair.publicKey)
  t.alike(summary(await pageOf(b, owner, channel, 3)), ['before', 'backdated', 'after'], 'unban shows everything again')
})

for (const byKeeper of [true, false]) test(`v2 moderation: a ban also cuts a log last listed in an older segment (mod ${byKeeper ? 'is' : 'is not'} the keeper)`, async (t) => {
  // The ban's cut covered logs listed in the current or previous segment only:
  // an author whose last post was older could append posts dated back into
  // that segment, and scrollback showed them.
  const b4a = require('b4a')
  const hcrypto = require('hypercore-crypto')
  const { AuthorLog } = require('../../../src/v2/author-log')
  const { signEntry } = require('../../../src/v2/roster')
  const { segmentOf: seg, segmentStart } = require('../../../src/v2/segments')
  const owner = await member(t, `mod-oldban-owner-${byKeeper}`)
  const now = seg(Date.now(), SEG)
  const old = now - 3
  const channel = b4a.toString(hcrypto.randomBytes(16), 'hex')
  await owner.community.appendAs(owner.identity.keyPair, { type: 'channel', id: channel, name: 'general', segmentMs: SEG, timestamp: segmentStart(old, SEG) })
  await owner.community.keep(channel)
  // The author's log (in the owner's store here, appended to as the author would).
  const author = { keyPair: hcrypto.keyPair(), seed: hcrypto.randomBytes(32) }
  const log = new AuthorLog(owner.store, { keyPair: AuthorLog.keyPairFor(author, owner.community.key, channel) })
  await log.ready()
  t.teardown(() => log.close())
  const t0 = segmentStart(old, SEG) + 1000
  const first = await log.appendMany([0, 1, 2].map(i => ({ t: t0 + i * 1000, text: `old${i}` })))
  await owner.community.writeRosterEntryUnchecked(channel, old, { author: author.keyPair.publicKey, log: log.key, start: first, sig: signEntry(owner.community.key, channel, old, log.key, first, author.keyPair) })

  const reader = await member(t, `mod-oldban-reader-${byKeeper}`, { key: owner.community.key, replicate: 'sparse' })
  t.teardown(link(owner, reader))
  await until(async () => { await reader.community.update(); return reader.community.channels().length === 1 })
  const back = () => reader.community.before(channel, { t: segmentStart(old + 1, SEG), limit: 50, timeout: 2000 })
  t.ok(await until(async () => (await back()).length === 3), 'three posts in the old segment')

  let mod = owner
  if (!byKeeper) {
    // A mod who isn't a keeper reads the keeper's author index remotely,
    // found through the roster's header.
    mod = await member(t, `mod-oldban-mod-${byKeeper}`, { key: owner.community.key })
    t.teardown(link(owner, mod))
    await until(async () => { await mod.community.update(); return mod.community.channels().length === 1 })
    await owner.community.setRole(mod.pub, 'mod', { writer: mod.community.localKey })
    await until(async () => { await mod.community.update(); return mod.community.role(mod.pub) === 'mod' && mod.community.control.writable })
  }
  await mod.community.ban(author.keyPair.publicKey, { reason: 'spam' })
  await until(async () => { await owner.community.update(); return !!owner.community.banned(author.keyPair.publicKey) })
  await log.appendRaw({ t: t0 + 5000, text: 'backdated after the ban' })
  t.ok(await until(async () => (await reader.community.logLength(log.key)) === 4), 'the reader holds the new post')
  await until(async () => { await reader.community.update(); return !!reader.community.banned(author.keyPair.publicKey) })
  t.alike((await back()).map(m => m.text).reverse(), ['old0', 'old1', 'old2'], 'scrollback shows only the posts before the ban')
})
