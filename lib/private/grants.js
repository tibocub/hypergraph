// Private spaces: grants as records (story 8, research.md A13), adapted from
// src/v2/grants.js. A grant is a `hg/grant { to, epoch, commit, sealed }`
// record in its granter's own log of the private space: an epoch key sealed
// to one device's box key (lib/private/crypto.js). Spec 008 kept them in a
// keeper's tree; keepers no longer exist, and a record in the granter's log is
// already signed (its log header proves who wrote it). Recipients find theirs
// through the local index (the type declares an index on `to`, the recipient
// device: the "grants-for" lookup, data-model.md). A grant counts for whoever
// opens it if the key it holds matches a commitment the decision log
// recorded (a made-up key opens to nothing useful). Grants are
// keyed by recipient, epoch and commitment (spec 008's lesson: two admins
// rotating at once both grant epoch n + 1 with different keys).

const b4a = require('b4a')
const z32 = require('z32')
const crypto = require('./crypto.js')

const TYPE = 'hg/grant'

// The index key a device's grants are found by (lib/index/indexer.js ixKeys
// for the type's `index: [['to']]`).
const grantIx = (devicePublicKey) => 'to\0' + z32.encode(devicePublicKey)

// A grant of `key` (epoch `epoch`, commitment `commit`) to a device: the
// record's values, or null if the device key isn't one.
function makeGrant (key, epoch, commit, devicePublicKey) {
  const box = crypto.boxPublicKey(devicePublicKey)
  if (!box) return null
  return { to: z32.encode(devicePublicKey), epoch, commit, sealed: crypto.seal(key, box) }
}

// The key a grant holds for this device (`boxKeyPair`), if the decision log
// recorded its commitment (`keys`: { current, commits: epoch -> hex, others:
// hex -> epoch }, a rotation that lost a race included): { commit (hex), key }
// or null.
function openGrant (values, boxKeyPair, keys) {
  if (!values || !b4a.isBuffer(values.sealed) || !b4a.isBuffer(values.commit) || !Number.isSafeInteger(values.epoch)) return null
  const commit = b4a.toString(values.commit, 'hex')
  if (!known(keys, values.epoch, commit)) return null
  const key = crypto.openSealed(values.sealed, boxKeyPair)
  if (!key || b4a.toString(crypto.commitOf(key), 'hex') !== commit) return null
  return { commit, key }
}

function known (keys, epoch, commit) {
  return !!keys && (keys.commits[epoch] === commit || (keys.others || {})[commit] === epoch)
}

// Is a grant one of the current key?
function current (values, keys) {
  return !!values && !!keys && b4a.isBuffer(values.commit) && values.epoch === keys.current && keys.commits[keys.current] === b4a.toString(values.commit, 'hex')
}

module.exports = { TYPE, grantIx, makeGrant, openGrant, current, known }
