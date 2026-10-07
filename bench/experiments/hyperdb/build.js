// Experiment 2 (design brief): HyperDB as the local index for a graph of
// records. This is hypergraph's own, one-time definition (built by us, not by
// app developers): one collection of records, and indexes that cover any app
// type without the app running a build step:
//   - by type and time (latest posts)
//   - by author and time
//   - by link target (what points at X), via a map over the record's links
//   - by app-declared index keys, via a map over keys our code computes when
//     the record is written (e.g. "post|forum=abc|<time>")
//
//   node bench/experiments/hyperdb/build.js

const path = require('path')
const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const SCHEMA_DIR = path.join(__dirname, 'spec', 'hyperschema')
const DB_DIR = path.join(__dirname, 'spec', 'hyperdb')

const schema = Hyperschema.from(SCHEMA_DIR)
const hg = schema.namespace('hg')
hg.register({
  name: 'record',
  compact: true,
  fields: [
    { name: 'id', type: 'string', required: true }, // author:seq, stable
    { name: 'type', type: 'string', required: true },
    { name: 'author', type: 'string', required: true },
    { name: 't', type: 'uint', required: true },
    { name: 'links', type: 'string', array: true }, // ids this record points at
    { name: 'ix', type: 'string', array: true }, // app-declared index keys, computed at write time
    { name: 'body', type: 'buffer' } // the app's fields, encoded
  ]
})
Hyperschema.toDisk(schema)

const db = HyperDB.from(SCHEMA_DIR, DB_DIR)
const hgdb = db.namespace('hg')
hgdb.require(path.join(__dirname, 'helpers.js'))
hgdb.collections.register({ name: 'records', schema: '@hg/record', key: ['id'] })
hgdb.indexes.register({ name: 'by-type', collection: '@hg/records', key: ['type', 't'] })
hgdb.indexes.register({ name: 'by-author', collection: '@hg/records', key: ['author', 't'] })
hgdb.indexes.register({ name: 'by-link', collection: '@hg/records', key: { type: 'string', map: 'linkKeys' } })
hgdb.indexes.register({ name: 'by-ix', collection: '@hg/records', key: { type: 'string', map: 'ixKeys' } })
HyperDB.toDisk(db)
console.log('built', DB_DIR)
