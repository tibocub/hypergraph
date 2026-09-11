/**
 * src/content-ref.js — external content references.
 *
 * An entity's content can be an *address* pointing at content held elsewhere,
 * instead of the content itself. Hypergraph stores and validates the envelope;
 * it never fetches, caches, or verifies what the address points at, and it
 * never interprets a scheme's meaning.
 *
 * A reference is an ordinary `content/append` event whose `contentType` is the
 * marker `'link'` and whose `body` is the JSON payload below. That is why this
 * feature needs no wire-format change and no apply-path change: `contentType`
 * and `body` are already strings, already replicate, already version per
 * entity, and already encrypt under a read scope.
 *
 * Payload shape (v1):
 *
 *   {
 *     "v": 1,
 *     "src": ["swarmfs://9f2c…", "https://gateway.example/9f2c…"],
 *     "size": 2147483648,
 *     "type": "video/mp4",
 *     "mutable": false,
 *     "digest": "blake3:9f2c…"     // optional
 *   }
 *
 * This module is pure: no I/O, no crypto, no graph access. See
 * `specs/001-external-content-refs/` for the reasoning behind these choices.
 */

/**
 * The `contentType` value marking a content record as holding a reference
 * rather than inline content.
 *
 * Deliberately the plain word `link` rather than a long standards-style media
 * type: content types in this ecosystem are chosen by these projects, so the
 * collision a longer name would guard against does not arise, and readability
 * matters more.
 *
 * @type {string}
 */
const CONTENT_LINK_TYPE = 'link'

/** Payload versions this build can read. */
const SUPPORTED_VERSIONS = [1]

/** Current payload version written by {@link formatReference}. */
const CURRENT_VERSION = 1

/** `<algo>:<hex>` — at least one hex digit required. */
const DIGEST_PATTERN = /^[a-z0-9-]+:[0-9a-f]+$/i

/**
 * Whether a content record's `contentType` marks it as a reference.
 *
 * @param   {*} contentType
 * @returns {boolean}
 */
function isReferenceType (contentType) {
  return contentType === CONTENT_LINK_TYPE
}

/**
 * Extract the scheme from an address, or null if it isn't a usable address.
 *
 * Uses the built-in URL parser rather than a regex or a new dependency. A bare
 * scheme is all hypergraph requires — it deliberately does not understand what
 * any scheme *means*, which is what lets new backends arrive without a change
 * here.
 *
 * @param   {*} address
 * @returns {string|null} Lowercased scheme without the trailing colon.
 */
function schemeOf (address) {
  if (typeof address !== 'string' || address.length === 0) return null

  try {
    const parsed = new URL(address)
    // URL keeps the trailing colon ('swarmfs:'); callers want the bare word.
    const scheme = parsed.protocol.slice(0, -1)
    return scheme.length > 0 ? scheme.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Normalize `src` to an array of addresses. Accepts a bare string for the
 * common single-address case.
 *
 * @param   {*} src
 * @returns {Array<*>|null} null if the shape is unusable.
 */
function normalizeSrc (src) {
  if (typeof src === 'string') return [src]
  if (Array.isArray(src)) return src
  return null
}

/**
 * Validate a reference's fields, returning an error string or null.
 *
 * Shared by {@link formatReference} (which throws on a non-null result) and
 * {@link parseReference} (which reports it). Keeping one implementation means
 * a write and a read can never disagree about what "valid" means.
 *
 * @param   {*} ref
 * @returns {string|null}
 */
function validationError (ref) {
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
    return 'reference must be an object'
  }

  const src = normalizeSrc(ref.src)
  if (src === null) return 'src must be a string or an array of strings'
  if (src.length === 0) return 'src must contain at least one address'

  for (const address of src) {
    if (schemeOf(address) === null) {
      return `src entry is not an address with a scheme: ${JSON.stringify(address)}`
    }
  }

  if (!Number.isInteger(ref.size) || ref.size < 0) {
    return 'size must be a non-negative integer'
  }

  if (typeof ref.type !== 'string' || ref.type.length === 0) {
    return 'type must be a non-empty string'
  }

  if (typeof ref.mutable !== 'boolean') {
    return 'mutable must be a boolean'
  }

  if (ref.digest !== undefined && ref.digest !== null) {
    if (typeof ref.digest !== 'string' || !DIGEST_PATTERN.test(ref.digest)) {
      return 'digest must be of the form <algo>:<hex>'
    }
  }

  return null
}

/**
 * Validate a reference and serialize it to the payload string stored in a
 * content record's `body`.
 *
 * THROWS on invalid input — by design. This runs on local writes, where the
 * caller is the developer and a mistake should surface immediately and loudly,
 * at the point it is cheapest to fix.
 *
 * @param   {Object} ref
 * @param   {string|string[]} ref.src - One address, or several for the same
 *   content in preference order.
 * @param   {number} ref.size - Declared byte length. An unverified claim.
 * @param   {string} ref.type - Declared media type of the referenced content.
 * @param   {boolean} ref.mutable - Whether the content behind the address may change.
 * @param   {string} [ref.digest] - Optional `<algo>:<hex>` content digest.
 * @returns {string} The payload to store as `body`.
 * @throws  {Error} If the reference is malformed.
 */
function formatReference (ref) {
  const error = validationError(ref)
  if (error) throw new Error(`Invalid content reference: ${error}`)

  const payload = {
    v: CURRENT_VERSION,
    src: normalizeSrc(ref.src),
    size: ref.size,
    type: ref.type,
    mutable: ref.mutable
  }

  if (ref.digest !== undefined && ref.digest !== null) {
    payload.digest = ref.digest
  }

  return JSON.stringify(payload)
}

/**
 * Parse a payload string into a reference.
 *
 * NEVER THROWS — by design, and this is load-bearing. This runs on data that
 * may have been written by a hostile or buggy peer. Throwing here would hand
 * that peer a denial of service; returning an invalid-but-well-formed result
 * lets a consumer report the problem and carry on. It mirrors how
 * `decodeEvent` already returns a `decodeError` marker rather than throwing.
 *
 * @param   {*} body - The stored payload. Any type; anything unusable yields
 *   `{ valid: false }` rather than an exception.
 * @returns {{ valid: boolean, error: string|null, src: Array<{scheme: string, address: string}>,
 *   size: number|null, type: string|null, mutable: boolean|null, digest: string|null }}
 */
function parseReference (body) {
  const invalid = (error) => ({
    valid: false,
    error,
    // Always an array, so a caller can iterate without guarding first.
    src: [],
    size: null,
    type: null,
    mutable: null,
    digest: null
  })

  if (typeof body !== 'string') {
    return invalid(`reference payload must be a string, got ${body === null ? 'null' : typeof body}`)
  }

  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    return invalid('reference payload is not valid JSON')
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return invalid('reference payload must be a JSON object')
  }

  if (!SUPPORTED_VERSIONS.includes(payload.v)) {
    return invalid(`unsupported reference payload version: ${JSON.stringify(payload.v)}`)
  }

  const error = validationError(payload)
  if (error) return invalid(error)

  return {
    valid: true,
    error: null,
    src: normalizeSrc(payload.src).map(address => ({
      scheme: schemeOf(address),
      address
    })),
    size: payload.size,
    type: payload.type,
    mutable: payload.mutable,
    digest: payload.digest === undefined ? null : payload.digest
  }
}

module.exports = {
  CONTENT_LINK_TYPE,
  CURRENT_VERSION,
  formatReference,
  parseReference,
  isReferenceType,
  schemeOf
}
