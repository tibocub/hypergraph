# Index Structure

All indexes are stored in GraphView's Hyperbee with UTF-8 keys and JSON values.

## Node Indexes

```
n:<entityId> → { id, type, author, deleted, createdAt }

nt:<type>:<createdAt>:<entityId> → { id }

nc:<createdAt>:<entityId> → { id }
```

**Node index design notes:**
- `n:` is keyed by `<type>/<authorCoreKeyHex>/<seq>` — NOT chronological across multiple
  authors, since a core key's hex has nothing to do with when its owner actually wrote
  something (confirmed directly: a newer entity from one author can sort before an older one
  from another, purely from key ordering)
- `nt:` and `nc:` exist specifically to give a real, efficient chronological scan: `nt:` when
  filtering by type (also used by `getByType()`), `nc:` for the type-agnostic case. Both are
  what `query()`'s default ordering and `.type()` filter actually use — not the raw `n:` scan

## Content Indexes

```
c:<entityId>:<seq> → { entityId, contentType, body, createdAt, encrypted, scope, epoch, nonce }
```

`encrypted`/`scope`/`epoch`/`nonce` are optional and default to unencrypted (`encrypted:
false`, the rest `null`) — see [Read Permission](../read-permission.md). When `encrypted` is
true, `body` holds a hex ciphertext rather than plaintext; `contentType` is never encrypted.

## Edge Indexes

```
e:<from>:<type>:<createdAt>:<to> → { from, to, type, author, createdAt, deleted, value }

i:in:<to>:<type>:<createdAt>:<from> → { ref: <full e: key> }

er:<from>:<type>:<to> → { ref: <full e: key> }

cnt:in:<to>:<type> → { count }
cnt:out:<from>:<type> → { count }
```

**Index design notes:**
- `createdAt` is embedded in edge keys for efficient time-ordered range scans
- `value` is an optional numeric field (weighted relations — e.g. a vote's +1/-1) present on
  the event since it's included in the signed digest; absent (`undefined`) on relations that
  never set it
- The `er:` index enforces one active edge per (from, type, to) triple
- Edge counts are incremented on create and decremented on delete (clamped at 0)
- In P2P delivery, if a delete arrives before its create, the count may read one low temporarily

## Tag Indexes

```
t:<tag>:<createdAt>:<entityId>:<author> → { createdAt }

tref:<tag>:<entityId>:<author> → { ref }
```

**Tag design notes:**
- Tags are author-scoped (only the entity's author can tag it) — confirmed directly: hypergraph
  throws if the caller isn't the entity's own author. This makes tags suited to
  self-categorization, not community/moderator-applied labeling (which needs `relate()` or a
  moderation event instead)
- This prevents spam and keeps tag indexes low-noise
- Unlike `n:`/`nt:`/`nc:`, tag lookups currently do a full scan with a per-node tag check —
  no dedicated index yet. Worth revisiting if tag-heavy queries become a real bottleneck

## Moderation Indexes

```
m:t:<targetId>:<createdAt>:<coreKeyHex>:<seq> → { eventId, action, target, author, createdAt, signature }

m:a:<author>:<createdAt>:<targetId>:<coreKeyHex>:<seq> → { eventId, action, target, author, createdAt, signature }
```

**Moderation design notes:**
- Moderation actions are signed by the author's keypair
- Peers validate signatures against the role registry before applying — an unauthorized
  action is hard-rejected at the apply layer and never indexed at all (confirmed directly:
  neither a filtered nor unfiltered query shows it), not "recorded but filtered at query time"
- This enables verifiable offline moderation without trusting any central authority

## Identity Indexes

```
id:profile:<pubkey> → { username, bio, ... }
```

## Scope Registry (ScopeBase's own Hyperbee, not GraphView)

ScopeBase maintains its own, separate Hyperbee (not part of GraphView's indexes above):

```
scopes:registry → {
  [scopeId]: {
    version, id, creator, currentEpoch,
    grants: { '<pubkeyHex>:<epoch>': { sealedKey, granter, timestamp } },
    revoked: { '<pubkeyHex>': true }
  }
}
```

The actual symmetric key is never stored here in the clear — only `sealedKey` (ciphertext,
openable only by its intended recipient). See [Read Permission](../read-permission.md).

## Checkpoint Indexes

```
meta:user:<keyHex>:lastSeq → { seq }
meta:context:<keyHex>:checkpoint → { checkpoint }
```

## Timestamp Encoding

All timestamps are 16-digit zero-padded decimal strings:

```js
String(timestamp).padStart(16, '0')
```

This ensures correct sorting across different digit lengths. Plain decimal strings do not sort correctly (e.g., "1000" < "999" alphabetically).

## See Also

- [Event Encoding](event-encoding.md) - Event format and encoding
- [Read Permission](../read-permission.md) - ScopeBase and content encryption in full
