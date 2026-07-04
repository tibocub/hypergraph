const EventEmitter = require('events')
const safetyCatch = require('safety-catch')
const crypto = require('crypto')
const b4a = require('b4a')

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withTimeout (promise, ms) {
  return await Promise.race([
    promise,
    sleep(ms).then(() => null)
  ])
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

    // Wait for discovery and swarms to be ready with timeout
    await withTimeout(dataDiscovery.flushed(), 10000)
    await withTimeout(controlDiscovery.flushed(), 10000)
    await withTimeout(this.#dataSwarm.flush(), 10000)
    await withTimeout(this.#controlSwarm.flush(), 10000)

    this.#connected = true
    this.emit('connected')
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
    if (this.#connections > 0) return true

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

    // Destroy control swarm (we created it)
    if (this.#ownsControlSwarm) {
      try {
        if (this.#controlSwarm) await this.#controlSwarm.destroy()
      } catch (err) {
        safetyCatch(err)
      }
    }

    // Don't destroy data swarm (passed by user)

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
