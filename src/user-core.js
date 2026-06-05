const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const codecs = require('codecs')
const { encodeEvent, decodeEvent } = require('./encodings/event')

module.exports = class UserCore extends ReadyResource {
  #store
  #core
  #keyEncoding
  #valueEncoding
  #length
  #key

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

  get core () {
    return this.#core
  }

  get key () {
    return this.#core?.key
  }

  get discoveryKey () {
    return this.#core?.discoveryKey
  }

  get length () {
    return this.#length
  }

  get writable () {
    return this.#core?.writable
  }

  // ========================================
  // Append Operations
  // ========================================

  async append (event) {
    if (!this.opened) await this.ready()

    const encoded = encodeEvent(event)
    await this.#core.append(encoded)
    this.#length = this.#core.length

    return this.#length - 1
  }

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

  async get (seq) {
    if (!this.opened) await this.ready()

    const block = await this.#core.get(seq)
    return decodeEvent(block)
  }

  async * createReadStream (opts = {}) {
    if (!this.opened) await this.ready()

    const stream = this.#core.createReadStream(opts)
    for await (const block of stream) {
      yield decodeEvent(block)
    }
  }

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

  replicate (isInitiator, opts) {
    return this.#core.replicate(isInitiator, opts)
  }

  update () {
    if (!this.#core) return Promise.resolve(false)
    return this.#core.update().then((changed) => {
      this.#length = this.#core.length
      return changed
    })
  }
}
