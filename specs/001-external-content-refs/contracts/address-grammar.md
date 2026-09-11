# Contract: Content Address Grammar

**Status**: Draft, pending agreement from HyperBBS and SwarmFS
**Version**: 1

This is the **cross-project contract** — the part of this feature that exists outside hypergraph.
It is written to be readable without knowing anything about hypergraph's internals, because its
audience is every project in the ecosystem that emits or resolves an address.

It governs two places:

- **Document layer** — a link or media directive inside a HyperMD document
  (`::video[swarmfs://<root>]`, or `[text](hyper://<key>)`). hypergraph stores such a document as
  ordinary text and never interprets it. The renderer parses it.
- **Entity layer** — the `src` entries of a content reference payload stored in a graph.

Both use this grammar. That is the point: a single address is meaningful whether it appears in a
document, in a graph record, or pasted into a chat message.

---

## 1. An address is a URI

```text
<scheme>:<scheme-specific-part>
```

It MUST parse as a URI and MUST carry a scheme. Nothing else is universally required.

**The scheme is the contract.** It tells a consumer which subsystem can resolve the address and how
to read the rest. A consumer that does not recognize a scheme MUST degrade — report the address as
unsupported, naming the scheme — and MUST NOT error.

hypergraph validates only that an address parses and has a scheme. It does not understand any
scheme's semantics, and adding a scheme requires no hypergraph change.

## 2. Registered schemes

| Scheme | Form | Target | Mutable | Self-verifying |
|---|---|---|---|---|
| `swarmfs` | `swarmfs://<merkle-root>` | Content-addressed file in SwarmFS | No | **Yes** — the address is a BLAKE3 merkle root, so it fixes the content |
| `hyperblobs` | `hyperblobs://<core-key>/<blob-id>` | Blob in a hypercore | No | Yes |
| `hyperdrive` | `hyperdrive://<drive-key>/<path>` | Path in a hyperdrive | Yes | No — the path's content can change |
| `hyper` | `hyper://<graph-key>` | Another hypergraph | Yes | No — an evolving multi-writer structure has no stable hash |
| `https` / `http` | Standard web URL | Web resource, gateway, fallback | Yes | No |
| `hypergraph` | `hypergraph://<entity-id>` | Content held inline in a graph, for small media | Yes | No |

`<entity-id>` is `type/authorHex/seq`. An id with fewer than three `/`-separated segments cannot
yield an author and is invalid — do not use informal path-like strings such as `video/my-vid.mp4`.

**This table is not exhaustive and is not a closed set.** A scheme absent here is not forbidden;
it is merely unknown to consumers that predate it, which is the degradation case above.

**Reserved for future use**: a name-resolving scheme, so an address can name content indirectly
through a naming service rather than naming a location. Resolution would be hyperDNS's job, not
hypergraph's. The grammar admits it today with no change (FR-004); this matters because addresses
in this ecosystem are overwhelmingly hashes — topics, graph keys, merkle roots — and hashes are
markedly less memorable than the IP addresses that motivated DNS in the first place.

## 3. Address equality

Two addresses denote the same content if and only if they are byte-identical after URI
normalization (lowercased scheme and host; path left untouched).

**Addresses MUST NOT carry metadata as query parameters.** Size, media type, mutability, and digest
belong in the reference payload (§4), never in the address. An address that carries them is no
longer canonical: two addresses for identical content would stop comparing equal, and
content-addressed deduplication — the reason content-addressing is worth having — would silently
stop working.

## 4. The reference payload (entity layer only)

Document-layer links are bare addresses. A reference stored in a graph carries an address plus
declared metadata:

```json
{
  "v": 1,
  "src": ["swarmfs://9f2c…a1", "https://gateway.example/9f2c…a1"],
  "size": 2147483648,
  "type": "video/mp4",
  "mutable": false,
  "digest": "blake3:9f2c…a1"
}
```

| Field | Required | Contract |
|---|---|---|
| `v` | yes | Payload version. `1` here. Unknown version ⇒ read as invalid, never thrown. |
| `src` | yes | Ordered, non-empty. **All entries MUST denote the same content.** Consumers try in order. |
| `size` | yes | Declared byte length. Unverified claim. |
| `type` | yes | Declared media type of the *content*. Unverified claim. |
| `mutable` | yes | Whether content behind the addresses may change. |
| `digest` | no | `<algo>:<hex>`. See §5. |

## 5. Integrity — the rules a consumer MUST follow

1. **If `digest` is present, verify obtained content against it.** A mismatch is a failure; do not
   surface the content as valid.
2. **If the address is self-verifying** (`swarmfs`, `hyperblobs`), the backend's own verification
   is sufficient and a `digest` is redundant.
3. **If `mutable` is true and no `digest` is present, the content is explicitly unverified.**
   Consumers SHOULD surface that distinction rather than presenting it as verified.
4. **Declared `size` and `type` are claims by the reference's author**, not facts. Treat them as
   hints for deciding whether to fetch, never as guarantees. In particular, do not preallocate
   unbounded memory on the strength of a declared size.

**A digest is deliberately optional.** Requiring one would forbid referencing a mutable target —
including another hypergraph — because an evolving multi-writer structure has no stable hash by
definition.

**Integrity is not trustworthiness.** A merkle root proves bytes are the *expected* bytes; it says
nothing about whether they are safe, exactly as HTTPS proves a server's identity and not a site's
honesty. Only the first property is in scope here.

## 6. Resolving vs fetching

These are different operations and consumers MUST NOT conflate them:

- **Resolving** turns an address into a current location or content identity. For a mutable target
  the result can differ between calls; it is not cacheable indefinitely.
- **Fetching** obtains bytes. For an immutable, self-verifying address the result is cacheable
  forever and shareable with other peers — this is what makes availability pool across everyone who
  holds the same content.

A `mutable: false` reference may be cached and re-served indefinitely. A `mutable: true` reference
MUST be re-resolved according to the consumer's own freshness policy.

## 7. Availability is not correctness

An address whose content nobody currently serves is **valid and normal**, not an error and not a
corrupt record. Consumers MUST distinguish "this reference is malformed" from "this content is
currently unavailable" and MUST NOT treat the second as the first.

## 8. What hypergraph does and does not do

**Does**: store addresses; validate that a payload is well-formed and that each address parses with
a scheme; encrypt a payload under a read scope so only members learn the address; return references
unchanged; keep superseded references addressable.

**Does not**: fetch, cache, pin, verify, or garbage-collect content; interpret any scheme's
semantics; contact any backend; measure or guarantee availability; resolve names.

hypergraph depends on none of the projects named in §2. It stores addresses naming them. Dependency
direction stays one-way.

---

## Agreement checklist

Before implementation lands in more than one repo:

- [ ] **HyperBBS** — can render document-layer links and media directives against §2, degrading
      per §1 on unknown schemes, and honouring §5 and §7 when reporting to the user.
- [ ] **SwarmFS** — `swarmfs://<merkle-root>` is the right shape for its content addresses, and
      §3's no-query-parameters rule does not conflict with anything it needs to express.
- [ ] **hyperDNS** — §2's reserved name-resolving scheme is compatible with how it will eventually
      name content, and nothing in §1 precludes it.
