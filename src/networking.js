const EventEmitter = require('events')
const safetyCatch = require('safety-catch')
const crypto = require('crypto')
const b4a = require('b4a')

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Like a timeout-capped await, but emits a 'flush-timeout' event on
 * `emitter` if the timeout wins the race, instead of silently swallowing
 * it. Still doesn't throw (connect() callers may reasonably want to
 * proceed and let application code decide what to do), but a caller can
 * now listen for 'flush-timeout' to detect a partial/failed connect
 * instead of only ever seeing an unconditional `connected: true`.
 */
async function withTimeoutWarn (emitter, label, promise, ms) {
  const result = await Promise.race([
    promise.then((value) => ({ timedOut: false, value })),
    sleep(ms).then(() => ({ timedOut: true, value: null }))
  ])
  if (result.timedOut) {
    emitter.emit('flush-timeout', { step: label, timeoutMs: ms })
  }
  return result.value
}

/**
 * HypergraphNetwork - Helper class for Hypergraph + Hyperswarm integration
 * 
 * This class provides a simple networking solution for Hypergraph applications by:
 * - Using dual Hyperswarm swarms (data + control) for separation of concerns
 * - Automatically calling store.replicate(conn) on data connections
 * - Handling writer authorization via JSON protocol on control swarm
 * - Sensible defaults for simple use cases, options for advanced customization
 * 
 * Design decisions:
 * - Dual swarm approach for reliability (data for replication, control for protocol)
 * - Hyperswarm instance passed as parameter (follows holepunch pattern)
 * - Control swarm created internally, sharing DHT from passed swarm
 * - Context keys (not instances) to avoid timing problems
 * - Any writer can add writers (no owner required for authorization)
 *
 * @example
 * const swarm = new Hyperswarm({ maxPeers: 16 })
 * const network = new HypergraphNetwork(graph, store, swarm, {
 *   topic: myTopic,
 *   contexts: { comments: contextKey, moderation: contextKey },
 *   role: 'peer'
 * })
 * await network.connect()
 */
module.exports = class HypergraphNetwork extends EventEmitter {
  #graph
  #store
  #dataSwarm
  #controlSwarm
  #topic
  #controlTopic
  #maxPeers
  #connected = false
  #ownsControlSwarm = true
  #autoReplicate = true
  #topicPrefix = ''
  #contexts = new Map() // name -> contextKey
  #contextInstances = new Map() // name -> contextInstance
  #role = 'peer'
  #connections = 0
  #hasPeerJoined = false

  /**
   * @param {Object} graph - Hypergraph instance
   * @param {Object} store - Corestore instance
   * @param {Object} swarm - Hyperswarm instance (used as data swarm)
   * @param {Object} opts - Configuration options
   * @param {Buffer|string} opts.topic - Hyperswarm topic for data swarm (Buffer or hex string)
   * @param {string} [opts.topicPrefix] - Optional salt for control topic derivation
   * @param {Object} [opts.contexts] - Context keys mapping: { name: contextKey }
   * @param {boolean} [opts.autoReplicate=true] - Auto-replicate store on data connections
   * @param {string} [opts.role='peer'] - Role: 'owner' or 'peer'
   */
  constructor (graph, store, swarm, opts = {}) {
    super()
    this.#graph = graph
    this.#store = store
    this.#dataSwarm = swarm
    this.#topic = typeof opts.topic === 'string' ? Buffer.from(opts.topic, 'hex') : opts.topic
    this.#topicPrefix = opts.topicPrefix || ''
    this.#autoReplicate = opts.autoReplicate !== false
    this.#role = opts.role || 'peer'

    if (!this.#topic) {
      throw new Error('Topic is required')
    }
    if (!this.#dataSwarm) {
      throw new Error('Hyperswarm instance is required')
    }

    // Parse contexts option
    if (opts.contexts) {
      for (const [name, key] of Object.entries(opts.contexts)) {
        this.#contexts.set(name, key)
      }
    }

    // Derive control topic from data topic with optional salt
    this.#controlTopic = this._deriveControlTopic(this.#topic, this.#topicPrefix)
  }

  /**
   * Derive control topic from data topic with optional salt
   * @private
   */
  _deriveControlTopic (dataTopic, prefix) {
    const hash = crypto.createHash('sha256')
    hash.update(dataTopic)
    if (prefix) hash.update(prefix)
    hash.update('control')
    return hash.digest()
  }

  /**
   * Handle data swarm connection - replicate cores
   * @private
   */
  _handleDataConnection (conn, info) {
    if (this.#autoReplicate) {
      // Replicate the entire store (includes usercore, viewcore, context cores)
      // Corestore replicates all cores loaded in memory
      this.#store.replicate(conn)
    }
    this.emit('data-connection', { conn, info })
  }

  /**
   * Handle control swarm connection - wire JSON protocol
   * @private
   */
  _handleControlConnection (conn, info) {
    this._wireControlConnection(conn, info)
    this.emit('control-connection', { conn, info })
  }

  /**
   * Open contexts internally
   * @private
   */
  async _openContexts () {
    for (const [name, key] of this.#contexts) {
      const context = await this.#graph.openContext(key)
      this.#contextInstances.set(name, context)
    }
  }

  /**
   * Wire control connection for JSON protocol
   * @private
   */
  _wireControlConnection (conn, info) {
    // Set up JSON message handling
    conn.setEncoding('utf8')

    let buffer = ''

    conn.on('data', (data) => {
      buffer += data
      const lines = buffer.split('\n')
      buffer = lines.pop() // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          this._handleControlMessage(msg, conn, info)
        } catch (err) {
          safetyCatch(err)
          this.emit('control-error', err)
        }
      }
    })

    // If peer role, send writer-request on connection
    if (this.#role === 'peer') {
      this._sendWriterRequest(conn)
    }

    this.emit('connection', { conn, info })
  }

  /**
   * Handle control message
   * @private
   */
  async _handleControlMessage (msg, conn, info) {
    this.emit('control-message', msg, conn, info)

    switch (msg.type) {
      case 'writer-request':
        await this._handleWriterRequest(msg, conn)
        break
      case 'writer-granted':
        this.emit('writer-granted', msg)
        break
      case 'writer-error':
        this.emit('writer-error', msg)
        break
      default:
        safetyCatch(new Error(`Unknown control message type: ${msg.type}`))
    }
  }

  /**
   * Handle writer-request message
   * @private
   */
  async _handleWriterRequest (msg, conn) {
    // Only writers (owner or peer with writer status) respond to writer-requests
    // For now, we'll allow any connected peer to respond
    // TODO: Add proper permission checking in Phase 2

    try {
      // Open userCore if provided
      if (msg.userCore) {
        await this.#graph.openUserCore(msg.userCore)
      }

      // Add writers for each context
      const granted = {}
      for (const [name, context] of this.#contextInstances) {
        const writerKeyHex = msg.contexts?.[name]
        if (writerKeyHex) {
          try {
            const writerKey = Buffer.from(writerKeyHex, 'hex')
            await context.addWriter(writerKey)
            granted[name] = true
          } catch (err) {
            safetyCatch(err)
            granted[name] = false
          }
        }
      }

      // Send writer-granted response
      this._sendControlMessage(conn, {
        type: 'writer-granted',
        contexts: granted
      })
    } catch (err) {
      safetyCatch(err)
      // Send writer-error on failure
      this._sendControlMessage(conn, {
        type: 'writer-error',
        message: err.message || String(err)
      })
    }
  }

  /**
   * Send writer-request message
   * @private
   */
  _sendWriterRequest (conn) {
    const contexts = {}
    for (const [name, context] of this.#contextInstances) {
      contexts[name] = context.localKey.toString('hex')
    }

    const msg = {
      type: 'writer-request',
      userCore: this.#graph.key.toString('hex'),
      contexts
    }

    this._sendControlMessage(conn, msg)
  }

  /**
   * Send control message
   * @private
   */
  _sendControlMessage (conn, msg) {
    conn.write(JSON.stringify(msg) + '\n')
  }

  /**
   * Connect to the Hyperswarm topics
   */
  async connect () {
    if (this.#connected) return

    const Hyperswarm = require('hyperswarm')

    // Open contexts internally before joining swarms
    await this._openContexts()

    // Create control swarm internally, sharing DHT from data swarm
    this.#controlSwarm = new Hyperswarm({ dht: this.#dataSwarm.dht })

    // Set up data swarm connection handler
    this.#dataSwarm.on('connection', (conn, info) => {
      this.#connections++
      this.#hasPeerJoined = true
      this._handleDataConnection(conn, info)

      const peerKey = info && info.publicKey ? info.publicKey.toString('hex') : 'unknown'
      this.emit('peer-join', { peerKey, conn, info })

      conn.on('error', (err) => {
        safetyCatch(err)
        this.emit('data-error', err)
      })

      conn.on('close', () => {
        this.#connections--
        this.emit('peer-leave', { peerKey, conn, info })
      })
    })

    // Set up control swarm connection handler
    this.#controlSwarm.on('connection', (conn, info) => {
      this.#connections++
      this._handleControlConnection(conn, info)

      const peerKey = info && info.publicKey ? info.publicKey.toString('hex') : 'unknown'

      conn.on('error', (err) => {
        safetyCatch(err)
        this.emit('control-error', err)
      })

      conn.on('close', () => {
        this.#connections--
      })
    })

    // Join data topic
    const dataDiscovery = this.#dataSwarm.join(this.#topic, { server: true, client: true })

    // Join control topic
    const controlDiscovery = this.#controlSwarm.join(this.#controlTopic, { server: true, client: true })

    // Wait for discovery and swarms to be ready with timeout.
    //
    // BUG FIX: withTimeout() silently swallows a timeout and returns null,
    // so connect() previously reported success (`connected = true`)
    // unconditionally after these four steps, regardless of whether any of
    // them actually completed. That's how a caller could see `connected:
    // true` on both sides while the control channel had never actually
    // connected at all — there was no way to tell the difference between
    // "flushed fine" and "gave up after 10s, silently, and moved on
    // anyway". 10s was also too short: DHT connections in real-world
    // testing on this project have been observed taking anywhere from a
    // few seconds up to ~90s. Both are fixed here: a much more realistic
    // timeout, and a warning emitted (not swallowed) if a step actually
    // times out, so a partial/failed connect is at least observable
    // instead of silently reported as success.
    await withTimeoutWarn(this, 'data discovery flush', dataDiscovery.flushed(), 60000)
    await withTimeoutWarn(this, 'control discovery flush', controlDiscovery.flushed(), 60000)
    await withTimeoutWarn(this, 'data swarm flush', this.#dataSwarm.flush(), 60000)
    await withTimeoutWarn(this, 'control swarm flush', this.#controlSwarm.flush(), 60000)

    // BUG FIX: flushed()/flush() resolving successfully does NOT mean any
    // peer was actually found or connected — it can resolve with zero
    // peers discovered at all (this is a real Hyperswarm/DHT behavior, not
    // a bug in flushed()/flush() themselves). connect() previously took
    // that resolution as proof of success and moved on regardless, the
    // same way the raw-Hyperswarm replication tests in this project's test
    // suite once did — and the fix that reliably worked there was a real
    // retry: leave and rejoin the topic, rather than just waiting longer
    // for the same attempt. That fix is applied here too, to the actual
    // product code rather than only ever inside tests, since any consumer
    // of connect() can hit this.
    await this._ensureConnectionWithRetry(this.#dataSwarm, this.#topic, 'data')
    await this._ensureConnectionWithRetry(this.#controlSwarm, this.#controlTopic, 'control')

    this.#connected = true
    this.emit('connected')
  }

  /**
   * Wait for a swarm to report at least one live connection, retrying by
   * leaving and rejoining the topic if none appears within the wait
   * window. `flushed()`/`flush()` resolving successfully does not mean any
   * peer was found — this actually confirms it, and gives a genuine second
   * (and third) chance via a fresh join rather than just waiting longer on
   * the same attempt.
   *
   * Emits 'connection-retry' (with the label and attempt number) each time
   * a rejoin is attempted, and 'connection-retry-exhausted' if no
   * connection ever appears after all attempts — both observable by a
   * caller, neither thrown, matching connect()'s existing "report what
   * happened, don't block the caller on it" behavior.
   *
   * @private
   * @param {import('hyperswarm')} swarm
   * @param {Buffer} topic
   * @param {string} label - 'data' or 'control', for event/log purposes
   */
  async _ensureConnectionWithRetry (swarm, topic, label) {
    const retries = 2
    const waitMs = 15000
    const joinOpts = { server: true, client: true }

    for (let attempt = 0; ; attempt++) {
      const start = Date.now()
      while (swarm.connections.size === 0 && Date.now() - start < waitMs) {
        await sleep(1000)
      }

      if (swarm.connections.size > 0) return

      if (attempt >= retries) {
        this.emit('connection-retry-exhausted', { label, attempts: attempt + 1 })
        return
      }

      this.emit('connection-retry', { label, attempt: attempt + 1 })
      try {
        await swarm.leave(topic)
      } catch (err) {
        safetyCatch(err)
      }
      await sleep(1000)

      const discovery = swarm.join(topic, joinOpts)
      try {
        await discovery.flushed()
      } catch (err) {
        safetyCatch(err)
      }
      try {
        await swarm.flush()
      } catch (err) {
        safetyCatch(err)
      }
    }
  }

  /**
   * Disconnect from the Hyperswarm topics
   */
  async disconnect () {
    if (!this.#connected) return

    // Leave data topic
    this.#dataSwarm.leave(this.#topic)
    await this.#dataSwarm.flush()

    // Leave control topic
    this.#controlSwarm.leave(this.#controlTopic)
    await this.#controlSwarm.flush()

    this.#connected = false
    this.emit('disconnected')
  }


  /**
   * Get the data swarm instance
   */
  get dataSwarm () {
    return this.#dataSwarm
  }

  /**
   * Get the control swarm instance
   */
  get controlSwarm () {
    return this.#controlSwarm
  }

  /**
   * Get the data topic
   */
  get topic () {
    return this.#topic
  }

  /**
   * Get the control topic
   */
  get controlTopic () {
    return this.#controlTopic
  }

  /**
   * Check if connected
   */
  get connected () {
    return this.#connected
  }

  /**
   * Get the number of active connections (data + control)
   */
  get connections () {
    return this.#connections
  }

  /**
   * Wait for at least one peer connection
   * @param {number} timeoutMs - Timeout in milliseconds (default: 10000)
   */
  async waitForPeer (timeoutMs = 10000) {
    if (this.#hasPeerJoined) return true

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('peer-join', onJoin)
        reject(new Error(`No peer connection within ${timeoutMs}ms`))
      }, timeoutMs)

      const onJoin = () => {
        clearTimeout(timeout)
        this.off('peer-join', onJoin)
        resolve(true)
      }

      this.on('peer-join', onJoin)
    })
  }

  /**
   * Destroy the networking helper
   * Disconnects and cleans up resources
   */
  async destroy () {
    await this.disconnect()

    // Destroy control swarm's own resources (we created it), but WITHOUT
    // destroying its DHT.
    //
    // BUG FIX: the control swarm's DHT is a *shared* reference borrowed
    // from the externally-provided data swarm
    // (`new Hyperswarm({ dht: dataSwarm.dht })`), not something this class
    // owns. Hyperswarm's own destroy() unconditionally calls
    // `this.dht.destroy()`, with no way to opt out and no tracking of
    // whether the dht was externally provided or created internally
    // (confirmed by reading Hyperswarm's constructor:
    // `this.dht = opts.dht || new DHT(...)` never records which case
    // applied). Since this class explicitly leaves the data swarm for the
    // caller to destroy separately (see below), calling the control
    // swarm's full destroy() here destroyed the *same* shared DHT a second
    // time once the caller destroyed their data swarm afterward.
    // HyperDHT.destroy() has no idempotency guard of its own either, so a
    // second destroy on already-torn-down internals can hang rather than
    // error — exactly the symptom observed (the whole test process never
    // exiting). Fixed by tearing down only the control swarm's own
    // resources (topics, server, connections) and leaving the shared DHT
    // alone; it's the data swarm owner's job to destroy that, exactly
    // once.
    if (this.#ownsControlSwarm && this.#controlSwarm) {
      try {
        await this.#controlSwarm.clear()
        await this.#controlSwarm.server.close()
        for (const conn of [...this.#controlSwarm.connections]) {
          try {
            conn.destroy()
          } catch (err) {
            safetyCatch(err)
          }
        }
      } catch (err) {
        safetyCatch(err)
      }
    }

    // Don't destroy data swarm (passed by user), and don't destroy the
    // shared DHT via the control swarm either (see above) — the caller
    // owns both and is responsible for destroying the data swarm once.

    this.removeAllListeners()
  }

  /**
   * Generate bootstrap.json for a hypergraph
   * This is a static method that can be called without an instance
   *
   * @param {Object} graph - Hypergraph instance
   * @param {Object} opts - Bootstrap options
   * @param {Buffer|string} opts.topic - Data swarm topic
   * @param {string} [opts.topicPrefix] - Optional salt for control topic derivation
   * @param {Object} opts.contexts - Context keys mapping: { name: contextKey }
   * @param {Object} [opts.metadata] - Optional app-specific metadata
   * @returns {Object} Bootstrap object
   */
  static generateBootstrap (graph, opts) {
    if (!graph || !graph.key) {
      throw new Error('Graph instance with key is required')
    }
    if (!opts || !opts.topic) {
      throw new Error('Topic is required')
    }
    if (!opts.contexts) {
      throw new Error('Contexts mapping is required')
    }

    const topic = typeof opts.topic === 'string' ? Buffer.from(opts.topic, 'hex') : opts.topic

    // Derive control topic
    const hash = crypto.createHash('sha256')
    hash.update(topic)
    if (opts.topicPrefix) hash.update(opts.topicPrefix)
    hash.update('control')
    const controlTopic = hash.digest()

    return {
      version: '1.0.0',
      topic: topic.toString('hex'),
      controlTopic: controlTopic.toString('hex'),
      ownerCore: graph.key.toString('hex'),
      contexts: opts.contexts,
      metadata: opts.metadata || null
    }
  }
}
