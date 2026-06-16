/**
 * A hex-encoded 32-byte public key string.
 * @typedef {string} PubKeyHex
 */

/**
 * A hex-encoded Autobase / context key.
 * @typedef {string} ContextKeyHex
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
