// Builds the local index's HyperDB definition (research R12, data-model.md)
// into lib/index/spec/. Run by hypergraph's developers when the definition
// changes, never by apps; the output is committed.
//
//   node lib/index/build.js
//
// Only append: HyperDB versions the definition, and indexes already on users'
// disks must keep decoding. Every key starts with the space, so one instance
// holds many spaces and dropping a space is a range delete.

const path = require('path')
const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const SCHEMA_DIR = path.join(__dirname, 'spec', 'hyperschema')
const DB_DIR = path.join(__dirname, 'spec', 'hyperdb')

const schema = Hyperschema.from(SCHEMA_DIR)
const hg = schema.namespace('hg')

// A record as indexed: its current version (latest allowed edit) and flags.
hg.register({
  name: 'record',
  compact: true,
  fields: [
    { name: 'space', type: 'fixed32', required: true },
    { name: 'id', type: 'buffer', required: true }, // log key + seq
    { name: 'type', type: 'string', required: true },
    { name: 'author', type: 'fixed32', required: true }, // the identity
    { name: 'device', type: 'fixed32', required: true },
    { name: 'log', type: 'fixed32', required: true },
    { name: 'seq', type: 'uint', required: true },
    { name: 'stamp', type: 'uint', required: true }, // when it was put: the order of lists
    { name: 'vstamp', type: 'uint', required: true }, // the current version's stamp (latest wins)
    { name: 'vdevice', type: 'fixed32', required: true }, // and its device (ties)
    { name: 'fields', type: 'buffer' }, // the current version's tagged fields
    { name: 'links', type: 'buffer', array: true },
    { name: 'ix', type: 'string', array: true },
    { name: 'flags', type: 'uint' }, // see FLAGS in lib/index/indexer.js
    { name: 'opm', type: 'bool' }, // a one-per-member type
    { name: 'target', type: 'buffer' } // one-per-member target (empty: the space)
  ]
})

// A device log in a space: accepted (indexed so far) or refused.
hg.register({
  name: 'log',
  compact: true,
  fields: [
    { name: 'space', type: 'fixed32', required: true },
    { name: 'log', type: 'fixed32', required: true },
    { name: 'identity', type: 'fixed32' },
    { name: 'device', type: 'fixed32' },
    { name: 'indexed', type: 'uint' },
    { name: 'cut', type: 'uint' },
    { name: 'refused', type: 'bool' }
  ]
})

// An edit or delete, kept by its target: it can arrive before the target,
// and the target's current version is the latest allowed one.
hg.register({
  name: 'change',
  compact: true,
  fields: [
    { name: 'space', type: 'fixed32', required: true },
    { name: 'target', type: 'buffer', required: true },
    { name: 'id', type: 'buffer', required: true },
    { name: 'kind', type: 'uint', required: true },
    { name: 'type', type: 'string', required: true },
    { name: 'author', type: 'fixed32', required: true },
    { name: 'device', type: 'fixed32', required: true },
    { name: 'stamp', type: 'uint', required: true },
    { name: 'fields', type: 'buffer' },
    { name: 'links', type: 'buffer', array: true }
  ]
})

// The spaces this instance holds.
hg.register({
  name: 'space',
  compact: true,
  fields: [
    { name: 'key', type: 'fixed32', required: true },
    { name: 'ns', type: 'string', required: true }, // its Corestore namespace on this device
    { name: 'name', type: 'string' },
    { name: 'parent', type: 'fixed32' },
    { name: 'joined', type: 'uint' }
  ]
})

// Instance-wide settings: identity, declared types, budgets, schema version.
hg.register({
  name: 'meta',
  compact: true,
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'value', type: 'buffer' }
  ]
})

Hyperschema.toDisk(schema)

const db = HyperDB.from(SCHEMA_DIR, DB_DIR)
const hgdb = db.namespace('hg')
hgdb.require(path.join(__dirname, 'helpers.js'))

hgdb.collections.register({ name: 'records', schema: '@hg/record', key: ['space', 'id'] })
hgdb.collections.register({ name: 'logs', schema: '@hg/log', key: ['space', 'log'] })
hgdb.collections.register({ name: 'changes', schema: '@hg/change', key: ['space', 'target', 'id'] })
hgdb.collections.register({ name: 'spaces', schema: '@hg/space', key: ['key'] })
hgdb.collections.register({ name: 'meta', schema: '@hg/meta', key: ['name'] })

hgdb.indexes.register({ name: 'by-type', collection: '@hg/records', key: ['space', 'type', 'stamp'] })
hgdb.indexes.register({ name: 'by-author', collection: '@hg/records', key: ['space', 'author', 'stamp'] })
hgdb.indexes.register({
  name: 'by-link',
  collection: '@hg/records',
  key: { type: { fields: [{ name: 'space', type: 'fixed32' }, { name: 'target', type: 'buffer' }, { name: 'type', type: 'string' }, { name: 'stamp', type: 'uint' }] }, map: 'linkKeys' }
})
hgdb.indexes.register({
  name: 'by-ix',
  collection: '@hg/records',
  key: { type: { fields: [{ name: 'space', type: 'fixed32' }, { name: 'type', type: 'string' }, { name: 'ix', type: 'string' }, { name: 'stamp', type: 'uint' }] }, map: 'ixKeys' }
})
hgdb.indexes.register({
  name: 'one-per-member',
  collection: '@hg/records',
  key: { type: { fields: [{ name: 'space', type: 'fixed32' }, { name: 'type', type: 'string' }, { name: 'target', type: 'buffer' }, { name: 'author', type: 'fixed32' }] }, map: 'onePerMember' }
})

HyperDB.toDisk(db)
console.log('built', DB_DIR)
