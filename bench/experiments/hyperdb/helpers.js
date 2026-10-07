// Index key functions for the experiment's definition (see build.js).

// "target|<time padded>": what points at a record, newest last.
exports.linkKeys = (record) => (record.links || []).map(target => `${target}|${String(record.t).padStart(15, '0')}`)

// Keys computed by our code from what the app declared; already sortable.
exports.ixKeys = (record) => record.ix || []
