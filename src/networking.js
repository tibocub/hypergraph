const EventEmitter = require('events')
const safetyCatch = require('safety-catch')
const c = require('compact-encoding')

// The bootstrap descriptor shape produced by generateBootstrap() and
// consumed by connectFromBootstrap(). No version negotiation/migration
// logic exists yet (not needed while nothing runs this in production) —
// connectFromBootstrap() just rejects anything that doesn't match exactly,
// so a future shape change fails loudly and immediately instead of
// silently misinterpreting an incompatible descriptor. Bump this and add
// real migration handling once there are real deployments to stay
// compatible with.
const BOOTSTRAP_VERSION = '2.0.0'

// A valid Hypercore key is exactly 32 bytes (64 hex characters).
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i

function isValidHexKey (value) {
  return typeof value === 'string' && HEX_KEY_PATTERN.test(value)
}

function describeForError (value) {
  if (typeof value !== 'string') return `${typeof value} (${JSON.stringify(value)})`
  return value.length > 40 ? `"${value.slice(0, 40)}..." (length ${value.length})` : `"${value}" (length ${value.length})`
}

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
 * - Using a single Hyperswarm connection for both replication and writer-auth control
 * - Automatically calling store.replicate(conn) on connections
 * - Handling writer authorization via a protomux channel multiplexed onto that same connection
 * - Sensible defaults for simple use cases, options for advanced customization
 *
 * Design decisions:
 * - REDESIGNED (previously used a second, internally-created Hyperswarm swarm
 *   sharing the data swarm's DHT, joining a second, derived "control" topic,
 *   with writer-auth as a raw JSON-line protocol over that separate
 *   connection). That design required establishing two independent DHT
 *   rendezvous/hole-punch processes between the same two peers. In extensive
 *   real-network testing, the data channel connected reliably every time;
 *   the control channel was unreliable — sometimes needing retries,
 *   sometimes never connecting at all, with no code-level bug found to
 *   explain the difference after an extensive investigation (see
 *   CHANGELOG.md). Rather than continue working around an unreliable second
 *   connection, this eliminates it: writer-auth is now a protomux channel
 *   multiplexed onto the *same* connection the data swarm already
 *   establishes — the one connection already proven reliable — using the
 *   same muxer Corestore's own replication already attaches to that
 *   connection (`Protomux.from(conn)` returns the existing muxer via
 *   `conn.userData`, confirmed by reading Hypercore.createProtocolStream()
 *   and NoiseSecretStream's `this.noiseStream = this` self-reference
 *   directly).
 * - Hyperswarm instance passed as parameter (follows holepunch pattern)
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
  #topic
  #maxPeers
  #connected = false
  #autoReplicate = true
  #contexts = new Map() // name -> contextKey
  #contextInstances = new Map() // name -> contextInstance
  #role = 'peer'
  #connections = 0
  #hasPeerJoined = false
  #hasReceivedWriterGrant = false
  #writerRequestTimeoutMs = 30000
  #channelsByConn = new WeakMap() // conn -> { channel, messages, writerRequestTimeout }
  #pendingWriterRequestTimeouts = new Set() // tracked separately since WeakMap can't be iterated for cleanup in destroy()

  /**
   * @param {Object} graph - Hypergraph instance
   * @param {Object} store - Corestore instance
   * @param {Object} swarm - Hyperswarm instance
   * @param {Object} opts - Configuration options
   * @param {Buffer|string} opts.topic - Hyperswarm topic (Buffer or hex string)
   * @param {Object} [opts.contexts] - Context keys mapping: { name: contextKey }
   * @param {boolean} [opts.autoReplicate=true] - Auto-replicate store on connections
   * @param {string} [opts.role='peer'] - Role: 'owner' or 'peer'
   * @param {number} [opts.writerRequestTimeoutMs=30000] - How long a peer waits for a
   *   writer-granted/writer-error response after sending a writer-request before emitting
   *   'writer-request-timeout'. Without this, a peer whose request is never answered (owner
   *   offline, response lost, etc.) would wait indefinitely with no way to detect it.
   */
  constructor (graph, store, swarm, opts = {}) {
    super()
    this.#graph = graph
    this.#store = store
    this.#dataSwarm = swarm
    this.#topic = typeof opts.topic === 'string' ? Buffer.from(opts.topic, 'hex') : opts.topic
    this.#autoReplicate = opts.autoReplicate !== false
    this.#role = opts.role || 'peer'
    this.#writerRequestTimeoutMs = opts.writerRequestTimeoutMs || 30000

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
  }

  /**
   * Handle a swarm connection: replicate the store and wire up the
   * writer-auth protomux channel on the same connection.
   * @private
   */
  _handleDataConnection (conn, info) {
    if (this.#autoReplicate) {
      // Replicate the entire store (includes usercore, viewcore, context cores)
      // Corestore replicates all cores loaded in memory
      this.#store.replicate(conn)
    }
    this._wireWriterAuthChannel(conn, info)
    this.emit('data-connection', { conn, info })
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
   * Wire the writer-auth protocol as a protomux channel multiplexed onto
   * the same connection the data swarm already established, instead of a
   * separate connection/topic. Protomux.from(conn) reuses the exact muxer
   * store.replicate(conn) already attached to this connection (via
   * conn.userData) rather than creating a second one.
   * @private
   */
  _wireWriterAuthChannel (conn, info) {
    const Protomux = require('protomux')
    const mux = Protomux.from(conn)

    const channel = mux.createChannel({
      protocol: 'hypergraph-writer-auth',
      id: this.#topic,
      onopen: () => {
        this.emit('control-connection', { conn, info })
        if (this.#role === 'peer') {
          this._sendWriterRequest(conn)
          this._startWriterRequestTimeout(conn, info)
        }
      },
      onclose: () => {
        this._clearWriterRequestTimeout(conn)
        this.#channelsByConn.delete(conn)
      }
    })

    if (!channel) return // duplicate channel on this connection; shouldn't normally happen

    const writerRequestMsg = channel.addMessage({
      encoding: c.json,
      onmessage: (msg) => {
        this.emit('control-message', msg, conn, info)
        this._handleWriterRequest(msg, conn).catch((err) => {
          safetyCatch(err)
          this.emit('control-error', err)
        })
      }
    })
    const writerGrantedMsg = channel.addMessage({
      encoding: c.json,
      onmessage: (msg) => {
        this.emit('control-message', msg, conn, info)
        this._clearWriterRequestTimeout(conn)
        this.#hasReceivedWriterGrant = true
        this.emit('writer-granted', msg)
      }
    })
    const writerErrorMsg = channel.addMessage({
      encoding: c.json,
      onmessage: (msg) => {
        this.emit('control-message', msg, conn, info)
        this._clearWriterRequestTimeout(conn)
        this.emit('writer-error', msg)
      }
    })

    this.#channelsByConn.set(conn, { channel, writerRequestMsg, writerGrantedMsg, writerErrorMsg, writerRequestTimeout: null })
    channel.open()
  }

  /**
   * Start a timeout after sending a writer-request: if neither
   * writer-granted nor writer-error arrives on this connection within
   * writerRequestTimeoutMs, emit 'writer-request-timeout' so the
   * application can react (retry, reconnect, alert the user) instead of
   * waiting indefinitely with no signal that anything is wrong.
   * @private
   */
  _startWriterRequestTimeout (conn, info) {
    const entry = this.#channelsByConn.get(conn)
    if (!entry) return
    const timeout = setTimeout(() => {
      this.#pendingWriterRequestTimeouts.delete(timeout)
      entry.writerRequestTimeout = null
      this.emit('writer-request-timeout', { conn, info, timeoutMs: this.#writerRequestTimeoutMs })
    }, this.#writerRequestTimeoutMs)
    entry.writerRequestTimeout = timeout
    this.#pendingWriterRequestTimeouts.add(timeout)
  }

  /**
   * @private
   */
  _clearWriterRequestTimeout (conn) {
    const entry = this.#channelsByConn.get(conn)
    if (entry && entry.writerRequestTimeout) {
      clearTimeout(entry.writerRequestTimeout)
      this.#pendingWriterRequestTimeouts.delete(entry.writerRequestTimeout)
      entry.writerRequestTimeout = null
    }
  }

  /**
   * Handle writer-request message
   * @private
   */
  async _handleWriterRequest (msg, conn) {
    // Permission checking: for closed-mode contexts, ContextBase.addWriter()
    // checks whether the author has the 'context.write' privilege (per the
    // attached RoleBase) before granting, and signs the resulting event
    // with this peer's own identity keyPair — verified again at the apply
    // layer, the real enforced security boundary (see context-base.js).
    // Passing this peer's own identity means the check is "does the peer
    // receiving this request have the authority to grant it", which is the
    // natural authorization model here (the same one already used
    // elsewhere in this codebase for role-gated actions). Open-mode
    // contexts are unaffected — no keyPair/signature is needed there.
    const keyPair = this.#graph.identity.deviceKeyPair

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
            await context.addWriter(writerKey, { keyPair })
            granted[name] = true
          } catch (err) {
            // A denial for one context (e.g. not authorized in closed
            // mode) shouldn't block grants for other contexts in the same
            // request that the requester IS authorized for — reported via
            // granted[name] = false, not escalated to the outer catch.
            safetyCatch(err)
            granted[name] = false
          }
        }
      }

      // Send writer-granted response
      this._sendControlMessage(conn, 'writerGrantedMsg', {
        type: 'writer-granted',
        contexts: granted
      })
    } catch (err) {
      safetyCatch(err)
      // Send writer-error on failure
      this._sendControlMessage(conn, 'writerErrorMsg', {
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

    this._sendControlMessage(conn, 'writerRequestMsg', msg)
  }

  /**
   * Send a message over this connection's writer-auth channel.
   * @private
   * @param {string} slot - 'writerRequestMsg' | 'writerGrantedMsg' | 'writerErrorMsg'
   */
  _sendControlMessage (conn, slot, msg) {
    const entry = this.#channelsByConn.get(conn)
    if (!entry) return
    entry[slot].send(msg)
  }

  /**
   * Connect to the Hyperswarm topic
   */
  async connect () {
    if (this.#connected) return

    // Open contexts internally before joining the swarm
    await this._openContexts()

    // Set up swarm connection handler: replicate + wire the writer-auth
    // channel onto the same connection (see _handleDataConnection).
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

    // Join topic
    const discovery = this.#dataSwarm.join(this.#topic, { server: true, client: true })

    // Wait for discovery and the swarm to be ready with timeout.
    //
    // BUG FIX: withTimeout() silently swallows a timeout and returns null,
    // so connect() previously reported success (`connected = true`)
    // unconditionally after these steps, regardless of whether any of them
    // actually completed. 10s was also too short: DHT connections in
    // real-world testing on this project have been observed taking
    // anywhere from a few seconds up to ~90s. Both are fixed here: a much
    // more realistic timeout, and a warning emitted (not swallowed) if a
    // step actually times out, so a partial/failed connect is at least
    // observable instead of silently reported as success.
    await withTimeoutWarn(this, 'discovery flush', discovery.flushed(), 60000)
    await withTimeoutWarn(this, 'swarm flush', this.#dataSwarm.flush(), 60000)

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
   * Disconnect from the Hyperswarm topic
   */
  async disconnect () {
    if (!this.#connected) return

    this.#dataSwarm.leave(this.#topic)
    await this.#dataSwarm.flush()

    this.#connected = false
    this.emit('disconnected')
  }


  /**
   * Get the swarm instance
   */
  get dataSwarm () {
    return this.#dataSwarm
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
   * Get the number of active connections
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
   * Wait for a writer-granted (or writer-error) response, so a caller can
   * explicitly await the outcome instead of only ever passively listening
   * for the event or the 'writer-request-timeout' notification. Rejects if
   * neither arrives within timeoutMs, or if a writer-error is received.
   * @param {number} timeoutMs - Timeout in milliseconds (default: 30000)
   */
  async waitForWriterGrant (timeoutMs = this.#writerRequestTimeoutMs) {
    if (this.#hasReceivedWriterGrant) return true

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('writer-granted', onGranted)
        this.off('writer-error', onError)
        reject(new Error(`No writer-granted/writer-error response within ${timeoutMs}ms`))
      }, timeoutMs)

      const onGranted = () => {
        clearTimeout(timeout)
        this.off('writer-error', onError)
        resolve(true)
      }

      const onError = (msg) => {
        clearTimeout(timeout)
        this.off('writer-granted', onGranted)
        reject(new Error(msg && msg.message ? msg.message : 'writer-error received'))
      }

      this.on('writer-granted', onGranted)
      this.on('writer-error', onError)
    })
  }

  /**
   * Destroy the networking helper.
   *
   * Since the redesign removed the internally-created control swarm
   * entirely (see class doc comment), there is no longer any
   * internally-owned network resource for this method to tear down — the
   * single swarm was always owned by the caller. This just marks the
   * instance disconnected and removes its own listeners; the caller is
   * still responsible for destroying their own swarm (with
   * `{ force: true }` recommended, to skip Hyperswarm's own
   * discovery-session cleanup, which can invoke an unannounce() network
   * call with no visible internal timeout).
   */
  async destroy () {
    if (this.#connected) {
      this.#connected = false
      this.emit('disconnected')
    }

    // Clear any pending writer-request timeouts — without this, a timer
    // set up to fire in up to writerRequestTimeoutMs would be left running
    // after destroy(), which is exactly the class of lingering-handle bug
    // that took many rounds to track down and fix elsewhere in this test
    // suite. removeAllListeners() below means the resulting emit would be
    // a harmless no-op even if left running, but the timer handle itself
    // would still keep the process alive until it fires.
    for (const timeout of this.#pendingWriterRequestTimeouts) {
      clearTimeout(timeout)
    }
    this.#pendingWriterRequestTimeouts.clear()

    this.removeAllListeners()
  }

  /**
   * Generate bootstrap.json for a hypergraph
   * This is a static method that can be called without an instance
   *
   * @param {Object} graph - Hypergraph instance
   * @param {Object} opts - Bootstrap options
   * @param {Buffer|string} opts.topic - Swarm topic
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

    return {
      version: BOOTSTRAP_VERSION,
      topic: topic.toString('hex'),
      ownerCore: graph.key.toString('hex'),
      contexts: opts.contexts,
      metadata: opts.metadata || null
    }
  }

  /**
   * Create a HypergraphNetwork instance configured to join from a bootstrap
   * descriptor (as produced by generateBootstrap()) — the consumption-side
   * counterpart, mirroring how Hypergraph.join() consumes its own export()
   * bootstrap shape. Also opens the owner's user core on the joining graph
   * (via bootstrap.ownerCore), so the owner's data becomes visible to the
   * view once connected, without the caller needing to do that step
   * themselves.
   *
   * The returned instance is not yet connected — call .connect() on it as
   * usual.
   *
   * @param {Object} graph - Hypergraph instance (the joining peer's own graph)
   * @param {Object} store - Corestore instance
   * @param {Object} swarm - Hyperswarm instance
   * @param {Object} bootstrap - A bootstrap descriptor from generateBootstrap()
   * @param {Object} [opts] - Additional constructor options (e.g. role, autoReplicate)
   * @returns {Promise<HypergraphNetwork>}
   */
  static async connectFromBootstrap (graph, store, swarm, bootstrap, opts = {}) {
    if (!bootstrap || !bootstrap.topic) {
      throw new Error('A valid bootstrap descriptor with a topic is required')
    }

    // No version migration logic exists yet — reject anything that doesn't
    // match exactly, so an incompatible descriptor fails loudly and
    // immediately instead of being silently misinterpreted (e.g. a future
    // shape change adding/renaming fields this code doesn't know about).
    if (bootstrap.version !== BOOTSTRAP_VERSION) {
      throw new Error(`Unsupported bootstrap version: ${bootstrap.version ?? '(missing)'} (expected ${BOOTSTRAP_VERSION})`)
    }

    // Shape-validate every key in the bootstrap before using any of them.
    // Without this, a corrupted bootstrap with a correctly-shaped but wrong
    // key (confirmed directly: e.g. all zeros) doesn't throw anywhere —
    // openUserCore() silently succeeds with a permanently-empty, dead core
    // reference, since there's no way to distinguish "wrong key" from "key
    // whose owner just hasn't sent anything yet" without actually trying to
    // connect. This can't catch a wrong-but-plausible key either (the same
    // fundamental limit applies), but it does catch a corrupted/truncated/
    // mistyped one immediately instead of leaving a caller to debug a
    // silent non-sync with no error at all.
    if (!isValidHexKey(bootstrap.topic)) {
      throw new Error(`bootstrap.topic must be a 64-character hex string (32 bytes), got: ${describeForError(bootstrap.topic)}`)
    }
    if (bootstrap.ownerCore && !isValidHexKey(bootstrap.ownerCore)) {
      throw new Error(`bootstrap.ownerCore must be a 64-character hex string (32 bytes), got: ${describeForError(bootstrap.ownerCore)}`)
    }
    if (bootstrap.contexts) {
      for (const [name, key] of Object.entries(bootstrap.contexts)) {
        if (!isValidHexKey(key)) {
          throw new Error(`bootstrap.contexts.${name} must be a 64-character hex string (32 bytes), got: ${describeForError(key)}`)
        }
      }
    }

    if (bootstrap.ownerCore) {
      await graph.openUserCore(bootstrap.ownerCore)
    }

    return new this(graph, store, swarm, {
      topic: bootstrap.topic,
      contexts: bootstrap.contexts || {},
      role: opts.role || 'peer',
      autoReplicate: opts.autoReplicate
    })
  }
}
