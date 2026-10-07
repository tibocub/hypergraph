// v2 prototype: what a member keeps (spec 007, US4, FR-011..FR-013, SC-008).
// replicate: 'all' holds every segment of every channel; 'sparse' only what
// was read; 'auto' (default) holds the newest segments that fit the budget,
// all of it when the community fits.

const test = require('brittle')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { member, link, until } = require('./_helpers')
const { AuthorLog } = require('../../../src/v2/author-log')
const { signEntry } = require('../../../src/v2/roster')
const { segmentOf, segmentStart } = require('../../../src/v2/segments')
const { STORED_OVERHEAD } = require('../../../src/v2/replication')

const SEG = 60000
const PER = 20 // messages per author per segment
const now = () => segmentOf(Date.now(), SEG)

// A channel whose history spans `segments` (oldest first), written straight
// into the owner's store: each author's log and the roster entries, signed
// by the authors (as bench/v2-chat.js does).
async function channelWithHistory (owner, name, authors, segments, logStore = owner.store) {
  const id = b4a.toString(hcrypto.randomBytes(16), 'hex')
  await owner.community.appendAs(owner.identity.keyPair, { type: 'channel', id, name, segmentMs: SEG, timestamp: segmentStart(segments[0], SEG) })
  await owner.community.keep(id)
  const logs = authors.map(a => new AuthorLog(logStore, { keyPair: AuthorLog.keyPairFor(a, owner.community.key, id) }))
  for (const log of logs) await log.ready()
  const ch = { id, authors, logs, segments: [] }
  await addSegments(owner, ch, segments)
  return ch
}

async function addSegments (owner, ch, segments) {
  for (const s of segments) {
    const start = segmentStart(s, SEG)
    const span = s === now() ? Math.max(1, Date.now() - start - 1) : SEG - 1
    const ranges = []
    for (let k = 0; k < ch.logs.length; k++) {
      const log = ch.logs[k]
      const messages = []
      for (let i = 0; i < PER; i++) messages.push({ t: start + Math.floor((i / PER) * span), text: `segment ${s} author ${k} message ${i}: some text of a usual length` })
      const first = await log.appendMany(messages)
      const a = ch.authors[k]
      await owner.community.writeRosterEntryUnchecked(ch.id, s, { author: a.keyPair.publicKey, log: log.key, start: first, sig: signEntry(owner.community.key, ch.id, s, log.key, first, a.keyPair) })
      ranges.push({ log: b4a.toString(log.key, 'hex'), start: first, end: first + PER })
    }
    ch.segments.push({ segment: s, ranges })
  }
}

const authors = (n) => Array.from({ length: n }, () => ({ keyPair: hcrypto.keyPair(), seed: hcrypto.randomBytes(32) }))

async function holdsSegment (peer, seg) {
  for (const r of seg.ranges) if (!(await peer.community.holds(r.log, r.start, r.end))) return false
  return true
}
async function holdsNothingOf (peer, seg) {
  for (const r of seg.ranges) for (let i = r.start; i < r.end; i++) if (await peer.community.holds(r.log, i, i + 1)) return false
  return true
}

test('v2 replication: all holds every segment of every channel, and keeps up live', async (t) => {
  const owner = await member(t, 'rep-all-owner')
  const c = now()
  const a = await channelWithHistory(owner, 'a', authors(2), [c - 4, c - 3, c - 2, c - 1, c])
  const b = await channelWithHistory(owner, 'b', authors(2), [c - 2, c])
  const peer = await member(t, 'rep-all-peer', { key: owner.community.key, replicate: 'all' })
  t.teardown(link(owner, peer))

  t.ok(await until(async () => {
    for (const ch of [a, b]) for (const seg of ch.segments) if (!(await holdsSegment(peer, seg))) return false
    return true
  }, 20000), 'every segment of both channels is held, without reading anything')
  const st = await peer.community.stats()
  t.is(st.mode, 'all')
  t.ok(st.heldBytes > 0, `held bytes counted (${st.heldBytes})`)

  // New content in the current segment arrives without being read.
  const log = a.logs[0]
  const seq = (await log.appendRaw({ t: Date.now(), text: 'live' })).seq
  t.ok(await until(() => peer.community.holds(b4a.toString(log.key, 'hex'), seq, seq + 1), 10000), 'a new message is held too')
})

test('v2 replication: sparse holds only what was read', async (t) => {
  const owner = await member(t, 'rep-sparse-owner')
  const c = now()
  const a = await channelWithHistory(owner, 'a', authors(2), [c - 3, c - 2, c])
  const b = await channelWithHistory(owner, 'b', authors(2), [c])
  const peer = await member(t, 'rep-sparse-peer', { key: owner.community.key, replicate: 'sparse' })
  t.teardown(link(owner, peer))
  await until(async () => { await peer.community.update(); return peer.community.channels().length === 2 })
  t.is((await peer.community.latest(a.id, { limit: 10 })).length, 10, 'read the latest 10 of channel a')
  await new Promise(resolve => setTimeout(resolve, 1000))

  t.ok(await holdsNothingOf(peer, a.segments[0]), 'the oldest segment of a is not held')
  t.ok(await holdsNothingOf(peer, b.segments[0]), 'nothing of channel b, never read')
  t.is((await peer.community.stats()).mode, 'sparse')
})

test('v2 replication: auto holds everything while the community fits the budget', async (t) => {
  const owner = await member(t, 'rep-auto-fit-owner')
  const c = now()
  const a = await channelWithHistory(owner, 'a', authors(2), [c - 3, c - 2, c - 1, c])
  const peer = await member(t, 'rep-auto-fit-peer', { key: owner.community.key, budget: 10 * 1024 * 1024 })
  t.teardown(link(owner, peer))
  t.ok(await until(async () => {
    for (const seg of a.segments) if (!(await holdsSegment(peer, seg))) return false
    return true
  }, 20000), 'everything is held')
  const st = await peer.community.stats()
  t.is(st.mode, 'auto', 'auto is the default')
  t.is(st.holding, 'all', 'and holds all of it')
})

test('v2 replication: auto over budget holds the newest segments that fit, and moves with the community', async (t) => {
  const owner = await member(t, 'rep-auto-over-owner')
  const c = now()
  const a = await channelWithHistory(owner, 'a', authors(2), [c - 6, c - 5, c - 4, c - 3])
  // Each segment is 2 authors x 20 blocks, each counted with what storing it
  // costs: a budget of 2.5 segments holds two.
  const segBytes = 2 * PER * ((await blockBytes(owner, a)) + STORED_OVERHEAD)
  const budget = Math.floor(segBytes * 2.5)
  const peer = await member(t, 'rep-auto-over-peer', { key: owner.community.key, budget })
  t.teardown(link(owner, peer))

  t.ok(await until(async () => (await holdsSegment(peer, a.segments[3])) && (await holdsSegment(peer, a.segments[2])), 20000), 'the two newest segments are held')
  await new Promise(resolve => setTimeout(resolve, 1000))
  t.ok(await holdsNothingOf(peer, a.segments[0]), 'the oldest is not')
  t.ok(await holdsNothingOf(peer, a.segments[1]), 'nor the next')
  let st = await peer.community.stats()
  t.is(st.holding, 'window', 'auto says it holds a window')
  t.ok(st.heldBytes <= budget, `held ${st.heldBytes} <= budget ${budget}`)

  // The community grows: two newer segments. The window moves; what fell
  // out of it is dropped.
  await addSegments(owner, a, [c - 2, c - 1])
  t.ok(await until(async () => (await holdsSegment(peer, a.segments[5])) && (await holdsSegment(peer, a.segments[4])), 20000), 'the new segments are held')
  t.ok(await until(async () => (await holdsNothingOf(peer, a.segments[3])) && (await holdsNothingOf(peer, a.segments[2])), 10000), 'the ones that fell out are dropped')
  st = await peer.community.stats()
  t.ok(st.heldBytes <= budget, `still within budget (${st.heldBytes} <= ${budget})`)
})

test('v2 replication: auto counts what was read beyond its window; the window makes room', async (t) => {
  // Scrollback past the window downloaded blocks no one counted: holdings
  // could grow past the budget for good.
  const owner = await member(t, 'rep-read-owner')
  const c = now()
  const a = await channelWithHistory(owner, 'a', authors(2), [c - 6, c - 5, c - 4, c - 3])
  const segBytes = 2 * PER * ((await blockBytes(owner, a)) + STORED_OVERHEAD)
  const budget = Math.floor(segBytes * 2.5)
  const peer = await member(t, 'rep-read-peer', { key: owner.community.key, budget })
  t.teardown(link(owner, peer))
  t.ok(await until(async () => (await holdsSegment(peer, a.segments[3])) && (await holdsSegment(peer, a.segments[2])), 20000), 'the window: the two newest segments')

  // Read the oldest segment in full.
  const oldest = a.segments[0]
  const page = await peer.community.before(a.id, { t: segmentStart(oldest.segment + 1, SEG), limit: 2 * PER })
  t.is(page.length, 2 * PER, 'read the oldest segment')
  t.ok(await until(async () => (await holdsNothingOf(peer, a.segments[2])) && (await holdsSegment(peer, a.segments[3])), 10000), 'the window shrank to the newest segment')
  t.ok(await holdsSegment(peer, oldest), 'what was read is kept')
  const st = await peer.community.stats()
  t.ok(st.heldBytes <= budget, `held ${st.heldBytes} <= budget ${budget}, reads counted`)
})

test('v2 replication: auto drops the oldest reads once reads alone pass the budget', async (t) => {
  const owner = await member(t, 'rep-reads-owner')
  const c = now()
  const a = await channelWithHistory(owner, 'a', authors(2), [c - 6, c - 5, c - 4, c - 3])
  const segBytes = 2 * PER * ((await blockBytes(owner, a)) + STORED_OVERHEAD)
  const budget = Math.floor(segBytes * 1.5)
  const peer = await member(t, 'rep-reads-peer', { key: owner.community.key, budget })
  t.teardown(link(owner, peer))
  await until(async () => holdsSegment(peer, a.segments[3]), 20000)

  for (const seg of [a.segments[0], a.segments[1]]) {
    const page = await peer.community.before(a.id, { t: segmentStart(seg.segment + 1, SEG), limit: 2 * PER })
    t.is(page.length, 2 * PER, `read segment ${seg.segment}`)
  }
  t.ok(await until(async () => holdsNothingOf(peer, a.segments[0]), 10000), 'the first read is dropped')
  t.ok(await holdsSegment(peer, a.segments[1]), 'the last read is kept')
  t.ok((await peer.community.stats()).heldBytes <= budget, 'within budget')
})

test('v2 replication: a helper holding everything serves old segments to a sparse member', async (t) => {
  const owner = await member(t, 'rep-helper-owner')
  const c = now()
  const a = await channelWithHistory(owner, 'a', authors(2), [c - 3, c - 2, c])
  const helper = await member(t, 'rep-helper-helper', { key: owner.community.key, replicate: 'all' })
  const unlink = link(owner, helper)
  t.ok(await until(async () => {
    for (const seg of a.segments) if (!(await holdsSegment(helper, seg))) return false
    return true
  }, 20000), 'the helper holds everything')
  unlink() // the owner goes away

  const reader = await member(t, 'rep-helper-reader', { key: owner.community.key, replicate: 'sparse' })
  t.teardown(link(helper, reader))
  await until(async () => { await reader.community.update(); return reader.community.channels().length === 1 })
  const oldest = a.segments[0]
  const page = await reader.community.before(a.id, { t: segmentStart(oldest.segment + 1, SEG), limit: 50, timeout: 5000 })
  t.is(page.length, 2 * PER, 'the oldest segment, served by the helper alone')
})

test('v2 replication: logs unreachable at first are fetched once their holder connects', async (t) => {
  // A closed segment planned while its logs were out of reach came out
  // empty (length 0) and that plan was kept: never fetched afterwards.
  t.timeout(60000) // retries back off: 2 s, 5 s, 10 s...
  const owner = await member(t, 'rep-late-owner')
  const holder = await member(t, 'rep-late-holder', { key: owner.community.key, replicate: 'sparse' })
  const c = now()
  // The roster is the owner's; the authors' logs exist only in holder's store.
  const a = await channelWithHistory(owner, 'a', authors(2), [c - 3, c - 2], holder.store)
  const peer = await member(t, 'rep-late-peer', { key: owner.community.key, replicate: 'all' })
  t.teardown(link(owner, peer))
  await until(async () => (await peer.community.stats()).replicationPasses > 0 && !(await peer.community.stats()).replicating, 10000)
  t.absent(await holdsSegment(peer, a.segments[0]), 'nothing held while the logs are out of reach')

  t.teardown(link(holder, peer))
  t.ok(await until(async () => (await holdsSegment(peer, a.segments[0])) && (await holdsSegment(peer, a.segments[1])), 25000), 'held once the holder connects')
})

test('v2 replication: a pass over what a holder already holds opens no active session', async (t) => {
  // Each pass opened an active session on every log it checked. Opening and
  // closing one makes Hypercore signal every peer of that log when its "in
  // use" state flips: a host on the default (auto) cost each member 350 KB
  // and 0.5 s of CPU per 10 idle seconds (bench/v2-community.js; 15 KB and
  // 32 ms with inactive sessions for planning and checking).
  const owner = await member(t, 'rep-quiet-owner') // auto: holds its own history
  const c = now()
  await channelWithHistory(owner, 'a', authors(10), [c - 3, c - 2])
  await until(async () => { const st = await owner.community.stats(); return st.replicationPasses > 0 && !st.replicating })
  const st0 = await owner.community.stats()
  t.is(st0.holding, 'all')
  t.is(st0.replicationActiveOpens, 0, 'none for logs it wrote and holds')

  // Restarted, it checks everything again: still none.
  await owner.community.close()
  const { Community } = require('../../../src/v2')
  const again = new Community(owner.store, { identity: owner.identity, key: owner.community.key })
  await again.ready()
  t.teardown(() => again.close())
  await until(async () => { const st = await again.stats(); return st.replicationPasses > 0 && !st.replicating })
  t.is((await again.stats()).replicationActiveOpens, 0, 'none after a restart either')
})

async function blockBytes (owner, ch) {
  const log = ch.logs[0]
  return Math.ceil(log.core.byteLength / log.core.length)
}
