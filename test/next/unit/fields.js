// Tagged field encoding (experiment 6): per present field its number, length
// and value; readers skip numbers they don't know, and get null for declared
// fields a record doesn't have.

const test = require('brittle')
const b4a = require('b4a')
const z32 = require('z32')
const crypto = require('hypercore-crypto')
const fields = require('../../../lib/fields.js')
const { idToString } = require('../../../lib/encodings.js')

const linkId = idToString({ log: crypto.randomBytes(32), seq: 12345 })

test('round trip of every kind', (t) => {
  const codec = fields.codec([
    { name: 's', kind: 'string' }, { name: 't', kind: 'text' }, { name: 'i', kind: 'int' },
    { name: 'u', kind: 'uint' }, { name: 'f', kind: 'float' }, { name: 'b', kind: 'bool' },
    { name: 'y', kind: 'bytes' }, { name: 'r', kind: 'ref' }, { name: 'l', kind: 'link' },
    { name: 'k', kind: 'space' }
  ])
  const value = {
    s: 'hello', t: 'a longer text ✓', i: -42, u: 7, f: 1.5, b: false,
    y: b4a.from([1, 2, 3]),
    r: { src: ['swarmwire://abc'], size: 2048, type: 'video/mp4', digest: 'blake3:9f2c', mutable: false },
    l: linkId,
    k: z32.encode(crypto.randomBytes(32))
  }
  const links = []
  const bytes = codec.encode(value, links)
  t.is(links.length, 1, 'the link goes to the record\'s links')
  const back = codec.decode(bytes, links)
  t.alike({ ...back, y: b4a.toString(back.y, 'hex') }, { ...value, y: '010203' })
})

test('absent fields decode as null', (t) => {
  const codec = fields.codec([{ name: 'a', kind: 'string' }, { name: 'b', kind: 'uint' }])
  t.alike(codec.decode(codec.encode({ a: 'x' }, []), []), { a: 'x', b: null })
})

test('an older reader skips fields it does not know; a newer one gets them empty', (t) => {
  const v1 = fields.codec([{ name: 'text', kind: 'text' }, { name: 'on', kind: 'link' }])
  const v2 = fields.codec([{ name: 'text', kind: 'text' }, { name: 'on', kind: 'link' }, { name: 'edited', kind: 'int' }])
  const links = []
  const fromNew = v1.decode(v2.encode({ text: 'hi', on: linkId, edited: 1 }, links), links)
  t.alike(fromNew, { text: 'hi', on: linkId })
  const links2 = []
  const fromOld = v2.decode(v1.encode({ text: 'hi', on: linkId }, links2), links2)
  t.alike(fromOld, { text: 'hi', on: linkId, edited: null })
})

test('sizes stay near experiment 6 (post 113 B, comment 116 B, vote 40 B, ±10%)', (t) => {
  const text = 'a typical post or comment text of a usual length, about eighty bytes long ok'
  const post = fields.codec([{ name: 'title', kind: 'string' }, { name: 'text', kind: 'text' }])
  const comment = fields.codec([{ name: 'text', kind: 'text' }, { name: 'on', kind: 'link' }])
  const vote = fields.codec([{ name: 'value', kind: 'int' }, { name: 'on', kind: 'link' }])
  // Links live in the record's link list (a 1-byte index in the fields), so
  // count them as the experiment did: the id's bytes (35 B) once per record.
  const size = (codec, v) => { const links = []; const n = codec.encode(v, links).byteLength; return n + links.reduce((s, l) => s + l.byteLength, 0) }
  const near = (got, want, name) => t.ok(Math.abs(got - want) <= want * 0.1, `${name}: ${got} B (experiment: ${want} B)`)
  near(size(post, { title: 'Hello everyone, a typical title', text }), 113, 'post')
  near(size(comment, { text, on: linkId }), 116, 'comment')
  near(size(vote, { value: 1, on: linkId }), 40, 'vote')
})

test('malformed bytes throw instead of returning garbage', (t) => {
  const codec = fields.codec([{ name: 'a', kind: 'string' }])
  t.exception(() => codec.decode(b4a.from([1, 200, 1]), []))
})
