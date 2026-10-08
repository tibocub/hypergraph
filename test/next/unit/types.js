// Type declarations (research R6): fields with kinds, links with allowed
// targets, one per member, who may edit, app-declared indexes; validation
// errors name the type and the field; between app versions only appending
// fields and adding types is allowed.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const z32 = require('z32')
const { Types } = require('../../../lib/types.js')
const { idToString } = require('../../../lib/encodings.js')

const forum = {
  post: { fields: { title: 'string', text: 'text', forum: 'string' }, index: [['forum', 'stamp']] },
  comment: { fields: { text: 'text', on: 'link' }, links: { on: ['post', 'comment'] } },
  vote: { fields: { value: 'int', on: 'link' }, links: { on: ['post', 'comment'] }, onePerMember: true },
  page: { fields: { title: 'string', body: 'text' }, editable: { permission: 'edit-pages' } },
  file: { fields: { name: 'string', size: 'uint', content: 'ref', folder: 'link', shared: 'bool', ratio: 'float', raw: 'bytes', home: 'space' } }
}
const id = idToString({ log: crypto.randomBytes(32), seq: 1 })

const code = (t, fn, wanted, ...parts) => {
  try { fn(); t.fail(`expected ${wanted}`) } catch (err) {
    t.is(err.code, wanted, err.message)
    for (const p of parts) t.ok(err.message.includes(p), `message names ${p}`)
  }
}

test('declares every field kind', (t) => {
  const types = new Types(forum)
  t.alike(types.get('file').fields.map(f => f.kind), ['string', 'uint', 'ref', 'link', 'bool', 'float', 'bytes', 'space'])
  t.alike(types.get('post').fields.map(f => f.name), ['title', 'text', 'forum'])
  t.ok(types.has('post'))
  t.absent(types.has('nope'))
})

test('bad declarations name the type and the field', (t) => {
  code(t, () => new Types({ post: { fields: { title: 'strin' } } }), 'INVALID_TYPE', 'post', 'title')
  code(t, () => new Types({ c: { fields: { text: 'text' }, links: { on: ['c'] } } }), 'INVALID_TYPE', 'c', 'on')
  code(t, () => new Types({ c: { fields: { on: 'link' }, links: { on: ['nope'] } } }), 'INVALID_TYPE', 'c', 'nope')
  code(t, () => new Types({ p: { fields: { a: 'string' }, editable: 'everyone' } }), 'INVALID_TYPE', 'p')
  code(t, () => new Types({ p: { fields: { a: 'string' }, index: [['b', 'stamp']] } }), 'INVALID_TYPE', 'p', 'b')
  code(t, () => new Types({ 'hg/x': { fields: {} } }), 'INVALID_TYPE', 'hg/x')
})

test('validation errors name the type and the field', (t) => {
  const types = new Types(forum)
  code(t, () => types.validate('post', { title: 3 }), 'INVALID_RECORD', 'post', 'title')
  code(t, () => types.validate('post', { colour: 'red' }), 'INVALID_RECORD', 'post', 'colour')
  code(t, () => types.validate('vote', { value: 1.5, on: id }), 'INVALID_RECORD', 'vote', 'value')
  code(t, () => types.validate('file', { size: -1 }), 'INVALID_RECORD', 'file', 'size')
  code(t, () => types.validate('comment', { on: 'not an id' }), 'INVALID_RECORD', 'comment', 'on')
  code(t, () => types.validate('nope', {}), 'INVALID_TYPE', 'nope')
})

test('validation normalizes links and spaces', (t) => {
  const types = new Types(forum)
  t.alike(types.validate('comment', { text: 'hi', on: { id, type: 'post' } }), { text: 'hi', on: id }, 'a record object becomes its id')
  const key = z32.encode(crypto.randomBytes(32))
  t.is(types.validate('file', { home: { key } }).home, key, 'a space becomes its key')
})

test('records round trip through their type, links in the record\'s links', (t) => {
  const types = new Types(forum)
  const { fields, links } = types.encode('comment', { text: 'hi', on: id })
  t.is(links.length, 1)
  t.alike(types.decode('comment', fields, links), { text: 'hi', on: id })
})

test('link targets are checked against the declared types', (t) => {
  const types = new Types(forum)
  t.ok(types.linkAllowed('comment', 'on', 'post'))
  t.ok(types.linkAllowed('comment', 'on', 'comment'))
  t.absent(types.linkAllowed('comment', 'on', 'vote'))
  t.ok(types.linkAllowed('file', 'folder', 'anything'), 'no list: any type')
})

test('onePerMember and editable forms', (t) => {
  const types = new Types({ ...forum, wiki: { fields: { a: 'string' }, editable: 'members' } })
  t.ok(types.get('vote').onePerMember)
  t.absent(types.get('post').onePerMember)
  t.alike(types.get('post').editable, { by: 'author' })
  t.alike(types.get('page').editable, { by: 'permission', permission: 'edit-pages' })
  t.alike(types.get('wiki').editable, { by: 'members' })
  t.is(types.get('vote').target, 'on', 'one per member per the first link field')
})

test('compatibility: appending fields and adding types is allowed', (t) => {
  const before = new Types(forum).describe()
  const after = new Types({ ...forum, post: { ...forum.post, fields: { ...forum.post.fields, tags: 'string' } }, poll: { fields: { q: 'string' } } })
  t.execution(() => after.checkCompatible(before))
  t.execution(() => new Types(forum).checkCompatible(null), 'nothing stored yet')
})

test('compatibility: anything else throws INCOMPATIBLE_TYPES naming type and field', (t) => {
  const before = new Types(forum).describe()
  const reordered = new Types({ ...forum, post: { ...forum.post, fields: { text: 'text', title: 'string', forum: 'string' } } })
  code(t, () => reordered.checkCompatible(before), 'INCOMPATIBLE_TYPES', 'post', 'title')
  const kind = new Types({ ...forum, vote: { ...forum.vote, fields: { value: 'string', on: 'link' } } })
  code(t, () => kind.checkCompatible(before), 'INCOMPATIBLE_TYPES', 'vote', 'value')
  const removedField = new Types({ ...forum, post: { fields: { title: 'string', text: 'text' } } })
  code(t, () => removedField.checkCompatible(before), 'INCOMPATIBLE_TYPES', 'post', 'forum')
  const { page, ...withoutPage } = forum
  code(t, () => new Types(withoutPage).checkCompatible(before), 'INCOMPATIBLE_TYPES', 'page')
  const editable = new Types({ ...forum, post: { ...forum.post, editable: 'members' } })
  code(t, () => editable.checkCompatible(before), 'INCOMPATIBLE_TYPES', 'post', 'editable')
})
