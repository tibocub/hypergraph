# I2P prototype

Spike 033: I2P as a second network for hypergraph. Findings: `specs/033-i2p-research/research.md`.

- `sam.js`: a minimal SAM v3 client (streams, repliable and raw datagrams). Talks only to 127.0.0.1.
- `router.js`: starts `i2pd` or `emissary-cli` as a hidden child process with its own data folder and SAM ports.
- `udx-shim.js`: a stand-in for `udx-native` that `dht-rpc` takes as `opts.udx`, so dht-rpc runs over SAM datagrams unforked.
- `bench.js`: router start times and idle cost, replication over SAM streams (028's scenario), dht-rpc lookups over I2P.
- `test.js`: self-check of the shim with an in-memory datagram network (no router needed).

```bash
node research/i2p/test.js
node research/i2p/bench.js start  --router i2pd --exe <i2pd.exe> --idle 600
node research/i2p/bench.js stream --router i2pd --exe <i2pd.exe>
node research/i2p/bench.js dht    --router i2pd --exe <i2pd.exe> --nodes 8 --style DATAGRAM
```

Routers come from their official releases (i2pd: github.com/PurpleI2P/i2pd; emissary: github.com/eepnet/emissary),
kept outside the repo. Both join the live I2P network and relay for others while they run.
