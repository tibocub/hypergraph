const Hyperbee = require('hyperbee')
const IndexEncoder = require('index-encoder')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const { rosterValue, authorEntry, announcement, grantSubmission, rosterSignable } = require('./encodings')

// A channel's roster as one keeper keeps it (spec 007, research R3): which
// authors posted in which segment, and where their messages start. A plain
// single-writer Hyperbee: one small entry per (segment, author), no open
// log per author on the keeper. Authors announce over a Hypercore extension
// on the roster's own core, which every reader replicates anyway.

const ENTRY = new IndexEncoder([IndexEncoder.UINT, IndexEncoder.BUFFER])
const EXTENSION = 'hg-v2-announce'
const GRANT_EXTENSION = 'hg-v2-grant' // grants of a private channel, to its keepers (spec 008)
const BIN = { keyEncoding: 'binary', valueEncoding: 'binary' }

class Roster {
  /**
   * @param {Object} core - the roster's Hypercore (writable for its keeper)
   * @param {Object} opts
   * @param {(ann: Object) => Promise<boolean>} [opts.onAnnouncement] - keeper only
   * @param {boolean} [opts.extension] - false: read only (a second session on
   *   the same core must not register the announcement extension again)
   * @param {Object} [opts.authors] - keeper only: the core of its author index
   *   (author -> latest entry), named in the roster's header. Readers never
   *   download it; a mod reads it to find every log a banned author has.
   * @param {Object} [opts.grants] - keeper of a private channel only: the core
   *   of its grants bee (spec 008), named in the header as well
   * @param {(g: Object) => Promise<boolean>} [opts.onGrant] - keeper only
   */
  constructor (core, { onAnnouncement = null, extension = true, authors = null, grants = null, onGrant = null } = {}) {
    this.core = core
    const metadata = authors || grants ? { contentFeed: authors ? authors.key : null, userData: grants ? grants.key : null } : null
    this.bee = new Hyperbee(core, { ...BIN, extension: false, metadata })
    this.authors = authors ? new Hyperbee(authors, { ...BIN, extension: false }) : null
    this.grants = grants ? new Hyperbee(grants, { ...BIN, extension: false }) : null
    this.onAnnouncement = onAnnouncement
    this.onGrant = onGrant
    this.ext = extension
      ? core.registerExtension(EXTENSION, {
        encoding: announcement.enc,
        onmessage: (msg) => { if (this.onAnnouncement) this.onAnnouncement(msg).catch(safetyCatch) }
      })
      : null
    this.grantExt = extension
      ? core.registerExtension(GRANT_EXTENSION, {
        encoding: grantSubmission.enc,
        onmessage: (msg) => { if (this.onGrant) this.onGrant(msg).catch(safetyCatch) }
      })
      : null
  }

  get key () { return this.core.key }
  get writable () { return this.core.writable }

  async ready () {
    await this.core.ready()
    await this.bee.ready()
    if (this.authors) await this.authors.ready()
    if (this.grants) await this.grants.ready()
    // The header names the author index and the grants bee: written now, not
    // with the first entry (Hyperbee's default), or a private channel nobody
    // has posted in yet has grants no member can find.
    if (this.core.writable && this.core.length === 0 && (this.authors || this.grants)) {
      const batch = this.bee.batch()
      await batch.getRoot(true)
      await batch.close()
    }
  }

  async close () {
    if (this.ext) this.ext.destroy()
    if (this.grantExt) this.grantExt.destroy()
    await this.bee.close()
    if (this.authors) await this.authors.close()
    if (this.grants) await this.grants.close()
  }

  announce (ann) {
    if (this.ext) this.ext.broadcast(ann)
  }

  submitGrant (g) {
    if (this.grantExt) this.grantExt.broadcast(g)
  }

  /** The grants bee's key, from the roster's header (null if none). */
  async grantsKey (opts) {
    const header = await this.bee.getHeader(opts)
    return (header && header.metadata && header.metadata.userData && header.metadata.userData.length === 32) ? header.metadata.userData : null
  }

  async has (segment, author) {
    return !!(await this.bee.get(ENTRY.encode([segment, author])))
  }

  async put (segment, author, value) {
    await this.bee.put(ENTRY.encode([segment, author]), rosterValue.encode(value))
    if (this.authors) {
      const known = await this.authors.get(author)
      if (!known || authorEntry.decode(known.value).segment <= segment) {
        await this.authors.put(author, authorEntry.encode({ segment, ...value }))
      }
    }
  }

  /** The author index's key, from the roster's header (null if it has none). */
  async authorsKey (opts) {
    const header = await this.bee.getHeader(opts)
    return (header && header.metadata && header.metadata.contentFeed && header.metadata.contentFeed.length === 32) ? header.metadata.contentFeed : null
  }

  /** Raw entries of one segment: [{ author, log, start, sig }] (unverified). */
  async segment (segment) {
    const out = []
    const range = ENTRY.encodeRange({ gte: [segment], lte: [segment] })
    for await (const { key, value } of this.bee.createReadStream(range)) {
      const [, author] = ENTRY.decode(key)
      out.push({ author, ...rosterValue.decode(value) })
    }
    return out
  }

  /** The highest segment ≤ `max` that has any entry, or -1. */
  async latestSegment (max) {
    const range = ENTRY.encodeRange({ lt: [max + 1] })
    for await (const { key } of this.bee.createReadStream({ ...range, reverse: true, limit: 1 })) {
      return ENTRY.decode(key)[0]
    }
    return -1
  }
}

/** Whether a roster entry is genuinely the author's. */
function verifyEntry (communityKey, channelId, segment, entry) {
  try {
    return hcrypto.verify(rosterSignable(communityKey, channelId, segment, entry.log, entry.start), entry.sig, entry.author)
  } catch {
    return false
  }
}

function signEntry (communityKey, channelId, segment, log, start, keyPair) {
  return hcrypto.sign(rosterSignable(communityKey, channelId, segment, log, start), keyPair.secretKey)
}

/** An author's latest entry in an author index bee, or null (unverified). */
async function lastEntry (authorsBee, author, opts) {
  const node = await authorsBee.get(author, opts)
  return node ? authorEntry.decode(node.value) : null
}

module.exports = { Roster, verifyEntry, signEntry, lastEntry, EXTENSION, ENTRY, BIN, b4a }
