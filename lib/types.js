// The app's record types, declared at runtime (research R6): fields with kinds
// (numbered by declaration order), links with allowed target types, "one per
// member", who may edit, and app-declared indexes. No build step.

const b4a = require('b4a')
const z32 = require('z32')
const fieldsCodec = require('./fields.js')
const { idFromString, idToString } = require('./encodings.js')
const { HypergraphError } = require('./errors.js')

const KINDS = new Set(fieldsCodec.KINDS)

class Types {
  constructor (declarations = {}) {
    this.types = new Map()
    for (const [name, decl] of Object.entries(declarations)) this.types.set(name, declare(name, decl, declarations))
  }

  has (name) { return this.types.has(name) }

  get (name) {
    const type = this.types.get(name)
    if (!type) throw new HypergraphError('INVALID_TYPE', `Unknown type "${name}": declare it in Hypergraph.open(dir, { types })`)
    return type
  }

  names () { return [...this.types.keys()] }

  // Checks values against the type; returns them normalized (records → ids,
  // spaces → keys). Throws INVALID_RECORD naming the type and the field.
  validate (name, values) {
    const type = this.get(name)
    if (!values || typeof values !== 'object') throw new HypergraphError('INVALID_RECORD', `A ${name} is an object of fields`)
    const out = {}
    for (const [field, value] of Object.entries(values)) {
      const decl = type.byName.get(field)
      if (!decl) throw new HypergraphError('INVALID_RECORD', `${name} has no field "${field}"`)
      if (value === undefined || value === null) continue
      out[field] = checkValue(name, field, decl.kind, value)
    }
    return out
  }

  encode (name, values) {
    const links = []
    const fields = this.get(name).codec.encode(values, links)
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
      out[name] = { fields: t.fields.map(f => [f.name, f.kind]), links: t.links, onePerMember: t.onePerMember, editable: t.editable }
    }
    return out
  }

  // Throws INCOMPATIBLE_TYPES unless this declaration only appends fields to
  // `stored`'s types or adds types.
  checkCompatible (stored) {
    if (!stored) return
    for (const [name, old] of Object.entries(stored)) {
      const now = this.types.get(name)
      if (!now) throw incompatible(`type "${name}" was removed; types can only be added`)
      old.fields.forEach(([field, kind], i) => {
        const f = now.fields[i]
        if (!f || f.name !== field) throw incompatible(`${name}: field "${field}" moved or was removed; fields can only be added at the end`)
        if (f.kind !== kind) throw incompatible(`${name}: field "${field}" changed from ${kind} to ${f.kind}`)
      })
      if (JSON.stringify(old.links) !== JSON.stringify(now.links)) throw incompatible(`${name}: links changed`)
      if (old.onePerMember !== now.onePerMember) throw incompatible(`${name}: onePerMember changed`)
      if (JSON.stringify(old.editable) !== JSON.stringify(now.editable)) throw incompatible(`${name}: editable changed`)
    }
  }
}

function declare (name, decl, all) {
  const bad = (msg) => new HypergraphError('INVALID_TYPE', `Type "${name}": ${msg}`)
  if (name.startsWith('hg/')) throw bad('names starting with "hg/" are hypergraph\'s own')
  if (!decl || typeof decl !== 'object' || !decl.fields || typeof decl.fields !== 'object') throw bad('declare its fields: { fields: { name: kind } }')

  const fields = Object.entries(decl.fields).map(([field, kind]) => {
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

module.exports = { Types }
