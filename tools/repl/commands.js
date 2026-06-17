const path = require('path')
const fs = require('fs')
const Corestore = require('corestore')
const { Hypergraph } = require('../../index.js')

/**
 * Execute a command in the REPL.
 * @param {string} line - The command line to execute
 * @param {Object} state - The REPL state (graph, store, storagePath, rl)
 * @returns {Promise<*>} The result of the command
 */
async function executeCommand (line, state) {
  const { graph, store, storagePath, rl } = state
  
  // Parse the command
  const parts = line.split(/\s+/)
  const cmd = parts[0].toLowerCase()
  const args = parts.slice(1)
  
  // Check if graph is required
  if (!graph && !['new', 'open', 'help'].includes(cmd)) {
    throw new Error('No graph open. Use "new <path>" or "open <path>" first.')
  }
  
  switch (cmd) {
    // Graph Management
    case 'new':
      return cmdNew(args, state)
    case 'open':
      return cmdOpen(args, state)
    case 'close':
      return cmdClose(state)
    case 'status':
      return cmdStatus(state)
    
    // CRUD Operations
    case 'put':
      return cmdPut(args, graph)
    case 'get':
      return cmdGet(args, graph)
    case 'del':
      return cmdDel(args, graph)
    case 'content':
      return cmdContent(args, graph)
    case 'put-content':
      return cmdPutContent(args, graph)
    
    // Relations
    case 'relate':
      return cmdRelate(args, graph)
    case 'unrelate':
      return cmdUnrelate(args, graph)
    case 'edges':
      return cmdEdges(args, graph)
    
    // Tags
    case 'tag':
      return cmdTag(args, graph)
    case 'untag':
      return cmdUntag(args, graph)
    case 'by-tag':
      return cmdByTag(args, graph)
    
    // Queries
    case 'query':
      return cmdQuery(args, graph)
    case 'nodes':
      return cmdNodes(args, graph)
    case 'count-edges':
      return cmdCountEdges(args, graph)
    
    // Identity and Roles
    case 'identity':
      return cmdIdentity(args, graph)
    case 'create-rolebase':
      return cmdCreateRoleBase(graph)
    case 'open-rolebase':
      return cmdOpenRoleBase(args, graph)
    case 'set-role':
      return cmdSetRole(args, graph)
    case 'can':
      return cmdCan(args, graph)
    
    // Context Management
    case 'create-context':
      return cmdCreateContext(args, graph)
    case 'open-context':
      return cmdOpenContext(args, graph)
    case 'contexts':
      return cmdContexts(graph)
    
    // Moderation
    case 'moderate':
      return cmdModerate(args, graph)
    case 'query-moderation':
      return cmdQueryModeration(args, graph)
    
    // Sync
    case 'update':
      return cmdUpdate(graph)
    case 'cores':
      return cmdCores(graph)
    
    // Help
    case 'help':
      return cmdHelp(args)
    
    default:
      throw new Error(`Unknown command: ${cmd}. Type "help" for available commands.`)
  }
}

// ===== Graph Management =====

async function cmdNew (args, state) {
  if (args.length === 0) {
    throw new Error('Usage: new <path>')
  }
  
  const storagePath = args[0]
  
  // Close existing graph if open
  if (state.graph) {
    await state.graph.close()
  }
  if (state.store) {
    await state.store.close()
  }
  
  // Create directory if it doesn't exist
  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true })
  }
  
  // Create new graph
  const store = new Corestore(storagePath)
  const graph = new Hypergraph(store)
  await graph.ready()
  
  state.graph = graph
  state.store = store
  state.storagePath = storagePath
  
  return {
    message: 'Graph created',
    path: storagePath,
    key: graph.key.toString('hex')
  }
}

async function cmdOpen (args, state) {
  if (args.length === 0) {
    throw new Error('Usage: open <path>')
  }
  
  const storagePath = args[0]
  
  if (!fs.existsSync(storagePath)) {
    throw new Error(`Path does not exist: ${storagePath}`)
  }
  
  // Close existing graph if open
  if (state.graph) {
    await state.graph.close()
  }
  if (state.store) {
    await state.store.close()
  }
  
  // Open existing graph
  const store = new Corestore(storagePath)
  const graph = new Hypergraph(store)
  await graph.ready()
  
  state.graph = graph
  state.store = store
  state.storagePath = storagePath
  
  return {
    message: 'Graph opened',
    path: storagePath,
    key: graph.key.toString('hex')
  }
}

async function cmdClose (state) {
  if (!state.graph) {
    throw new Error('No graph open')
  }
  
  await state.graph.close()
  await state.store.close()
  
  state.graph = null
  state.store = null
  state.storagePath = null
  
  return 'Graph closed'
}

async function cmdStatus (state) {
  if (!state.graph) {
    return 'No graph open'
  }
  
  const status = {
    storagePath: state.storagePath,
    key: state.graph.key.toString('hex'),
    discoveryKey: state.graph.discoveryKey.toString('hex'),
    userCoreKey: state.graph.core ? state.graph.core.key.toString('hex') : null
  }
  
  return status
}

// ===== CRUD Operations =====

async function cmdPut (args, graph) {
  if (args.length === 0) {
    throw new Error('Usage: put <type> [json]')
  }
  
  const type = args[0]
  let data = {}
  
  if (args.length > 1) {
    const jsonStr = args.slice(1).join(' ')
    try {
      data = JSON.parse(jsonStr)
    } catch (err) {
      throw new Error('Invalid JSON: ' + err.message)
    }
  }
  
  const node = await graph.put({ type, ...data })
  return node
}

async function cmdGet (args, graph) {
  if (args.length === 0) {
    throw new Error('Usage: get <id>')
  }
  
  const id = args[0]
  const node = await graph.get(id)
  
  if (!node) {
    throw new Error(`Entity not found: ${id}`)
  }
  
  return node
}

async function cmdDel (args, graph) {
  if (args.length === 0) {
    throw new Error('Usage: del <id>')
  }
  
  const id = args[0]
  await graph.del(id)
  return `Deleted: ${id}`
}

async function cmdContent (args, graph) {
  if (args.length === 0) {
    throw new Error('Usage: content <id>')
  }
  
  const id = args[0]
  const content = await graph.getContent(id)
  
  if (!content) {
    throw new Error(`Content not found for: ${id}`)
  }
  
  return content
}

async function cmdPutContent (args, graph) {
  if (args.length < 2) {
    throw new Error('Usage: put-content <id> <body> [type]')
  }
  
  const id = args[0]
  const body = args[1]
  const type = args[2] || 'text'
  
  await graph.putContent(id, body, type)
  return `Content added to: ${id}`
}

// ===== Relations =====

async function cmdRelate (args, graph) {
  if (args.length < 3) {
    throw new Error('Usage: relate <from> <to> <type> [context]')
  }
  
  const from = args[0]
  const to = args[1]
  const type = args[2]
  const context = args[3]
  
  if (!context) {
    throw new Error('Context is required. Use "create-context" first or specify context key.')
  }
  
  const edge = await graph.relate({
    from,
    to,
    type,
    author: graph.key.toString('hex'),
    context
  })
  
  return edge
}

async function cmdUnrelate (args, graph) {
  if (args.length < 3) {
    throw new Error('Usage: unrelate <from> <to> <type> [context]')
  }
  
  const from = args[0]
  const to = args[1]
  const type = args[2]
  const context = args[3]
  
  if (!context) {
    throw new Error('Context is required')
  }
  
  await graph.unrelate({
    from,
    to,
    type,
    author: graph.key.toString('hex'),
    context
  })
  
  return 'Relation removed'
}

async function cmdEdges (args, graph) {
  if (args.length === 0) {
    throw new Error('Usage: edges <id> [direction] [type]')
  }
  
  const id = args[0]
  const direction = args[1] || 'out'
  const type = args[2]
  
  const opts = { direction }
  if (type) opts.type = type
  
  const edges = []
  for await (const edge of graph.edges(id, opts)) {
    edges.push(edge)
  }
  
  return edges
}

// ===== Tags =====

async function cmdTag (args, graph) {
  if (args.length < 3) {
    throw new Error('Usage: tag <id> <tag> <context>')
  }
  
  const id = args[0]
  const tag = args[1]
  const context = args[2]
  
  await graph.tag(id, tag, {
    author: graph.key.toString('hex'),
    context
  })
  
  return `Tag "${tag}" added to ${id}`
}

async function cmdUntag (args, graph) {
  if (args.length < 3) {
    throw new Error('Usage: untag <id> <tag> <context>')
  }
  
  const id = args[0]
  const tag = args[1]
  const context = args[2]
  
  await graph.untag(id, tag, {
    author: graph.key.toString('hex'),
    context
  })
  
  return `Tag "${tag}" removed from ${id}`
}

async function cmdByTag (args, graph) {
  if (args.length < 2) {
    throw new Error('Usage: by-tag <tag> <context>')
  }
  
  const tag = args[0]
  const context = args[1]
  
  const nodes = []
  for await (const node of graph.getByTag(tag, { context })) {
    nodes.push(node)
  }
  
  return nodes
}

// ===== Queries =====

async function cmdQuery (args, graph) {
  if (args.length === 0) {
    throw new Error('Usage: query <javascript-expression>')
  }
  
  const expr = args.join(' ')
  
  try {
    // Create a safe-ish evaluation context
    const result = eval(`(async () => { ${expr} })()`)
    return await result
  } catch (err) {
    throw new Error(`Query error: ${err.message}`)
  }
}

async function cmdNodes (args, graph) {
  const type = args[0]
  
  if (!type) {
    throw new Error('Usage: nodes <type>')
  }
  
  const nodes = await graph.query().type(type).toArray()
  return nodes
}

async function cmdCountEdges (args, graph) {
  if (args.length < 2) {
    throw new Error('Usage: count-edges <id> <type> [direction]')
  }
  
  const id = args[0]
  const type = args[1]
  const direction = args[2] || 'out'
  
  if (direction === 'in') {
    return await graph.countEdgesIn(id, type)
  } else {
    return await graph.countEdgesOut(id, type)
  }
}

// ===== Identity and Roles =====

async function cmdIdentity (args, graph) {
  if (args.length === 0) {
    // Get own identity
    const identity = await graph.getIdentity(graph.key.toString('hex'))
    return identity || 'No identity set'
  }
  
  // Set identity
  const username = args[0]
  const bio = args[1] || null
  
  const identity = await graph.setIdentity({ username, bio })
  return identity
}

async function cmdCreateRoleBase (graph) {
  const keyHex = await graph.createRoleBase()
  return { roleBaseKey: keyHex }
}

async function cmdOpenRoleBase (args, graph) {
  if (args.length === 0) {
    throw new Error('Usage: open-rolebase <key>')
  }
  
  const keyHex = args[0]
  await graph.openRoleBase(keyHex)
  return `Role base opened: ${keyHex}`
}

async function cmdSetRole (args, graph) {
  if (args.length < 2) {
    throw new Error('Usage: set-role <pubkey> <role>')
  }
  
  const pubkey = args[0]
  const role = args[1]
  
  await graph.setRole(pubkey, role)
  return `Role "${role}" set for ${pubkey}`
}

async function cmdCan (args, graph) {
  if (args.length < 2) {
    throw new Error('Usage: can <pubkey> <action>')
  }
  
  const pubkey = args[0]
  const action = args[1]
  
  const result = await graph.can(pubkey, action)
  return result
}

// ===== Context Management =====

async function cmdCreateContext (args, graph) {
  const writeMode = args[0] || 'open'
  
  if (writeMode !== 'open' && writeMode !== 'closed') {
    throw new Error('writeMode must be "open" or "closed"')
  }
  
  const keyHex = await graph.createContext({ writeMode })
  return { contextKey: keyHex, writeMode }
}

async function cmdOpenContext (args, graph) {
  if (args.length === 0) {
    throw new Error('Usage: open-context <key> [writeMode]')
  }
  
  const keyHex = args[0]
  const writeMode = args[1]
  
  const ctx = await graph.openContext(keyHex, writeMode ? { writeMode } : {})
  return {
    contextKey: ctx.key.toString('hex'),
    writable: ctx.writable
  }
}

async function cmdContexts (graph) {
  // Contexts are managed internally - track them manually in your application
  return 'Contexts are managed internally. Use create-context and open-context to work with contexts.'
}

// ===== Moderation =====

async function cmdModerate (args, graph) {
  if (args.length < 2) {
    throw new Error('Usage: moderate <target> <action> [reason] [context]')
  }
  
  const target = args[0]
  const action = args[1]
  const reason = args[2] || null
  const context = args[3]
  
  if (!context) {
    throw new Error('Context is required')
  }
  
  const crypto = require('hypercore-crypto')
  const keyPair = crypto.keyPair()
  
  const event = await graph.moderateAction({
    context,
    action,
    target,
    reason,
    keyPair
  })
  
  return event
}

async function cmdQueryModeration (args, graph) {
  if (args.length < 2) {
    throw new Error('Usage: query-moderation <target> <context>')
  }
  
  const target = args[0]
  const context = args[1]
  
  const events = []
  for await (const ev of graph.queryContext({
    type: 'moderation',
    context,
    target
  })) {
    events.push(ev)
  }
  
  return events
}

// ===== Sync =====

async function cmdUpdate (graph) {
  await graph.update()
  return 'Indexes updated'
}

async function cmdCores (graph) {
  return graph.getCores()
}

// ===== Help =====

function cmdHelp (args) {
  if (args.length === 0) {
    return `Available commands:

Graph Management:
  new <path>              - Create new graph at path
  open <path>             - Open existing graph from path
  close                   - Close current graph
  status                  - Show current graph info

CRUD Operations:
  put <type> [json]       - Create entity
  get <id>                - Get entity by ID
  del <id>                - Delete entity
  content <id>            - Get content for entity
  put-content <id> <body> [type] - Add content to entity

Relations:
  relate <from> <to> <type> [context] - Create relation
  unrelate <from> <to> <type> [context] - Remove relation
  edges <id> [direction] [type] - List edges

Tags:
  tag <id> <tag> <context> - Add tag
  untag <id> <tag> <context> - Remove tag
  by-tag <tag> <context> - Get entities by tag

Queries:
  query <expression> - Run JavaScript query
  nodes <type> - Get nodes by type
  count-edges <id> <type> [direction] - Count edges

Identity and Roles:
  identity [username] [bio] - Set/get identity
  create-rolebase - Create role base
  open-rolebase <key> - Open role base
  set-role <pubkey> <role> - Assign role
  can <pubkey> <action> - Check permission

Contexts:
  create-context [writeMode] - Create context
  open-context <key> [writeMode] - Open context
  contexts - List open contexts

Moderation:
  moderate <target> <action> [reason] [context] - Create moderation
  query-moderation <target> <context> - Query moderation events

Sync:
  update - Update all indexes
  cores - List all cores

Help:
  help [command] - Show detailed help for command
  .commands - List all commands
  .exit - Exit REPL
`
  }
  
  const command = args[0]
  const helpText = getCommandHelp(command)
  if (helpText) {
    return helpText
  }
  
  throw new Error(`No help available for: ${command}`)
}

function getCommandHelp (command) {
  const help = {
    new: 'Create a new graph at the specified path.\nUsage: new <path>\nExample: new ./my-graph',
    open: 'Open an existing graph from the specified path.\nUsage: open <path>\nExample: open ./my-graph',
    put: 'Create a new entity with the specified type.\nUsage: put <type> [json]\nExample: put post\nExample: put post {"body":"hello"}',
    get: 'Get an entity by its ID.\nUsage: get <id>\nExample: get post/abc123/0',
    relate: 'Create a directed relation between two entities.\nUsage: relate <from> <to> <type> [context]\nExample: relate comment1 post1 reply ctx123',
    query: 'Run a JavaScript query expression.\nUsage: query <expression>\nExample: query graph.query().type("post").toArray()',
    help: 'Show help for commands.\nUsage: help [command]\nExample: help put'
  }
  
  return help[command] || null
}

module.exports = { executeCommand }
