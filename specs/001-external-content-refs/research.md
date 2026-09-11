# Phase 0 Research: External Content References

Five decisions. Each is grounded in the current implementation, which was read rather than assumed.

---

## R1 — How a content record is marked as holding a reference (FR-006)

**Decision**: A reserved `contentType` value. The record is an ordinary `content/append` event
whose `contentType` is `application/vnd.hypergraph.ref+json` and whose `body` is the JSON address
payload. **No wire-format change, no new event type, no apply-path change.**

**Rationale**:

- `contentType` and `body` are already `c.string` fields in the `content/append` branch of
  `src/encodings/event.js`. A reserved value costs nothing to encode and nothing to decode.
- It gives the degradation FR-007 demands. An unaware consumer reads a `contentType` it does not
  recognize and declines to render — *visibly* unsupported. The failure is loud and safe.
- It is the only option that leaves the Autobase apply path untouched, which is what makes the
  Principle I argument trivial rather than delicate (see R4).
- The real media type of the referenced content is not lost: it lives in the payload's `type`
  field, which FR-008 requires to be present anyway.
- The `+json` structured suffix follows RFC 6839, and `vnd.` marks it vendor-specific, so it
  cannot collide with a registered IANA media type.

**Alternatives considered**:

- *A marker key inside the body, with `contentType` holding the real media type.* Rejected: an
  existing consumer would see `video/mp4` and treat a JSON body as video bytes — silently wrong,
  which is strictly worse than visibly unsupported. It also forces every consumer to parse every
  body before knowing what it is, and a genuine text body containing the reserved key would be
  misread.
- *A new `content/ref` event type.* Rejected: a wire-format change touching `src/encodings/`
  (Principle II's non-negotiable tier), a new apply branch (Principle I risk), and a break for
  symlinked consumers (Principle V) — all to express something the existing primitive already
  expresses. It also contradicts spec FR-001's "using the existing content mechanism, with no
  change to how content replicates."
- *A new boolean field on `content/append`.* Rejected: still a wire-format change, and it makes
  `contentType` ambiguous (does it describe the wrapper or the target?) without buying anything
  over the reserved value.

---

## R2 — The address grammar (FR-002, FR-003, FR-004)

**Decision**: An address is a **URI with an explicit scheme**, parsed with the Node standard
library's `URL`. hypergraph requires only that it parse and carry a scheme.

**Rationale**:

- It is the grammar the ecosystem already uses to address hypersites and names, so document-layer
  links (`::video[swarmfs://<root>]` inside HyperMD) and entity-layer references share one format.
  Neither application invents its own convention (SC-008).
- The scheme is a natural, self-describing discriminator, which is what FR-007's "report precisely
  which scheme it lacked" needs.
- New backends are admitted with no grammar change and no hypergraph change (FR-002).
- It does not preclude a name-resolving address arriving later (FR-004) — a future
  `hyperdns:name@authority` or similar is just another scheme.
- `URL` is standard-library, so Principle III's no-new-dependency constraint holds.

**Schemes the grammar admits** (hypergraph implements resolution for none of them):

| Scheme | Target | Mutable |
|---|---|---|
| `swarmfs:` | BLAKE3 merkle root | No — the address fixes the content |
| `hyperblobs:` | core key + blob id | No |
| `hyperdrive:` | drive key + path | Yes |
| `hyper:` | another hypergraph | Yes |
| `https:` / `http:` | web URL | Yes |
| `hypergraph:` | an entity in this graph, for small inline content | Yes |

**Alternatives considered**:

- *A structured object with a `scheme` field and per-scheme sub-fields.* Rejected: reinvents URI
  parsing, is not pasteable or human-readable, and cannot be shared with the document layer where
  a link must be a single string.
- *Bare, unprefixed identifiers (a raw merkle root).* Rejected: not self-describing, so a consumer
  cannot tell a merkle root from a drive key, and FR-007 becomes impossible.

---

## R3 — How per-reference metadata is carried (FR-008, FR-009, FR-010, FR-016)

**Decision**: A small JSON object in `body`, carrying an **ordered array** of addresses plus
declared metadata. Not query parameters on the URI.

**Rationale**:

- FR-016 requires multiple addresses for the same content in preference order. A single URI cannot
  express that; an array can, and ordering is explicit.
- FR-008 (size and media type readable without contacting a backend), FR-009 (mutability declared)
  and FR-010 (optional digest) each need a field. Stuffing them into query strings would make the
  address itself non-canonical — two addresses for the same content would stop comparing equal,
  which breaks deduplication.
- JSON keeps `body` a string, so the existing encoding, the existing scope-encryption path
  (`putContent` encrypts `String(content)`), and the existing storage all work untouched.
- A `v` version field allows the payload to evolve without a wire change.

**Alternatives considered**:

- *Query parameters (`swarmfs://root?size=…&type=…`).* Rejected: pollutes the canonical address,
  breaks address equality and therefore deduplication, and cannot express ordered fallbacks.
- *Compact binary encoding.* Rejected: would require touching `src/encodings/` for a payload
  measured in hundreds of bytes against content measured in gigabytes. No meaningful saving, real
  constitutional cost.

---

## R4 — Where validation happens (FR-015)

**Decision**: **Validate on local write; never validate in apply.** `putContentRef()` rejects a
malformed payload before it is appended. The apply path stores reference records exactly as it
stores any content record, with no knowledge that they are references. Malformed payloads arriving
from peers are caught at **parse time on read** and surfaced as well-formed-but-invalid.

**Rationale**:

- This is the decisive Principle I argument. If apply never inspects the payload, a hostile or
  buggy peer cannot block apply, cannot cause divergence, and cannot crash a reader mid-apply —
  because the code path that could do those things does not exist.
- It matches how the codebase already treats decode failures: `decodeEvent` returns a
  `decodeError` marker rather than throwing or dropping, so a bad record degrades locally instead
  of poisoning the view.
- Local-write validation still catches the overwhelmingly common case — a developer's own mistake
   — at the moment it is cheapest to fix, with a clear error.
- A read-time invalid marker satisfies FR-007's "must not error" while still letting a consumer
  report exactly what was wrong.

**Rejected at write time** (from the record alone, no network):
body is not valid JSON; unknown payload version; `src` missing, empty, or not an array; any entry
not a parseable URI with a scheme; `size` not a non-negative integer; `type` not a string;
`mutable` not a boolean; `digest` present but not `<algo>:<hex>`.

**Never rejected** (unverifiable locally, and therefore a consumer concern per FR-017): whether
the content exists, whether anyone serves it, whether the declared size or type is honest, whether
the digest matches.

**Alternatives considered**:

- *Validate in apply and drop invalid records.* Rejected: adds a rejection branch to the most
  safety-critical path in the project for no gain, and a bug there would be a convergence bug.
- *No validation at all.* Rejected: pushes a developer's own typo to a distant runtime failure in
  another repo, which is exactly the cross-boundary debugging cost this ecosystem has already paid
  more than once.

---

## R5 — Mutability, integrity, and the stable address (FR-009, FR-010, FR-011)

**Decision**: Mutability is an explicit declared field, not inferred from the scheme. The digest is
optional; consumers verify when present and treat its absence on a mutable target as explicitly
unverified. The stable-address requirement needs **no new mechanism**.

**Rationale**:

- *Explicit mutability*: mostly derivable from scheme, but a consumer would then need a table of
  every scheme — including ones defined after it shipped — which defeats FR-002's extensibility.
  Declaring it keeps the consumer's rule uniform.
- *Optional digest*: settled in the spec (Q2). Requiring one would make a hypergraph referencing
  another hypergraph unexpressible, since an evolving multi-writer structure has no stable hash.
  A merkle root also proves only that bytes are the *expected* bytes, not that they are *safe* —
  integrity and trustworthiness are separate, and only the first is in scope.
- *Stable address*: **verified in the implementation, not assumed.** `src/view.js` writes content
  at `c:${event.entityId}:${toSortableTs(seq)}` and `getContent()` reads with
  `reverse: true, limit: 1`. Content is therefore already versioned per entity with newest-wins
  semantics. Storing a new reference is an ordinary new content version, so FR-011 (entity id
  unchanged, relations and tags preserved) and FR-013 (superseded versions remain addressable) are
  satisfied by existing behavior with zero new code. No indirection record is needed at this layer.

**Consequence worth stating**: because a mutable address names a moving target, *resolving an
address* and *fetching immutable bytes* are different operations with different caching rules.
hypergraph performs neither; the distinction is recorded in the contract so consumers implement it
consistently.

**Alternatives considered**:

- *Infer mutability from a built-in scheme table.* Rejected: unknown schemes would have no answer,
  and the table would need updating for every new backend — a hypergraph change per backend, which
  FR-002 exists to avoid.
- *A separate indirection/pointer record for mutability.* Rejected: duplicates content versioning,
  which already provides exactly this, and would add a second source of truth for "current".
