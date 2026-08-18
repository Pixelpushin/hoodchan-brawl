// Redis key scheme for the win/loss stats + recent-matches feed, shared by
// match-result.js, hoodie/[tokenId]/stats.js, and matches/recent.js.
//
// "onchainhoodies" keeps the original unprefixed key format
// (hoodie:{id}:wins, matches:recent) - this endpoint's data predates the
// adapter system, and hoodies-fight's live deployment already has real
// accumulated stats under those exact keys. Renaming them out from under it
// would silently zero out every Hoodie's fight record. Every other adapter
// gets a real namespace instead, so two different collections' token #42
// never collide in the same key.
const LEGACY_ADAPTER_KEY = "onchainhoodies";

function statsKeys(adapterKey, tokenId) {
  if (adapterKey === LEGACY_ADAPTER_KEY) {
    return { wins: `hoodie:${tokenId}:wins`, losses: `hoodie:${tokenId}:losses` };
  }
  return {
    wins: `stats:${adapterKey}:${tokenId}:wins`,
    losses: `stats:${adapterKey}:${tokenId}:losses`,
  };
}

function recentMatchesKey(adapterKey) {
  return adapterKey === LEGACY_ADAPTER_KEY ? "matches:recent" : `matches:recent:${adapterKey}`;
}

// Not a collection-specific supply cap anymore (used to be OnChainHoodies'
// own 0-5999 range) - just a sanity bound so a malformed/malicious request
// can't write an absurd Redis key. Any adapter's real token ID range fits
// comfortably under this.
const MAX_TOKEN_ID = 10_000_000;

// Adapter keys come from each adapter's own config.key (src/adapters/*/index.js)
// - lowercase alphanumeric plus hyphens, same shape as those. Validated here
// so a bad/missing adapter query param fails loudly instead of silently
// landing in a weird Redis key.
const ADAPTER_KEY_PATTERN = /^[a-z0-9-]{1,64}$/;

function isValidAdapterKey(adapterKey) {
  return typeof adapterKey === "string" && ADAPTER_KEY_PATTERN.test(adapterKey);
}

module.exports = { statsKeys, recentMatchesKey, MAX_TOKEN_ID, isValidAdapterKey, LEGACY_ADAPTER_KEY };
