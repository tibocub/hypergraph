// SC-006, T075 (research.md A15): nothing a peer sends crashes a member or
// shows where the rules say it shouldn't. A member's modified app writes junk
// straight into its log (malformed and oversized blocks, unknown kinds and
// types, fields that don't decode, links that aren't ids, records breaking the
// app's rules, edits and deletes of others' records, stamps far ahead); a
// stranger sends malformed and odd messages on the space channel; a banned
// member and a removed device keep writing. Every member, and a newcomer, shows
// only what counts. (Throwaway-key activity spam: test/next/net/activity.js;
// a non-member's log and someone writing into a personal space:
// test/next/forum/inspect.js and personal.js.)

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const enc = require('../../../lib/encodings.js')
const activity = require('../../../lib/activity.js')
const { account, device, threeMembers } = require('../forum/_setup.js')
const { eventually, sleep } = require('../helpers.js')

const YEAR = 365 * 864e5
const titles = (f) => forum.latest(f, 50).then((xs) => xs.map((x) => x.title).sort().join('|'))
const agree = (spaces, fn, expected, ms = 10000) => eventually(async () => {
  for (const f of spaces) if ((await fn(f)) !== expected) return false
  return true
}, ms)

// A record as a modified app would encode it, bypassing every check but the
// encoding's own (or not even that: `bytes`).
function record (space, { kind = enc.PUT, type = 'post', fields = {}, stamp = Date.now(), target = null, links = null, raw = null }) {
  const encoded = raw ? { fields: raw, links: [] } : space.types.encode(type, fields)
  return c.encode(enc.record, { kind, type, stamp, target: target ? enc.idBytes(target) : null, links: links || encoded.links, fields: encoded.fields })
}

test('junk in a member\'s log: no crash, nothing shown that doesn\'t count, the rest still shown', { timeout: 120000 }, async (t) => {
  const { fa, fb, fc } = await threeMembers(t)
  const mine = await forum.post(fa, 'by a', 'untouched')
  t.ok(await eventually(async () => (await fc.get(mine.id)).record, 10000), 'c holds a\'s post')
  await testing.writeRaw(fc, { kind: 'put', type: 'post', fields: { title: 'before the junk', text: '' } })

  const valid = record(fc, { fields: { title: 'x', text: '' } })
  const badKind = b4a.from(valid)
  badKind[0] = 9
  const junk = [
    b4a.from('garbage'),
    b4a.alloc(0),
    b4a.alloc(70 * 1024, 1), // over the 64 KB a record may take
    record(fc, { fields: { title: 'big', text: 'y'.repeat(64 * 1024) } }), // encodes past 64 KB
    badKind,
    record(fc, { fields: { title: 'a put with a target', text: '' }, target: mine.id }),
    record(fc, { fields: { title: 'a link that isn\'t an id', text: '' }, links: [b4a.alloc(5)] }),
    record(fc, { raw: b4a.from([0xff, 0xff, 0xff, 0xff]) }), // fields that don't decode
    record(fc, { type: 'z'.repeat(10000), raw: b4a.alloc(0) }), // an unknown type with a long name
    record(fc, { fields: { title: 't'.repeat(400), text: 'breaks the forum\'s title-length rule' } }),
    record(fc, { kind: enc.EDIT, fields: { title: 'edited by c', text: '' }, target: mine.id }), // not c's
    record(fc, { kind: enc.DELETE, raw: b4a.alloc(0), target: mine.id }), // not c's
    record(fc, { type: 'hg/tag', fields: { on: mine.id, tag: '' } }), // an empty tag
    record(fc, { type: 'hg/relation', raw: b4a.alloc(0) }), // a relation with nothing in it
    record(fc, { type: 'comment', fields: { text: 'on nothing', on: enc.idToString({ log: crypto.randomBytes(32), seq: 7 }) } })
  ]
  // a stamp past what a JavaScript number holds exactly (uint64 all ones): written raw
  const huge = record(fc, { fields: { title: 'a stamp too big', text: '' }, stamp: Number.MAX_SAFE_INTEGER })
  huge.fill(0xff, 7, 15) // kind (1), type 'post' (5), then the stamp: 0xff and 8 bytes
  junk.push(huge)
  for (const bytes of junk) await fc.own.core.append(bytes)
  await testing.writeRaw(fc, { kind: 'put', type: 'post', fields: { title: 'from far ahead', text: '' }, stamp: Date.now() + YEAR })
  await testing.writeRaw(fc, { kind: 'put', type: 'post', fields: { title: 'from the end of time', text: '' }, stamp: Number.MAX_SAFE_INTEGER })
  await testing.writeRaw(fc, { kind: 'put', type: 'post', fields: { title: 'after the junk', text: '' } })

  const expected = ['after the junk', 'before the junk', 'by a', 'from far ahead', 'from the end of time'].sort().join('|')
  t.ok(await agree([fa, fb], titles, expected), 'every member shows the valid posts only')
  for (const f of [fa, fb]) {
    const { record: r } = await f.get(mine.id)
    t.is(r && `${r.title}/${r.text}`, 'by a/untouched', 'a\'s post: neither edited nor deleted by c')
    const ahead = (await forum.latest(f, 50)).filter((x) => x.title.startsWith('from'))
    t.ok(ahead.length === 2 && ahead.every((x) => x.futureStamp), 'records stamped far ahead are flagged')
    t.alike(await forum.tagsOf(f, mine), [], 'no empty tag')
  }

  // A reply to a record stamped far ahead isn't dragged into the future.
  const future = (await forum.latest(fa, 50)).find((x) => x.title === 'from the end of time')
  const reply = await forum.comment(fa, future, 'replying to the future')
  t.ok(reply.stamp < Date.now() + 60000, 'a reply to it keeps a stamp near the writer\'s clock')

  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  t.ok(await agree([fd], titles, expected, 20000), 'a newcomer shows the same')
  t.ok(await fd.inspect(), 'inspect() works over the junk')
})

// Sends `bytes` as message `i` on a channel, whatever the message's encoding
// (the receiver decodes it with its own): a peer sending malformed messages.
function sendRaw (ch, i, bytes) {
  const m = ch.messages[i]
  const e = m.encoding
  const { preencode, encode } = e
  e.preencode = (state) => { state.end += bytes.byteLength }
  e.encode = (state) => {
    state.buffer.set(bytes, state.start)
    state.start += bytes.byteLength
  }
  try {
    m.send(null)
  } finally {
    e.preencode = preencode
    e.encode = encode
  }
}

test('malformed and odd messages from a stranger: no crash, nothing kept, the members carry on', { timeout: 120000 }, async (t) => {
  const { fa, fb, fc } = await threeMembers(t)
  const e = await account(t, 'stranger')
  const fe = await testing.openSpace(e, fa.key)
  await testing.writeRaw(fe, { kind: 'put', type: 'post', fields: { title: 'stranger', text: '' } })
  t.ok(await eventually(() => fe.directory.channels.size >= 1, 30000), 'the stranger reached a member')

  const random = () => crypto.randomBytes(32)
  const big = 2 ** 52
  const decision = c.encode(enc.decision, { type: 'writer/add', stamp: Date.now(), key: random(), proof: crypto.randomBytes(100) })
  for (const ch of [...fe.directory.channels]) {
    // well-formed but odd
    ch.messages[0].send({ count: big, digest: random(), records: big }) // summary
    ch.messages[2].send(Array.from({ length: 3000 }, random)) // a list of logs nobody has
    ch.messages[3].send(random()) // a notice
    ch.messages[4].send(random()) // a get
    ch.messages[5].send({ redemption: crypto.randomBytes(200) })
    ch.messages[6].send({ decision: crypto.randomBytes(200) })
    ch.messages[6].send({ decision })
    ch.messages[7].send(crypto.randomBytes(150)) // hello: a proof that isn't one
    ch.messages[8].send({ log: random(), period: big, start: big }) // an activity entry
    ch.messages[8].send({ log: fa.own.key, period: big, start: big })
    ch.messages[9].send({ from: big }) // want
    ch.messages[10].send({ from: big, entries: Array.from({ length: 50 }, () => ({ log: random(), period: 1, start: 1 })), done: false })
  }
  await sleep(1000)
  for (const ch of [...fe.directory.channels]) {
    // malformed: each makes the member close that connection
    for (let i = 0; i <= 10; i++) sendRaw(ch, i, b4a.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))
  }
  await sleep(2000)

  const p = await forum.post(fa, 'still here', '')
  t.ok(await agree([fb, fc], (f) => f.get(p.id).then((r) => !!r.record), true, 15000), 'the members still pass records on')
  for (const f of [fa, fb, fc]) {
    t.absent(testing.logs(f).includes(testing.ownLog(fe)), 'the stranger\'s log is not kept')
    t.ok(testing.logs(f).length <= 4, 'no log from the lists of random keys')
    t.absent((await testing.activity(f)).some((x) => x.period >= big - 1), 'no entry from the odd ones')
    t.absent((await forum.latest(f, 50)).some((x) => x.title === 'stranger'))
  }
})

test('a flood of log keys from a stranger: fetched a few at a time, the queue bounded, the members carry on', { timeout: 120000 }, async (t) => {
  const { fa, fb } = await threeMembers(t)
  const e = await account(t, 'stranger')
  const fe = await testing.openSpace(e, fa.key)
  t.ok(await eventually(() => fe.directory.channels.size >= 1, 30000), 'the stranger reached a member')
  let most = 0
  const watch = setInterval(() => { most = Math.max(most, ...[fa, fb].map((f) => testing.fetching(f).running + testing.fetching(f).waiting)) }, 20)
  for (const ch of [...fe.directory.channels]) {
    for (let i = 0; i < 2; i++) ch.messages[2].send(Array.from({ length: 1000 }, () => crypto.randomBytes(32))) // lists of logs
    for (let i = 0; i < 500; i++) ch.messages[3].send(crypto.randomBytes(32)) // notices
  }
  await sleep(3000)
  clearInterval(watch)
  const now = [fa, fb].map((f) => testing.fetching(f))
  t.ok(now.every((x) => x.running <= 16), `headers fetched a few at a time (${now.map((x) => x.running).join(', ')})`)
  t.ok(most <= 16 + 1024, `what waits is bounded (at most ${most})`)
  const p = await forum.post(fa, 'still here', '')
  t.ok(await agree([fb], (f) => f.get(p.id).then((r) => !!r.record), true, 15000), 'the members still pass records on')
})

test('a banned member keeps writing, junk included: nothing past the cut counts, for members and newcomers', { timeout: 120000 }, async (t) => {
  const { fa, fb, fc, c: cHg } = await threeMembers(t)
  await forum.post(fc, 'before the ban', '')
  t.ok(await agree([fa, fb], titles, 'before the ban'))
  await forum.ban(fa, cHg.identity.publicKey, { reason: 'spam' })
  t.ok(await eventually(async () => (await forum.roleOf(fc, cHg.identity.publicKey)) === null, 10000), 'c learns it is out')
  await testing.writeRaw(fc, { kind: 'put', type: 'post', fields: { title: 'after the ban', text: '' } })
  await fc.own.core.append(b4a.from('garbage after the ban'))
  await testing.writeRaw(fc, { kind: 'put', type: 'post', fields: { title: 'from far ahead, after the ban', text: '' }, stamp: Date.now() + YEAR })
  await sleep(1000)
  t.ok(await agree([fa, fb], titles, 'before the ban'), 'nothing written after the ban shows')
  const d = await account(t, 'd')
  const fd = await forum.join(d, await forum.invite(fa))
  t.ok(await agree([fd], titles, 'before the ban', 20000), 'a newcomer shows the same')
})

test('a removed device keeps writing: nothing after its removal counts', { timeout: 120000 }, async (t) => {
  const laptop = await account(t, 'laptop')
  const b = await account(t, 'b')
  const fl = await forum.createForum(laptop, 'Fans')
  const fb = await forum.join(b, await forum.invite(fl))
  const { code } = await forum.addDevice(laptop)
  const phone = await device(t, 'phone', code)
  t.ok(await eventually(() => forum.forums(phone).some((f) => f.key === fl.key), 15000), 'the phone shows the forum')
  const fp = phone.space(fl.key)
  t.ok(await eventually(async () => {
    try { return !!(await forum.post(fp, 'from the phone', '')) } catch { return false }
  }, 10000), 'the phone writes')
  t.ok(await agree([fl, fb], titles, 'from the phone'))

  await forum.protectPhrase(laptop, 'laptop password')
  await forum.removeDevice(laptop, phone.device.publicKey, 'laptop password')
  await testing.writeRaw(fp, { kind: 'put', type: 'post', fields: { title: 'lost phone', text: '' } })
  await fp.own.core.append(b4a.alloc(70 * 1024, 2))
  await testing.writeRaw(fp, { kind: 'put', type: 'post', fields: { title: 'lost phone, far ahead', text: '' }, stamp: Date.now() + YEAR })
  await sleep(1000)
  t.ok(await agree([fl, fb], titles, 'from the phone'), 'nothing it writes after its removal shows')
})

test('activity entries with odd numbers are refused without a crash', async (t) => {
  // (no network) the check itself, with values a peer can send
  const ok = (e, at) => activity.checkEntry(e, at)
  t.is(ok({ period: 2 ** 52, start: 2 ** 52 }, { before: null, at: null, limit: Infinity }), 'wait')
  t.is(ok({ period: 1, start: 0 }, { before: null, at: null, limit: Infinity }), 'false')
  t.is(ok({ period: 1, start: NaN }, { before: null, at: null, limit: Infinity }), 'false')
})
