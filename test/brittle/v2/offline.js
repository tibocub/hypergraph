// v2 prototype: offline (spec 007, FR-014, SC-007).
// What a member has shown stays readable after a restart with no peer; what
// it never fetched is reported unavailable, without waiting forever.

const test = require('brittle')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { member, link, until } = require('./_helpers')
const { Community } = require('../../../src/v2')
const { AuthorLog } = require('../../../src/v2/author-log')
const { signEntry } = require('../../../src/v2/roster')
const { segmentOf, segmentStart } = require('../../../src/v2/segments')

const SEG = 60000

// A channel with 2 authors posting 30 messages in each of these segments.
async function history (owner, segments) {
  const id = b4a.toString(hcrypto.randomBytes(16), 'hex')
  await owner.community.appendAs(owner.identity.keyPair, { type: 'channel', id, name: 'general', segmentMs: SEG, timestamp: segmentStart(segments[0], SEG) })
  await owner.community.keep(id)
  const authors = [0, 1].map(() => ({ keyPair: hcrypto.keyPair(), seed: hcrypto.randomBytes(32) }))
  const logs = []
  for (const a of authors) {
    const log = new AuthorLog(owner.store, { keyPair: AuthorLog.keyPairFor(a, owner.community.key, id) })
    await log.ready()
    logs.push(log)
  }
  const now = segmentOf(Date.now(), SEG)
  for (const s of segments) {
    const start = segmentStart(s, SEG)
    const span = s === now ? Math.max(1, Date.now() - start - 1) : SEG - 1
    for (let k = 0; k < logs.length; k++) {
      const messages = []
      for (let i = 0; i < 30; i++) messages.push({ t: start + Math.floor((i / 30) * span), text: `s${s} a${k} m${i}` })
      const first = await logs[k].appendMany(messages)
      await owner.community.writeRosterEntryUnchecked(id, s, { author: authors[k].keyPair.publicKey, log: logs[k].key, start: first, sig: signEntry(owner.community.key, id, s, logs[k].key, first, authors[k].keyPair) })
    }
  }
  return id
}

async function restartAlone (t, peer) {
  await peer.community.close()
  const again = new Community(peer.store, { identity: peer.identity, key: peer.community.key, replicate: 'sparse' })
  await again.ready()
  t.teardown(() => again.close())
  return again
}

test('v2 offline: a page shown before a restart shows again with no peer, in under a second', async (t) => {
  const owner = await member(t, 'off-shown-owner')
  const c = segmentOf(Date.now(), SEG)
  const channel = await history(owner, [c - 2, c - 1, c])
  const peer = await member(t, 'off-shown-peer', { key: owner.community.key, replicate: 'sparse' })
  const unlink = link(owner, peer)
  await until(async () => { await peer.community.update(); return peer.community.channels().length === 1 })
  let shown = []
  await until(async () => (shown = await peer.community.latest(channel, { limit: 50 })).length === 50)
  unlink()

  const again = await restartAlone(t, peer)
  const t0 = Date.now()
  const page = await again.latest(channel, { limit: 50 })
  const ms = Date.now() - t0
  t.alike(page.map(m => m.text), shown.map(m => m.text), 'the same page')
  t.ok(ms < 1000, `in ${ms} ms`)
})

test('v2 offline: scrollback to a segment never fetched says so, without hanging', async (t) => {
  const owner = await member(t, 'off-never-owner')
  const c = segmentOf(Date.now(), SEG)
  const channel = await history(owner, [c - 3, c - 2, c])
  const peer = await member(t, 'off-never-peer', { key: owner.community.key, replicate: 'sparse' })
  const unlink = link(owner, peer)
  await until(async () => { await peer.community.update(); return peer.community.channels().length === 1 })
  await until(async () => (await peer.community.latest(channel, { limit: 20 })).length === 20)
  unlink()

  const again = await restartAlone(t, peer)
  const t0 = Date.now()
  const older = await again.before(channel, { t: segmentStart(c - 2, SEG), limit: 50, timeout: 1000 })
  const ms = Date.now() - t0
  t.is(older.length, 0, 'nothing from the segment never fetched')
  t.ok(ms < 5000, `answered in ${ms} ms`)
  t.ok((await again.stats()).unreachable > 0, 'and reported unreachable')
})
