const b4a = require('b4a')

// An entity id inside a compact index key (spec 002, layout 2) is three key
// members: (type, author, seq). A canonical id `<type>/<64 lowercase hex>/<seq>`
// becomes (type, the 32 author bytes, seq): 32 bytes for the author instead
// of 64 hex characters, and seq sorted as a number. Any other string (a
// relation may point at anything) becomes (string, <empty>, 0); a parsed id
// always has a 32-byte author, so the two forms never collide.

const HEX64 = /^[0-9a-f]{64}$/
const SEQ = /^(0|[1-9][0-9]*)$/
const EMPTY = b4a.alloc(0)

/**
 * @param {string} id
 * @returns {{ type: string, author: Buffer, seq: number } | null} null when
 *   `id` is not in canonical form.
 */
function parseEntityId (id) {
  if (typeof id !== 'string') return null
  const last = id.lastIndexOf('/')
  if (last < 0) return null
  const prev = id.lastIndexOf('/', last - 1)
  if (prev < 0) return null

  const hex = id.slice(prev + 1, last)
  const seqText = id.slice(last + 1)
  if (!HEX64.test(hex) || !SEQ.test(seqText)) return null
  const seq = Number(seqText)
  if (!Number.isSafeInteger(seq)) return null

  return { type: id.slice(0, prev), author: b4a.from(hex, 'hex'), seq }
}

function formatEntityId ({ type, author, seq }) {
  return `${type}/${b4a.toString(author, 'hex')}/${seq}`
}

/** @returns {[string, Buffer, number]} */
function toKeyParts (id) {
  const p = parseEntityId(id)
  return p ? [p.type, p.author, p.seq] : [String(id), EMPTY, 0]
}

function fromKeyParts ([typeOrRaw, author, seq]) {
  return author && author.length ? formatEntityId({ type: typeOrRaw, author, seq }) : typeOrRaw
}

module.exports = { parseEntityId, formatEntityId, toKeyParts, fromKeyParts }
