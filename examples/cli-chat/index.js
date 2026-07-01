#!/usr/bin/env node

/**
 * CLI Chat Example (using usercore pattern like forum-web/chat-web)
 * 
 * A simple P2P chat application using Hypergraph:
 * - Messages stored on local usercore
 * - Peer announcements stored on local usercore (bypassing context replication)
 * - Usercores replicate via store.replicate()
 * 
 * This pattern works because usercores replicate reliably, unlike Autobase contexts.
 * 
 * Usage: node index.js
 */

const { Hypergraph, HypergraphNetworking } = require('../../index.js')
const Corestore = require('corestore')
const crypto = require('crypto')
const readline = require('readline')
const fs = require('fs')
const path = require('path')

// ============================================================================
// CONFIGURATION
// ============================================================================

function argValue (argv, key) {
  const pref = `-${key}=`
  const a = argv.find(v => v.startsWith(pref))
  return a ? a.slice(pref.length) : null
}

const username = argValue(process.argv.slice(2), 'u') || 'default'
const verbose = process.argv.includes('-v') || process.argv.includes('--verbose')
const STORAGE_DIR = path.join(__dirname, `.${username}-chat-storage`)
const BOOTSTRAP_PATH = path.join(__dirname, '.chat-bootstrap.json') // Shared bootstrap

function debug (tag, ...args) {
  if (verbose) console.log(`[DEBUG ${tag}]`, ...args)
}

function readJson (p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

function writeJson (p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(value, null, 2))
}

// Hard-coded topic for Hyperswarm (all peers use this)
const TOPIC = crypto.createHash('sha256').update('hypergraph-cli-chat').digest()

// ============================================================================
// CHAT APPLICATION (using usercore pattern)
// ============================================================================

class ChatApp {
  constructor (graph, store, networking, contextKey) {
    this.graph = graph
    this.store = store
    this.networking = networking
    this.contextKey = contextKey
    this.remoteUserCores = new Map()
    this.username = username
    this.knownPeerKeys = new Set()
  }

  /**
   * Announce local usercore via usercore (bypassing context replication)
   */
  async announceUserCore () {
    try {
      const author = this.graph.key.toString('hex')
      debug('ANNOUNCE', `Announcing usercore: usercore:${author} to chatroom`)
      
      // Store announcement in local usercore (not context)
      const announcement = await this.graph.put({
        type: 'announce',
        username: this.username,
        timestamp: Date.now()
      })
      
      debug('ANNOUNCE', `Announcement stored in usercore: ${announcement.id}`)
      console.log('[INFO] Announced usercore')
    } catch (err) {
      console.error('[ERROR] Failed to announce usercore:', err.message)
      debug('ANNOUNCE', 'Announce error:', err)
    }
  }

  /**
   * Discover peer usercores via peer connections
   */
  async discoverPeerCores () {
    try {
      debug('DISCOVER', 'Starting peer discovery')
      
      // Try to open usercores for all connected peers
      // HypergraphNetworking tracks peer connections internally
      // We'll rely on peer-join events to trigger discovery
      debug('DISCOVER', 'Discovery relies on peer-join events')
      
      // Also try HypergraphNetworking's discoverPeerCores as a fallback
      try {
        const discovered = await this.networking.discoverPeerCores(this.contextKey, 'chatroom')
        debug('DISCOVER', `HypergraphNetworking discovered ${discovered.length} peers via context`)
        
        for (const keyHex of discovered) {
          if (!this.knownPeerKeys.has(keyHex)) {
            await this.openRemoteUserCore(keyHex)
          }
        }
      } catch (err) {
        debug('DISCOVER', `Context-based discovery failed: ${err.message}`)
      }
    } catch (err) {
      console.error('[ERROR] Failed to discover peer cores:', err.message)
      debug('DISCOVER', 'Discovery error:', err)
    }
  }

  /**
   * Open a remote usercore and watch for messages
   */
  async openRemoteUserCore (keyHex) {
    try {
      debug('OPEN', `Opening usercore for peer ${keyHex.slice(0, 16)}...`)
      const userCore = await this.graph.openUserCore(keyHex)
      this.remoteUserCores.set(keyHex, userCore)
      console.log(`[INFO] Discovered peer: ${keyHex.slice(0, 16)}...`)
      debug('OPEN', `Usercore opened successfully, has core: ${!!userCore.core}`)

      // Watch for new messages
      if (userCore.core) {
        debug('OPEN', `Setting up append event listener for ${keyHex.slice(0, 16)}...`)
        userCore.core.on('append', () => {
          debug('APPEND', `Append event on ${keyHex.slice(0, 16)}...`)
          this.readMessages(userCore)
        })
        // Read existing messages
        debug('OPEN', `Reading existing messages from ${keyHex.slice(0, 16)}...`)
        await this.readMessages(userCore)
      } else {
        debug('OPEN', `WARNING: No core object for usercore ${keyHex.slice(0, 16)}...`)
      }
    } catch (err) {
      console.error(`[ERROR] Failed to open usercore ${keyHex.slice(0, 16)}...:`, err.message)
      debug('OPEN', `Failed to open usercore:`, err)
    }
  }

  /**
   * Read messages from a usercore
   */
  async readMessages (userCore) {
    try {
      debug('READ', 'Starting to read messages from usercore')
      const stream = userCore.createReadStream()
      let msgCount = 0
      
      for await (const msg of stream) {
        msgCount++
        debug('READ', `Found message: type=${msg.type}, id=${msg.id?.slice(0, 8)}...`)
        
        if (msg.type === 'message') {
          debug('READ', `Message is type 'message', fetching content`)
          const content = await this.graph.getContent(msg.id, 'text')
          debug('READ', `Content retrieved: "${content}"`)
          const timestamp = new Date(msg.timestamp).toLocaleTimeString()
          console.log(`[${timestamp}] ${msg.username}: ${content}`)
        }
      }
      
      debug('READ', `Finished reading, total messages: ${msgCount}`)
    } catch (err) {
      console.error('[ERROR] Failed to read messages:', err.message)
      debug('READ', 'Read error:', err)
    }
  }

  /**
   * Send a message
   */
  async sendMessage (text) {
    try {
      debug('SEND', `Sending message: "${text}"`)
      const message = await this.graph.put({
        type: 'message',
        username: this.username,
        timestamp: Date.now()
      })
      debug('SEND', `Message created with id: ${message.id}`)
      
      await this.graph.putContent(message.id, text, 'text')
      debug('SEND', `Content stored for message ${message.id}`)
      
      // Check local usercore length
      if (this.graph.userCore && this.graph.userCore.core) {
        const length = this.graph.userCore.core.length
        debug('SEND', `Local usercore length after send: ${length}`)
      }
      
      console.log(`[INFO] Sent message: ${text}`)
    } catch (err) {
      console.error('[ERROR] Failed to send message:', err.message)
      debug('SEND', 'Send error:', err)
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main () {
  console.log('=== Hypergraph CLI Chat (with HypergraphNetworking) ===\n')

  // Create storage (per-user directory to avoid file locks)
  // Note: On Windows, RocksDB may still have file lock issues.
  // For testing multiple instances on Windows, you may need to copy
  // the entire cli-chat directory to separate locations.
  fs.mkdirSync(STORAGE_DIR, { recursive: true })
  const store = new Corestore(STORAGE_DIR)

  // Initialize Hypergraph
  const graph = new Hypergraph(store)
  await graph.ready()
  console.log(`[INFO] Local usercore: ${graph.key.toString('hex').slice(0, 16)}...`)

  // Load or create bootstrap (like forum-web)
  let bootstrap = readJson(BOOTSTRAP_PATH)

  if (!bootstrap) {
    // First run: create context and save to bootstrap
    console.log('[INFO] First run - creating context...')
    const contextKey = await graph.createContext({ writeMode: 'open' })
    bootstrap = {
      version: 1,
      topic: TOPIC.toString('hex'),
      context: contextKey
    }
    writeJson(BOOTSTRAP_PATH, bootstrap)
    console.log('[INFO] Bootstrap saved to', BOOTSTRAP_PATH)
  }

  const contextKey = Buffer.from(bootstrap.context, 'hex')
  console.log(`[INFO] Context: ${contextKey.toString('hex').slice(0, 16)}...`)

  // Open context
  const context = await graph.openContext(contextKey, { writeMode: 'open' })
  await context.ready()
  debug('CONTEXT', `Context opened: ${contextKey.toString('hex').slice(0, 16)}...`)
  debug('CONTEXT', `Context writable: ${context.writable}`)

  // Create HypergraphNetworking helper
  const networking = new HypergraphNetworking(graph, store, {
    topic: TOPIC,
    contexts: { chatroom: contextKey },
    autoAddWriters: true
  })

  // Connect to swarm
  await networking.connect()
  console.log('[INFO] Connected to swarm\n')

  // Create chat app
  const chat = new ChatApp(graph, store, networking, contextKey)

  // Listen for peer join events (after chat is created)
  networking.on('peer-join', async ({ peerKey, conn, info }) => {
    console.log(`[INFO] Peer connected: ${peerKey.slice(0, 16)}...`)
    debug('NETWORKING', `Peer join event: ${peerKey.slice(0, 16)}...`)
    
    // Try to open the peer's usercore directly using their swarm public key
    // In Hypergraph, the swarm public key is the same as the usercore key
    try {
      await chat.openRemoteUserCore(peerKey)
    } catch (err) {
      debug('NETWORKING', `Failed to open usercore for ${peerKey.slice(0, 16)}...:`, err.message)
    }
  })

  // Announce usercore
  await chat.announceUserCore()

  // Discover peers periodically
  await chat.discoverPeerCores()
  setInterval(() => chat.discoverPeerCores().catch(() => {}), 5000)

  // Setup readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  console.log('Type messages and press Enter to send. Press Ctrl+C to exit.\n')

  // Handle user input
  rl.on('line', async (input) => {
    const text = input.trim()
    if (text) {
      await chat.sendMessage(text)
    }
    rl.prompt()
  })

  rl.prompt()

  // Handle cleanup
  process.on('SIGINT', async () => {
    console.log('\n[INFO] Shutting down...')
    await networking.disconnect()
    await networking.destroy()
    await store.close()
    process.exit(0)
  })
}

main().catch(err => {
  console.error('[FATAL]', err)
  process.exit(1)
})
