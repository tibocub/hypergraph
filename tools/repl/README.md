# Hypergraph REPL

An interactive CLI tool for exploring and manipulating hypergraph databases, similar to PostgreSQL's psql.

## Usage

```bash
# Start REPL with new graph
node tools/repl.js

# Start REPL and open existing graph
node tools/repl.js --storage ./my-graph
```

## Commands

### Graph Management
- `new <path>` - Create new graph at path
- `open <path>` - Open existing graph from path
- `close` - Close current graph
- `status` - Show current graph info

### CRUD Operations
- `put <type> [json]` - Create entity
- `get <id>` - Get entity by ID
- `del <id>` - Delete entity
- `content <id>` - Get content for entity
- `put-content <id> <body> [type]` - Add content to entity

### Relations
- `relate <from> <to> <type> [context]` - Create relation
- `unrelate <from> <to> <type> [context]` - Remove relation
- `edges <id> [direction] [type]` - List edges

### Tags
- `tag <id> <tag> <context>` - Add tag
- `untag <id> <tag> <context>` - Remove tag
- `by-tag <tag> <context>` - Get entities by tag

### Queries
- `query <expression>` - Run JavaScript query
- `nodes <type>` - Get nodes by type
- `count-edges <id> <type> [direction]` - Count edges

### Identity and Roles
- `identity [username] [bio]` - Set/get identity
- `create-rolebase` - Create role base
- `open-rolebase <key>` - Open role base
- `set-role <pubkey> <role>` - Assign role
- `can <pubkey> <action>` - Check permission

### Contexts
- `create-context [writeMode]` - Create context
- `open-context <key> [writeMode]` - Open context

### Moderation
- `moderate <target> <action> [reason] [context]` - Create moderation
- `query-moderation <target> <context>` - Query moderation events

### Sync
- `update` - Update all indexes
- `cores` - List all cores

### Meta Commands
- `.exit`, `.quit` - Exit the REPL
- `.help`, `.?` - Show meta command help
- `.commands` - List all commands
- `help [command]` - Show detailed help for command

## Examples

```bash
# Create a new graph
> new ./my-graph

# Create a post
> put post

# Create a post with data (no outer quotes needed in REPL)
> put post {"body":"Hello world"}

# Add content to the post
> put-content post/abc123/0 "Hello world"

# Create a context for relations
> create-context open

# Create a reply relation
> relate post/abc123/1 post/abc123/0 reply <context-key>

# Query all posts
> nodes post

# Run a custom query
> query graph.query().type('post').toArray()

# Exit
> .exit
```

## Features

- **Command history** - Use up/down arrows to navigate history
- **Tab completion** - Tab to complete commands
- **Pretty-printed output** - Results are formatted for readability
- **Error handling** - Clear error messages with optional debug mode
