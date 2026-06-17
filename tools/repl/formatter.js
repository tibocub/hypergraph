const util = require('util')

/**
 * Format output for display in the REPL.
 * @param {*} value - The value to format
 * @returns {string} Formatted string
 */
function formatOutput (value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return String(value)
  
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return formatArray(value)
  }
  
  if (typeof value === 'object') {
    return formatObject(value)
  }
  
  return util.inspect(value, { colors: true, depth: 3, maxArrayLength: 20 })
}

function formatArray (arr) {
  if (arr.length === 0) return '[]'
  
  // Check if array of objects with common structure (like query results)
  if (arr.every(item => typeof item === 'object' && item !== null)) {
    const keys = getCommonKeys(arr)
    if (keys.length > 0) {
      return formatAsTable(arr, keys)
    }
  }
  
  // Regular array
  return util.inspect(arr, { colors: true, depth: 3, maxArrayLength: 20 })
}

function formatObject (obj) {
  if (obj === null) return 'null'
  
  // Check if it's an entity with common structure
  if (obj.id && obj.type) {
    return formatEntity(obj)
  }
  
  // Check if it's an edge
  if (obj.from && obj.to) {
    return formatEdge(obj)
  }
  
  // Regular object
  return util.inspect(obj, { colors: true, depth: 3 })
}

function formatEntity (entity) {
  const lines = [
    `Entity: ${entity.id}`,
    `  type: ${entity.type}`,
    `  author: ${entity.author || 'unknown'}`
  ]
  
  if (entity.createdAt) {
    lines.push(`  createdAt: ${new Date(entity.createdAt).toISOString()}`)
  }
  
  // Add other properties
  for (const [key, value] of Object.entries(entity)) {
    if (!['id', 'type', 'author', 'createdAt'].includes(key)) {
      const strVal = typeof value === 'string' && value.length > 50 
        ? value.slice(0, 47) + '...' 
        : String(value)
      lines.push(`  ${key}: ${strVal}`)
    }
  }
  
  return lines.join('\n')
}

function formatEdge (edge) {
  const lines = [
    `Edge: ${edge.from} -> ${edge.to}`,
    `  type: ${edge.type || edge.relationType || 'unknown'}`
  ]
  
  if (edge.author) lines.push(`  author: ${edge.author}`)
  if (edge.createdAt) lines.push(`  createdAt: ${new Date(edge.createdAt).toISOString()}`)
  
  return lines.join('\n')
}

function getCommonKeys (arr) {
  if (arr.length === 0) return []
  
  const firstKeys = Object.keys(arr[0])
  const commonKeys = firstKeys.filter(key => 
    arr.every(item => key in item)
  )
  
  return commonKeys
}

function formatAsTable (arr, keys) {
  // Calculate column widths
  const widths = {}
  keys.forEach(key => {
    widths[key] = Math.max(
      key.length,
      ...arr.map(item => String(item[key] ?? '').length)
    )
  })
  
  // Build header
  const header = keys.map(key => key.padEnd(widths[key])).join(' | ')
  const separator = keys.map(key => '-'.repeat(widths[key])).join('-+-')
  
  // Build rows
  const rows = arr.map(item => {
    return keys.map(key => {
      let val = item[key]
      if (val === null || val === undefined) val = ''
      if (typeof val === 'string' && val.length > widths[key]) {
        val = val.slice(0, widths[key] - 3) + '...'
      }
      return String(val).padEnd(widths[key])
    }).join(' | ')
  })
  
  // Limit rows for display
  const maxRows = 20
  const displayRows = rows.slice(0, maxRows)
  if (rows.length > maxRows) {
    displayRows.push(`... (${rows.length - maxRows} more rows)`)
  }
  
  return [header, separator, ...displayRows].join('\n')
}

module.exports = { formatOutput }
