# Index Structure

All indexes are stored in GraphView's Hyperbee with UTF-8 keys and JSON values.

## Node Indexes

```
n:<entityId> → { id, type, author, deleted, createdAt }

nt:<type>:<createdAt>:<entityId> → { id }
```

## Content Indexes

```
c:<entityId>:<seq> → { contentType, body }
```

## Edge Indexes

```
e:<from>:<type>:<createdAt>:<to> → { from, to, type, author, createdAt, deleted }

i:in:<to>:<type>:<createdAt>:<from> → { ref: <full e: key> }

er:<from>:<type>:<to> → { ref: <full e: key> }

cnt:in:<to>:<type> → { count }
cnt:out:<from>:<type> → { count }
```

**Index design notes:**
- `createdAt` is embedded in edge keys for efficient time-ordered range scans
- The `er:` index enforces one active edge per (from, type, to) triple
- Edge counts are incremented on create and decremented on delete (clamped at 0)
- In P2P delivery, if a delete arrives before its create, the count may read one low temporarily

## Tag Indexes

```
t:<tag>:<createdAt>:<entityId>:<author> → { createdAt }

tref:<tag>:<entityId>:<author> → { ref }
```

**Tag design notes:**
- Tags are author-scoped (only the entity's author can tag it)
- This prevents spam and keeps tag indexes low-noise

## Moderation Indexes

```
m:t:<targetId>:<createdAt>:<coreKeyHex>:<seq> → { eventId, action, target, author, createdAt, signature }

m:a:<author>:<createdAt>:<targetId>:<coreKeyHex>:<seq> → { eventId, action, target, author, createdAt, signature }
```

**Moderation design notes:**
- Moderation actions are signed by the author's keypair
- Peers validate signatures against the role registry before applying
- This enables verifiable offline moderation without trusting any central authority

## Identity Indexes

```
id:profile:<pubkey> → { username, bio, ... }
```

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
