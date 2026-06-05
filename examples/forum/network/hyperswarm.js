const Hyperswarm = require('hyperswarm')
const crypto = require('crypto')
const EventEmitter = require('events')

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withTimeout (promise, ms) {
  return await Promise.race([
    promise,
    sleep(ms).then(() => null)
  ])
}

module.exports = class ForumNetwork extends EventEmitter {
  constructor (store, opts = {}) {
    super()

    this.store = store
    this.maxPeers = opts.maxPeers || 16
    this.role = opts.role || 'peer'

    this.dataSwarm = new Hyperswarm({ maxPeers: this.maxPeers })
    // Share the same DHT instance to keep connection behaviour predictable.
    this.controlSwarm = new Hyperswarm({ maxPeers: this.maxPeers, dht: this.dataSwarm.dht })

    this.connections = 0
    this._dataTopic = null
    this._controlTopic = null

    this.dataSwarm.on('connection', (conn) => {
      this.connections++
      this.store.replicate(conn)
      conn.on('error', (err) => {
        // Prevent unhandled 'error' events from crashing the process.
        // Timeouts/disconnects are expected when peers stop.
        this.emit('data-error', err)
      })
      conn.on('close', () => {
        this.connections--
      })
    })

    this.controlSwarm.on('connection', (conn, info) => {
      this.connections++
      this._wireControlConnection(conn, info)
      conn.on('error', (err) => {
        this.emit('control-error', err)
      })
      conn.on('close', () => {
        this.connections--
      })
    })
  }

  _deriveControlTopic (discoveryKey) {
    return crypto
      .createHash('sha256')
      .update('hypergraph-forum-control-v1')
      .update(discoveryKey)
      .digest()
  }

  _wireControlConnection (conn, info) {
    let buf = ''
    conn.on('data', (data) => {
      buf += data.toString('utf-8')

      for (;;) {
        const idx = buf.indexOf('\n')
        if (idx === -1) break
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line) continue

        let msg = null
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }

        this.emit('control-message', msg, conn, info)
      }
    })

    this.emit('control-connection', conn, info)
  }

  sendControl (conn, msg) {
    const line = JSON.stringify(msg) + '\n'
    conn.write(Buffer.from(line, 'utf-8'))
  }

  async join (discoveryKey) {
    this._dataTopic = discoveryKey
    this._controlTopic = this._deriveControlTopic(discoveryKey)

    const d1 = this.dataSwarm.join(this._dataTopic, { server: true, client: true })

    const d2 = this.controlSwarm.join(this._controlTopic, { server: true, client: true })

    // Hyperswarm's flushed/flush can hang indefinitely in some environments
    // (e.g. limited DHT bootstrap). Joining still works, so we only wait briefly.
    await withTimeout(d1.flushed(), 2000)
    await withTimeout(d2.flushed(), 2000)
    await withTimeout(this.dataSwarm.flush(), 2000)
    await withTimeout(this.controlSwarm.flush(), 2000)

    return { data: d1, control: d2 }
  }

  async close () {
    await this.dataSwarm.destroy()
    await this.controlSwarm.destroy()
  }
}
