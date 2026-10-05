/**
 * src/batch.js — bulk writes: `graph.batch()`.
 *
 * Collects entity creations, content versions and relations, then writes them
 * as one append to the author's user core and one append per context touched.
 * The second part matters most: every peer replays a context one writer batch
 * at a time, forever, so a bulk import written one event at a time stays
 * expensive for every future member (specs/002-scale-indexing/research.md R2).
 *
 * This module only records and shape-checks operations. Writing happens in
 * Hypergraph, which owns the user core, the contexts and the signing keys,
 * through the same event builders the single-item methods use, so the two
 * paths cannot produce different events.
 *
 * Contract: specs/002-scale-indexing/contracts/bulk-write.md
 */

const { formatReference, CONTENT_LINK_TYPE } = require('./content-ref')

/**
 * Validate the options shared by `graph.relate()` and `batch.relate()`.
 * Throws the same messages from both.
 *
 * @param {Object} opts
 */
function validateRelateOpts (opts) {
  if (!opts) throw new Error('Options object is required')
  if (!opts.from) throw new Error('opts.from is required')
  if (!opts.to) throw new Error('opts.to is required')
  if (!opts.context) throw new Error('opts.context is required')
  if (!opts.type && !opts.relationType) throw new Error('opts.type or opts.relationType is required')
  if (opts.value !== undefined && (typeof opts.value !== 'number' || !Number.isFinite(opts.value))) {
    throw new Error('opts.value must be a finite number if provided')
  }
}

/**
 * Stands for an entity created by `batch.put()`, before it has an id.
 * Accepted anywhere an entity id is, within the same batch.
 */
class EntityRef {
  #id

  constructor (batch, type, position) {
    this.batch = batch
    this.type = type
    this.position = position // index in the batch's operation list
    this.#id = null
  }

  /** @returns {string} The entity id. Throws until the batch is flushed. */
  get id () {
    if (this.#id === null) throw new Error('EntityRef not flushed yet: its id is assigned by batch.flush()')
    return this.#id
  }

  /** @returns {boolean} */
  get resolved () {
    return this.#id !== null
  }

  _resolve (id) {
    this.#id = id
  }
}

/**
 * Thrown when the user core was written but a context append then failed.
 * The user core and contexts are separate logs, so this cannot be atomic;
 * this error says exactly what now exists, so a retry can redo only the rest
 * instead of creating duplicate entities.
 */
class BulkWriteError extends Error {
  constructor (message, { written, entities, cause }) {
    super(message, { cause })
    this.name = 'BulkWriteError'
    this.written = written
    this.entities = entities
  }
}

class Batch {
  #flush
  #flushed

  /**
   * @param {(batch: Batch) => Promise<Object>} flush - Provided by Hypergraph.
   */
  constructor (flush) {
    this.#flush = flush
    this.#flushed = false
    /** @type {Array<Object>} Recorded operations, in call order. Internal. */
    this._ops = []
  }

  /**
   * Create an entity. Same input as `graph.put()`.
   *
   * @param {{ type: string }} entity
   * @returns {EntityRef}
   */
  put (entity) {
    this.#assertOpen()
    if (!entity || typeof entity.type !== 'string' || entity.type.length === 0) throw new Error('entity.type is required')
    if (entity.id) throw new Error('Entity id must NOT be provided')

    const ref = new EntityRef(this, entity.type, this._ops.length)
    this._ops.push({ op: 'put', ref })
    return ref
  }

  /**
   * Add a content version. Same arguments as `graph.putContent()`; the
   * target may be an `EntityRef` from this batch.
   */
  putContent (entityIdOrRef, content, contentType = 'text', opts = {}) {
    this.#assertOpen()
    const target = this.#target(entityIdOrRef, 'entityId')
    this._ops.push({ op: 'content', target, content, contentType, opts: opts || {} })
  }

  /**
   * Add a reference to content held elsewhere. Same arguments as
   * `graph.putContentRef()`; a malformed reference throws here, at the call.
   */
  putContentRef (entityIdOrRef, reference, opts = {}) {
    this.#assertOpen()
    const target = this.#target(entityIdOrRef, 'entityId')
    const body = formatReference(reference)
    this._ops.push({ op: 'content', target, content: body, contentType: CONTENT_LINK_TYPE, opts: opts || {} })
  }

  /**
   * Create a relation. Same options as `graph.relate()`; `from` and `to` may
   * be `EntityRef`s from this batch.
   */
  relate (opts) {
    this.#assertOpen()
    validateRelateOpts(opts)
    this._ops.push({
      op: 'relate',
      from: this.#target(opts.from, 'opts.from'),
      to: this.#target(opts.to, 'opts.to'),
      relationType: opts.type || opts.relationType,
      value: opts.value,
      context: opts.context
    })
  }

  /**
   * Validate everything, then write it. See the contract for the return
   * shape and failure modes.
   *
   * @returns {Promise<{ entities: Array<{id: string, type: string, author: string}>, written: { userCore: boolean, contexts: string[] } }>}
   */
  async flush () {
    this.#assertOpen()
    this.#flushed = true
    return this.#flush(this)
  }

  #assertOpen () {
    if (this.#flushed) throw new Error('Batch already flushed')
  }

  #target (value, name) {
    if (value instanceof EntityRef) {
      if (value.batch !== this) throw new Error(`${name} is an EntityRef from another batch`)
      return value
    }
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be an entity id or an EntityRef`)
    return value
  }
}

module.exports = { Batch, EntityRef, BulkWriteError, validateRelateOpts }
