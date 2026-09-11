# Contract: hypergraph Public API

What this feature adds to `require('hypergraph')`. Naming and placement follow the existing
`putContent` / `getContent` convention (Principle IV).

---

## `graph.putContentRef(entityId, reference, opts?)`

Store a reference to content held elsewhere, as a new content version on `entityId`.

**Parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `entityId` | string | yes | Must name an existing entity, as `putContent` requires. |
| `reference.src` | string \| string[] | yes | One address, or several for the same content in preference order. A bare string is accepted and normalized to a one-element array. |
| `reference.size` | integer | yes | Declared byte length. |
| `reference.type` | string | yes | Declared media type of the *content*. |
| `reference.mutable` | boolean | yes | Whether content behind the addresses may change. |
| `reference.digest` | string | no | `<algo>:<hex>`. |
| `opts.scope` | string | no | Store the reference encrypted under a read scope, exactly as `putContent`'s `opts.scope` does. |

**Returns** `{ entityId, contentType, reference }` — the parsed reference the caller just wrote,
mirroring how `putContent` returns the plaintext the caller wrote rather than what was stored.

**Throws** on a malformed reference, per the write-time rules in `data-model.md`: invalid or empty
`src`, an entry that is not a URI with a scheme, a non-integer or negative `size`, a missing
`type`, a non-boolean `mutable`, a malformed `digest`. Also throws, as `putContent` already does,
when the entity does not exist or when `opts.scope` is unknown or its key is unavailable.

**Never** contacts a backend, checks that the content exists, or validates the honesty of declared
metadata.

**Why this method exists rather than documenting a magic `contentType`**: requiring callers to
hand-build the JSON envelope would be exactly the partial abstraction `API_PROBLEMS.md` warns
about — it would leak the whole format while appearing to provide one, and every consumer would
reimplement validation slightly differently.

---

## `graph.getContent(entityId)` — extended, not replaced

Unchanged for inline content. The returned record gains one field when it holds a reference.

```js
// inline content — identical to today
{ entityId, contentType: 'text', body: 'hello', createdAt, … }

// a reference
{
  entityId,
  contentType: 'application/vnd.hypergraph.ref+json',
  body: '{"v":1,"src":[…],…}',   // the raw payload, still present
  reference: {                    // ← added
    valid: true,
    error: null,
    src: [ { scheme: 'swarmfs', address: 'swarmfs://9f2c…' } ],
    size: 2147483648,
    type: 'video/mp4',
    mutable: false,
    digest: 'blake3:9f2c…'
  },
  …
}
```

**Contract**

- `reference` is present **only** when `contentType` is the reserved value; otherwise absent.
- `reference` is **never** a reason to throw. A malformed payload yields `valid: false` with
  `error` explaining why, and `body` still carries the raw payload for diagnosis.
- Existing callers are unaffected — they neither see nor need the new field.
- Encrypted references behave exactly as encrypted inline content: a caller holding the scope key
  gets a parsed `reference`; one without it gets `body: null` and no `reference`, and can still
  tell that referenced content exists.

**No separate `getContentRef()` is added.** One read path that surfaces more when there is more to
surface beats two paths a caller must choose between (Principle IV).

---

## `Hypergraph.CONTENT_REF_TYPE`

The reserved media type, exported as a constant so no consumer hardcodes the string.

```js
const { CONTENT_REF_TYPE } = require('hypergraph')
// 'application/vnd.hypergraph.ref+json'
```

---

## `src/content-ref.js` — internal module

Pure functions, no I/O, no crypto, no graph access. Exported internally for unit testing; not part
of the public surface.

| Function | Purpose |
|---|---|
| `formatReference(ref)` | Validate and serialize to the payload string. Throws on invalid input. |
| `parseReference(body)` | Parse a payload string into a parsed reference. **Never throws** — returns `{ valid: false, error }` instead. |
| `isReferenceType(contentType)` | Whether a content type is the reserved marker. |

The throwing/non-throwing split is deliberate and load-bearing: `format` runs on local writes where
a developer's mistake should surface immediately and loudly; `parse` runs on data that may have
come from a hostile peer, where throwing would hand that peer a denial-of-service.

---

## Compatibility

**Additive. Nothing breaks.**

| Surface | Effect |
|---|---|
| Existing `putContent` calls | Unchanged |
| Existing `getContent` calls | Unchanged; one new field appears only on reference records |
| Wire format | **Unchanged** — no new event type, no new field, no encoding change |
| Stored records | Unchanged; no migration |
| Apply path | **Untouched** |
| Consumers on the symlink (HyperBBS, hyperDNS) | No action required |

A `CHANGELOG.md` entry is still required under Principle V, because the capability is
consumer-visible — announcing a feature, not a break.
