const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { invite: inviteEnc, redemption: redemptionEnc } = require('./encodings')
const { sha256 } = require('./crypto')

// Invite links for v2 communities (spec 008, research R6). A link is a
// signed invite: community, optional staff role, optional private channels,
// expiry, use limit, maker. Never any key. A newcomer redeems it with a
// signed request; a control log writer records the redemption (the role and
// use counts are decided there, the same on every peer) and a key holder
// grants the channels.

const PREFIX = 'hg2:'
const NO_SIG = b4a.alloc(64)

const inviteSignable = (inv) => sha256('hg-v2-invite\0', inviteEnc.encode({ ...inv, sig: NO_SIG }))
const redemptionSignable = (r) => sha256('hg-v2-redeem\0', redemptionEnc.encode({ ...r, sig: NO_SIG }))

/** A signed invite (the maker is the key pair's public key). */
function makeInvite ({ community, role = null, channels = [], expires = 0, uses = 0 }, keyPair) {
  const inv = { id: hcrypto.randomBytes(16), community: b4a.from(community), role: role || null, channels: [...channels], expires: expires || 0, uses: uses || 0, maker: keyPair.publicKey, sig: NO_SIG }
  inv.sig = hcrypto.sign(inviteSignable(inv), keyPair.secretKey)
  return inv
}

function verifyInvite (inv) {
  try {
    return hcrypto.verify(inviteSignable(inv), inv.sig, inv.maker)
  } catch {
    return false
  }
}

function encodeLink (inv) {
  return PREFIX + b4a.toString(inviteEnc.encode(inv), 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The invite in a link; throws on anything else. */
function decodeLink (link) {
  if (typeof link !== 'string' || !link.startsWith(PREFIX)) throw new Error('Not a v2 invite link')
  const b64 = link.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
  return inviteEnc.decode(b4a.from(b64, 'base64'))
}

function makeRedemption (inv, identity, encryptionKey, writer) {
  const r = { invite: inv, identity: identity.publicKey, encryptionKey, writer: writer || null, t: Date.now(), sig: NO_SIG }
  r.sig = hcrypto.sign(redemptionSignable(r), identity.secretKey)
  return r
}

function verifyRedemption (r) {
  try {
    return hcrypto.verify(redemptionSignable(r), r.sig, r.identity) && verifyInvite(r.invite)
  } catch {
    return false
  }
}

module.exports = { makeInvite, verifyInvite, encodeLink, decodeLink, makeRedemption, verifyRedemption, inviteEnc, redemptionEnc }
