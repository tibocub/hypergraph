# Data model: Logs open only while used

## Held log entry (`directory.logs` value), new fields

| field | meaning |
|---|---|
| `core` | the open session, or null while closed |
| `uses` | open/release count; 0 starts the idle close |
| `opening` | the open under way (one at a time) |
| `length`, `byteLength` | last known, kept without the core (FR-001) |
| `claim` | the longest length a settled exchange reported for it (R4); `claimAt` when it was opened for it |
| `handed` | its length at the last helper hand-off (R6) |

Saved in the log's counters (`@hg/meta`, JSON, `droppedName`): `len`, `bytes`, `admitted`.

## Summary entry

`hash(key ‖ uint(min(length, limit)))`, XORed per sub-range and in total (the summary digest).

## Channel (per peer, per space)

`theirs` (its last summary digest), `settledOn` (the digest this member last settled with).
