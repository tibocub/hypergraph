// Secure conversations' chains and key store (lib/private/chains.js): no
// network, no disk (the store's rows go to a Map, as they would to the engine's table).

const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const chains = require('../../../lib/private/chains.js')
const crypto = require('../../../lib/private/crypto.js')
const grants = require('../../../lib/private/grants.js')

const { KeyStore } = chains
const DAY = 24 * 3600 * 1000
const hex = (b) => b4a.toString(b, 'hex')

// A store whose rows live in `disk`, at a clock the test moves.
function store (disk = new Map(), clock = { now: 1e12 }) {
  const write = async (ops) => { for (const [name, value] of ops) value ? disk.set(name, b4a.from(value)) : disk.delete(name) }
  const ks = KeyStore.load([...disk].map(([name, value]) => ({ name, value })), { now: () => clock.now, write })
  return { ks, disk, clock, again: () => store(disk, clock).ks }
}

// One epoch over two writer logs, derived in a store.
function epochIn (ks, { epoch = 0, logs = [b4a.alloc(32, 3), b4a.alloc(32, 5)] } = {}) {
  const key = crypto.newEpochKey()
  const commit = crypto.commitOf(key)
  const space = b4a.alloc(32, 2)
  ks.addEpoch(key, { epoch, commit, space, logs })
  return { key, commit, short: crypto.shortCommit(commit), space, logs }
}

test('KDF vectors: the chain start is keyed BLAKE2b, each step crypto_kdf with constants 1 and 2', (t) => {
  // checked against an independent BLAKE2b (Python hashlib.blake2b: key, salt = id, person = "hgchain1")
  const ck0 = chains.chainStart(b4a.alloc(32, 1), b4a.alloc(32, 2), b4a.alloc(32, 3), b4a.alloc(32, 4))
  t.is(hex(ck0), '70777882e297284ee358cc8e41216b6746c54110b08d97d2768eeaeb56d97e26')
  const s0 = chains.step(ck0)
  t.is(hex(s0.mk), '8baecdc585d74a074a6a71c0489df240aac3ee2139bbbcc7f320399813f00d3e', 'MK_0')
  t.is(hex(s0.next), 'e19c61daf735132699d91fed84598bb6932aa3016ae3dfdf17d9cbfa392f4735', 'CK_1')
  t.is(hex(chains.step(s0.next).mk), '63a24126aa66f88a32b44b7c94644b1b660f8ea310ebf2882615498d5f490068', 'MK_1')
  t.unlike(chains.chainStart(b4a.alloc(32, 1), b4a.alloc(32, 2), b4a.alloc(32, 9), b4a.alloc(32, 4)), ck0, 'another log: another chain')
})

test('sender and reader agree on each message key; out of order keeps the skipped ones, used once', (t) => {
  const sender = store().ks
  const reader = store().ks
  const key = crypto.newEpochKey()
  const commit = crypto.commitOf(key)
  const opts = { epoch: 0, commit, space: b4a.alloc(32, 2), logs: [b4a.alloc(32, 3)] }
  sender.addEpoch(key, opts)
  reader.addEpoch(key, opts)
  const short = crypto.shortCommit(commit)
  const log = hex(opts.logs[0])
  const sent = [0, 1, 2, 3, 4].map((n) => sender.messageKey(short, log, n))
  t.alike(reader.messageKey(short, log, 0), sent[0], 'in order')
  t.alike(reader.messageKey(short, log, 3), sent[3], 'a jump ahead')
  t.is(reader.skipped.size, 2, 'the two in between kept as skipped keys')
  t.alike(reader.messageKey(short, log, 1), sent[1], 'a late one: its skipped key')
  t.is(reader.messageKey(short, log, 1), null, 'used once: gone')
  t.alike(reader.messageKey(short, log, 2), sent[2])
  t.is(reader.skipped.size, 0)
  t.is(reader.messageKey(short, log, 0), null, 'an index already passed, not skipped: null')
})

test('caps: an index past 65,535 is refused; past 100,000 skipped keys the oldest go', (t) => {
  const { ks } = store()
  const e = epochIn(ks)
  const log = hex(e.logs[0])
  t.is(ks.messageKey(e.short, log, chains.MAX_INDEX + 1), null, 'past the cap: refused')
  t.ok(ks.messageKey(e.short, log, chains.MAX_INDEX), 'at the cap: fine')
  t.is(ks.skipped.size, chains.MAX_INDEX)
  const other = hex(e.logs[1])
  ks.messageKey(e.short, other, 50000)
  t.is(ks.skipped.size, chains.MAX_SKIPPED, 'never more than the cap')
  t.is(ks.messageKey(e.short, log, 0), null, 'the oldest skipped key went first')
  t.ok(ks.messageKey(e.short, other, 49999), 'a newer one is still there')
})

test('a skipped key unused for 90 days is erased; the record is then lacking, asked for, and gone after 30 more', (t) => {
  const { ks, clock } = store()
  const e = epochIn(ks)
  const log = hex(e.logs[0])
  ks.messageKey(e.short, log, 2)
  clock.now += 89 * DAY
  ks.sweep({ current: e.short })
  t.is(ks.skipped.size, 2, 'kept 89 days')
  clock.now += 2 * DAY
  ks.sweep({ current: e.short })
  t.is(ks.skipped.size, 0, 'erased after 90')
  t.is(ks.messageKey(e.short, log, 1), null)
  t.is(ks.lacks(log, 1), 'ask', 'lacking: asked of its author')
  ks.asked([log + ':1'])
  t.is(ks.lacks(log, 1), 'wait')
  clock.now += 7 * DAY
  t.is(ks.lacks(log, 1), 'ask', 'asked again after 7 days')
  clock.now += 23 * DAY
  t.is(ks.lacks(log, 1), 'gone', 'gone 30 days after it was first missed')
})

test('an older epoch\'s chain goes once its writer moved on and every earlier block is read', (t) => {
  const { ks } = store()
  const old = epochIn(ks, { epoch: 0 })
  const log = hex(old.logs[0])
  const key = crypto.newEpochKey()
  const commit = crypto.commitOf(key)
  ks.addEpoch(key, { epoch: 1, commit, space: old.space, logs: old.logs })
  const short = crypto.shortCommit(commit)
  ks.messageKey(old.short, log, 0, 1)
  ks.messageKey(short, log, 0, 5) // block 5: the writer's first in epoch 1
  ks.sweep({ current: short, readTo: () => 3 })
  t.ok(ks.chain(old.short, log), 'kept while blocks 3 and 4 may still be in epoch 0')
  ks.sweep({ current: short, readTo: () => 5 })
  t.is(ks.chain(old.short, log), null, 'dropped once they are read')
  t.ok(ks.chain(old.short, hex(old.logs[1])), 'another writer\'s chain of that epoch stays')
})

test('a crash between storing the next step and appending never reuses a step', async (t) => {
  const { ks, again } = store()
  const e = epochIn(ks)
  const log = hex(e.logs[0])
  await ks.flush()
  const first = ks.messageKey(e.short, log, ks.chain(e.short, log).n)
  await ks.flush() // stored, then the process dies before the append
  const after = again()
  t.is(after.chain(e.short, log).n, 1, 'the restarted store goes on at the next step')
  const second = after.messageKey(e.short, log, after.chain(e.short, log).n)
  t.unlike(second, first, 'a new key: index 0 is skipped by readers, never reused')
})

test('the epoch key and a used prekey\'s secret are never on disk; a used prekey opens nothing', async (t) => {
  const device = store()
  const { ks, disk } = device
  const pre = ks.newPrekey()
  await ks.flush()
  t.ok(disk.has('p:' + pre.n), 'an unused prekey\'s secret is stored')
  const key = crypto.newEpochKey()
  const commit = crypto.commitOf(key)
  const keys = { current: 0, commits: { 0: hex(commit) }, others: {} }
  const grant = grants.makePrekeyGrant(key, 0, commit, b4a.alloc(32, 7), { n: pre.n, key: pre.publicKey })
  const thiefCopy = new Map(disk) // a copy taken while the prekey is unused opens the grant
  const opened = grants.openGrant(grant, ks.prekey(pre.n), keys, true)
  t.alike(opened.key, key, 'the device opens its grant')
  ks.addEpoch(opened.key, { epoch: 0, commit, space: b4a.alloc(32, 2), logs: [b4a.alloc(32, 3)] })
  await ks.flush()
  ks.usePrekey(pre.n)
  await ks.flush()
  t.absent([...disk.values()].some((value) => b4a.indexOf(value, key) !== -1), 'the epoch key is in no row')
  t.absent(disk.has('p:' + pre.n), 'the prekey\'s secret is gone from disk')
  t.is(ks.prekey(pre.n), null, 'and from memory')
  const stolen = KeyStore.load([...disk].map(([name, value]) => ({ name, value })))
  t.is(stolen.prekey(pre.n), null, 'a copy taken after the open holds no prekey for that grant')
  const other = { publicKey: b4a.alloc(32), secretKey: b4a.alloc(32) }
  sodium.crypto_box_keypair(other.publicKey, other.secretKey)
  t.is(grants.openGrant(grant, other, keys, true), null, 'and no other key opens it')
  const before = KeyStore.load([...thiefCopy].map(([name, value]) => ({ name, value })))
  t.ok(grants.openGrant(grant, before.prekey(pre.n), keys, true), 'the documented limit: a copy taken before the open opens it')
})

test('only the two newest unused prekeys are kept', (t) => {
  const { ks } = store()
  const a = ks.newPrekey()
  const b = ks.newPrekey()
  const c = ks.newPrekey()
  t.is(ks.prekey(a.n), null, 'the oldest erased')
  t.ok(ks.prekey(b.n) && ks.prekey(c.n))
})

test('record keys: erased on purpose stay erased; trimmed and timed out ones go', async (t) => {
  const { ks, again } = store()
  const mk = b4a.alloc(32, 9)
  ks.keep('aa', 1, mk, 100)
  ks.keep('aa', 2, b4a.alloc(32, 8), 200)
  ks.keep('bb', 1, b4a.alloc(32, 7), 300)
  ks.erase('aa', 1)
  t.is(ks.keyOf('aa', 1), null)
  t.is(mk[0], 0, 'its bytes are wiped')
  t.ok(ks.wasErased('aa', 1), 'never asked for again')
  ks.eraseWhere((log, seq, stamp) => stamp < 250)
  t.is(ks.keyOf('aa', 2), null, 'older than the timer: gone')
  t.ok(ks.keyOf('bb', 1))
  await ks.flush()
  const back = again()
  t.ok(back.wasErased('aa', 1) && !back.keyOf('aa', 2) && back.keyOf('bb', 1), 'the same after a restart')
})

test('resends: once per (record, device), within the daily budget', (t) => {
  const { ks, clock } = store()
  t.ok(ks.mayAnswer('aa', 1, 'dev1', 40))
  t.absent(ks.mayAnswer('aa', 1, 'dev1', 40), 'the same pair: once')
  t.ok(ks.mayAnswer('aa', 1, 'dev2', 40), 'another device: its own answer')
  t.absent(ks.mayAnswer('aa', 2, 'dev1', chains.RESEND_BYTES), 'past the day\'s budget: waits')
  clock.now += DAY
  t.ok(ks.mayAnswer('aa', 2, 'dev1', chains.RESEND_BYTES - 40), 'a new day')
  const reply = ks.newReply()
  t.ok(ks.reply(reply.id))
  ks.dropReply(reply.id)
  t.is(ks.reply(reply.id), null, 'a reply key is used once')
})

test('a message key seals a record that only it opens, at its place and index', (t) => {
  const mk = b4a.alloc(32)
  sodium.randombytes_buf(mk)
  const commit = b4a.alloc(32, 4)
  const space = b4a.alloc(32, 2)
  const log = b4a.alloc(32, 3)
  const ad = (seq, n) => crypto.recordAD(space, log, seq, 1, n, crypto.CHAIN)
  const sealed = crypto.sealRecord(mk, 1, ad(7, 5), { fields: b4a.from('hi'), links: [] }, { scheme: crypto.CHAIN, n: 5, commit })
  t.alike(crypto.sealedWith(sealed), { scheme: crypto.CHAIN, epoch: 1, commit: crypto.shortCommit(commit), n: 5 })
  t.alike(crypto.openRecord(mk, ad(7, 5), sealed).fields, b4a.from('hi'))
  t.is(crypto.openRecord(mk, ad(7, 6), sealed), null, 'another index: doesn\'t open')
  t.is(crypto.openRecord(mk, crypto.recordAD(space, log, 7, 1, 5), sealed), null, 'another scheme: doesn\'t open')
})

test('a shared type holds no content: a text or bytes field is refused; a later version may make a type shared', (t) => {
  const { Types } = require('../../../lib/types.js')
  const name = new Types({ nick: { fields: { name: 'string' }, shared: true } })
  t.is(name.get('nick').shared, true)
  t.is(name.describe().nick.shared, true, 'kept in the declaration a space records')
  for (const kind of ['text', 'bytes']) t.exception(() => new Types({ note: { fields: { body: kind }, shared: true } }), /no text or bytes/, kind + ': refused')
  new Types({ nick: { fields: { name: 'string' }, shared: true } }).checkCompatible(new Types({ nick: { fields: { name: 'string' } } }).describe()) // a later version may make it shared: each record says how it is sealed
  t.pass('a type may become shared in a later version')
  t.is(new Types({ post: { fields: { title: 'string' } } }).get('post').shared, false, 'never by default')
})
