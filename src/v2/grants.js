const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { grantKey, grantValue } = require('./encodings')
const { sha256 } = require('./crypto')

// Grants of a private channel as one keeper keeps them (spec 008, research
// R1): a single-writer Hyperbee next to the keeper's roster, named in the
// roster's header. Two key spaces:
//   0x00 + [recipient encryption key, epoch] -> { identity, sealed, granter, sig }
//   0x01 + recipient identity                -> recipient encryption key
// A member reads only the range of its own encryption key (never anyone
// else's grants). The identity index lets the keeper refuse grants to
// revoked members and vouch for key holders who grant (memberGrants).

const ENTRIES = b4a.from([0])
const WHO = b4a.from([1])
const entryKey = (recipient, epoch, commit) => b4a.concat([ENTRIES, grantKey.encode([recipient, epoch, commit])])
const whoKey = (identity) => b4a.concat([WHO, identity])

/** What a granter signs: binds the sealed key to community, channel, recipient, epoch and commitment. */
function grantSignable (communityKey, channel, g) {
  return sha256('hg-v2-grant\0', communityKey, channel + '\0', g.recipient, g.identity, `${g.epoch}\0`, g.commit, g.sealed)
}

function signGrant (communityKey, channel, g, keyPair) {
  return hcrypto.sign(grantSignable(communityKey, channel, g), keyPair.secretKey)
}

function verifyGrant (communityKey, channel, g) {
  try {
    return hcrypto.verify(grantSignable(communityKey, channel, g), g.sig, g.granter)
  } catch {
    return false
  }
}

/** Write a grant (and its identity index) unless that recipient's epoch is there. */
async function putGrant (bee, g) {
  const key = entryKey(g.recipient, g.epoch, g.commit)
  if (await bee.get(key)) return false
  const batch = bee.batch()
  await batch.put(key, grantValue.encode(g))
  await batch.put(whoKey(g.identity), g.recipient)
  await batch.flush()
  return true
}

async function hasGrant (bee, recipient, epoch, commit, opts) {
  return !!(await bee.get(entryKey(recipient, epoch, commit), opts))
}

/**
 * `recipient`'s grants for these epochs, one lookup each. A range read over
 * the same keys fetched ~30 blocks of an 80-block bee (Hyperbee keeps keys in
 * their own blocks and a range loads every key it passes); a lookup is a
 * binary search.
 */
async function grantsForEpochs (bee, recipient, epochs, opts) {
  const found = await Promise.all(epochs.map(async ({ epoch, commit }) => {
    const node = await bee.get(entryKey(recipient, epoch, commit), opts)
    return node ? { recipient, epoch, ...grantValue.decode(node.value) } : null
  }))
  return found.filter(Boolean)
}

/** All grants sealed to `recipient`: [{ recipient, epoch, identity, sealed, granter, sig }]. */
async function grantsFor (bee, recipient) {
  const out = []
  const range = grantKey.range(recipient)
  const stream = bee.createReadStream({ gte: b4a.concat([ENTRIES, range.gte]), lt: b4a.concat([ENTRIES, range.lt]) })
  for await (const { key, value } of stream) {
    const [r, epoch] = grantKey.decode(key.subarray(1))
    out.push({ recipient: r, epoch, ...grantValue.decode(value) })
  }
  return out
}

/** Every recipient: [{ identity, recipient }] (an admin's view, O(members)). */
async function allRecipients (bee) {
  const out = []
  for await (const { key, value } of bee.createReadStream({ gte: WHO, lt: b4a.from([2]) })) {
    out.push({ identity: key.subarray(1), recipient: value })
  }
  return out
}

async function recipientOf (bee, identity, opts) {
  const node = await bee.get(whoKey(identity), opts)
  return node ? node.value : null
}

module.exports = { grantSignable, signGrant, verifyGrant, putGrant, hasGrant, grantsFor, grantsForEpochs, allRecipients, recipientOf }
