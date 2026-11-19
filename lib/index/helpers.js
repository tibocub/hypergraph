// Map functions for the local index's definition (lib/index/build.js). They
// run inside HyperDB on every insert: keep them pure and cheap.

/**
 * @typedef {import('./indexer.js').RecordRow} RecordRow
 */

/** @param {RecordRow} record */
exports.linkKeys = (record) => (record.links || []).map((target) => ({ space: record.space, target, type: record.type, stamp: record.stamp }))

// App-declared keys ("forum\0news"), computed by the indexer from the type's
// `index` declaration when the record is written.
/** @param {RecordRow} record */
exports.ixKeys = (record) => (record.ix || []).map((ix) => ({ space: record.space, type: record.type, ix, stamp: record.stamp }))

/** @param {RecordRow} record */
exports.onePerMember = (record) => record.opm ? [{ space: record.space, type: record.type, target: record.target, author: record.author }] : []
