const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const codecs = require('codecs')
const { encodeEvent, decodeEvent } = require('./encodings/event')

/**
 * UserCore wraps a Hypercore for storing user events with compact encoding.
 *
 * Manages a personal Hypercore that stores graph events (entity creation, content,
 * identity updates, etc.) using compact binary encoding. Used by Hypergraph as the
 * primary event log for each user.
 *
 * @extends ReadyResource
 */
module.exports = class UserCore extends ReadyResource {
  #store
  #core
  #keyEncoding
  #valueEncoding
  #length
  #key

  /**
   * Create a new UserCore instance.
   *
   * @param {import('corestore')} store - Corestore instance for core management
   * @param {Object} [opts] - Configuration options
   * @param {Buffer|string} [opts.key] - Open an existing core with this key instead of creating new
   * @param {string} [opts.keyEncoding] - Codec name for keys (passed to codecs)
   * @param {string} [opts.valueEncoding] - Codec name for values
   */
  constructor (store, opts = {}) {
    super()

    this.#store = store
    this.#key = opts.key || null
    this.#keyEncoding = opts.keyEncoding ? codecs(opts.keyEncoding) : null
    this.#valueEncoding = opts.valueEncoding ? codecs(opts.valueEncoding) : null
    this.#core = null
    this.#length = 0

    this.ready().catch(safetyCatch)
  }

  async _open () {
    // Get or create the user's personal core.
    // If a key is provided, open that core instead (useful for remote / read-only replication).
    this.#core = this.#key
      ? this.#store.get(this.#key)
      : this.#store.get({ name: 'user-core' })
    await this.#core.ready()
    this.#length = this.#core.length
  }

  async _close () {
    if (this.#core) await this.#core.close()
  }

  /** @returns {import('hypercore')} The underlying Hypercore instance */
  get core () {
    return this.#core
  }

  /** @returns {Buffer|undefined} The core's public key */
  get key () {
    return this.#core?.key
  }

  /** @returns {Buffer|undefined} The core's discovery key */
  get discoveryKey () {
    return this.#core?.discoveryKey
  }

  /** @returns {number} The number of events in the core */
  get length () {
    return this.#length
  }

  /** @returns {boolean} Whether the core is writable */
  get writable () {
    return this.#core?.writable
  }

  // ========================================
  // Append Operations
  // ========================================

  /**
   * Append a single event to the user core.
   *
   * @param {Object} event - The event to append
   * @returns {Promise<number>} The sequence number of the appended event
   */
  async append (event) {
    if (!this.opened) await this.ready()

    const encoded = encodeEvent(event)
    await this.#core.append(encoded)
    this.#length = this.#core.length

    return this.#length - 1
  }

  /**
   * Append multiple events to the user core in a batch.
   *
   * @param {Object[]} events - Array of events to append
   * @returns {Promise<number>} The sequence number of the last appended event
   */
  async appendBatch (events) {
    if (!this.opened) await this.ready()

    const encoded = events.map(encodeEvent)
    await this.#core.append(encoded)
    this.#length = this.#core.length

    return this.#length - events.length
  }

  // ========================================
  // Read Operations
  // ========================================

  /**
   * Get a single event by sequence number.
   *
   * @param {number} seq - The sequence number of the event
   * @returns {Promise<Object|null>} The decoded event, or null if not found
   */
  async get (seq) {
    if (!this.opened) await this.ready()

    const block = await this.#core.get(seq)
    return decodeEvent(block)
  }

  /**
   * Create a readable stream of events.
   *
   * @param {Object} [opts] - Stream options (passed to Hypercore.createReadStream)
   * @returns {AsyncIterable<Object|null>} Async iterator of decoded events
   */
  async * createReadStream (opts = {}) {
    if (!this.opened) await this.ready()

    const stream = this.#core.createReadStream(opts)
    for await (const block of stream) {
      yield decodeEvent(block)
    }
  }

  /**
   * Create a readable stream of events including historical snapshots.
   *
   * @param {Object} [opts] - Stream options (passed to Hypercore.createHistoryStream)
   * @returns {AsyncIterable<Object|null>} Async iterator of decoded events
   */
  async * createHistoryStream (opts = {}) {
    if (!this.opened) await this.ready()

    const stream = this.#core.createHistoryStream(opts)
    for await (const block of stream) {
      yield decodeEvent(block)
    }
  }

  // ========================================
  // Replication
  // ========================================

  /**
   * Create a replication stream for the core.
   *
   * @param {boolean} isInitiator - Whether this side initiated the connection
   * @param {Object} [opts] - Replication options (passed to Hypercore.replicate)
   * @returns {import('streamx').Duplex} The replication stream
   */
  replicate (isInitiator, opts) {
    return this.#core.replicate(isInitiator, opts)
  }

  /**
   * Update the core from remote peers.
   *
   * @returns {Promise<boolean>} True if the core was updated, false otherwise
   */
  update () {
    if (!this.#core) return Promise.resolve(false)
    return this.#core.update().then((changed) => {
      this.#length = this.#core.length
      return changed
    })
  }
}
