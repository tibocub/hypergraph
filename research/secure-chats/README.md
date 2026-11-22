# Secure conversations: cost measurements

`cost.js` prices the crypto of spec 031 against today's private spaces: crypto only (sodium-universal, as
`lib/private/crypto.js`), no network, disk or index.

```bash
node research/secure-chats/cost.js
bare research/secure-chats/cost.js
```

Medians of 5 runs of 20,000 operations, one desktop CPU core, Node 26.4 and Bare 1.35, 2026-11-22.

| | Node | Bare |
|---|---|---|
| chat line, padded block: today → with chains | 264.0 → 264.3 B (+0.11%) | same |
| send, µs/message: today → with chains | 1.70 → 3.50 | 1.80 → 3.30 |
| receive, µs/message: today → with chains | 1.50 → 2.25 | 1.25 → 2.05 |
| skipping ahead, µs/skipped key | 1.00 | 0.85 |
| key change, 10 devices: decider / each device | 0.71 / 0.085 ms | 0.70 / 0.070 ms |
| key change, 100 devices: decider / each device | 7.10 / 0.150 ms | 6.45 / 0.100 ms |
| key change, written | 512 B per device (a grant and a prekey, 256 B blocks each) | same |

Assumptions: chat lines are log-normal, median 40 characters (as spec 030); a record's type, stamp and field
framing add 60 B around its text; the chain index is a compact-encoding uint (1 B under 253, 3 B after).
Not measured: the local key store's writes (one small write per message sent or received, next to the index
write hypergraph already makes), and anything on a phone.
