// The app's record types, declared at runtime (research R6): fields with kinds
// (numbered by declaration order), links with allowed target types, "one per
// member", who may edit, and app-declared indexes. No build step.

const b4a = require('b4a')
const z32 = require('z32')
const fieldsCodec = require('./fields.js')
const { idFromString, idToString } = require('./encodings.js')
const { HypergraphError } = require('./errors.js')

const KINDS = new Set(fieldsCodec.KINDS)
// What a record carries next to its fields (lib/index/query.js shape()).
const RESERVED = new Set(['id', 'type', 'author', 'device', 'stamp', 'edited', 'futureStamp'])

// Hypergraph's own types (research.md A7): apps can't write them. The
// personal space's (PERSONAL) count there only; removals only in an identity
// log, signed by the identity key (lib/space.js).
const BUILTIN = {
  'hg/device': { fields: { key: 'bytes', name: 'string' } }, // a device of the identity, written by itself
  'hg/space': { fields: { space: 'space', name: 'string', root: 'space' } }, // a space the identity created or joined (root: a sub-space's top space, story 8)
  'hg/setting': { fields: { name: 'string', value: 'text' }, index: [['name', 'stamp']] }, // JSON value, latest wins
  'hg/heads': { fields: { heads: 'bytes' } }, // a device's log lengths per space
  'hg/device-remove': { fields: { removed: 'bytes', cut: 'bytes', proof: 'bytes' } }, // a device, cut, signed by the identity
  // The graph (story 5, research.md A9): never edited or deleted; `off`
  // undoes an earlier one, the latest wins per (from, to, rel) and (on, tag).
  'hg/relation': { fields: { from: 'link', to: 'link', rel: 'string', value: 'float', data: 'text', off: 'bool' } },
  'hg/tag': { fields: { on: 'link', tag: 'string', off: 'bool' } },
  // A private space's epoch key sealed to one device (story 8, lib/private/grants.js)
  'hg/grant': { fields: { to: 'string', epoch: 'uint', commit: 'bytes', sealed: 'bytes' }, index: [['to']] },
  // An older epoch key sealed with a newer one (A16): whoever holds `from` opens `to`, back to epoch 0
  'hg/key-link': { fields: { from: 'bytes', to: 'bytes', epoch: 'uint', sealed: 'bytes' } }
}
const GRAPH = new Set(['hg/relation', 'hg/tag'])
const PERSONAL = new Set(['hg/device', 'hg/space', 'hg/setting', 'hg/heads'])

class Types {
  constructor (declarations = {}) {
    this.types = new Map()
    for (const [name, decl] of Object.entries(declarations)) this.types.set(name, declare(name, decl, declarations))
    for (const [name, decl] of Object.entries(BUILTIN)) this.types.set(name, declare(name, decl, BUILTIN, true))
  }

  has (name) { return this.types.has(name) }

  get (name) {
    const type = this.types.get(name)
    if (!type) throw new HypergraphError('INVALID_TYPE', `Unknown type "${name}": declare it in Hypergraph.open(dir, { types })`)
    return type
  }

  names () { return [...this.types.keys()] }

  // Checks values against the type; returns them normalized (records → ids,
  // spaces → keys). Throws INVALID_RECORD naming the type and the field. A
  // field passed as undefined is absent, known or not (helpers shared by an
  // older and a newer app version); an unknown field with a value (null
  // included) is a typo.
  validate (name, values) {
    const type = this.get(name)
    if (!values || typeof values !== 'object') throw new HypergraphError('INVALID_RECORD', `A ${name} is an object of fields`)
    const out = {}
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined) continue
      const decl = type.byName.get(field)
      if (!decl) throw new HypergraphError('INVALID_RECORD', `${name} has no field "${field}"`)
      if (value === null) continue
      out[field] = checkValue(name, field, decl.kind, value)
    }
    return out
  }

  // `keep` ({ fields, links }): the version an edit replaces, whose fields
  // this app version doesn't know are kept (lib/fields.js).
  encode (name, values, keep = null) {
    const links = []
    const fields = this.get(name).codec.encode(values, links, keep)
    return { fields, links }
  }

  decode (name, fields, links) {
    return this.get(name).codec.decode(fields, links)
  }

  // May field `field` of type `name` point at a record of type `targetType`?
  linkAllowed (name, field, targetType) {
    const allowed = this.get(name).links[field]
    return !allowed || allowed.includes(targetType)
  }

  // A JSON form to store, to compare with the next app version's.
  describe () {
    const out = {}
    for (const [name, t] of this.types) {
      if (BUILTIN[name]) continue
      out[name] = { fields: t.fields.map(f => [f.name, f.kind]), links: t.links, onePerMember: t.onePerMember, editable: t.editable, index: t.index }
    }
    return out
  }

  // Throws INCOMPATIBLE_TYPES unless this declaration only appends fields to
  // `stored`'s types (link fields with their allowed targets), adds types or
  // adds indexes.
  checkCompatible (stored) {
    if (!stored) return
    for (const [name, old] of Object.entries(stored)) {
      const now = this.types.get(name)
      if (!now) throw incompatible(`type "${name}" was removed; types can only be added`)
      old.fields.forEach(([field, kind], i) => {
        const f = now.fields[i]
        if (!f || f.name !== field) throw incompatible(`${name}: field "${field}" moved or was removed; fields can only be added at the end`)
        if (f.kind !== kind) throw incompatible(`${name}: field "${field}" changed from ${kind} to ${f.kind}`)
        if (kind === 'link' && JSON.stringify((old.links || {})[field] || null) !== JSON.stringify(now.links[field] || null)) {
          throw incompatible(`${name}: the types field "${field}" may link to changed`)
        }
      })
      if (old.onePerMember !== now.onePerMember) throw incompatible(`${name}: onePerMember changed`)
      // One per member groups by the first link field: one appended to a
      // type that had none would group records differently.
      if (now.onePerMember && now.target && !old.fields.some(([, kind]) => kind === 'link')) {
        throw incompatible(`${name}: field "${now.target}" would be its first link, which changes what one per member counts by`)
      }
      if (JSON.stringify(old.editable) !== JSON.stringify(now.editable)) throw incompatible(`${name}: editable changed`)
    }
  }

  // The types whose records the local index may hold with what it derives
  // from their declaration out of date: types it didn't know (no one per
  // member, indexes or checks) and types that gained an index (story 7,
  // research.md A11). Link targets derive nothing: they are judged when read
  // (research.md A12).
  stale (stored) {
    if (!stored) return []
    const out = []
    for (const [name, now] of this.types) {
      if (BUILTIN[name]) continue
      const old = stored[name]
      if (!old) {
        out.push(name)
        continue
      }
      if (old.index !== undefined && JSON.stringify(old.index) !== JSON.stringify(now.index)) out.push(name)
    }
    return out
  }
}

function declare (name, decl, all, builtin = false) {
  const bad = (msg) => new HypergraphError('INVALID_TYPE', `Type "${name}": ${msg}`)
  if (name.startsWith('hg/') && !builtin) throw bad('names starting with "hg/" are hypergraph\'s own')
  if (!decl || typeof decl !== 'object' || !decl.fields || typeof decl.fields !== 'object') throw bad('declare its fields: { fields: { name: kind } }')

  const fields = Object.entries(decl.fields).map(([field, kind]) => {
    if (RESERVED.has(field)) throw bad(`field "${field}": that name is taken by the record itself (${[...RESERVED].join(', ')})`)
    if (!KINDS.has(kind)) throw bad(`field "${field}" has unknown kind "${kind}" (kinds: ${[...KINDS].join(', ')})`)
    return { name: field, kind }
  })
  const byName = new Map(fields.map(f => [f.name, f]))

  const links = {}
  for (const [field, targets] of Object.entries(decl.links || {})) {
    const f = byName.get(field)
    if (!f || f.kind !== 'link') throw bad(`links.${field}: "${field}" is not a link field`)
    if (!Array.isArray(targets)) throw bad(`links.${field}: a list of type names`)
    for (const target of targets) if (!all[target]) throw bad(`links.${field}: unknown type "${target}"`)
    links[field] = [...targets]
  }

  let editable
  const e = decl.editable === undefined ? 'author' : decl.editable
  if (e === 'author') editable = { by: 'author' }
  else if (e === 'members') editable = { by: 'members' }
  else if (e && typeof e === 'object' && typeof e.permission === 'string' && e.permission) editable = { by: 'permission', permission: e.permission }
  else throw bad('editable is "author", "members" or { permission: name }')

  const index = []
  for (const keys of decl.index || []) {
    if (!Array.isArray(keys) || !keys.length) throw bad('index is a list of field lists, e.g. [[\'forum\', \'stamp\']]')
    for (const k of keys) if (k !== 'stamp' && !byName.has(k)) throw bad(`index: unknown field "${k}"`)
    index.push(keys.filter(k => k !== 'stamp'))
  }

  const firstLink = fields.find(f => f.kind === 'link')
  return {
    name,
    fields,
    byName,
    links,
    onePerMember: !!decl.onePerMember,
    target: decl.onePerMember && firstLink ? firstLink.name : null,
    editable,
    index,
    codec: fieldsCodec.codec(fields)
  }
}

function checkValue (type, field, kind, value) {
  const bad = (what) => new HypergraphError('INVALID_RECORD', `${type}.${field} must be ${what}`)
  switch (kind) {
    case 'string':
    case 'text':
      if (typeof value !== 'string') throw bad('a string')
      return value
    case 'int':
      if (!Number.isSafeInteger(value)) throw bad('an integer')
      return value
    case 'uint':
      if (!Number.isSafeInteger(value) || value < 0) throw bad('a positive integer or 0')
      return value
    case 'float':
      if (typeof value !== 'number') throw bad('a number')
      return value
    case 'bool':
      if (typeof value !== 'boolean') throw bad('true or false')
      return value
    case 'bytes':
      if (!b4a.isBuffer(value)) throw bad('bytes')
      return value
    case 'ref':
      if (!value || typeof value !== 'object' || !Array.isArray(value.src) || !value.src.every(s => typeof s === 'string')) throw bad('a reference { src: [addresses], size, type, digest }')
      if (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size < 0)) throw bad('a reference with a positive size')
      return { src: value.src, size: value.size || 0, type: value.type || '', digest: value.digest || '', mutable: !!value.mutable }
    case 'link': {
      const id = typeof value === 'string' ? value : (value && typeof value.id === 'string' ? value.id : null)
      if (!id) throw bad('a record or its id')
      try { return idToString(idFromString(id)) } catch { throw bad('a record or its id') }
    }
    case 'space': {
      const key = typeof value === 'string' ? value : (value && value.key) || null
      let bytes = null
      try { bytes = typeof key === 'string' ? z32.decode(key) : key } catch {}
      if (!b4a.isBuffer(bytes) || bytes.byteLength !== 32) throw bad('a space or its key')
      return z32.encode(bytes)
    }
  }
  throw bad(`a known kind (not ${kind})`)
}

function incompatible (msg) {
  return new HypergraphError('INCOMPATIBLE_TYPES', `${msg}. Between app versions, only adding fields at the end of a type and adding types is allowed.`)
}

module.exports = { Types, BUILTIN, PERSONAL, GRAPH }
