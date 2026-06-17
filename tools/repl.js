#!/usr/bin/env node

const readline = require('readline')
const path = require('path')
const fs = require('fs')
const Corestore = require('corestore')
const { Hypergraph } = require('../index.js')
const { executeCommand } = require('./repl/commands')
const { formatOutput } = require('./repl/formatter')
const { createCompleter } = require('./repl/completer')

let VERSION = '0.0.0'
try {
  VERSION = require('../package.json').version
} catch {
  VERSION = 'dev'
}

function printBanner () {
  console.log(`Hypergraph REPL v${VERSION}`)
  console.log('Type "help" for available commands, ".exit" to quit')
  console.log('')
}

async function main () {
  const args = process.argv.slice(2)
  let storagePath = null
  let graph = null
  let store = null

  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--storage' && args[i + 1]) {
      storagePath = args[i + 1]
      i++
    }
  }

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: createCompleter(),
    history: [],
    historySize: 1000
  })

  printBanner()

  // REPL state
  const state = {
    graph,
    store,
    storagePath,
    rl
  }

  // If storage path provided, try to open existing graph
  if (storagePath) {
    try {
      if (!fs.existsSync(storagePath)) {
        console.log(`Storage path does not exist: ${storagePath}`)
        console.log('Use "new <path>" to create a new graph')
      } else {
        store = new Corestore(storagePath)
        graph = new Hypergraph(store)
        await graph.ready()
        state.graph = graph
        state.store = store
        console.log(`Opened graph from: ${storagePath}`)
        console.log(`Graph key: ${graph.key.toString('hex')}`)
        console.log('')
      }
    } catch (err) {
      console.error(`Error opening graph: ${err.message}`)
    }
  }

  // REPL loop
  const prompt = () => {
    const prefix = graph ? 'hg' : '(no graph)'
    rl.setPrompt(`${prefix}> `)
    rl.prompt()
  }

  prompt()

  rl.on('line', async (line) => {
    line = line.trim()

    // Skip empty lines
    if (!line) {
      prompt()
      return
    }

    // Handle dot commands (meta commands)
    if (line.startsWith('.')) {
      if (line === '.exit' || line === '.quit') {
        console.log('Goodbye!')
        if (graph) await graph.close()
        if (store) await store.close()
        rl.close()
        process.exit(0)
      } else if (line === '.help' || line === '.?') {
        console.log('Meta commands:')
        console.log('  .exit, .quit  - Exit the REPL')
        console.log('  .help, .?    - Show this help')
        console.log('  .commands     - List all commands')
      } else if (line === '.commands') {
        console.log('Available commands:')
        console.log('  Graph Management: new, open, close, status')
        console.log('  CRUD: put, get, del, content, put-content')
        console.log('  Relations: relate, unrelate, edges')
        console.log('  Tags: tag, untag, by-tag')
        console.log('  Queries: query, nodes, count-edges')
        console.log('  Identity: identity, create-rolebase, open-rolebase')
        console.log('  Contexts: create-context, open-context, contexts')
        console.log('  Moderation: moderate, query-moderation')
        console.log('  Sync: update, cores')
        console.log('  Help: help')
      } else {
        console.log(`Unknown meta command: ${line}`)
        console.log('Type .help for available meta commands')
      }
      prompt()
      return
    }

    // Execute command
    try {
      const result = await executeCommand(line, state)
      if (result !== undefined) {
        const formatted = formatOutput(result)
        console.log(formatted)
      }
    } catch (err) {
      console.error(`Error: ${err.message}`)
      if (process.env.DEBUG) {
        console.error(err.stack)
      }
    }

    prompt()
  })

  rl.on('SIGINT', () => {
    console.log('\nType .exit to quit, or press Ctrl+C again to force quit')
  })

  rl.on('close', async () => {
    if (graph) await graph.close()
    if (store) await store.close()
    process.exit(0)
  })
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
