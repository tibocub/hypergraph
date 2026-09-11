/**
 * test/brittle/core/content-ref-format.js
 *
 * Unit tests for src/content-ref.js — the pure format module for external
 * content references. No graph, no I/O, no crypto.
 *
 * The load-bearing property under test is the throwing/non-throwing split:
 *
 *   formatReference() THROWS      — runs on local writes, where a developer's
 *                                   own mistake should surface immediately.
 *   parseReference()  NEVER THROWS — runs on data that may have come from a
 *                                   hostile peer, where throwing would hand
 *                                   that peer a denial of service.
 *
 * Run: npx brittle test/brittle/core/content-ref-format.js
 */

const test = require('brittle')
const {
  CONTENT_LINK_TYPE,
  formatReference,
  parseReference,
  isReferenceType
} = require('../../../src/content-ref.js')

const VALID = {
  src: ['swarmfs://9f2ca1b3'],
  size: 2147483648,
  type: 'video/mp4',
  mutable: false
}

// ── The marker ───────────────────────────────────────────────────────────────

test('content-ref: the marker is the plain string "link"', t => {
  t.is(CONTENT_LINK_TYPE, 'link', 'marker is "link", not a long media type')
  t.ok(isReferenceType('link'), 'recognizes its own marker')
  t.absent(isReferenceType('text'), 'does not claim inline text')
  t.absent(isReferenceType('video/mp4'), 'does not claim a real media type')
  t.absent(isReferenceType(undefined), 'tolerates undefined')
  t.absent(isReferenceType(null), 'tolerates null')
})

// ── formatReference / parseReference round-trip ──────────────────────────────

test('content-ref: round-trips a single address', t => {
  const parsed = parseReference(formatReference(VALID))

  t.ok(parsed.valid, 'parses as valid')
  t.is(parsed.error, null, 'no error')
  t.is(parsed.src.length, 1, 'one address')
  t.is(parsed.src[0].address, 'swarmfs://9f2ca1b3', 'address preserved')
  t.is(parsed.src[0].scheme, 'swarmfs', 'scheme extracted')
  t.is(parsed.size, 2147483648, 'size preserved')
  t.is(parsed.type, 'video/mp4', 'type preserved')
  t.is(parsed.mutable, false, 'mutable preserved')
  t.is(parsed.digest, null, 'no digest')
})

test('content-ref: round-trips multiple addresses in order', t => {
  const parsed = parseReference(formatReference({
    ...VALID,
    src: ['swarmfs://9f2ca1b3', 'https://gateway.example/9f2ca1b3']
  }))

  t.ok(parsed.valid)
  t.is(parsed.src.length, 2, 'both addresses kept')
  t.is(parsed.src[0].scheme, 'swarmfs', 'preference order preserved')
  t.is(parsed.src[1].scheme, 'https', 'fallback second')
})

test('content-ref: accepts a bare string for src and normalizes it', t => {
  const parsed = parseReference(formatReference({ ...VALID, src: 'swarmfs://abc' }))

  t.ok(parsed.valid)
  t.is(parsed.src.length, 1, 'normalized to a one-element array')
  t.is(parsed.src[0].address, 'swarmfs://abc')
})

test('content-ref: round-trips a digest', t => {
  const parsed = parseReference(formatReference({ ...VALID, digest: 'blake3:9f2ca1b3' }))

  t.ok(parsed.valid)
  t.is(parsed.digest, 'blake3:9f2ca1b3', 'digest preserved')
})

test('content-ref: round-trips mutable in both states', t => {
  t.is(parseReference(formatReference({ ...VALID, mutable: true })).mutable, true)
  t.is(parseReference(formatReference({ ...VALID, mutable: false })).mutable, false)
})

test('content-ref: size 0 is valid', t => {
  const parsed = parseReference(formatReference({ ...VALID, size: 0 }))
  t.ok(parsed.valid, 'an empty file is a legitimate reference')
  t.is(parsed.size, 0)
})

// ── formatReference rejects bad input ────────────────────────────────────────

test('content-ref: formatReference throws on malformed input', t => {
  const bad = [
    ['src empty array', { ...VALID, src: [] }],
    ['src missing', { size: 1, type: 'text/plain', mutable: false }],
    ['src not an array or string', { ...VALID, src: 42 }],
    ['src entry not a URI', { ...VALID, src: ['not a uri at all'] }],
    ['src entry has no scheme', { ...VALID, src: ['//no-scheme/path'] }],
    ['src entry empty string', { ...VALID, src: [''] }],
    ['size negative', { ...VALID, size: -1 }],
    ['size not an integer', { ...VALID, size: 1.5 }],
    ['size not a number', { ...VALID, size: '100' }],
    ['size missing', { src: VALID.src, type: 'video/mp4', mutable: false }],
    ['type missing', { src: VALID.src, size: 1, mutable: false }],
    ['type empty', { ...VALID, type: '' }],
    ['type not a string', { ...VALID, type: 42 }],
    ['mutable missing', { src: VALID.src, size: 1, type: 'video/mp4' }],
    ['mutable not a boolean', { ...VALID, mutable: 'yes' }],
    ['digest malformed', { ...VALID, digest: 'nonsense' }],
    ['digest missing hex', { ...VALID, digest: 'blake3:' }],
    ['digest not a string', { ...VALID, digest: 42 }],
    ['reference not an object', 'a string'],
    ['reference null', null]
  ]

  for (const [label, input] of bad) {
    t.exception(() => formatReference(input), `throws: ${label}`)
  }
})

// ── parseReference never throws ──────────────────────────────────────────────

test('content-ref: parseReference never throws, however hostile the input', t => {
  const hostile = [
    ['invalid JSON', '{not json'],
    ['empty string', ''],
    ['whitespace', '   '],
    ['JSON null', 'null'],
    ['JSON array', '[1,2,3]'],
    ['JSON number', '42'],
    ['JSON string', '"hello"'],
    ['JSON true', 'true'],
    ['empty object', '{}'],
    ['unknown version', JSON.stringify({ v: 999, src: ['a://b'], size: 1, type: 't', mutable: false })],
    ['missing v', JSON.stringify({ src: ['a://b'], size: 1, type: 't', mutable: false })],
    ['src missing', JSON.stringify({ v: 1, size: 1, type: 't', mutable: false })],
    ['src empty', JSON.stringify({ v: 1, src: [], size: 1, type: 't', mutable: false })],
    ['src not array', JSON.stringify({ v: 1, src: 5, size: 1, type: 't', mutable: false })],
    ['src entry not a URI', JSON.stringify({ v: 1, src: ['nope'], size: 1, type: 't', mutable: false })],
    ['size wrong type', JSON.stringify({ v: 1, src: ['a://b'], size: 'big', type: 't', mutable: false })],
    ['type wrong', JSON.stringify({ v: 1, src: ['a://b'], size: 1, type: 5, mutable: false })],
    ['mutable wrong', JSON.stringify({ v: 1, src: ['a://b'], size: 1, type: 't', mutable: 'no' })],
    ['digest malformed', JSON.stringify({ v: 1, src: ['a://b'], size: 1, type: 't', mutable: false, digest: 'x' })],
    ['deeply nested', JSON.stringify({ v: 1, src: [{ a: { b: { c: {} } } }], size: 1, type: 't', mutable: false })],
    ['null body', null],
    ['undefined body', undefined],
    ['number body', 42],
    ['object body', {}]
  ]

  for (const [label, input] of hostile) {
    let result
    t.execution(() => { result = parseReference(input) }, `does not throw: ${label}`)
    t.absent(result && result.valid, `reports invalid: ${label}`)
    t.ok(result && typeof result.error === 'string', `explains why: ${label}`)
  }
})

test('content-ref: an invalid parse still reports a usable shape', t => {
  const parsed = parseReference('{not json')

  t.is(parsed.valid, false, 'valid is false, not undefined')
  t.ok(typeof parsed.error === 'string' && parsed.error.length > 0, 'error explains the failure')
  t.ok(Array.isArray(parsed.src), 'src is still an array, so callers can iterate safely')
  t.is(parsed.src.length, 0, 'and it is empty')
})

// ── Addresses hypergraph must accept without understanding ───────────────────

test('content-ref: accepts every registered scheme, and unknown ones too', t => {
  const addresses = [
    'swarmfs://9f2ca1b3',
    'hyperblobs://abc123/42',
    'hyperdrive://abc123/path/to/file.txt',
    'hyper://abc123',
    'https://example.com/file.zip',
    'http://example.com/file.zip',
    'hypergraph://video/a3f9c2/7',
    'somefuturebackend://whatever'
  ]

  for (const address of addresses) {
    const parsed = parseReference(formatReference({ ...VALID, src: [address] }))
    t.ok(parsed.valid, `accepts ${address}`)
    t.is(parsed.src[0].address, address, `preserves ${address} byte-for-byte`)
    t.ok(parsed.src[0].scheme.length > 0, `extracts a scheme from ${address}`)
  }
})

test('content-ref: hypergraph never interprets a scheme, only records it', t => {
  // A scheme invented right here must work exactly as well as a known one.
  // This is what lets new backends arrive with no hypergraph change.
  const parsed = parseReference(formatReference({
    ...VALID,
    src: ['zzz-invented-backend://xyz']
  }))

  t.ok(parsed.valid, 'an unknown scheme is well-formed, not an error')
  t.is(parsed.src[0].scheme, 'zzz-invented-backend', 'scheme reported so a consumer can say what it lacked')
})
