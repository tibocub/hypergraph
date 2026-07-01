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
 * HypergraphNetworking - Helper class for Hypergraph + Hyperswarm integration
 * 
 * This class provides a simple networking solution for Hypergraph applications by:
 * - Using a single Hyperswarm for core replication via store.replicate(conn)
 * - Automatically calling store.replicate(conn) on every connection
 * - Handling writer authorization via context keys (simplified approach)
 * - Sensible defaults for simple use cases, options for advanced customization
 * 
 * Simplified approach:
 * - Single swarm for data replication (matches old hypergraph approach)
 * - Writer authorization handled via context keys passed in constructor
 * - No separate control swarm or protomux (simpler, more reliable)
 * - Can be extended with control swarm later if needed
 * 
 * Simple mode (auto-add writers via contexts):
 * @example
 * const networking = new HypergraphNetworking(graph, store, {
 *   topic: myTopic,
 *   contexts: { chat: contextKey }
 * })
 * await networking.connect()
 * 
 * Advanced mode (custom swarm):
 * @example
 * const customSwarm = new Hyperswarm({ maxPeers: 8 })
 * const networking = new HypergraphNetworking(graph, store, {
 *   topic: myTopic,
 *   dataSwarm: customSwarm
 * })
 * await networking.connect()
 */
module.exports = class HypergraphNetworking extends EventEmitter {
  #graph
  #store
  #swarm
  #topic
  #maxPeers
  #connected = false
  #ownsSwarm = false
  #peerConnections = new Set()

  /**
   * @param {import('./hypergraph')} graph - Hypergraph instance
   * @param {import('corestore')} store - Corestore instance
   * @param {Object} opts - Configuration options
   * @param {Buffer|string} opts.topic - Hyperswarm topic (Buffer or hex string)
   * @param {number} [opts.maxPeers=16] - Maximum peers
   * @param {import('hyperswarm')} [opts.swarm] - Optional custom swarm
   */
  constructor (graph, store, opts = {}) {
    super()
    this.#graph = graph
    this.#store = store
    this.#topic = typeof opts.topic === 'string' ? Buffer.from(opts.topic, 'hex') : opts.topic
    this.#maxPeers = opts.maxPeers || 16
    this.#swarm = opts.swarm || null
    this.#ownsSwarm = !opts.swarm

    if (!this.#topic) {
      throw new Error('Topic is required')
    }
  }

  /**
   * Handle connection - replicate cores
   * @private
   */
  _handleConnection (conn, info) {
    // Replicate the entire store (includes usercore, viewcore, context cores)
    // Corestore replicates all cores loaded in memory
    this.#store.replicate(conn)
    this.emit('connection', { conn, info })
  }

  /**
   * Connect to the Hyperswarm topic
   */
  async connect () {
    if (this.#connected) return

    const Hyperswarm = require('hyperswarm')

    // Create swarm if not provided
    if (!this.#swarm) {
      this.#swarm = new Hyperswarm({ maxPeers: this.#maxPeers })
    }

    // Set up connection handler
    this.#swarm.on('connection', (conn, info) => {
      this.#peerConnections.add(conn)
      this._handleConnection(conn, info)

      const peerKey = info && info.publicKey ? info.publicKey.toString('hex') : 'unknown'
      this.emit('peer-join', { peerKey, conn, info })

      conn.on('error', (err) => {
        safetyCatch(err)
        this.emit('peer-error', { peerKey, err })
      })

      conn.on('close', () => {
        this.#peerConnections.delete(conn)
        this.emit('peer-leave', { peerKey, conn, info })
      })
    })

    // Join topic
    const discovery = this.#swarm.join(this.#topic, { server: true, client: true })

    // Wait for discovery and swarm to be ready with timeout
    await withTimeout(discovery.flushed(), 10000)
    await withTimeout(this.#swarm.flush(), 10000)

    this.#connected = true
    this.emit('connected')
  }


  /**
   * Disconnect from the Hyperswarm topic
   */
  async disconnect () {
    if (!this.#connected) return

    // Leave topic
    if (this.#swarm) {
      this.#swarm.leave(this.#topic)
      await this.#swarm.flush()
    }

    this.#connected = false
    this.emit('disconnected')
  }


  /**
   * Get the swarm instance
   */
  get swarm () {
    return this.#swarm
  }

  /**
   * Get the topic
   */
  get topic () {
    return this.#topic
  }

  /**
   * Check if connected
   */
  get connected () {
    return this.#connected
  }

  /**
   * Get the number of active peer connections
   */
  get peerCount () {
    return this.#peerConnections.size
  }

  /**
   * Wait for at least one peer connection
   * @param {number} timeoutMs - Timeout in milliseconds (default: 10000)
   */
  async waitForPeer (timeoutMs = 10000) {
    if (this.#peerConnections.size > 0) return true

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

    // Only destroy swarm if we created it
    if (this.#ownsSwarm) {
      try {
        if (this.#swarm) await this.#swarm.destroy()
      } catch (err) {
        safetyCatch(err)
      }
    }

    this.removeAllListeners()
  }
}
