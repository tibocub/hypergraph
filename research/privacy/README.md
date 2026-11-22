# Privacy prototypes (spec 029)

Findings: `specs/029-privacy-deniability/research.md`. Nothing here is product code or in `npm test`.

- `vault/vault.js`: a deniable vault file. Random fill, one salt, 16 header slots tried with one Argon2id run,
  encrypted 4 KiB pages (XChaCha20-Poly1305), page maps. `vault/test.js` checks it (and shows the known limit:
  an identity written alone can destroy one that wasn't opened).
- `vault/bench.js`: Argon2id times, fill speed, encrypted page write/read against a plain file.
- `vault/hypercore-io.js`: what hypercore on RocksDB writes per record (the load a vault must carry).
- `padding/measure.js`: real encrypted block sizes from a private forum (forum scenario API), priced under
  padding schemes.
- `jitter/simulate.js`: can a holder link two identities on one device by when they come online, and do random
  sync delays stop it?
- `electron-traces/main.js` + `check.js`: what an Electron session (in-memory or `persist:`) leaves on disk.

```bash
node research/privacy/vault/test.js
node research/privacy/vault/bench.js 256 32
node research/privacy/vault/hypercore-io.js
node research/privacy/padding/measure.js
node research/privacy/jitter/simulate.js
../HyperBrowser/node_modules/electron/dist/electron.exe research/privacy/electron-traces/main.js <scratch folder>/etrace/memory memory
node research/privacy/electron-traces/check.js <scratch folder>/etrace/memory
```
