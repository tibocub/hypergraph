// Point 6 of the design brief (schemas), without a build step for apps: the
// app declares its types at runtime, and records must stay readable across app
// versions (an old app reading a record with a field it doesn't know; a new app
// reading a record without a field it added). Hyperschema does this with code
// generation, which apps would have to run, so this compares two runtime
// encodings for typical forum records:
//
//   json:   JSON text, links as hex
//   tagged: per present field, its number (declaration order, append-only)
//           then its value; unknown numbers are skipped (as protobuf does)
//
//   node bench/experiments/schema/encoding.js

const c = require('compact-encoding')
const crypto = require('hypercore-crypto')

const now = () => Number(process.hrtime.bigint()) / 1e6

// A link to a record: the author log's key and the block number.
const linkEnc = {
  preencode (state, l) { c.fixed32.preencode(state, l.log); c.uint.preencode(state, l.seq) },
  encode (state, l) { c.fixed32.encode(state, l.log); c.uint.encode(state, l.seq) },
  decode (state) { return { log: c.fixed32.decode(state), seq: c.uint.decode(state) } }
}
const kinds = { string: c.string, text: c.string, int: c.int, link: linkEnc }

// fields: [[name, kind], ...] in declaration order; a field's number is its
// position + 1, so apps may only add fields at the end.
function tagged (fields) {
  const byName = new Map(fields.map(([name, kind], i) => [name, { n: i + 1, enc: kinds[kind] }]))
  const byNumber = new Map(fields.map(([name, kind], i) => [i + 1, { name, enc: kinds[kind] }]))
  return {
    encode (record) {
      const state = { start: 0, end: 0, buffer: null }
      const present = Object.keys(record).filter((k) => byName.has(k) && record[k] != null)
      for (const k of present) {
        const { n, enc } = byName.get(k)
        c.uint.preencode(state, n)
        // length-prefixed, so a reader that doesn't know the field can skip it
        const len = c.encode(enc, record[k]).byteLength
        c.uint.preencode(state, len)
        state.end += len
      }
      state.buffer = Buffer.allocUnsafe(state.end)
      for (const k of present) {
        const { n, enc } = byName.get(k)
        c.uint.encode(state, n)
        const value = c.encode(enc, record[k])
        c.uint.encode(state, value.byteLength)
        value.copy(state.buffer, state.start)
        state.start += value.byteLength
      }
      return state.buffer
    },
    decode (buffer) {
      const state = { start: 0, end: buffer.byteLength, buffer }
      const record = {}
      for (const [name] of fields) record[name] = null
      while (state.start < state.end) {
        const n = c.uint.decode(state)
        const len = c.uint.decode(state)
        const field = byNumber.get(n)
        if (field) record[field.name] = c.decode(field.enc, buffer.subarray(state.start, state.start + len))
        state.start += len
      }
      return record
    }
  }
}

const toJSON = (r) => Buffer.from(JSON.stringify(r, (k, v) => (v && v.type === 'Buffer') ? Buffer.from(v.data).toString('hex') : v))

const types = {
  post: [['title', 'string'], ['text', 'text']],
  comment: [['text', 'text'], ['on', 'link']],
  vote: [['value', 'int'], ['on', 'link']]
}
const link = { log: crypto.randomBytes(32), seq: 12345 }
const samples = {
  post: { title: 'Hello everyone, a typical title', text: 'a typical post or comment text of a usual length, about eighty bytes long ok' },
  comment: { text: 'a typical post or comment text of a usual length, about eighty bytes long ok', on: link },
  vote: { value: 1, on: link }
}

function main () {
  const sizes = {}
  for (const [type, fields] of Object.entries(types)) {
    const enc = tagged(fields)
    sizes[type] = { json: toJSON(samples[type]).byteLength, tagged: enc.encode(samples[type]).byteLength }
  }

  // Versions: v2 of "comment" adds a field at the end.
  const v1 = tagged(types.comment)
  const v2 = tagged([...types.comment, ['edited', 'int']])
  const fromNew = v1.decode(v2.encode({ ...samples.comment, edited: 1 }))
  const fromOld = v2.decode(v1.encode(samples.comment))
  const compatible = fromNew.text === samples.comment.text && fromNew.edited === undefined &&
    fromOld.text === samples.comment.text && fromOld.edited === null

  const enc = tagged(types.comment)
  const n = 200000
  let t0 = now()
  let buf
  for (let i = 0; i < n; i++) buf = enc.encode(samples.comment)
  const encodeUs = (now() - t0) * 1000 / n
  t0 = now()
  for (let i = 0; i < n; i++) enc.decode(buf)
  const decodeUs = (now() - t0) * 1000 / n
  t0 = now()
  const j = toJSON(samples.comment)
  for (let i = 0; i < n; i++) JSON.parse(j)
  const jsonDecodeUs = (now() - t0) * 1000 / n

  console.log(JSON.stringify({
    bytes: sizes,
    oldAppReadsNewRecord_andNewAppReadsOld: compatible,
    commentTaggedUs: { encode: +encodeUs.toFixed(2), decode: +decodeUs.toFixed(2) },
    commentJsonDecodeUs: +jsonDecodeUs.toFixed(2)
  }))
}

main()
