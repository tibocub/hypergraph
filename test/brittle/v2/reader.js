// v2 prototype: reading a channel (spec 007, FR-006, FR-008; US1, US2).

const test = require('brittle')
const { member, link, until, sleep } = require('./_helpers')
const { segmentOf } = require('../../../src/v2/segments')

const SEG = 3000 // short segments, so a test spans two of them in real time

async function setup (t, label, authors = 2) {
  const owner = await member(t, `${label}-owner`)
  const channel = await owner.community.createChannel({ name: 'general', segmentMs: SEG })
  await owner.community.keep(channel)
  const peers = []
  for (let i = 0; i < authors; i++) {
    const p = await member(t, `${label}-a${i}`, { key: owner.community.key })
    t.teardown(link(owner, p))
    await until(async () => { await p.community.update(); return p.community.keepers(channel).length === 1 })
    peers.push(p)
  }
  return { owner, peers, channel }
}

const texts = (page) => page.map(m => m.text)

// Wait until the keeper lists everyone who posted in these segments.
async function settled (reader, channel, segments, count) {
  return until(async () => {
    let n = 0
    for (const s of segments) n += (await reader.community.rosterEntries(channel, s)).length
    return n >= count
  })
}

test('v2 reader: the latest page merges authors newest first, the same on every reader', async (t) => {
  const { owner, peers, channel } = await setup(t, 'rd-merge')
  const [a, b] = peers
  const posted = []
  for (let i = 0; i < 6; i++) {
    const who = i % 2 ? b : a
    posted.push(await who.community.post(channel, `m${i}`))
    await sleep(5)
  }
  const segs = [...new Set(posted.map(p => segmentOf(p.t, SEG)))]
  const pairs = new Set(posted.map(p => `${p.author}:${segmentOf(p.t, SEG)}`)).size
  t.ok(await settled(owner, channel, segs, pairs), 'every author listed in every segment it posted in')
  let page = []
  t.ok(await until(async () => { page = await owner.community.latest(channel, { limit: 4 }); return page.length === 4 && page[0].text === 'm5' }), 'the owner shows the newest four')
  t.alike(texts(page), ['m5', 'm4', 'm3', 'm2'])
  let pageA = []
  t.ok(await until(async () => { pageA = await a.community.latest(channel, { limit: 4 }); return pageA.length === 4 && pageA[0].text === 'm5' }))
  t.alike(texts(pageA), texts(page), 'the same page on another reader')
  t.ok(page.every(m => m.author && m.log && typeof m.seq === 'number' && m.hidden === false))
})

test('v2 reader: a page spans into the previous segment; scrollback reads before a time', async (t) => {
  const { owner, peers, channel } = await setup(t, 'rd-span', 1)
  const [a] = peers
  const early = []
  for (let i = 0; i < 3; i++) early.push(await a.community.post(channel, `old${i}`))
  // Into the next segment.
  const wait = SEG - (Date.now() % SEG) + 50
  await sleep(wait)
  const late = await a.community.post(channel, 'new0')
  t.not(segmentOf(late.t, SEG), segmentOf(early[0].t, SEG), 'two segments')
  t.ok(await settled(owner, channel, [segmentOf(early[0].t, SEG), segmentOf(late.t, SEG)], 2), 'listed in both')

  let page = []
  t.ok(await until(async () => { page = await owner.community.latest(channel, { limit: 3 }); return page.length === 3 && page[0].text === 'new0' }))
  t.alike(texts(page), ['new0', 'old2', 'old1'], 'the newest, then the previous segment')
  const older = await owner.community.before(channel, { t: page[page.length - 1].t, limit: 10 })
  t.alike(texts(older), ['old0'], 'scrollback: what comes before')
})

test('v2 reader: a message claiming the future is held back; an unreachable author does not block the page', async (t) => {
  const { owner, peers, channel } = await setup(t, 'rd-edge')
  const [a, b] = peers
  await a.community.post(channel, 'a1')
  await a.community.postRaw(channel, { t: Date.now() + 10 * 60 * 1000, text: 'from the future' })
  t.ok(await until(async () => (await owner.community.latest(channel)).some(m => m.text === 'a1')))
  t.absent((await owner.community.latest(channel)).some(m => m.text === 'from the future'), 'held back')

  // b posts while connected only to... nobody the owner can reach: close b first.
  const bPost = await b.community.post(channel, 'b1')
  t.ok(await until(async () => (await owner.community.rosterEntries(channel, segmentOf(bPost.t, SEG))).some(e => e.author === b.pub)), 'b is listed')
  await b.community.close()
  const page = await owner.community.latest(channel, { timeout: 1000 })
  t.ok(page.some(m => m.text === 'a1'), 'the reachable author still shows')
  t.ok((await owner.community.stats()).unreachable >= 1 || page.some(m => m.text === 'b1'), 'and the gap is reported (unless b1 had already arrived)')
})

test('v2 reader: a page fetches about what it shows, not every author’s newest page', async (t) => {
  // The reader took each author's newest `limit` messages, then kept `limit`:
  // 2,500 blocks for a 50-message page from 50 authors (bench/v2-chat.js,
  // about half the newcomer's bytes).
  const b4a = require('b4a')
  const hcrypto = require('hypercore-crypto')
  const { AuthorLog } = require('../../../src/v2/author-log')
  const { signEntry } = require('../../../src/v2/roster')
  const owner = await member(t, 'rd-fetch-owner')
  const channel = await owner.community.createChannel({ name: 'general', segmentMs: 60000 })
  await owner.community.keep(channel)
  const AUTHORS = 20
  const PER = 30
  const now = Date.now() - 5000
  const seg = segmentOf(now, 60000)
  const logs = []
  for (let k = 0; k < AUTHORS; k++) {
    const a = { keyPair: hcrypto.keyPair(), seed: hcrypto.randomBytes(32) }
    const log = new AuthorLog(owner.store, { keyPair: AuthorLog.keyPairFor(a, owner.community.key, channel) })
    await log.ready()
    const messages = []
    // Interleaved in time: the newest 10 are one message each from 10 authors.
    for (let i = 0; i < PER; i++) messages.push({ t: now - (PER - i) * 100 + k, text: `a${k} m${i}` })
    const first = await log.appendMany(messages)
    await owner.community.writeRosterEntryUnchecked(channel, seg, { author: a.keyPair.publicKey, log: log.key, start: first, sig: signEntry(owner.community.key, channel, seg, log.key, first, a.keyPair) })
    logs.push(b4a.toString(log.key, 'hex'))
  }
  const reader = await member(t, 'rd-fetch-reader', { key: owner.community.key, replicate: 'sparse' })
  t.teardown(link(owner, reader))
  await until(async () => { await reader.community.update(); return reader.community.channels().length === 1 })

  const page = await reader.community.latest(channel, { limit: 10 })
  t.alike(texts(page), texts(await owner.community.latest(channel, { limit: 10 })), 'the same page the owner shows')
  let held = 0
  for (const log of logs) for (let i = 0; i < PER; i++) if (await reader.community.holds(log, i)) held++
  t.ok(held <= 10 + 2 * AUTHORS, `${held} blocks fetched for 10 messages from ${AUTHORS} authors`)

  // Scrollback to the middle: found by binary search over each author's
  // times, not by walking down through everything newer (1M: 1.1 MB -> 161 KB).
  const middle = now - (PER / 2) * 100
  const older = await reader.community.before(channel, { t: middle, limit: 10 })
  t.alike(texts(older), texts(await owner.community.before(channel, { t: middle, limit: 10 })), 'scrollback: the same page the owner shows')
  let after = 0
  for (const log of logs) for (let i = 0; i < PER; i++) if (await reader.community.holds(log, i)) after++
  const bound = 10 + AUTHORS * (2 + Math.ceil(Math.log2(PER)) + 1)
  t.ok(after - held <= bound, `${after - held} more blocks for 10 messages back (bound ${bound})`)
})

test('v2 reader: follow delivers new posts from other members, once each', async (t) => {
  const { owner, peers, channel } = await setup(t, 'rd-follow')
  const [a] = peers
  const seen = []
  const stop = owner.community.follow(channel, (m) => seen.push(m.text))
  t.teardown(stop)
  for (let i = 0; i < 3; i++) {
    const p = await a.community.post(channel, `live${i}`)
    t.ok(await until(() => seen.includes(`live${i}`), 5000), `live${i} arrives`)
    t.ok(Date.now() - p.t < 5000)
  }
  await sleep(300)
  t.alike(seen, ['live0', 'live1', 'live2'], 'in order, no duplicates')
})

test('v2 reader: follow finds a new author when the roster grows, not on the next poll', async (t) => {
  // A new author's first post used to wait for the 500 ms roster poll
  // (bench/v2-chat.js: live p95 521 ms at 10M, 2.4 s with 100 new writers).
  // With the poll pushed out of reach, only reacting to the roster finds it.
  const { owner, peers, channel } = await setup(t, 'rd-follow-roster')
  const [a, b] = peers
  t.teardown(link(a, b))
  const atKeeper = []
  const atReader = []
  const stops = [
    owner.community.follow(channel, (m) => atKeeper.push(m.text), { pollMs: 600000 }),
    b.community.follow(channel, (m) => atReader.push(m.text), { pollMs: 600000 })
  ]
  t.teardown(() => stops.forEach(stop => stop()))
  await sleep(300) // the first scans are done: nobody listed yet
  await a.community.post(channel, 'first')
  t.ok(await until(() => atKeeper.includes('first'), 3000), 'the keeper sees the new author')
  t.ok(await until(() => atReader.includes('first'), 3000), 'another member sees the new author')
})
