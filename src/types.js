/**
 * @typedef {Object} HypergraphOptions
 * @property {string|Object} [keyEncoding]
 * @property {string|Object} [valueEncoding]
 * @property {Buffer|string|null} [userCoreKey]
 */

/**
 * @typedef {Object} Entity
 * @property {string} type
 * @property {string} [author]
 */

/**
 * @typedef {Object} EntityRef
 * @property {string} id
 * @property {string} type
 * @property {string} author
 */

/**
 * @typedef {Object} IdentityProfile
 * @property {string} username
 * @property {string} [bio]
 */

/**
 * @typedef {Object} RelationOptions
 * @property {string} from
 * @property {string} to
 * @property {string} context
 * @property {string} [type]
 * @property {string} [relationType]
 * @property {string} author
 */

/**
 * @typedef {Object} TagOptions
 * @property {string} author
 * @property {string} context
 */

/**
 * @typedef {Object} ModerationOptions
 * @property {string|Buffer} context
 * @property {'content.flag'|'content.hide'|'content.remove'|'content.reveal'} action
 * @property {string} target
 * @property {string} [reason]
 * @property {boolean} [includeContext]
 * @property {{
 *   publicKey: Buffer,
 *   secretKey: Buffer
 * }} keyPair
 */
