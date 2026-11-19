// Tagged field encoding. A type's fields are
// numbered by declaration order (1, 2, ...), so apps may only add fields at the
// end. Per present field: its number, its length, its value. A reader skips
// numbers it doesn't know (an older app reading a newer record) and gets null
// for declared fields a record lacks (a newer app reading an older record).
//
// Link fields hold a 1-byte-ish index into the record's `links` list, so links
// can be indexed without knowing the type (another app version may not).

const c = require('compact-encoding')
const b4a = require('b4a')
const z32 = require('z32')
const { recordId, idToString, idFromString } = require('./encodings.js')

/**
 * @typedef {{ src?: string[], size?: number, type?: string, digest?: string, mutable?: boolean }} Ref A file's reference: where to fetch it, its size, media type and digest.
 * @typedef {'string' | 'text' | 'int' | 'uint' | 'float' | 'bool' | 'bytes' | 'ref' | 'space' | 'link'} FieldKind
 * @typedef {{ name: string, kind: FieldKind }} FieldDecl
 * @typedef {{ fields: Uint8Array, links: Uint8Array[] }} EncodedFields A record's fields as bytes and the links they point into.
 * @typedef {{ encode (values: Record<string, unknown>, links: Uint8Array[], keep?: EncodedFields | null): Uint8Array, decode (buffer: Uint8Array, links: Uint8Array[]): DecodedFields }} FieldCodec
 * @typedef {Record<string, any>} DecodedFields A record's fields by name, as their kinds decode (strings, numbers, bytes, ids...): the type says which.
 */

/** @type {import('./encodings.js').Codec<Ref>} */
const ref = {
  /**
   * @param {c.State} state
   * @param {Ref} r
   */
  preencode (state, r) {
    c.array(c.string).preencode(state, r.src || [])
    c.uint.preencode(state, r.size || 0)
    c.string.preencode(state, r.type || '')
    c.string.preencode(state, r.digest || '')
    c.bool.preencode(state, !!r.mutable)
  },
  /**
   * @param {c.State} state
   * @param {Ref} r
   */
  encode (state, r) {
    c.array(c.string).encode(state, r.src || [])
    c.uint.encode(state, r.size || 0)
    c.string.encode(state, r.type || '')
    c.string.encode(state, r.digest || '')
    c.bool.encode(state, !!r.mutable)
  },
  /**
   * @param {c.State} state
   */
  decode (state) {
    const src = c.array(c.string).decode(state)
    const size = c.uint.decode(state)
    const type = c.string.decode(state)
    const digest = c.string.decode(state)
    const mutable = c.bool.decode(state)
    return { src, size, type, digest, mutable }
  }
}

const spaceKey = {
  /**
   * @param {c.State} state
   * @param {string | Uint8Array} k
   */
  preencode (state, k) { c.fixed32.preencode(state, toKey(k)) },
  /**
   * @param {c.State} state
   * @param {string | Uint8Array} k
   */
  encode (state, k) { c.fixed32.encode(state, toKey(k)) },
  /**
   * @param {c.State} state
   */
  decode (state) { return z32.encode(c.fixed32.decode(state)) }
}

/** @type {Record<string, import('./encodings.js').Codec<any>>} */
const KINDS = {
  string: c.string,
  text: c.string,
  int: c.int,
  uint: c.uint,
  float: c.float64,
  bool: c.bool,
  bytes: c.raw,
  ref,
  space: spaceKey,
  link: c.uint // an index into the record's links
}

/**
 * @param {string | Uint8Array} k
 * @returns {Uint8Array}
 */
function toKey (k) {
  const key = typeof k === 'string' ? z32.decode(k) : k
  if (!b4a.isBuffer(key) || key.byteLength !== 32) throw new Error('A space key is 32 bytes')
  return key
}

/**
 * @param {number} a
 * @param {number} b
 */
function uints (a, b) {
  /** @type {c.State} */
  const state = { start: 0, end: 0, buffer: null }
  c.uint.preencode(state, a)
  c.uint.preencode(state, b)
  state.buffer = b4a.allocUnsafe(state.end)
  c.uint.encode(state, a)
  c.uint.encode(state, b)
  return state.buffer
}

/**
 * @param {FieldDecl[]} fieldList
 * @returns {FieldCodec}
 */
function codec (fieldList) {
  /** @type {Map<string, { n: number, kind: FieldKind, enc: import('./encodings.js').Codec<any> }>} */
  const byName = new Map()
  /** @type {Map<number, { name: string, kind: FieldKind, enc: import('./encodings.js').Codec<any> }>} */
  const byNumber = new Map()
  fieldList.forEach(({ name, kind }, /** @type {number} */ i) => {
    const enc = KINDS[kind]
    if (!enc) throw new Error(`Unknown field kind: ${kind}`)
    byName.set(name, { n: i + 1, kind, enc })
    byNumber.set(i + 1, { name, kind, enc })
  })

  /**
   * @param {Uint8Array} buffer
   */
  function unknownOf (buffer) {
    const out = []
    const state = { start: 0, end: buffer.byteLength, buffer }
    while (state.start < state.end) {
      const from = state.start
      const n = c.uint.decode(state)
      const len = c.uint.decode(state)
      if (state.start + len > state.end) throw new Error('Field runs past the end of the record')
      state.start += len
      if (!byNumber.has(n)) out.push(buffer.subarray(from, state.start))
    }
    return out
  }

  return {
    // links: the record's link list; link fields append their target to it.
    // `keep` ({ fields, links }: the version an edit replaces): the fields
    // this codec doesn't know (a newer app version's) are kept byte for byte,
    // and with them the links of that version, in place (one of them may be
    // a link into that list).
    /**
     * @param {Record<string, unknown>} values
     * @param {Uint8Array[]} links
     * @param {EncodedFields | null} [keep]
     */
    encode (values, links, keep = null) {
      const parts = []
      let total = 0
      const unknown = keep ? unknownOf(keep.fields) : []
      if (unknown.length) links.push(.../** @type {EncodedFields} */ (keep).links)
      for (const [name, { n, kind, enc }] of byName) {
        const v = values[name]
        if (v === undefined || v === null) continue
        let value = v
        if (kind === 'link') {
          const id = typeof v === 'string' ? idFromString(v) : c.encode(recordId, /** @type {import('./encodings.js').RecordId} */ (v))
          let at = links.findIndex((/** @type {Uint8Array} */ l) => b4a.equals(l, id))
          if (at === -1) { at = links.length; links.push(id) }
          value = at
        }
        const bytes = c.encode(enc, value)
        const head = uints(n, bytes.byteLength)
        parts.push(head, bytes)
        total += head.byteLength + bytes.byteLength
      }
      for (const raw of unknown) {
        parts.push(raw)
        total += raw.byteLength
      }
      return b4a.concat(parts, total)
    },

    /**
     * @param {Uint8Array} buffer
     * @param {Uint8Array[]} links
     */
    decode (buffer, links) {
      /** @type {DecodedFields} */
      const out = {}
      for (const name of byName.keys()) out[name] = null
      const state = { start: 0, end: buffer.byteLength, buffer }
      while (state.start < state.end) {
        const n = c.uint.decode(state)
        const len = c.uint.decode(state)
        if (state.start + len > state.end) throw new Error('Field runs past the end of the record')
        const field = byNumber.get(n)
        if (field) {
          const value = c.decode(field.enc, buffer.subarray(state.start, state.start + len))
          if (field.kind === 'link') {
            if (!links[value]) throw new Error('Link field points past the record\'s links')
            out[field.name] = idToString(links[value])
          } else {
            out[field.name] = value
          }
        }
        state.start += len
      }
      return out
    }
  }
}

module.exports = { codec, KINDS: Object.keys(KINDS) }
