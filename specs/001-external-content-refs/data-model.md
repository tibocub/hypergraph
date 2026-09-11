# Phase 1 Data Model: External Content References

## Storage shape — what actually changes

**Nothing structural.** A reference is a `content/append` event, stored as a content record at
`c:<entityId>:<sortableSeq>` exactly like inline content. No new event type, no new index, no new
key prefix, no encoding change.

```text
content/append  (existing event, existing encoding)
├── entityId     "video/a3f9…c2/7"
├── contentType  "application/vnd.hypergraph.ref+json"   ← the marker
├── body         "{\"v\":1,\"src\":[…],\"size\":…}"       ← the address payload
├── timestamp    …
└── encrypted / scope / epoch / nonce   (present only when stored under a read scope)
```

When stored under a scope, `body` is encrypted by the **existing** path — `putContent` encrypts
`String(content)` with XSalsa20-Poly1305 and the scope's current epoch key. The payload is a
string, so this requires no new cryptography and no change to scope or epoch handling (FR-014).

## Entity: Content Reference Payload

The JSON object carried in `body`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | integer | yes | Payload version. `1` for this specification. Unknown versions are read as invalid, never thrown. |
| `src` | array of string | yes | One or more addresses for the **same** content, in preference order. Consumers try in order. Must contain at least one entry. |
| `size` | integer | yes | Declared byte length of the referenced content. `0` is valid. An **unverified claim** (FR-017). |
| `type` | string | yes | Declared media type of the referenced content (e.g. `video/mp4`). This is where the real type lives, since the record's own `contentType` is the marker. Unverified. |
| `mutable` | boolean | yes | Whether the content behind these addresses may change. Drives consumer caching and verification (FR-009). |
| `digest` | string | no | `<algo>:<hex>` (e.g. `blake3:9f2c…`). When present, a consumer **MUST** verify obtained content against it. When absent on a `mutable` target, content is **explicitly unverified** (FR-010). |

**Deliberately absent**: any field naming a peer, a topic, a connection hint, or a fetch strategy.
Those are backend concerns. A reference says *what* content is wanted, never *how* to get it.

### Validation rules

Enforced by `putContentRef()` at local write time; evaluated at parse time on read. Never
evaluated in the apply path (research R4).

| Rule | On local write | On read (any origin) |
|---|---|---|
| `body` parses as JSON | throw | mark invalid |
| `v` is a known version | throw | mark invalid |
| `src` is a non-empty array | throw | mark invalid |
| every `src` entry parses as a URI with a scheme | throw | mark invalid |
| `size` is a non-negative integer | throw | mark invalid |
| `type` is a non-empty string | throw | mark invalid |
| `mutable` is a boolean | throw | mark invalid |
| `digest`, if present, matches `<algo>:<hex>` | throw | mark invalid |
| content exists / is served / claims are honest | **never checked** | **never checked** |

"Mark invalid" means `getContent()` returns a well-formed record whose `reference` reports the
failure. It never throws, never blocks apply, never drops the record (FR-007, FR-015).

## Entity: Address

A URI. The scheme is the extension point; hypergraph checks only that the address parses and has
one, and never interprets scheme semantics (research R4).

```text
swarmfs://<merkle-root>
hyperblobs://<core-key>/<blob-id>
hyperdrive://<drive-key>/<path>
hyper://<graph-key>
https://<host>/<path>
hypergraph://<entity-id>
```

`hypergraph://` addresses content held inline in this graph, so small and large media are
addressed uniformly (FR-003, Story 2). Its target is an entity id of the form
`type/authorHex/seq` — note that an id with fewer than three segments yields no author and is
silently dropped on read elsewhere in the codebase, which is exactly why informal path-like
strings are not permitted here.

## Entity: Parsed Reference (read-side, in memory only)

What `getContent()` surfaces as `reference`. Never stored.

| Field | Type | Meaning |
|---|---|---|
| `valid` | boolean | Whether the payload passed parse-time validation. |
| `error` | string \| null | Why it failed, when `valid` is false. For reporting, not control flow. |
| `src` | array of `{ scheme, address }` | Addresses in preference order, each with its scheme pre-extracted so a consumer can match without re-parsing. |
| `size`, `type`, `mutable`, `digest` | as above | Present when `valid`. |

A consumer selects the first entry whose `scheme` it supports; if it supports none, it reports
exactly which schemes were offered (SC-005).

## State transitions

Content is append-only; a reference has no lifecycle of its own.

```text
(no content)
   │ putContentRef()
   ▼
reference v1 ──putContentRef()──▶ reference v2 ──putContent()──▶ inline content
   │                                    │                             │
   └────────── all remain addressable at their own seq ───────────────┘
                     getContent() returns the newest
```

Three properties follow from existing content behavior rather than new code:

- **Replacing a reference does not change the entity id** — relations and tags pointing at the
  entity stay valid (FR-011).
- **Superseded references remain addressable** at their own sequence (FR-013).
- **An entity may switch between reference and inline content**, in either direction, because both
  are content records. A consumer discriminates per version by `contentType`, never by entity type.

## Concurrency

Two peers concurrently storing different references for one entity produce two `content/append`
events. Autobase linearizes them deterministically, both are written at distinct sequences, and
`getContent()` returns the newest under that linearization — identically on every peer (FR-012).

This is the existing convergence rule for concurrent content versions. **No new merge logic is
introduced, and none is needed.** The regression test in `quickstart.md` pins the behavior for
references specifically, since a future change to content versioning would otherwise break
references silently.
