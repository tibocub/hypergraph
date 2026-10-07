const ReadyResource = require('ready-resource')
const nodeCrypto = require('crypto')
const ProtomuxWakeup = require('protomux-wakeup')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const { Control, sign, mayAssign, RANK } = require('./control')
const { Roster, verifyEntry, signEntry, lastEntry, BIN } = require('./roster')
const Hyperbee = require('hyperbee')
const { AuthorLog } = require('./author-log')
const { segmentOf, isFuture, FUTURE_MS } = require('./segments')
const { Replicator } = require('./replication')
const { boxKeyPair, newEpochKey, commitOf, messageAD, encryptMessage, decryptMessage, seal, openSealed } = require('./crypto')
const { signGrant, verifyGrant, putGrant, putGrants, hasGrant, grantsForEpochs, allRecipients, recipientOf } = require('./grants')
const { isSealed, sealedContent, redemption: redemptionCodec, invite: inviteCodec } = require('./encodings')
const { makeInvite, encodeLink, decodeLink, makeRedemption, verifyRedemption } = require('./invites')

// Scaling v2 prototype (spec 007): a community where cost follows what a
// peer holds and reads. Unstable; not part of the v1 API. See
// docs/v2-prototype.md and specs/007-scaling-v2-prototype/.

const ROSTER_WAIT_MS = 2000
const TRACE = !!process.env.HG_V2_TRACE // timings on stderr (benchmarks)
const trace = (...a) => { if (TRACE) process.stderr.write(`[v2 ${process.pid}] ${Date.now()} ${a.join(' ')}\n`) }
// > 0 when message a comes after b in the order every peer agrees on:
// time, then author key, then seq.
const newer = (a, b) => (a.t - b.t) || (a.author > b.author ? 1 : a.author < b.author ? -1 : 0) || (a.seq - b.seq)
const toHex = (k) => (b4a.isBuffer(k) ? b4a.toString(k, 'hex') : String(k))

function rosterKeyPair (identity, communityKey, channel, domain = 'hg-v2-roster') {
  const seed = identity.seed || nodeCrypto.createHash('sha256').update(identity.keyPair.secretKey).digest()
  return hcrypto.keyPair(nodeCrypto.createHash('sha256').update(domain + '\0').update(seed).update(communityKey).update(b4a.from(channel)).digest())
}

// Whichever first: the promise, or `ms`; the timer is cleared either way.
async function within (promise, ms) {
  let timer = null
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms) })])
  } finally {
    clearTimeout(timer)
  }
}

class Community extends ReadyResource {
  #store
  #identity
  #key
  #wakeup
  #control = null
  #ns = null
  #logs = new Map() // log key hex -> AuthorLog (others' logs, opened by key)
  #logChannels = new Map() // log key hex -> Set of channel ids reading it
  #ownLogs = new Map() // channel id -> this member's AuthorLog
  #rosters = new Map() // channel id -> Map(keeper pubkey hex -> Roster)
  #kept = new Set() // channels this member keeps
  #listing = new Map() // `${channel}:${segment}` -> Set of authors listed or being listed (keeper)
  #announced = new Set() // `${channel}:${segment}` this member is listed in
  #pending = new Map() // `${channel}:${segment}` -> announcement, until listed
  #retry = null
  #unreachable = 0 // logs a read gave up on (last page)
  #follows = new Map() // stop function of a live follow -> its channel
  #scans = 0 // roster scans by follows (idle-cost introspection)
  #boxKeys = null // this member's encryption key pair (spec 008)
  #keys = new Map() // private channel -> Map(epoch -> key) this member holds
  #keysLoadedAt = new Map() // private channel -> when this member last read its grants
  #grantBees = new Map() // grants core key hex -> Hyperbee (other keepers' grants)
  #grantPending = new Map() // `${channel}:${recipient}:${epoch}` -> submission, until a keeper lists it
  #grantRetry = null
  #accepting = new Set() // grants a keeper is writing (copies arriving together)
  #redeemCore = null // the control log's key core: redemptions travel on its extension
  #redeemExt = null
  #recording = new Set() // redemptions this writer is recording
  #completed = new Set() // redeemed channel grants already done (or not ours to do)
  #completing = null
  #completeAgain = false
  #mode = 'auto'
  #budget = 1e9
  #replicator = null

  /**
   * @param {Object} store - Corestore
   * @param {Object} opts
   * @param {{ keyPair: Object, seed?: Buffer }} opts.identity - the member
   * @param {Buffer|string} [opts.key] - an existing community; omit to create one
   */
  constructor (store, opts = {}) {
    super()
    if (!opts.identity || !opts.identity.keyPair) throw new Error('opts.identity.keyPair is required')
    this.#store = store
    this.#identity = opts.identity
    this.#key = opts.key ? b4a.from(toHex(opts.key), 'hex') : null
    if (opts.replicate !== undefined) {
      if (!['all', 'sparse', 'auto'].includes(opts.replicate)) throw new Error("opts.replicate must be 'all', 'sparse' or 'auto'")
      this.#mode = opts.replicate
    }
    if (opts.budget !== undefined) {
      if (!(Number.isFinite(opts.budget) && opts.budget >= 0)) throw new Error('opts.budget must be a number of bytes')
      this.#budget = opts.budget
    }
    this.#wakeup = new ProtomuxWakeup()
    this.ready().catch(() => {})
  }

  get key () { return this.#control ? this.#control.key : null }
  get localKey () { return this.#control ? this.#control.localKey : null }
  get identity () { return this.#identity }
  get control () { return this.#control }

  async _open () {
    // One namespace per community: two Autobases opened from the same
    // namespace get the same local writer key (bench/roster.js).
    const ns = this.#store.namespace('hg-v2:' + (this.#key ? toHex(this.#key) : toHex(hcrypto.randomBytes(16))))
    this.#ns = ns
    this.#control = new Control(ns, this.#key, { wakeup: this.#wakeup })
    await this.#control.ready()
    if (!this.#key) await this.#control.append(this.#sign({ type: 'init', name: '' }))
    // Rosters this member keeps, from an earlier session.
    const me = toHex(this.#identity.keyPair.publicKey)
    for (const [channel, keepers] of Object.entries(this.#control.state.keepers)) {
      if (keepers.some(k => k.keeper === me)) await this.#openOwnRoster(channel)
    }
    this.#replicator = new Replicator({
      mode: this.#mode,
      budget: this.#budget,
      store: this.#store,
      channels: () => Object.entries(this.#state.channels).map(([id, c]) => ({ id, segmentMs: c.segmentMs, createdAt: c.createdAt })),
      keepers: (channel) => this.keepers(channel),
      entriesFrom: (rosters, channel, segment) => this.#entriesFrom(rosters, channel, segment),
      latestFrom: (rosters, max) => this.#latestFrom(rosters, max)
    })
    this.#control.on('change', () => this.#replicator.schedule('control'))
    this.#replicator.schedule('open')
    // Redemption requests reach every peer of the control log's key core;
    // writers record them, key holders then grant (spec 008, R6).
    this.#redeemCore = ns.get({ key: this.key })
    await this.#redeemCore.ready()
    this.#redeemExt = this.#redeemCore.registerExtension('hg-v2-redeem', {
      encoding: redemptionCodec.enc,
      onmessage: (r) => this.#recordRedemption(r).catch(safetyCatch)
    })
    this.#control.on('change', () => this.#completeRedemptions().catch(safetyCatch))
  }

  async _close () {
    if (this.#redeemExt) this.#redeemExt.destroy()
    if (this.#redeemCore) await this.#redeemCore.close().catch(safetyCatch)
    if (this.#replicator) await this.#replicator.close()
    if (this.#retry) clearInterval(this.#retry)
    if (this.#grantRetry) clearInterval(this.#grantRetry)
    for (const gs of this.#grantBees.values()) {
      await gs.bee.close().catch(safetyCatch)
      if (gs.who) await gs.who.close().catch(safetyCatch)
    }
    for (const stop of [...this.#follows.keys()]) stop()
    for (const rosters of this.#rosters.values()) for (const r of rosters.values()) await r.close().catch(safetyCatch)
    for (const log of this.#logs.values()) await log.close().catch(safetyCatch)
    for (const log of this.#ownLogs.values()) await log.close().catch(safetyCatch)
    if (this.#control) await this.#control.close()
    this.#wakeup.destroy()
  }

  /** Wire a replication stream (the control log's writer discovery included). */
  replicate (isInitiatorOrStream, opts) {
    const stream = this.#store.replicate(isInitiatorOrStream, opts)
    this.#wakeup.addStream(stream)
    return stream
  }

  async update () {
    if (!this.opened) await this.ready()
    await this.#control.update()
  }

  // ── control state (synchronous: kept in memory, small) ───────────────────

  get #state () { return this.#control.state }
  role (pubkey) { const r = this.#state.roles[toHex(pubkey)]; return r ? r.role : null }
  roles () { return Object.fromEntries(Object.entries(this.#state.roles).map(([k, v]) => [k, v.role])) }
  channels () {
    return Object.entries(this.#state.channels).map(([id, c]) => ({ id, name: c.name, segmentMs: c.segmentMs, ...(c.private ? { private: true } : {}) }))
  }
  channel (id) { return this.#state.channels[id] || null }
  banned (pubkey) { return this.#state.bans[toHex(pubkey)] || null }
  /** A private channel's current epoch (null for a public channel). */
  epoch (channel) { const c = this.channel(channel); return c && c.private ? c.epoch : null }
  /** The commitment (hex) the control log records for an epoch of a private channel. */
  epochCommit (channel, epoch) { const e = (this.#state.epochs[channel] || {})[epoch]; return e ? e.commit : null }
  revoked (channel, member) { return (this.#state.revoked[channel] || {})[toHex(member)] || null }

  /** This member's encryption public key (hex): what grants are sealed to. */
  get encryptionKey () { return toHex(this.#box().publicKey) }

  #box () {
    if (!this.#boxKeys) this.#boxKeys = boxKeyPair(this.#identity)
    return this.#boxKeys
  }

  // An epoch key this member holds, if its commitment matches the control
  // log's (a key from a losing rotation doesn't count).
  #epochKey (channel, epoch) {
    const key = (this.#keys.get(channel) || new Map()).get(epoch)
    if (!key) return null
    const commit = this.epochCommit(channel, epoch)
    return commit && toHex(commitOf(key)) === commit ? key : null
  }

  #holdKey (channel, epoch, key) {
    let keys = this.#keys.get(channel)
    if (!keys) this.#keys.set(channel, (keys = new Map()))
    keys.set(epoch, key)
  }

  // Epochs of a channel this member holds a valid key for, oldest first.
  #heldEpochs (channel) {
    return [...(this.#keys.get(channel) || new Map()).keys()].filter(e => this.#epochKey(channel, e)).sort((a, b) => a - b)
  }

  /**
   * What this member can read of a private channel: the epochs it holds, and
   * whether it holds the current one (after looking for grants).
   * @returns {Promise<{ epochs: number[], current: boolean }>}
   */
  async access (channel) {
    if (!this.opened) await this.ready()
    const record = this.channel(channel)
    if (!record || !record.private) throw new Error('Not a private channel')
    await this.#loadKeys(channel, true)
    return { epochs: this.#heldEpochs(channel), current: !!this.#epochKey(channel, record.epoch) }
  }

  /**
   * Give a member access to a private channel: every epoch key this member
   * holds, sealed to the recipient's encryption key, sent to the channel's
   * keepers (retried until one lists it). Admins and up; key holders too if
   * the channel allows it.
   */
  async grant (channel, member) {
    return this.grantMany(channel, [member])
  }

  /**
   * grant() for many members at once: one batch on a keeper (bulk grants,
   * a rotation's re-grants).
   * @param {Array<{ identity, encryptionKey }>} members
   */
  async grantMany (channel, members) {
    if (!this.opened) await this.ready()
    const record = this.channel(channel)
    if (!record || !record.private) throw new Error('Not a private channel')
    const me = toHex(this.#identity.keyPair.publicKey)
    if (!this.#heldEpochs(channel).length) await this.#loadKeys(channel, true)
    const epochs = this.#heldEpochs(channel)
    const admin = (RANK[this.#myRole()] || 0) >= RANK.admin
    if (!admin && !(record.memberGrants && epochs.length && !this.revoked(channel, me))) throw new Error('Granting this channel is not allowed for this member')
    if (!epochs.length) throw new Error('This member holds no key for this channel')
    const list = []
    for (const { identity, encryptionKey } of members) {
      const recipient = b4a.from(toHex(encryptionKey), 'hex')
      const id = b4a.from(toHex(identity), 'hex')
      if (this.revoked(channel, id)) {
        if (!admin) throw new Error('This member is revoked from the channel')
        await this.#control.append(this.#sign({ type: 'unrevoke', channel, member: toHex(id) })) // granting again lifts it
      }
      for (const epoch of epochs) list.push(this.#makeGrant(channel, epoch, id, recipient))
    }
    await this.#submitGrants(channel, list)
  }

  #makeGrant (channel, epoch, identity, recipient) {
    const key = this.#keys.get(channel).get(epoch)
    const g = { channel, recipient, identity, epoch, commit: commitOf(key), sealed: seal(key, recipient), granter: this.#identity.keyPair.publicKey }
    g.sig = signGrant(this.key, channel, g, this.#identity.keyPair)
    return g
  }

  /**
   * A new epoch for a private channel, re-granted to every current member
   * (anyone with a grant, minus the revoked). Admins and up, holding the
   * current epoch. Of two concurrent rotations the control log keeps one; if
   * this one lost, it waits for the winner's key and rotates again.
   * @returns {Promise<{ epoch: number, granted: number }>}
   */
  async rotate (channel) {
    if (!this.opened) await this.ready()
    const record = this.channel(channel)
    if (!record || !record.private) throw new Error('Not a private channel')
    if (!((RANK[this.#myRole()] || 0) >= RANK.admin)) throw new Error('Rotating this channel is not allowed for this member')
    this.#requireWriter()
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.update()
      const current = this.channel(channel).epoch
      if (!(await this.#waitForKey(channel, current))) throw new Error('This member holds no key for the current epoch of this private channel')
      const key = newEpochKey()
      const commit = toHex(commitOf(key))
      this.#holdKey(channel, current + 1, key)
      await this.#control.append(this.#sign({ type: 'rotate', channel, epoch: current + 1, commit }))
      if (this.epochCommit(channel, current + 1) === commit) {
        return { epoch: current + 1, granted: await this.#regrant(channel, current + 1) }
      }
      // Another admin's rotation to that epoch came first: theirs is the one.
      this.#keys.get(channel).delete(current + 1)
    }
    throw new Error('Could not rotate: other rotations kept coming first')
  }

  /**
   * Take a member's access away: recorded, then a rotation, so nothing
   * posted afterwards is readable to them. What they already had stays theirs.
   */
  async revoke (channel, member) {
    if (!this.opened) await this.ready()
    const record = this.channel(channel)
    if (!record || !record.private) throw new Error('Not a private channel')
    if (!((RANK[this.#myRole()] || 0) >= RANK.admin)) throw new Error('Revoking is not allowed for this member')
    this.#requireWriter()
    await this.#control.append(this.#sign({ type: 'revoke', channel, member: toHex(member) }))
    let result = await this.rotate(channel)
    // A concurrent rotation by an admin who hadn't seen the revocation may
    // end up first once both are ordered: rotate again if ours didn't stay.
    for (let i = 0; i < 3; i++) {
      await this.update()
      if (this.epochCommit(channel, result.epoch) && this.#epochKey(channel, result.epoch) && this.channel(channel).epoch === result.epoch) break
      result = await this.rotate(channel)
    }
    return result
  }

  /** Identities (hex) holding a grant for the channel, minus the revoked (an admin's view). */
  async members (channel) {
    return [...(await this.#recipients(channel)).keys()]
  }

  // identity hex -> encryption key, from every keeper's grants bee.
  async #recipients (channel) {
    const out = new Map()
    for (const roster of (await this.#keeperRosters(channel)).values()) {
      const gs = await this.#grantsBee(roster)
      if (!gs || !(await this.#whoBee(gs))) continue
      if (!roster.grants) await within(gs.who.core.update({ wait: true }).catch(safetyCatch), 2000)
      let list = []
      try {
        list = await allRecipients(gs)
      } catch (err) {
        safetyCatch(err)
      }
      for (const { identity, recipient } of list) {
        const id = toHex(identity)
        if (!this.revoked(channel, id)) out.set(id, recipient)
      }
    }
    return out
  }

  async #regrant (channel, epoch) {
    const members = await this.#recipients(channel)
    members.set(toHex(this.#identity.keyPair.publicKey), this.#box().publicKey) // this admin too
    await this.#submitGrants(channel, [...members].map(([id, recipient]) => this.#makeGrant(channel, epoch, b4a.from(id, 'hex'), recipient)))
    return members.size
  }

  // Up to 10 s for this member's key to an epoch (a rotation's winner grants it).
  async #waitForKey (channel, epoch) {
    for (let i = 0; i < 20 && !this.#epochKey(channel, epoch); i++) {
      await this.#loadKeys(channel, true)
      if (!this.#epochKey(channel, epoch)) await new Promise(resolve => setTimeout(resolve, 500))
    }
    return !!this.#epochKey(channel, epoch)
  }

  // A grant to the keepers: written here if this member keeps the channel,
  // broadcast to the others; the timer re-sends it until a keeper lists it.
  async #submitGrants (channel, list) {
    if (this.#kept.has(channel)) await this.#acceptGrants(channel, list)
    const rosters = await this.#keeperRosters(channel)
    if (this.#kept.has(channel) && rosters.size === 1) return // listed here, no other keeper
    for (const g of list) {
      this.#grantPending.set(`${g.channel}:${toHex(g.recipient)}:${g.epoch}:${toHex(g.commit)}`, g)
      for (const roster of rosters.values()) if (!roster.writable) roster.submitGrant(g)
    }
    if (!this.#grantRetry) {
      this.#grantRetry = setInterval(() => this.#sendGrants().catch(safetyCatch), 500)
      if (this.#grantRetry.unref) this.#grantRetry.unref()
    }
  }

  async #sendGrants () {
    for (const [id, g] of [...this.#grantPending]) {
      const rosters = await this.#keeperRosters(g.channel)
      let listed = false
      for (const roster of rosters.values()) {
        const bee = await this.#grantsBee(roster)
        if (bee && await within(hasGrant(bee, g.recipient, g.epoch, g.commit, { timeout: 1000 }).catch(() => false), 1500)) { listed = true; break }
      }
      if (listed) this.#grantPending.delete(id)
      else for (const roster of rosters.values()) if (!roster.writable) roster.submitGrant(g)
    }
    if (this.#grantPending.size === 0 && this.#grantRetry) {
      clearInterval(this.#grantRetry)
      this.#grantRetry = null
    }
  }

  // Keeper: the grants that check out, in one batch.
  async #acceptGrants (channel, list) {
    const record = this.channel(channel)
    const roster = this.#rostersOf(channel).get(toHex(this.#identity.keyPair.publicKey))
    if (!record || !record.private || !roster || !roster.grants || !roster.writable) return 0
    const ok = []
    for (const g of list) {
      if (g.epoch > record.epoch || !verifyGrant(this.key, channel, g) || this.revoked(channel, g.identity)) continue
      if (!(await this.#mayGrant(channel, g.granter, roster.grants))) continue
      ok.push(g)
    }
    return putGrants(roster.grants, ok)
  }

  /** Keeper: list a grant if its signature, granter and recipient check out. */
  async acceptGrant (g) {
    if (!this.opened) await this.ready()
    const record = this.channel(g.channel)
    if (!record || !record.private || !this.#kept.has(g.channel)) return false
    const roster = this.#rostersOf(g.channel).get(toHex(this.#identity.keyPair.publicKey))
    if (!roster || !roster.grants || !roster.writable) return false
    if (g.epoch > record.epoch || !verifyGrant(this.key, g.channel, g)) return false
    if (this.revoked(g.channel, g.identity)) return false
    if (!(await this.#mayGrant(g.channel, g.granter, roster.grants))) return false
    const id = `${g.channel}:${toHex(g.recipient)}:${g.epoch}:${toHex(g.commit)}`
    if (this.#accepting.has(id)) return true // a copy of one being written
    this.#accepting.add(id)
    try {
      await putGrant(roster.grants, g)
    } finally {
      this.#accepting.delete(id)
    }
    return true
  }

  // Admins and up; or, where the channel allows it, a member the keeper's
  // grants bee already lists (a valid grant got them there) and not revoked.
  async #mayGrant (channel, granter, bee) {
    if ((RANK[this.role(granter)] || 0) >= RANK.admin) return true
    const record = this.channel(channel)
    if (!record || !record.memberGrants || this.revoked(channel, granter)) return false
    if (!(await this.#whoBee(bee))) return false
    return !!(await within(recipientOf(bee, b4a.from(toHex(granter), 'hex'), { timeout: 1000 }).catch(() => null), 1500))
  }

  // A grants store's identity index (opened from the grants tree's header).
  async #whoBee (gs) {
    if (gs.who) return gs.who
    const header = await within(gs.bee.getHeader({ timeout: 2000 }).catch(() => null), 2000)
    const key = header && header.metadata && header.metadata.contentFeed
    if (!key || key.length !== 32) return null
    gs.who = new Hyperbee(this.#store.get({ key }), { ...BIN, extension: false })
    await gs.who.ready()
    await within(gs.who.core.update({ wait: true }).catch(safetyCatch), 1000)
    return gs.who
  }

  async #grantsBee (roster) {
    if (roster.grants) return roster.grants
    const id = toHex(roster.key)
    if (this.#grantBees.has(id)) return this.#grantBees.get(id)
    const key = await within(roster.grantsKey({ timeout: 2000 }).catch(() => null), 2000)
    if (!key) return null
    const bee = new Hyperbee(this.#store.get({ key }), { ...BIN, extension: false })
    await bee.ready()
    const gs = { bee, who: null }
    this.#grantBees.set(id, gs)
    return gs
  }

  // This member's grants for a channel, from each keeper: checked (granter's
  // signature and right, the key matching the epoch's commitment) and kept
  // in memory. At most once a second unless forced.
  async #loadKeys (channel, force = false) {
    const record = this.channel(channel)
    if (!record || !record.private) return
    const last = this.#keysLoadedAt.get(channel) || 0
    if (!force && Date.now() - last < 1000) return
    this.#keysLoadedAt.set(channel, Date.now())
    const box = this.#box()
    for (const roster of (await this.#keeperRosters(channel)).values()) {
      const bee = await this.#grantsBee(roster)
      if (!bee) continue
      if (!roster.grants) await within(bee.bee.core.update({ wait: true }).catch(safetyCatch), 1000)
      // The epochs the control log has, minus those already held.
      const missing = []
      for (let e = 0; e <= record.epoch; e++) {
        const commit = this.epochCommit(channel, e)
        if (commit && !this.#epochKey(channel, e)) missing.push({ epoch: e, commit: b4a.from(commit, 'hex') })
      }
      if (missing.length === 0) return
      let list = []
      try {
        list = await within(grantsForEpochs(bee, box.publicKey, missing, { timeout: 2000 }), 3000) || []
      } catch (err) {
        safetyCatch(err)
      }
      trace('load-keys', channel.slice(0, 6), 'missing', missing.map(m => m.epoch).join(','), 'found', list.length, 'bee', bee.bee.core.length)
      for (const g of list) {
        if (this.#epochKey(channel, g.epoch)) continue
        if (!verifyGrant(this.key, channel, g)) { trace('grant-bad-sig', g.epoch); continue }
        if (!(await this.#mayGrant(channel, g.granter, bee))) { trace('grant-not-allowed', g.epoch, toHex(g.granter).slice(0, 8)); continue }
        const key = openSealed(g.sealed, box)
        const commit = this.epochCommit(channel, g.epoch)
        if (!key || !commit || toHex(commitOf(key)) !== commit) { trace('grant-key-mismatch', g.epoch, !!key); continue }
        this.#holdKey(channel, g.epoch, key)
      }
    }
  }
  hidden (author, log, seq) { return this.#state.hides[`${toHex(author)}:${toHex(log)}:${seq}`] || null }
  keepers (channelId) { return this.#state.keepers[channelId] || [] }

  // ── administration ───────────────────────────────────────────────────────

  #sign (event, keyPair = this.#identity.keyPair) {
    return sign(this.#control.hex, event, keyPair)
  }

  #myRole () { return this.role(this.#identity.keyPair.publicKey) }

  #requireWriter () {
    if (!this.#control.writable) throw new Error('This member is not a writer of the control log')
  }

  async setRole (pubkey, role, opts = {}) {
    if (!this.opened) await this.ready()
    const member = toHex(pubkey)
    if (!mayAssign(this.#myRole(), this.role(member), role || null)) throw new Error('Setting this role is not allowed for this member')
    this.#requireWriter()
    await this.#control.append(this.#sign({ type: 'role', member, role: role || null, writer: opts.writer ? toHex(opts.writer) : null }))
  }

  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.keep] - also keep it (list who posts): one control
   *   event instead of two (500 channels: 2,003 events, ~20-40 MB more on
   *   every member than with half of them)
   */
  async createChannel ({ name = '', segmentMs = 3600000, keep = false, private: priv = false, memberGrants = false } = {}) {
    if (!this.opened) await this.ready()
    if (!((RANK[this.#myRole()] || 0) >= RANK.admin)) throw new Error('Creating a channel is not allowed for this member')
    this.#requireWriter()
    const id = toHex(hcrypto.randomBytes(16))
    const event = { type: 'channel', id, name, segmentMs }
    if (priv) {
      // Epoch 0: the key stays here (and, sealed, with keepers once granted);
      // the control log only records its commitment.
      const key = newEpochKey()
      this.#holdKey(id, 0, key)
      Object.assign(event, { private: true, commit: toHex(commitOf(key)), memberGrants: !!memberGrants })
    }
    // The roster core's key, not its key pair's public key (Hypercore derives
    // a core's key from its manifest).
    if (keep) event.rosterKey = toHex((await this.#openOwnRoster(id, { private: priv })).key)
    await this.#control.append(this.#sign(event))
    // The creator's own grant: its key survives a restart and reaches its
    // other devices (pending until a keeper lists it).
    if (priv) await this.grant(id, { identity: this.#identity.keyPair.publicKey, encryptionKey: this.#box().publicKey })
    return id
  }

  async ban (pubkey, { reason = '' } = {}) {
    if (!this.opened) await this.ready()
    await this.#moderate({ type: 'ban', member: toHex(pubkey), reason, cut: await this.#banCut(toHex(pubkey)) })
  }

  // The author's logs listed in the current or previous segment of each
  // channel, with the length this peer sees now. An author already listed
  // can keep appending to that log with times dated before the ban; the cut
  // stops those. (A log last listed in an older segment isn't found: there
  // the time rule alone applies, so backdated posts can show on scrollback
  // to that segment.)
  async #banCut (author) {
    const cut = {}
    for (const { id, segmentMs } of this.channels()) {
      const wasOpen = this.#rosters.has(id)
      const seg = segmentOf(Date.now(), segmentMs)
      for (const s of [seg - 1, seg]) {
        for (const e of await this.rosterEntries(id, s)) {
          if (e.author !== author || cut[e.log] !== undefined) continue
          const log = await this.#log(e.log, id)
          await within(log.update({ wait: true }).catch(safetyCatch), 1000)
          cut[e.log] = log.length
        }
      }
      // A log last listed earlier: from each keeper's author index (the
      // author's own signature on the entry is checked).
      for (const roster of (await this.#keeperRosters(id)).values()) {
        const e = await this.#lastListed(roster, id, author)
        if (!e || cut[e.log] !== undefined) continue
        const log = await this.#log(e.log, id)
        await within(log.update({ wait: true }).catch(safetyCatch), 1000)
        cut[e.log] = log.length
      }
      if (!wasOpen) await this.closeChannel(id) // opened only for this
    }
    return cut
  }

  async unban (pubkey) {
    await this.#moderate({ type: 'unban', member: toHex(pubkey) })
  }

  async hide ({ author, log, seq }, { reason = '' } = {}) {
    await this.#moderate({ type: 'hide', member: toHex(author), log: toHex(log), seq, reason })
  }

  async #moderate (event) {
    if (!this.opened) await this.ready()
    if (!((RANK[this.#myRole()] || 0) >= RANK.mod)) throw new Error('Moderation is not allowed for this member')
    this.#requireWriter()
    await this.#control.append(this.#sign(event))
  }

  // ── keepers and rosters ──────────────────────────────────────────────────

  async #openOwnRoster (channel, opts = {}) {
    const me = toHex(this.#identity.keyPair.publicKey)
    const record = this.channel(channel)
    const priv = opts.private !== undefined ? opts.private : !!(record && record.private)
    const rosters = this.#rostersOf(channel)
    if (rosters.has(me) && rosters.get(me).writable) return rosters.get(me)
    // Derived from the identity, community and channel, like author logs:
    // the same roster after a restart and on any device. (Named in the
    // storage namespace, it came back empty under a new key after the
    // community was reopened by key, which every reader missed.)
    const roster = new Roster(this.#store.get({ keyPair: rosterKeyPair(this.#identity, this.key, channel) }), {
      onAnnouncement: (ann) => this.acceptAnnouncement(ann),
      authors: this.#store.get({ keyPair: rosterKeyPair(this.#identity, this.key, channel, 'hg-v2-authors') }),
      // A private channel's keeper also keeps its grants (spec 008, R1).
      grants: priv ? this.#store.get({ keyPair: rosterKeyPair(this.#identity, this.key, channel, 'hg-v2-grants') }) : null,
      grantsWho: priv ? this.#store.get({ keyPair: rosterKeyPair(this.#identity, this.key, channel, 'hg-v2-grants-who') }) : null,
      onGrant: (g) => this.acceptGrant(g)
    })
    await roster.ready()
    rosters.set(me, roster)
    this.#kept.add(channel)
    return roster
  }

  #rostersOf (channel) {
    let m = this.#rosters.get(channel)
    if (!m) this.#rosters.set(channel, (m = new Map()))
    return m
  }

  // Open (lazily) every keeper's roster for a channel, as the control log
  // lists them.
  async #keeperRosters (channel) {
    const rosters = this.#rostersOf(channel)
    for (const { keeper, rosterKey } of this.keepers(channel)) {
      if (rosters.has(keeper)) continue
      const roster = new Roster(this.#store.get({ key: b4a.from(rosterKey, 'hex') }))
      await roster.ready()
      // Never seen: wait for its length from peers, or a newcomer's first
      // page comes back empty. (Seen before, e.g. offline: no wait.)
      if (roster.core.length === 0) await within(roster.core.update({ wait: true }).catch(safetyCatch), ROSTER_WAIT_MS)
      rosters.set(keeper, roster)
    }
    return rosters
  }

  /** As a keeper (role keeper or above): start keeping the channel's roster. */
  async keep (channel) {
    if (!this.opened) await this.ready()
    if (!this.channel(channel)) throw new Error('Unknown channel')
    if (!((RANK[this.#myRole()] || 0) >= RANK.keeper)) throw new Error('Keeping a roster is not allowed for this member')
    this.#requireWriter()
    const roster = await this.#openOwnRoster(channel)
    const me = toHex(this.#identity.keyPair.publicKey)
    if (!this.keepers(channel).some(k => k.keeper === me)) {
      await this.#control.append(this.#sign({ type: 'keeper', channel, rosterKey: toHex(roster.key) }))
    }
  }

  /**
   * Keeper side: list an author if the announcement checks out. Returns
   * whether the author is (now) listed.
   */
  async acceptAnnouncement (ann) {
    if (!this.opened) await this.ready()
    const channel = this.channel(ann.channel)
    if (!channel || !this.#kept.has(ann.channel)) return false
    const me = toHex(this.#identity.keyPair.publicKey)
    const roster = this.#rostersOf(ann.channel).get(me)
    if (!roster || !roster.writable) return false
    const current = segmentOf(Date.now(), channel.segmentMs)
    if (ann.segment < current - 1 || ann.segment > current + 1) return false
    if (this.banned(ann.author)) return false
    if (!verifyEntry(this.key, ann.channel, ann.segment, ann)) return false
    // Claimed before any await: copies of one announcement arriving together
    // all passed the roster check before the first was written (100 authors
    // posting at once: 2,996 entries, each a permanent block).
    const claimed = this.#claim(ann.channel, ann.segment, current, toHex(ann.author))
    if (!claimed) return true
    try {
      if (!(await roster.has(ann.segment, ann.author))) {
        await roster.put(ann.segment, ann.author, { log: ann.log, start: ann.start, sig: ann.sig })
        trace('listed', toHex(ann.author).slice(0, 8))
      }
    } catch (err) {
      claimed.delete(toHex(ann.author))
      throw err
    }
    return true
  }

  // The keeper's set for this segment, after adding `author` to it; null if
  // it was there already. Segments too old to accept are forgotten.
  #claim (channel, segment, current, author) {
    const id = `${channel}:${segment}`
    let authors = this.#listing.get(id)
    if (!authors) {
      for (const key of this.#listing.keys()) {
        const [ch, seg] = key.split(':')
        if (ch === channel && Number(seg) < current - 1) this.#listing.delete(key)
      }
      this.#listing.set(id, (authors = new Set()))
    }
    if (authors.has(author)) return null
    authors.add(author)
    return authors
  }

  /**
   * A segment's roster across every keeper: entries whose signature checks
   * out, one per author (the lowest start). `opts.keeper` reads one keeper.
   *
   * @returns {Promise<Array<{ author: string, log: string, start: number }>>}
   */
  async rosterEntries (channel, segment, opts = {}) {
    if (!this.opened) await this.ready()
    return this.#entriesFrom(await this.#keeperRosters(channel), channel, segment, opts)
  }

  async #lastListed (roster, channel, author) {
    let bee = roster.authors
    let session = null
    try {
      if (!bee) {
        const key = await within(roster.authorsKey({ timeout: 2000 }).catch(() => null), 2000)
        if (!key) return null
        session = this.#store.get({ key })
        bee = new Hyperbee(session, { ...BIN, extension: false })
        await bee.ready()
        // Never seen here: its length from the keeper first, or the lookup
        // finds nothing.
        await within(session.update({ wait: true }).catch(safetyCatch), 2000)
      }
      const e = await within(lastEntry(bee, b4a.from(author, 'hex'), { timeout: 2000 }).catch(() => null), 2000)
      if (!e) return null
      const entry = { author: b4a.from(author, 'hex'), log: e.log, start: e.start, sig: e.sig }
      if (!verifyEntry(this.key, channel, e.segment, entry)) return null
      return { log: toHex(e.log), segment: e.segment, start: e.start }
    } finally {
      if (session) await bee.close().catch(safetyCatch)
    }
  }

  // The union of these rosters' entries for a segment: signature checked,
  // lowest start per author.
  async #entriesFrom (rosters, channel, segment, opts = {}) {
    const byAuthor = new Map()
    for (const [keeper, roster] of rosters) {
      if (opts.keeper && keeper !== opts.keeper) continue
      let entries = []
      try {
        entries = await roster.segment(segment)
      } catch (err) {
        safetyCatch(err)
        continue
      }
      for (const e of entries) {
        if (!verifyEntry(this.key, channel, segment, e)) continue
        const author = toHex(e.author)
        const known = byAuthor.get(author)
        if (!known || e.start < known.start) byAuthor.set(author, { author, log: toHex(e.log), start: e.start })
      }
    }
    return [...byAuthor.values()]
  }

  /** The highest segment ≤ max with any roster entry, across keepers, or -1. */
  async latestSegment (channel, max) {
    return this.#latestFrom(await this.#keeperRosters(channel), max)
  }

  async #latestFrom (rosters, max) {
    let best = -1
    for (const roster of rosters.values()) {
      try {
        best = Math.max(best, await roster.latestSegment(max))
      } catch (err) {
        safetyCatch(err)
      }
    }
    return best
  }

  // ── posting ──────────────────────────────────────────────────────────────

  async #ownLog (channel) {
    let log = this.#ownLogs.get(channel)
    if (!log) {
      log = new AuthorLog(this.#store, { keyPair: AuthorLog.keyPairFor(this.#identity, this.key, channel) })
      await log.ready()
      this.#ownLogs.set(channel, log)
    }
    return log
  }

  /**
   * Post a message to a channel: appended to this member's own log for the
   * channel, no agreement with anyone needed. The first post in a segment
   * announces this member to the channel's keepers.
   *
   * @returns {Promise<{ author: string, log: string, seq: number, t: number }>}
   */
  async post (channel, text, opts = {}) {
    if (!this.opened) await this.ready()
    const record = this.channel(channel)
    if (!record) throw new Error('Unknown channel')
    if (this.banned(this.#identity.keyPair.publicKey)) throw new Error('This member is banned')
    const log = await this.#ownLog(channel)
    const reply = opts.reply ? { log: b4a.from(toHex(opts.reply.log), 'hex'), seq: opts.reply.seq } : null
    let appended
    if (record.private) {
      // Only with the epoch the control log names current, and its key.
      const epoch = record.epoch
      if (!this.#epochKey(channel, epoch)) await this.#loadKeys(channel, true)
      const key = this.#epochKey(channel, epoch)
      if (!key) throw new Error('This member holds no key for the current epoch of this private channel')
      const t = log.nextT()
      const { nonce, box } = encryptMessage(key, messageAD(this.key, channel, log.key, epoch, t), sealedContent.encode({ text, reply }))
      appended = await log.appendRaw({ t, epoch, nonce, box })
    } else {
      appended = await log.append({ text, reply })
    }
    const { seq, t } = appended
    const segment = segmentOf(t, record.segmentMs)
    if (!this.#announced.has(`${channel}:${segment}`)) await this.#announce(channel, segment, log, seq)
    return { author: toHex(this.#identity.keyPair.publicKey), log: toHex(log.key), seq, t }
  }

  async #announce (channel, segment, log, start) {
    const id = `${channel}:${segment}`
    const ann = {
      channel,
      segment,
      author: this.#identity.keyPair.publicKey,
      log: log.key,
      start,
      sig: signEntry(this.key, channel, segment, log.key, start, this.#identity.keyPair)
    }
    this.#announced.add(id)
    this.#pending.set(id, ann)
    if (this.#kept.has(channel)) await this.acceptAnnouncement(ann)
    await this.#broadcast(ann)
    if (!this.#retry) {
      // Until a keeper lists it: a keeper may not be connected yet.
      this.#retry = setInterval(() => this.#sendPending().catch(safetyCatch), 500)
      if (this.#retry.unref) this.#retry.unref()
    }
  }

  // This announcement to every keeper's roster; the retry timer re-sends the
  // ones still pending (re-sending them all with each new one: 10 first posts,
  // 54 broadcasts).
  async #broadcast (ann) {
    const rosters = await this.#keeperRosters(ann.channel)
    for (const roster of rosters.values()) if (!roster.writable) roster.announce(ann)
  }

  async #sendPending () {
    trace('send-pending', this.#pending.size)
    for (const [id, ann] of this.#pending) {
      const rosters = await this.#keeperRosters(ann.channel)
      let listed = false
      for (const roster of rosters.values()) {
        try {
          if (await roster.has(ann.segment, ann.author)) { listed = true; break }
        } catch (err) {
          safetyCatch(err)
        }
      }
      if (listed) {
        this.#pending.delete(id)
        continue
      }
      for (const roster of rosters.values()) if (!roster.writable) roster.announce(ann)
    }
    if (this.#pending.size === 0 && this.#retry) {
      clearInterval(this.#retry)
      this.#retry = null
    }
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async #log (logHex, channel = null) {
    for (const own of this.#ownLogs.values()) if (toHex(own.key) === logHex) return own
    let log = this.#logs.get(logHex)
    if (!log) {
      log = new AuthorLog(this.#store, { key: b4a.from(logHex, 'hex') })
      await log.ready()
      this.#logs.set(logHex, log)
    }
    if (channel !== null) {
      let users = this.#logChannels.get(logHex)
      if (!users) this.#logChannels.set(logHex, (users = new Set()))
      users.add(channel)
    }
    return log
  }

  /**
   * Stop reading a channel: its follows end, and the rosters and author logs
   * opened for it are closed (unless another open channel reads them). The
   * data stays on disk; reading the channel again reopens them. A roster this
   * member keeps and its own log are left alone.
   */
  async closeChannel (channel) {
    for (const [stop, ch] of [...this.#follows]) if (ch === channel) stop()
    const rosters = this.#rosters.get(channel)
    if (rosters) {
      for (const [keeper, roster] of [...rosters]) {
        if (roster.writable) continue
        rosters.delete(keeper)
        await roster.close().catch(safetyCatch)
      }
      if (rosters.size === 0) this.#rosters.delete(channel)
    }
    for (const [logHex, users] of [...this.#logChannels]) {
      if (!users.delete(channel) || users.size > 0) continue
      this.#logChannels.delete(logHex)
      const log = this.#logs.get(logHex)
      this.#logs.delete(logHex)
      if (log) await log.close().catch(safetyCatch)
    }
  }

  // A log's length as far as peers say within `timeout` (its local length if
  // nobody answers).
  // The highest seq in [lo, hi] whose message is older than `t` (lo - 1 if
  // none), assuming non-decreasing times; null if a block can't be fetched.
  async #lastBefore (log, lo, hi, t, timeout) {
    const at = async (i) => {
      try {
        return await log.get(i, { timeout })
      } catch (err) {
        safetyCatch(err)
        return null
      }
    }
    const top = await at(hi)
    if (!top) return null
    if (top.t < t) return hi
    let found = lo - 1
    hi--
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const m = await at(mid)
      if (!m) return null
      if (m.t < t) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return found
  }

  async #length (log, timeout) {
    if (log.writable) return log.length
    await within(log.update({ wait: true }).catch(safetyCatch), timeout)
    return log.length
  }

  #shape (channel, author, logHex, m) {
    const hidden = !!this.hidden(author, logHex, m.seq)
    if (!isSealed(m)) return { author, log: logHex, seq: m.seq, t: m.t, text: hidden ? null : m.text, hidden }
    // Private: the text only with the epoch's key and an intact box;
    // otherwise unreadable, never an error (FR-003).
    const out = { author, log: logHex, seq: m.seq, t: m.t, text: null, hidden, encrypted: true, epoch: m.epoch }
    const key = this.#epochKey(channel, m.epoch)
    const plain = key && decryptMessage(key, messageAD(this.key, channel, b4a.from(logHex, 'hex'), m.epoch, m.t), m.nonce, m.box)
    if (!plain) return { ...out, unreadable: true }
    let content = null
    try { content = sealedContent.decode(plain) } catch { return { ...out, unreadable: true } }
    if (!hidden) out.text = content.text
    if (content.reply) out.reply = { log: toHex(content.reply.log), seq: content.reply.seq }
    return out
  }

  #visible (author, logHex, m) {
    if (isFuture(m.t)) return false
    const ban = this.banned(author)
    if (!ban) return true
    const cut = ban.cut && ban.cut[logHex]
    return cut !== undefined ? m.seq < cut : m.t <= ban.at
  }

  // Newest messages with t < beforeT, at most `limit`, newest first. Walks
  // back from the newest segment that has roster entries; each listed
  // author's messages in a segment are read from their newest down. Older
  // segments only hold older messages, so it stops once a page is full.
  async #page (channel, beforeT, limit, timeout) {
    const record = this.channel(channel)
    if (!record) throw new Error('Unknown channel')
    if (record.private) await this.#loadKeys(channel)
    const first = segmentOf(record.createdAt, record.segmentMs)
    const startT = Number.isFinite(beforeT) ? beforeT : Date.now() + FUTURE_MS
    let seg = segmentOf(startT, record.segmentMs)
    const later = new Map() // author -> where their entry in a later segment starts
    const out = []
    let unreachable = 0
    while (seg >= first) {
      seg = await this.latestSegment(channel, seg)
      if (seg < 0) break
      const entries = await this.rosterEntries(channel, seg)
      const cursors = await Promise.all(entries.map(async (e) => {
        const log = await this.#log(e.log, channel)
        const end = later.has(e.author) ? later.get(e.author) : await this.#length(log, timeout)
        const c = { e, log, next: end - 1, done: end - 1 < e.start, oldest: null, shown: [] }
        // Scrollback: start below `beforeT` by binary search over the
        // author's times (non-decreasing), not by walking down to it.
        if (!c.done && Number.isFinite(beforeT)) {
          const at = await this.#lastBefore(log, e.start, end - 1, beforeT, timeout)
          if (at === null) {
            unreachable++
            c.done = true
          } else {
            c.next = at
            if (c.next < e.start) c.done = true
          }
        }
        c.top = c.next // where reading starts: [next + 1, top + 1) is what was read
        return c
      }))
      // In rounds, all authors at once: each author still in the running
      // gives its next batch (1, 2, 4... blocks); an author is out once its
      // oldest fetched message is older than the `need`-th newest shown so
      // far. Taking every author's newest `limit` fetched 2,500 blocks for a
      // 50-message page from 50 authors.
      const need = limit - out.length
      let threshold = null
      let shown = []
      for (let batch = 1; ; batch *= 2) {
        const active = cursors.filter(c => !c.done && (threshold === null || newer(c.oldest, threshold) > 0))
        if (active.length === 0) break
        await Promise.all(active.map(async (c) => {
          const from = Math.max(c.e.start, c.next - batch + 1)
          const seqs = []
          for (let i = c.next; i >= from; i--) seqs.push(i)
          const got = await Promise.all(seqs.map(i => c.log.get(i, { timeout }).catch((err) => { safetyCatch(err); return null })))
          for (const m of got) {
            if (!m) {
              unreachable++
              c.done = true
              break
            }
            c.oldest = { t: m.t, author: c.e.author, seq: m.seq }
            if (m.t < beforeT && this.#visible(c.e.author, c.e.log, m)) c.shown.push(this.#shape(channel, c.e.author, c.e.log, m))
          }
          c.next = from - 1
          if (c.next < c.e.start) c.done = true
        }))
        shown = cursors.flatMap(c => c.shown).sort((x, y) => newer(y, x))
        if (shown.length >= need) threshold = shown[need - 1]
      }
      out.push(...shown)
      this.#replicator.noteRead(channel, seg, cursors.filter(c => c.next + 1 <= c.top).map(c => ({
        log: c.e.log,
        start: c.next + 1,
        end: c.top + 1,
        blockBytes: c.log.core.length > 0 ? c.log.core.byteLength / c.log.core.length : 0
      })))
      for (const e of entries) later.set(e.author, e.start)
      if (out.length >= limit) break
      seg--
    }
    this.#unreachable = unreachable
    // Newest first: by time, then author, then seq, all descending: the
    // exact reverse of the order every peer agrees on.
    out.sort((x, y) => newer(y, x))
    return out.slice(0, limit)
  }

  /**
   * The latest messages of a channel, newest first.
   *
   * @param {string} channel
   * @param {{ limit?: number, timeout?: number }} [opts] - timeout: ms to
   *   wait for an author's log before leaving it out (stats().unreachable)
   */
  async latest (channel, { limit = 50, timeout = 5000 } = {}) {
    if (!this.opened) await this.ready()
    return this.#page(channel, Infinity, limit, timeout)
  }

  /** Scrollback: the messages before time `t`, newest first. */
  async before (channel, { t, limit = 50, timeout = 5000 } = {}) {
    if (!this.opened) await this.ready()
    return this.#page(channel, t, limit, timeout)
  }

  /**
   * Follow a channel live: `onmessage` gets other members' new posts in the
   * current segment, once each, in each author's order.
   *
   * @returns {() => void} stop
   */
  follow (channel, onmessage, opts = {}) {
    const me = toHex(this.#identity.keyPair.publicKey)
    const watched = new Map() // log hex -> { author, next, log, onappend, range }
    let stopped = false
    let initial = true // the first scan: what is already there is history
    const since = Date.now()

    const drain = async (w) => {
      while (!stopped && w.next < w.log.length) {
        const seq = w.next++
        let m = null
        try {
          m = await w.log.get(seq)
        } catch (err) {
          safetyCatch(err)
        }
        if (!m || m.t < since || !this.#visible(w.author, toHex(w.log.key), m)) continue
        let shaped = this.#shape(channel, w.author, toHex(w.log.key), m)
        if (shaped.unreadable) {
          await this.#loadKeys(channel)
          shaped = this.#shape(channel, w.author, toHex(w.log.key), m)
        }
        onmessage(shaped)
      }
    }

    let scanning = false
    let rescan = false
    // A roster that grows means someone may have posted for the first time
    // in this segment: scan right away instead of waiting for the poll.
    const hooked = new Set()
    const onroster = () => scan().catch(safetyCatch)
    const watch = async (e, first) => {
      const log = await this.#log(e.log, channel)
      if (first) await within(log.update({ wait: true }).catch(safetyCatch), 2000)
      // Authors found by the first scan: their messages so far are history.
      // Authors listed later: everything from their entry, as long as it was
      // posted since following began.
      const w = { author: e.author, log, next: first ? Math.max(e.start, log.length) : e.start }
      w.onappend = () => drain(w).catch(safetyCatch)
      log.core.on('append', w.onappend)
      w.range = log.core.download({ start: w.next, end: -1 })
      watched.set(e.log, w)
      w.onappend() // anything already there since following began
    }
    const scan = async () => {
      // One scan at a time (the timer would otherwise overlap a slow one and
      // watch the same author twice); new authors are set up in parallel.
      if (stopped) return
      if (scanning) { rescan = true; return } // once this one ends
      scanning = true
      this.#scans++
      try {
        const record = this.channel(channel)
        if (!record) return
        for (const roster of (await this.#keeperRosters(channel)).values()) {
          if (hooked.has(roster)) continue
          hooked.add(roster)
          roster.core.on('append', onroster)
        }
        const seg = segmentOf(Date.now(), record.segmentMs)
        const fresh = []
        for (const s of [seg - 1, seg]) {
          for (const e of await this.rosterEntries(channel, s)) {
            if (e.author === me || watched.has(e.log) || fresh.some(f => f.log === e.log)) continue
            fresh.push(e)
          }
        }
        const first = initial
        initial = false
        if (fresh.length) trace('found', fresh.length, fresh.map(e => e.author.slice(0, 8)).join(','))
        for (const e of fresh) watched.set(e.log, null) // claimed
        await Promise.all(fresh.map(e => watch(e, first).catch(err => { watched.delete(e.log); safetyCatch(err) })))
      } finally {
        scanning = false
        if (rescan && !stopped) {
          rescan = false
          scan().catch(safetyCatch)
        }
      }
    }

    scan().catch(safetyCatch)
    // A keeper added later shows up in the control log: scan then. No
    // polling by default (it was the whole idle cost of a follow); pollMs
    // adds one.
    const oncontrol = () => scan().catch(safetyCatch)
    this.#control.on('change', oncontrol)
    const timer = opts.pollMs ? setInterval(() => scan().catch(safetyCatch), opts.pollMs) : null
    if (timer && timer.unref) timer.unref()
    const stop = () => {
      if (stopped) return
      stopped = true
      if (timer) clearInterval(timer)
      this.#control.off('change', oncontrol)
      for (const roster of hooked) roster.core.off('append', onroster)
      for (const w of watched.values()) {
        if (!w) continue
        w.log.core.off('append', w.onappend)
        try { w.range.destroy() } catch (err) { safetyCatch(err) }
      }
      this.#follows.delete(stop)
    }
    this.#follows.set(stop, channel)
    return stop
  }

  async stats () {
    let rosterKeepers = 0
    for (const m of this.#rosters.values()) rosterKeepers += m.size
    return {
      openLogs: this.#logs.size + this.#ownLogs.size,
      follows: this.#follows.size,
      mode: this.#mode,
      holding: this.#replicator.holding,
      heldBytes: this.#replicator.heldBytes,
      budget: this.#budget,
      replicationPasses: this.#replicator.passes,
      replicating: !!(this.#replicator.running || this.#replicator.timer || this.#replicator.retryTimer),
      replicationRosters: this.#replicator.rosters.size,
      replicationLiveLogs: this.#replicator.live.size,
      replicationActiveOpens: this.#replicator.activeOpens,
      scans: this.#scans,
      rosterKeepers,
      unreachable: this.#unreachable,
      controlLength: this.#control.base.length
    }
  }

  // ── test hooks (prototype only) ──────────────────────────────────────────

  /**
   * Post as another identity through this peer (benchmarks: many authors in
   * one process without one control log replica each). Same log and
   * announcement as that identity's own post() would produce.
   */
  async postAs (identity, channel, text) {
    const record = this.channel(channel)
    if (!record) throw new Error('Unknown channel')
    const author = toHex(identity.keyPair.publicKey)
    const id = `${author}:${channel}`
    let log = this.#ownLogs.get(id)
    if (!log) {
      log = new AuthorLog(this.#store, { keyPair: AuthorLog.keyPairFor(identity, this.key, channel) })
      await log.ready()
      this.#ownLogs.set(id, log)
    }
    const { seq, t } = await log.append({ text })
    const segment = segmentOf(t, record.segmentMs)
    const announced = `${author}:${channel}:${segment}`
    if (!this.#announced.has(announced)) {
      trace('first-post', author.slice(0, 8))
      this.#announced.add(announced)
      const ann = { channel, segment, author: identity.keyPair.publicKey, log: log.key, start: seq, sig: signEntry(this.key, channel, segment, log.key, seq, identity.keyPair) }
      this.#pending.set(announced, ann)
      if (this.#kept.has(channel)) await this.acceptAnnouncement(ann)
      await this.#broadcast(ann)
      if (!this.#retry) {
        this.#retry = setInterval(() => this.#sendPending().catch(safetyCatch), 500)
        if (this.#retry.unref) this.#retry.unref()
      }
    }
    return { author, log: toHex(log.key), seq, t }
  }

  /** Post with a given time, announcing for its segment (tests). */
  /** Length of an author log as this peer knows it (after a short update). */
  async logLength (logKey) {
    const log = await this.#log(toHex(logKey))
    await within(log.update({ wait: true }).catch(safetyCatch), 1000)
    return log.length
  }

  /** Whether this peer holds blocks [start, end) of a log, locally. */
  async holds (logKey, start, end = start + 1) {
    const core = this.#store.get({ key: b4a.from(toHex(logKey), 'hex') })
    try {
      await core.ready()
      return await core.has(start, end)
    } finally {
      await core.close().catch(safetyCatch)
    }
  }

  async postRaw (channel, { t, text }) {
    const record = this.channel(channel)
    const log = await this.#ownLog(channel)
    const { seq } = await log.appendRaw({ t, text })
    const segment = segmentOf(t, record.segmentMs)
    if (!this.#announced.has(`${channel}:${segment}`)) await this.#announce(channel, segment, log, seq)
    return { seq, t }
  }

  /** As a keeper, write a roster entry without any check (tests forging). */
  /**
   * Open a community from an invite link (then `redeem(link)` it).
   * @returns {Promise<Community>}
   */
  static async join (store, link, opts = {}) {
    const inv = decodeLink(link)
    const community = new Community(store, { ...opts, key: inv.community })
    await community.ready()
    return community
  }

  /**
   * An invite link: the community, and optionally a staff role, private
   * channels, an expiry (ms since epoch) and a use limit. Only for what this
   * member could give itself. Never carries a key.
   */
  async createInvite ({ role = null, channels = [], expires = 0, uses = 0 } = {}) {
    if (!this.opened) await this.ready()
    const mine = this.#myRole()
    if (role && !mayAssign(mine, null, role)) throw new Error('Inviting with this role is not allowed for this member')
    for (const ch of channels) {
      const record = this.channel(ch)
      if (!record || !record.private) throw new Error('Unknown private channel: ' + ch)
      if (!((RANK[mine] || 0) >= RANK.admin) && !(record.memberGrants && this.#heldEpochs(ch).length)) throw new Error('Inviting into this channel is not allowed for this member')
    }
    return encodeLink(makeInvite({ community: this.key, role, channels, expires, uses }, this.#identity.keyPair))
  }

  /** No more redemptions of this link (its maker or an admin). */
  async revokeInvite (link) {
    if (!this.opened) await this.ready()
    const inv = decodeLink(link)
    const me = toHex(this.#identity.keyPair.publicKey)
    if (!((RANK[this.#myRole()] || 0) >= RANK.admin) && toHex(inv.maker) !== me) throw new Error('Revoking this invite is not allowed for this member')
    this.#requireWriter()
    await this.#control.append(this.#sign({ type: 'revokeInvite', invite: toHex(inviteCodec.encode(inv)) }))
  }

  /** Identities (hex) that redeemed an invite (by its id, hex). */
  redemptions (inviteId) {
    const prefix = toHex(inviteId) + ':'
    return Object.keys(this.#state.redeemed).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
  }

  /**
   * Redeem an invite: the request goes to whichever control log writer is
   * online (the maker needn't be), retried until it is recorded or `timeout`.
   * @returns {Promise<{ recorded: boolean, role: string|null, channels: Object }>}
   */
  async redeem (link, { timeout = 30000 } = {}) {
    if (!this.opened) await this.ready()
    const inv = decodeLink(link)
    if (!b4a.equals(inv.community, this.key)) throw new Error('This invite is for another community')
    const me = toHex(this.#identity.keyPair.publicKey)
    const id = `${toHex(inv.id)}:${me}`
    const r = makeRedemption(inv, this.#identity.keyPair, this.#box().publicKey, inv.role ? this.localKey : null)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await this.update()
      const record = this.#state.redeemed[id]
      if (record) {
        const channels = {}
        for (const ch of record.channels || []) {
          await this.#loadKeys(ch, true)
          channels[ch] = this.#epochKey(ch, this.epoch(ch)) ? 'granted' : 'pending'
        }
        return { recorded: true, role: record.role || null, channels }
      }
      await this.#recordRedemption(r) // a writer records its own
      this.#redeemExt.broadcast(r)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return { recorded: false, role: null, channels: {} }
  }

  // A writer records a redemption that the control log would accept now
  // (checked again in apply; checked here too so a forged or used-up invite
  // doesn't add an event on every retry).
  async #recordRedemption (r) {
    if (!this.opened) await this.ready()
    if (!this.#control.writable || !((RANK[this.#myRole()] || 0) >= RANK.keeper)) return
    const inv = r.invite
    if (!verifyRedemption(r) || !b4a.equals(inv.community, this.key)) return
    const id = toHex(inv.id)
    const key = `${id}:${toHex(r.identity)}`
    if (this.#state.redeemed[key] || this.#recording.has(key)) return
    if (this.#state.invitesRevoked[id] || (inv.expires && Date.now() > inv.expires)) return
    if (inv.uses && (this.#state.uses[id] || 0) >= inv.uses) return
    const makerRole = this.role(inv.maker)
    if (inv.role && !mayAssign(makerRole, this.role(r.identity), inv.role)) return
    for (const ch of inv.channels) {
      const record = this.channel(ch)
      if (!record || !record.private || (!((RANK[makerRole] || 0) >= RANK.admin) && !record.memberGrants)) return
    }
    this.#recording.add(key)
    try {
      await this.#control.append(this.#sign({ type: 'redeem', redemption: toHex(redemptionCodec.encode(r)) }))
    } finally {
      this.#recording.delete(key)
    }
  }

  // Key holders grant the private channels of recorded redemptions.
  async #completeRedemptions () {
    if (this.#completing) {
      this.#completeAgain = true
      return
    }
    this.#completing = (async () => {
      do {
        this.#completeAgain = false
        for (const [key, record] of Object.entries(this.#state.redeemed)) {
          if (!record.channels || record.channels.length === 0) continue
          const identity = key.split(':')[1]
          for (const ch of record.channels) {
            const channel = this.channel(ch)
            if (!channel || !channel.private) continue
            const done = `${key}:${ch}:${channel.epoch}`
            if (this.#completed.has(done)) continue
            if (this.revoked(ch, identity)) { this.#completed.add(done); continue }
            const admin = (RANK[this.#myRole()] || 0) >= RANK.admin
            if (!this.#epochKey(ch, channel.epoch)) continue // not ours to do (yet)
            if (!admin && !channel.memberGrants) continue
            await this.grantMany(ch, [{ identity, encryptionKey: record.encryptionKey }])
            this.#completed.add(done)
          }
        }
      } while (this.#completeAgain)
    })()
    try {
      await this.#completing
    } catch (err) {
      safetyCatch(err)
    } finally {
      this.#completing = null
    }
  }

  /** Keeper only: write a grant into its grants bee without any check. */
  async writeGrantUnchecked (channel, { recipient, identity, epoch, sealed, granterKeyPair }) {
    const roster = await this.#openOwnRoster(channel)
    const g = { channel, recipient: b4a.from(toHex(recipient), 'hex'), identity: b4a.from(toHex(identity), 'hex'), epoch, commit: b4a.from(this.epochCommit(channel, epoch), 'hex'), sealed, granter: granterKeyPair.publicKey }
    g.sig = signGrant(this.key, channel, g, granterKeyPair)
    await putGrant(roster.grants, g)
  }

  /** The keys (hex) of the channel's keepers' grants cores. */
  async grantsCores (channel) {
    const out = []
    for (const roster of (await this.#keeperRosters(channel)).values()) {
      const gs = await this.#grantsBee(roster)
      if (gs) out.push(toHex(gs.bee.core.key))
    }
    return out
  }

  async writeRosterEntryUnchecked (channel, segment, entry) {
    const roster = await this.#openOwnRoster(channel)
    await roster.put(segment, entry.author, entry)
  }

  /** Append an event signed by another key pair, through this peer's writer. */
  async appendAs (keyPair, event) {
    this.#requireWriter()
    await this.#control.append(this.#sign(event, keyPair))
  }

  /** Append an event claiming `author` but signed by `signer`. */
  async appendForged (event, author, signer) {
    this.#requireWriter()
    const signed = this.#sign(event, signer)
    signed.author = toHex(author)
    await this.#control.append(signed)
  }
}

module.exports = { Community, rosterKeyPair }
