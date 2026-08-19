// Talks to the real h00dchan app's public dev API (hoodchan.org/api/v1/*)
// instead of doing this adapter's own on-chain+IPFS resolution. Two wins
// over chain.js's approach:
//
// 1. Speed: h00dchan permanently caches every token's metadata (Redis) and,
//    once backfilled, serves its image off Vercel Blob's CDN rather than a
//    live IPFS gateway fetch - the exact slow/flaky path chain.js's own
//    comments already document workarounds for (a client-side throttle
//    that used to exist, a dedicated-gateway setup step in ADAPTERS.md).
//    This adapter gets that speed for free without needing its own gateway
//    config at all.
// 2. Real archetype mapping: h00dchan now computes real Builder/Hodler/
//    Collector XP per token (see hoodchan.org's lib/leveling.ts) - the
//    exact same three names this game's combat archetypes use. Whichever
//    category actually dominates a token's real posting/holding behavior
//    can now decide its archetype, instead of index.js's old tokenId % 4
//    placeholder.
//
// Falls back to chain.js's on-chain reads if the API is unreachable (see
// index.js) - this file never throws in a way that leaves the adapter
// with no path forward, it just means a caller should retry the fallback.
//
// Also solves a CORS problem chain.js had to work around: raw IPFS gateway
// responses don't send Access-Control-Allow-Origin, so chain.js
// base64-encodes every image into a data: URI before handing it to canvas
// (see fetchIpfsImageDataUri/blobToDataUri) to avoid tainting the canvas.
// Vercel Blob's public files DO send proper CORS headers, so the plain
// https:// URL from this API works directly with head-image.js's existing
// `img.crossOrigin = "anonymous"` - no data-URI conversion needed here.
const API_BASE = "https://www.hoodchan.org/api/v1";
const FETCH_TIMEOUT_MS = 8000;

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`hoodchan API ${path} failed (${res.status})`);
  return res.json();
}

// Real behavior decides the archetype, not a coin flip: whichever of the
// three tracked categories a token actually leans into wins. "Flipper" -
// the one archetype this API has no directly-named XP category for - is
// the default for a token with no real signal in any of the other three
// (never claimed, never posted, no meaningful holding streak), which
// matches the site's own framing: a flipper is defined by the ABSENCE of
// the hodler/builder/collector behaviors, not a fourth thing to measure.
function archetypeKeyFromXp(xpBreakdown) {
  if (!xpBreakdown) return null;
  const { builderXp = 0, hodlerXp = 0, collectorXp = 0 } = xpBreakdown;
  const max = Math.max(builderXp, hodlerXp, collectorXp);
  if (max <= 0) return "Flipper";
  if (max === hodlerXp) return "Hodler";
  if (max === collectorXp) return "Collector";
  return "Builder";
}

export async function fetchTokenFromApi(tokenId) {
  const data = await apiFetch(`/token/${tokenId}`);
  return {
    tokenId: data.tokenId,
    name: data.name,
    image: data.image,
    attributes: data.attributes ?? [],
    archetypeKey: archetypeKeyFromXp(data.xpBreakdown),
  };
}

export async function fetchWalletTokenIdsFromApi(address) {
  const data = await apiFetch(`/wallet/${address}`);
  return data.tokenIds ?? [];
}
