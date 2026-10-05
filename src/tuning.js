/**
 * Indexing batch sizes, in one place so tests can shrink them.
 *
 * Not public API: chosen by measurement (bench/scale.js; see
 * specs/002-scale-indexing/research.md R9), and only worth exposing if one
 * size turns out not to serve both a phone and a desktop.
 */
module.exports = {
  // Index entries are committed (one hypercore append: one hash, one
  // signature, one flush) every this many events. Bounds memory held by an
  // open batch, and is how often a long pass becomes visible to readers.
  INDEX_BATCH: 1000,

  // How many blocks of another user's log to request ahead of the indexing
  // position, instead of one network round trip per block.
  PREFETCH_WINDOW: 4096,

  // How often a context's indexers acknowledge new history, which is what
  // lets it become confirmed (signed). Autobase's own default. With acks off,
  // multi-writer contexts never confirmed anything (specs/003-fast-forward-
  // contexts/research.md R1).
  ACK_INTERVAL: 1000
}
