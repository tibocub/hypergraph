/**
 * Create a tab completer for the REPL.
 * @returns {Function} Completer function for readline
 */
function createCompleter () {
  const commands = [
    'new', 'open', 'close', 'status',
    'put', 'get', 'del', 'content', 'put-content',
    'relate', 'unrelate', 'edges',
    'tag', 'untag', 'by-tag',
    'query', 'nodes', 'count-edges',
    'identity', 'create-rolebase', 'open-rolebase',
    'create-context', 'open-context', 'contexts',
    'moderate', 'query-moderation',
    'update', 'cores',
    'help'
  ]
  
  const metaCommands = ['.exit', '.quit', '.help', '.?', '.commands']
  
  return function completer (line) {
    const hits = []
    
    // Complete meta commands
    if (line.startsWith('.')) {
      const metaHits = metaCommands.filter(cmd => cmd.startsWith(line))
      return [metaHits, line]
    }
    
    // Get the current word being typed
    const parts = line.split(/\s+/)
    const currentWord = parts[parts.length - 1]
    
    // If it's the first word, complete commands
    if (parts.length === 1 || (parts.length === 2 && line.endsWith(' '))) {
      const commandHits = commands.filter(cmd => cmd.startsWith(currentWord))
      return [commandHits, line]
    }
    
    // Context-specific completions could be added here
    // For now, just return empty
    return [hits, line]
  }
}

module.exports = { createCompleter }
