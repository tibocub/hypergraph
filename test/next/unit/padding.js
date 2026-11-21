// A private space's records are padded inside the encryption (256 B at
// least, then Padmé), so whoever holds the blocks sees a few sizes only.
// The padding scheme is versioned; old unpadded blocks still read; public
// spaces aren't padded (nothing to hide from a reader).

const test = require('brittle')
const b4a = require('b4a')
const { Hypergraph } = require('../../../lib/index.js')
const enc = require('../../../lib/encodings.js')
const symbols = require('../../../lib/symbols.js')
const testing = require('../../../lib/testing.js')
const pc = require('../../../lib/private/crypto.js')
const { tmpDir } = require('../helpers.js')

const types = { post: { fields: { title: 'string', text: 'text' } } }
const record = (text) => ({ kind: enc.PUT, type: 'post', stamp: 1, target: null, links: [], fields: b4a.from(text) })

async function open (t) {
  const hg = await Hypergraph.open(tmpDir(t), { types })
  t.teardown(() => hg.close(), { order: 0 })
  return hg
}

test('padded records: a few bytes apart, the same size; the record round-trips; 256 B then Padmé', (t) => {
  const a = enc.encodeRecord(record('ok'), { pad: true })
  const b = enc.encodeRecord(record('ok, see you at noon'), { pad: true })
  t.is(a.byteLength, 256)
  t.is(b.byteLength, 256, 'the same size')
  t.alike(enc.decodeRecord(b), record('ok, see you at noon'), 'the record comes back whole')
  const long = enc.encodeRecord(record('x'.repeat(1000)), { pad: true })
  t.is(long.byteLength, 1024, 'past 256 B: Padmé')
  t.is(enc.decodeRecord(long).fields.byteLength, 1000)
  t.is(enc.paddedSize(257), 272)
  t.is(enc.paddedSize(65552), 67584)
  t.ok(enc.decodeRecord(enc.encodeRecord(record('x'.repeat(64 * 1024 - 20)), { pad: true })), 'a record at the limit still reads padded')
})

test('an unpadded block reads as before; an unknown padding scheme is refused', (t) => {
  t.alike(enc.decodeRecord(enc.encodeRecord(record('old'))), record('old'), 'unpadded')
  const padded = enc.encodeRecord(record('new'), { pad: true })
  t.is(padded[1], enc.PAD_SCHEME)
  const future = b4a.from(padded)
  future[1] = enc.PAD_SCHEME + 1
  t.exception(() => enc.decodeRecord(future), /scheme 2/, 'a newer scheme: refused, saying so')
  const short = b4a.from(padded.subarray(0, 4))
  t.exception(() => enc.decodeRecord(short), /INVALID_RECORD|Malformed/, 'a length past the block: refused')
})

test('a private space stores its records padded: whoever holds the blocks sees padded sizes only', async (t) => {
  const hg = await open(t)
  const space = await hg.createSpace({ name: 'Club', private: true })
  const a = await space.put('post', { title: 'hi', text: '' })
  const b = await space.put('post', { title: 'hi, see you all at noon', text: '' })
  const c = await space.put('post', { title: 'long', text: 'y'.repeat(900) })
  const sizes = []
  for (const id of [a.id, b.id, c.id]) sizes.push((await testing.rawBlock(space, id)).byteLength)
  t.is(sizes[0], sizes[1], 'two short records: the same stored size')
  t.ok(sizes[2] > sizes[0], 'a long one: bigger')
  for (const s of sizes) t.is(enc.paddedSize(s), s, `${s} B: a padded size`)
  const own = space.own.core
  const nonce = own.encryption.padding(own.core, 1) // the core's encryption adds its own few bytes
  const held = await testing.rawBlocks(hg.store, [space.own.key]) // as a holder without the key has them
  t.alike(held.slice(-3).map((b) => b.byteLength), sizes.map((s) => s + nonce), "a holder's copy: padded sizes")
  t.is((await space.get(b.id)).record.title, 'hi, see you all at noon', 'and they read')
})

test('a private space written before padding: its old blocks still read, new ones are padded', async (t) => {
  const hg = await open(t)
  const space = await hg.createSpace({ name: 'Old club', private: true })
  const own = await space[symbols.ownLog]()
  const append = own.core.append.bind(own.core)
  own.core.append = (block) => append(enc.encodeRecord(enc.decodeRecord(block))) // as a build before padding wrote it
  const old = await space.put('post', { title: 'from before', text: '' })
  own.core.append = append
  const fresh = await space.put('post', { title: 'from now', text: '' })
  const raw = await space.directory.get(space.directory.logs.get(b4a.toString(own.key, 'hex')), enc.idParts(old.id).seq)
  t.ok(raw[0] <= enc.DELETE, 'the old block is unpadded')
  t.is((await space.get(old.id)).record.title, 'from before', 'and reads')
  t.is((await space.get(fresh.id)).record.title, 'from now')
  t.is((await testing.rawBlock(space, fresh.id)).byteLength, 256, 'the new one is padded')
  t.alike((await space.query('post').latest(10)).items.map((p) => p.title).sort(), ['from before', 'from now'])
})

test('a public space is not padded', async (t) => {
  const hg = await open(t)
  const space = await hg.createSpace({ name: 'Open' })
  const p = await space.put('post', { title: 'hi', text: '' })
  const raw = await testing.rawBlock(space, p.id)
  t.ok(raw.byteLength < 100, 'its exact size')
  t.ok(raw[0] <= enc.DELETE, 'an unpadded record')
})

test("a sealed payload is padded when its block isn't (a private board with no disk key); old and padded boxes open the same way", (t) => {
  const key = pc.newEpochKey()
  const ad = b4a.from('ad')
  const seal = (text, pad) => pc.sealRecord(key, 0, ad, { fields: b4a.from(text), links: [] }, { pad })
  const a = seal('ok', true)
  const b = seal('ok, see you at noon', true)
  t.is(a.byteLength, b.byteLength, 'a few bytes apart: the same size')
  t.alike(pc.openRecord(key, ad, b), { fields: b4a.from('ok, see you at noon'), links: [] }, 'opens whole')
  t.ok(seal('ok', false).byteLength < a.byteLength, 'unpadded: smaller')
  t.alike(pc.openRecord(key, ad, seal('ok', false)), { fields: b4a.from('ok'), links: [] }, 'and opens as before')
  t.ok(seal('x'.repeat(62 * 1024), true).byteLength < enc.MAX_RECORD - 900, 'near the 64 KB limit: padded less, so the record still fits')
})
