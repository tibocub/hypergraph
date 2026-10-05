// Entity ids inside compact index keys (spec 002, layout 2).

const test = require('brittle')
const b4a = require('b4a')
const IndexEncoder = require('index-encoder')
const { parseEntityId, formatEntityId, toKeyParts, fromKeyParts } = require('../../../src/index-layout/entity-id')

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)

test('entity-id: canonical ids parse into (type, author, seq) and format back', (t) => {
  for (const id of [`post/${A}/0`, `post/${A}/42`, `a/b:c/${A}/9007199254740991`, `/${A}/1`]) {
    const p = parseEntityId(id)
    t.ok(p, `parses ${id.slice(0, 12)}…`)
    t.is(p.author.length, 32, 'author is 32 bytes')
    t.is(formatEntityId(p), id, 'formats back to the same string')
  }
  const p = parseEntityId(`a/b:c/${A}/7`)
  t.is(p.type, 'a/b:c', 'types may contain / and :')
  t.is(p.seq, 7)
})

test('entity-id: strings that almost parse stay raw and round-trip exactly', (t) => {
  const almost = [
    `post/${A.toUpperCase()}/1`, // uppercase hex
    `post/${A}/01`, // leading zero
    `post/${A.slice(1)}/1`, // 63 chars
    `post/${A}/-1`,
    `post/${A}/1.5`,
    `post/${A}/9007199254740992`, // beyond a safe integer
    `${A}/1`, // no type separator before the author
    'post/does-not-exist',
    '',
    'just text'
  ]
  for (const id of almost) {
    t.is(parseEntityId(id), null, `not canonical: ${JSON.stringify(id.slice(0, 20))}`)
    const parts = toKeyParts(id)
    t.is(parts[1].length, 0, 'raw ids carry an empty author')
    t.is(fromKeyParts(parts), id, 'and decode to the exact original string')
  }
})

test('entity-id: key tuples sort like the ids, with seq compared as a number', (t) => {
  const enc = new IndexEncoder([IndexEncoder.STRING, IndexEncoder.BUFFER, IndexEncoder.UINT], { prefix: 1 })
  const ids = [`post/${A}/10`, `post/${A}/9`, `post/${B}/0`, `file/${B}/3`, `filex/${A}/0`]
  const sorted = ids.map(id => ({ id, key: enc.encode(toKeyParts(id)) })).sort((x, y) => b4a.compare(x.key, y.key)).map(x => x.id)
  t.alike(sorted, [`file/${B}/3`, `filex/${A}/0`, `post/${A}/9`, `post/${A}/10`, `post/${B}/0`])
  for (const id of ids) t.is(fromKeyParts(enc.decode(enc.encode(toKeyParts(id)))), id, 'decodes')
})
