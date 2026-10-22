// Who may change a record (FR-003, story 5, research.md A9): the author
// always; any member for 'members'; for { permission }, an editor's records
// below the cut recorded when they lost it count, those past it don't, and a
// log without a cut counts while they hold it. Deletes only by the author.
// Relations and tags are said by who may edit what they start from.

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const gate = require('../../../lib/gate.js')
const enc = require('../../../lib/encodings.js')
const { Types } = require('../../../lib/types.js')
const { State } = require('../../../lib/decisions/state.js')

const hex = (b) => b4a.toString(b, 'hex')
const types = new Types({
  post: { fields: { title: 'string' } },
  page: { fields: { title: 'string' }, editable: { permission: 'edit-pages' } },
  wiki: { fields: { title: 'string' }, editable: 'members' }
})

const author = crypto.randomBytes(32)
const editor = crypto.randomBytes(32)
const member = crypto.randomBytes(32)
const log = crypto.randomBytes(32)
const at = (seq, l = log) => enc.idBytes({ log: l, seq })

// editor has the role 'editor' (post, edit-pages) unless `demoted`, with a cut
// of `log` at 5 when demoted.
function state ({ demoted = false } = {}) {
  const entries = [
    ['meta', { name: 'W', owner: hex(author) }],
    [`member:${hex(author)}`, { role: 'owner' }],
    [`member:${hex(editor)}`, { role: demoted ? 'member' : 'editor' }],
    [`member:${hex(member)}`, { role: 'member' }],
    ['role:editor', { permissions: ['post', 'edit-pages'] }]
  ]
  if (demoted) entries.push([`editcut:${hex(editor)}`, { perms: { 'edit-pages': { [hex(log)]: 5 } } }])
  return State.from(entries)
}

const row = (type) => ({ type, author })
const edit = (type, who, id = null) => ({ kind: enc.EDIT, type, author: who, id })
const del = (type, who, id = null) => ({ kind: enc.DELETE, type, author: who, id })

test('the author edits and deletes; others only as the type allows', (t) => {
  const st = state()
  t.ok(gate.mayChange(types, edit('post', author), row('post'), st))
  t.ok(gate.mayChange(types, del('post', author), row('post'), st))
  t.absent(gate.mayChange(types, edit('post', editor), row('post'), st), 'author-only type')
  t.ok(gate.mayChange(types, edit('wiki', member, at(3)), row('wiki'), st), "'members': any member edits")
  t.ok(gate.mayChange(types, edit('page', editor, at(3)), row('page'), st), 'an editor edits')
  t.absent(gate.mayChange(types, edit('page', member, at(3)), row('page'), st), 'a member without the permission does not')
  t.absent(gate.mayChange(types, edit('page', author), row('post'), st), 'a change of another type never counts')
})

test('deletes of shared records: only the author (moderators take down by decision)', (t) => {
  const st = state()
  t.absent(gate.mayChange(types, del('page', editor, at(3)), row('page'), st), 'an editor cannot delete')
  t.absent(gate.mayChange(types, del('wiki', member, at(3)), row('wiki'), st), 'nor any member')
  t.ok(gate.mayChange(types, del('page', author), row('page'), st), 'the author can')
})

test('losing the permission is a cut: below it counts, past it not, for everyone', (t) => {
  const st = state({ demoted: true })
  t.is(st.editLimit(editor, 'edit-pages', log), 5)
  t.ok(gate.mayChange(types, edit('page', editor, at(4)), row('page'), st), 'an edit below the cut stays')
  t.absent(gate.mayChange(types, edit('page', editor, at(5)), row('page'), st), 'an edit at the cut does not count')
  t.absent(gate.mayChange(types, edit('page', editor, at(2, crypto.randomBytes(32))), row('page'), st), 'a log the cut does not name counts for nothing')
  t.absent(gate.mayChange(types, edit('page', editor), row('page'), st), 'the app refuses a new edit')
  t.is(state().editLimit(editor, 'edit-pages', log), Infinity, 'no cut, holding it: everything')
  t.is(state().editLimit(member, 'edit-pages', log), 0, 'no cut, not holding it: nothing')
})

test('relations and tags: said by who may edit what they start from', (t) => {
  const st = state({ demoted: true })
  t.ok(gate.mayEdit(types, { author, id: null }, row('post'), st))
  t.absent(gate.mayEdit(types, { author: editor, id: at(1) }, row('post'), st), 'not from someone else\'s post')
  t.ok(gate.mayEdit(types, { author: editor, id: at(4) }, row('page'), st), 'an editor of a page, below the cut')
  t.absent(gate.mayEdit(types, { author: editor, id: at(6) }, row('page'), st), 'past it')
})

test('relations and tags: only as puts, with valid fields', (t) => {
  const link = enc.idToString(at(1))
  const ok = (type, values, kind = enc.PUT) => gate.builtinValid({ kind, type }, values)
  t.ok(ok('hg/relation', { from: link, to: link, rel: 'cites', value: 1, data: 'x'.repeat(4096) }))
  t.ok(ok('hg/relation', { from: link, to: link, rel: 'cites', value: null, data: null }))
  t.absent(ok('hg/relation', { from: link, to: link, rel: 'cites', data: 'é'.repeat(2049) }), 'data over 4 KB')
  t.absent(ok('hg/relation', { from: link, to: link, rel: 'cites', value: Infinity }), 'value not finite')
  t.absent(ok('hg/relation', { from: link, to: link, rel: '' }), 'no type')
  t.absent(ok('hg/relation', { from: null, to: link, rel: 'cites' }), 'no from')
  t.absent(ok('hg/relation', { from: link, to: link, rel: 'cites' }, enc.EDIT), 'never edited')
  t.ok(ok('hg/tag', { on: link, tag: 'rust', off: false }))
  t.absent(ok('hg/tag', { on: link, tag: '' }), 'no tag')
  t.absent(ok('hg/tag', { on: link, tag: 'rust' }, enc.DELETE), 'never deleted')
  t.ok(ok('post', { title: 'x' }), 'app types are not concerned')
})
