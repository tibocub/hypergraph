/**
 * A hex-encoded 32-byte public key string.
 * @typedef {string} PubKeyHex
 */

/**
 * A hex-encoded Autobase / context key.
 * @typedef {string} ContextKeyHex
 */

/**
 * A tag event for signature verification.
 * @typedef {Object} TagEvent
 * @property {string} type - Event type ('tag/add' or 'tag/remove')
 * @property {string} entityId - Entity ID
 * @property {string} tag - Tag name
 * @property {PubKeyHex} author - Author public key (hex)
 * @property {number} timestamp - Unix timestamp
 */

/**
 * A graph entity as stored in the view.
 * @typedef {Object} Entity
 * @property {string}     id         - Derived ID: `<type>/<authorHex>/<seq>`
 * @property {string}     type       - Application-defined entity type (e.g. `'post'`)
 * @property {PubKeyHex}  author     - Hex public key of the creating user
 * @property {boolean}    deleted    - True when the entity has been tombstoned
 * @property {number}     createdAt  - Unix ms timestamp
 */

/**
 * Input descriptor for creating an entity. `id` must NOT be provided —
 * it is derived deterministically from (type, coreKey, seq).
 * @typedef {Object} EntityInput
 * @property {string}    type    - Application-defined entity type
 * @property {PubKeyHex} [author] - If omitted the local user key is used
 */

/**
 * A node-to-node relation as stored in the view.
 * @typedef {Object} Edge
 * @property {string}         from         - Source entity ID
 * @property {string}         to           - Target entity ID
 * @property {string}         type         - Relation type (e.g. `'reply'`)
 * @property {PubKeyHex}      author       - Hex public key of the author
 * @property {number}         createdAt    - Unix ms timestamp
 * @property {boolean}        deleted
 */

/**
 * Options accepted by {@link Hypergraph#edges}.
 * @typedef {Object} EdgeQueryOpts
 * @property {'in'|'out'}  [direction='out'] - Traversal direction
 * @property {string}      [type]            - Filter by relation type
 */

/**
 * A cryptographic keypair as returned by `hypercore-crypto.keyPair()`.
 * @typedef {Object} KeyPair
 * @property {Buffer} publicKey
 * @property {Buffer} secretKey
 */

/**
 * A moderation event as stored in a context.
 * @typedef {Object} ModerationEvent
 * @property {string}    eventId    - Unique event ID (SHA256 of coreKey:seq)
 * @property {string}    action     - One of the four allowed action strings
 * @property {string}    target     - Entity ID that the action targets
 * @property {PubKeyHex} author
 * @property {string|null} reason
 * @property {number}    timestamp
 * @property {string}    signature  - Hex-encoded Ed25519 signature
 */

/**
 * @typedef {'content.flag'|'content.hide'|'content.remove'|'content.reveal'} ModerationAction
 */

/**
 * Options for {@link Hypergraph#moderateAction}.
 * @typedef {Object} ModerateActionOpts
 * @property {ContextKeyHex|Buffer} context        - Target context key
 * @property {ModerationAction}     action
 * @property {string}               target         - Entity ID to act on
 * @property {string}               [reason]
 * @property {KeyPair}              keyPair        - Signs the event
 * @property {boolean}              [includeContext=false]
 */

/**
 * Options for {@link Hypergraph#queryContext}.
 * @typedef {Object} QueryContextOpts
 * @property {'moderation'}         type
 * @property {ContextKeyHex|Buffer} context
 * @property {string}               target
 * @property {PubKeyHex[]}          [authors]   - Allowlist; omit for all authors
 * @property {PubKeyHex}            [author]    - Convenience single-author shorthand
 * @property {number}               [since]     - Unix ms lower bound (inclusive)
 */

// ─── Constructor options ────────────────────────────────────────────────────

/**
 * @typedef {Object} HypergraphOpts
 * @property {string}         [keyEncoding]   - Codec name for keys (passed to `codecs`)
 * @property {string}         [valueEncoding] - Codec name for values
 * @property {Buffer|string}  [userCoreKey]   - Open an existing user core instead of creating one
 */

/**
 * Identity profile for a user.
 * @typedef {Object} IdentityProfile
 * @property {string} username - The username
 * @property {string} [bio] - Optional bio/description
 */

// ─── Core Component Types ─────────────────────────────────────────────────────

/**
 * Corestore instance from the corestore package.
 * @typedef {Object} Corestore
 * @property {Function} get - Get or create a Hypercore
 * @property {Function} namespace - Create a namespaced Corestore
 */

/**
 * Hypercore instance from the hypercore package.
 * @typedef {Object} Hypercore
 * @property {Buffer} key - Public key
 * @property {Buffer} discoveryKey - Discovery key
 * @property {number} length - Length of the core
 * @property {boolean} writable - Whether the core is writable
 * @property {Function} ready - Wait for the core to be ready
 * @property {Function} close - Close the core
 * @property {Function} append - Append data to the core
 * @property {Function} get - Get data at a sequence number
 * @property {Function} update - Update from remote peers
 * @property {Function} replicate - Create a replication stream
 */

/**
 * Hyperbee instance from the hyperbee package.
 * @typedef {Object} Hyperbee
 * @property {Hypercore} core - Underlying Hypercore
 * @property {Function} get - Get a value by key
 * @property {Function} put - Put a value by key
 * @property {Function} del - Delete a value by key
 * @property {Function} createReadStream - Create a readable stream
 */

/**
 * Autobase instance from the autobase package.
 * @typedef {Object} Autobase
 * @property {Buffer} key - Public key
 * @property {Buffer} discoveryKey - Discovery key
 * @property {number} length - Length of the base
 * @property {boolean} writable - Whether the base is writable
 * @property {Hypercore} core - Underlying Hypercore
 * @property {Hypercore|null} local - Local writer core
 * @property {Hyperbee} view - Materialized view
 * @property {Function} ready - Wait for the base to be ready
 * @property {Function} close - Close the base
 * @property {Function} append - Append data to the base
 * @property {Function} update - Update from remote peers
 * @property {Function} addWriter - Add a writer to the base
 * @property {Function} replicate - Create a replication stream
 */

/**
 * UserCore instance - wraps a Hypercore for user events.
 * @typedef {Object} UserCore
 * @property {Hypercore} core - Underlying Hypercore
 * @property {Buffer} key - Public key
 * @property {Buffer} discoveryKey - Discovery key
 * @property {number} length - Number of events
 * @property {boolean} writable - Whether the core is writable
 * @property {boolean} opened - Whether the core is opened
 * @property {Function} ready - Wait for the core to be ready
 * @property {Function} close - Close the core
 * @property {Function} append - Append an event
 * @property {Function} appendBatch - Append multiple events
 * @property {Function} get - Get an event by sequence number
 * @property {Function} createReadStream - Create a stream of events
 * @property {Function} createHistoryStream - Create a history stream
 * @property {Function} update - Update from remote peers
 * @property {Function} replicate - Create a replication stream
 */

/**
 * ContextBase instance - manages collaborative contexts via Autobase.
 * @typedef {Object} ContextBase
 * @property {Autobase} base - Underlying Autobase
 * @property {Hypercore} core - Underlying Autobase core
 * @property {Buffer} key - Public key
 * @property {Buffer} discoveryKey - Discovery key
 * @property {Buffer} localKey - Local writer's public key
 * @property {number} version - Autobase version
 * @property {Hyperbee} view - Materialized view
 * @property {'open'|'closed'} writeMode - Write mode of the context
 * @property {boolean} writable - Whether the context is writable
 * @property {boolean} opened - Whether the context is opened
 * @property {Function} ready - Wait for the context to be ready
 * @property {Function} close - Close the context
 * @property {Function} append - Append an event
 * @property {Function} addWriter - Add a writer to the context
 * @property {Function} get - Get a value from the view
 * @property {Function} createReadStream - Create a stream from the view
 * @property {Function} update - Update from remote peers
 * @property {Function} replicate - Create a replication stream
 * @property {Function} handlePeerConnection - Handle a peer connection
 * @property {Function} requestWriter - Request writer access
 * @property {Function} approveWriter - Approve a writer request
 * @property {Function} rejectWriter - Reject a writer request
 * @property {Function} writerKeys - Get all writer keys
 * @property {Function} onContextEvent - Register an event listener
 * @property {Function} offContextEvent - Remove an event listener
 * @property {Function} emitContextEvent - Emit an event
 */

/**
 * RoleBase instance - manages role-based access control via Autobase.
 * @typedef {Object} RoleBase
 * @property {Buffer} key - Public key
 * @property {Buffer} discoveryKey - Discovery key
 * @property {boolean} opened - Whether the base is opened
 * @property {Function} ready - Wait for the base to be ready
 * @property {Function} close - Close the base
 * @property {Function} update - Update from remote peers
 * @property {Function} getRegistry - Get the role registry state
 * @property {Function} append - Append a role event
 * @property {Function} can - Check if a key has permission
 * @property {Function} initRegistry - Initialize a new registry
 * @property {Function} setRole - Set a role for a member
 * @property {Function} removeMember - Remove a member
 * @property {Function} setRolePermissions - Set permissions for a role
 */

/**
 * Role registry state.
 * @typedef {Object} RoleRegistry
 * @property {number} version - Registry version
 * @property {Object.<string, string[]>} roles - Role name to permissions mapping
 * @property {Object.<string, string>} members - Public key to role name mapping
 */

/**
 * Role management event.
 * @typedef {Object} RoleEvent
 * @property {string} type - Event type ('roles/init', 'roles/setRole', 'roles/removeMember', 'roles/setRolePermissions')
 * @property {string} [pubkey] - Public key (for setRole)
 * @property {string} [role] - Role name
 * @property {string[]} [permissions] - Permissions array
 * @property {string} [member] - Member public key
 * @property {RoleRegistry} [registry] - Full registry (for init)
 * @property {string} author - Author's public key
 * @property {string} [signature] - Signature
 */

/**
 * IdentityManager instance - handles keet-identity-key integration.
 * @typedef {Object} IdentityManager
 * @property {Buffer} identityPublicKey - Identity public key
 * @property {KeyPair} deviceKeyPair - Device keyPair for signing
 * @property {KeyPair} profileDiscoveryKeyPair - Profile discovery keyPair
 * @property {Buffer} profileDiscoveryPublicKey - Profile discovery public key
 * @property {Buffer} attestationProof - Device attestation proof
 * @property {Function} init - Initialize the identity
 * @property {Function} attestDevice - Attest to a new device
 * @property {Function} verifyProof - Verify an attestation proof
 * @property {Function} clear - Clear private data
 */

/**
 * GraphView instance - manages materialized view for graph operations.
 * @typedef {Object} GraphView
 * @property {Hyperbee} bee - Underlying Hyperbee
 * @property {boolean} opened - Whether the view is opened
 * @property {Function} ready - Wait for the view to be ready
 * @property {Function} close - Close the view
 * @property {Function} update - Update the view from cores and contexts
 * @property {Function} registerDeviceIdentity - Register a device-to-identity mapping
 * @property {Function} getIdentityForDevice - Get identity for a device key
 * @property {Function} getIdentity - Get identity for a user core
 * @property {Function} addUserCore - Add a user core to the view
 * @property {Function} addContext - Add a context to the view
 * @property {Function} getNode - Get a node by ID
 * @property {Function} getContent - Get content for an entity
 * @property {Function} getEdges - Get edges for a node
 * @property {Function} getByTag - Get entities by tag
 * @property {Function} getByType - Get entities by type
 * @property {Function} getByAuthor - Get entities by author
 * @property {Function} createReadStream - Create a stream of nodes
 * @property {Function} get - Get a value from the view
 * @property {Function} put - Put a value in the view
 */

/**
 * GraphQuery instance - fluent query builder for graph operations.
 * @typedef {Object} GraphQuery
 * @property {Function} filter - Add a custom filter
 * @property {Function} type - Filter by entity type
 * @property {Function} author - Filter by author
 * @property {Function} tag - Filter by tag
 * @property {Function} out - Traverse outgoing edges
 * @property {Function} in - Traverse incoming edges
 * @property {Function} limit - Limit results
 * @property {Function} reverse - Reverse order
 * @property {Function} toArray - Execute and return array
 * @property {Function} first - Execute and return first result
 * @property {Function} count - Execute and count results
 * @property {Function} createReadStream - Create a readable stream
 */

/**
 * PeerDiscovery instance - manages peer announcements and discovery.
 * @typedef {Object} PeerDiscovery
 * @property {Function} announce - Announce presence to the graph
 * @property {Function} discoverPeers - Discover other peers
 * @property {Function} listPeers - Get list of known peers
 * @property {Function} handlePeerConnection - Handle a peer connection
 * @property {Function} handlePeerDisconnection - Handle a peer disconnection
 * @property {Function} on - Register an event listener
 * @property {Function} off - Remove an event listener
 */











// Legacy typedefs kept for backward compatibility
// Note: Some of these may be redundant with the typedefs above

/**
 * @typedef {Object} HypergraphOptions
 * @property {string|Object} [keyEncoding]
 * @property {string|Object} [valueEncoding]
 * @property {Buffer|string|null} [userCoreKey]
 * @deprecated Use HypergraphOpts instead
 */

/**
 * Options for creating a relation.
 * @typedef {Object} RelationOptions
 * @property {string} from - Source entity ID
 * @property {string} to - Target entity ID
 * @property {string} context - Context key
 * @property {string} [type] - Relation type (alias for relationType)
 * @property {string} [relationType] - Relation type
 * @property {string} author - Author's hex public key
 */

/**
 * Options for tagging an entity.
 * @typedef {Object} TagOptions
 * @property {string} author - Author's hex public key
 * @property {string} context - Context key
 */

// Export empty object to make this a module for TypeScript imports
module.exports = {}
