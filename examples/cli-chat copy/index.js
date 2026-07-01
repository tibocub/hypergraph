#!/usr/bin/env node

/**
 * CLI Chat Example (using usercore pattern like forum-web/chat-web)
 * 
 * A simple P2P chat application using Hypergraph:
 * - Messages stored on local usercore
 * - Context used for coordination (announcing/discovering usercores)
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

const STORAGE_DIR = path.join(__dirname, '.chat-storage')

// Hard-coded context key for coordination (usercore discovery)
const CHATROOM_CONTEXT_KEY = Buffer.from('0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff', 'hex')

// Hard-coded topic for Hyperswarm (all peers use this)
const TOPIC = crypto.createHash('sha256').update('hypergraph-cli-chat').digest()

// ============================================================================
// CHAT APPLICATION (using usercore pattern)
// ============================================================================

class ChatApp {
  constructor (graph, store, networking, context) {
    this.graph = graph
    this.store = store
    this.networking = networking
    this.context = context
    this.remoteUserCores = new Map()
    this.username = 'Anonymous'
    this.knownPeerKeys = new Set()
  }

  /**
   * Announce local usercore via context relation
   */
  async announceUserCore () {
    try {
      const author = this.graph.key.toString('hex')
      await this.graph.relate({
        from: `usercore:${author}`,
        to: 'chatroom',
        type: 'announce',
        author,
        context: CHATROOM_CONTEXT_KEY
      })
      console.log('[INFO] Announced usercore to context')
    } catch (err) {
      console.error('[ERROR] Failed to announce usercore:', err.message)
    }
  }

  /**
   * Discover peer usercores by querying context
   */
  async discoverPeerCores () {
    try {
      await this.graph.update()
      const relations = await this.graph.query({
        type: 'announce',
        to: 'chatroom',
        context: CHATROOM_CONTEXT_KEY
      })

      // graph.query returns an array of relations
      if (Array.isArray(relations)) {
        for (const rel of relations) {
          const from = rel.from ? String(rel.from) : ''
          if (!from.startsWith('usercore:')) continue
          
          const keyHex = from.slice('usercore:'.length)
          if (!keyHex || keyHex === this.graph.key.toString('hex')) continue
          
          if (this.knownPeerKeys.has(keyHex)) continue
          this.knownPeerKeys.add(keyHex)

          await this.openRemoteUserCore(keyHex)
        }
      }
    } catch (err) {
      console.error('[ERROR] Failed to discover peer cores:', err.message)
    }
  }

  /**
   * Open a remote usercore and watch for messages
   */
  async openRemoteUserCore (keyHex) {
    try {
      const userCore = await this.graph.openUserCore(keyHex)
      this.remoteUserCores.set(keyHex, userCore)
      console.log(`[INFO] Discovered peer: ${keyHex.slice(0, 16)}...`)

      // Watch for new messages
      if (userCore.core) {
        userCore.core.on('append', () => this.readMessages(userCore))
        // Read existing messages
        await this.readMessages(userCore)
      }
    } catch (err) {
      console.error(`[ERROR] Failed to open usercore ${keyHex.slice(0, 16)}...:`, err.message)
    }
  }

  /**
   * Read messages from a usercore
   */
  async readMessages (userCore) {
    try {
      const stream = userCore.createReadStream()
      for await (const msg of stream) {
        if (msg.type === 'message') {
          const content = await this.graph.getContent(msg.id, 'text')
          const timestamp = new Date(msg.timestamp).toLocaleTimeString()
          console.log(`[${timestamp}] ${msg.username}: ${content}`)
        }
      }
    } catch (err) {
      console.error('[ERROR] Failed to read messages:', err.message)
    }
  }

  /**
   * Send a message
   */
  async sendMessage (text) {
    try {
      const message = await this.graph.put({
        type: 'message',
        username: this.username,
        timestamp: Date.now()
      })
      await this.graph.putContent(message.id, text, 'text')
      console.log(`[INFO] Sent message: ${text}`)
    } catch (err) {
      console.error('[ERROR] Failed to send message:', err.message)
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main () {
  console.log('=== Hypergraph CLI Chat (with HypergraphNetworking) ===\n')

  // Create storage
  fs.mkdirSync(STORAGE_DIR, { recursive: true })
  const store = new Corestore(STORAGE_DIR)

  // Initialize Hypergraph
  const graph = new Hypergraph(store)
  await graph.ready()
  console.log(`[INFO] Local usercore: ${graph.key.toString('hex').slice(0, 16)}...`)

  // Open context for coordination
  const context = await graph.openContext(CHATROOM_CONTEXT_KEY, { writeMode: 'open' })
  await context.ready()
  console.log(`[INFO] Context: ${CHATROOM_CONTEXT_KEY.toString('hex').slice(0, 16)}...`)

  // Create HypergraphNetworking helper
  const networking = new HypergraphNetworking(graph, store, {
    topic: TOPIC,
    contexts: { chatroom: CHATROOM_CONTEXT_KEY },
    autoAddWriters: true
  })

  // Connect to swarm
  await networking.connect()
  console.log('[INFO] Connected to swarm\n')

  // Create chat app
  const chat = new ChatApp(graph, store, networking, context)

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
