// Server-side IPFS gateway proxy - exists purely to dodge a browser-only
// restriction. CORS is enforced by browsers, not servers: a Vercel function
// fetching from a public IPFS gateway has zero CORS exposure regardless of
// whether that gateway sends an Access-Control-Allow-Origin header, since
// this is a plain server-to-server request. Racing all 5 gateways here
// (same list adapters used to race client-side) actually works as
// designed - verified live that 4 of 5 public IPFS gateways send no CORS
// header at all for this content when called from a browser, which made
// racing them client-side pointless (guaranteed failures, wasted latency)
// even though the content itself was reachable the whole time. See
// src/adapters/hoodchan/chain.js, which calls this instead of hitting
// gateways directly now.
//
// Plain query-string route (?path=<cid>/<subpath>) rather than a
// /api/ipfs/[...path] catch-all - simpler and avoids a real Vercel dev
// routing quirk hit while building this (a 2+-segment catch-all path
// wasn't reaching the function locally; a single query param sidesteps
// dynamic-route matching entirely and is exactly the pattern the rest of
// this repo's own api/ routes already use).
const GATEWAYS = [
  (p) => `https://dweb.link/ipfs/${p}`,
  (p) => `https://w3s.link/ipfs/${p}`,
  (p) => `https://nftstorage.link/ipfs/${p}`,
  (p) => `https://ipfs.io/ipfs/${p}`,
  (p) => `https://gateway.pinata.cloud/ipfs/${p}`,
];

const FETCH_TIMEOUT_MS = 8000;

function raceGateways(cidPath) {
  const attempts = GATEWAYS.map(async (gateway) => {
    const upstream = await fetch(gateway(cidPath), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!upstream.ok) throw new Error(`Gateway responded ${upstream.status}`);
    return upstream;
  });
  return Promise.any(attempts);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") {
    res.status(405).json({ error: "Use GET" });
    return;
  }

  // Node/Vercel already URL-decodes query values, so this arrives as the
  // real CID + subpath (with real slashes) - the client encodeURIComponent's
  // the whole thing once when building the request URL (see
  // ipfsProxyUrl in src/adapters/hoodchan/chain.js), nothing further to
  // decode here.
  const cidPath = typeof req.query.path === "string" ? req.query.path : "";
  if (!cidPath) {
    res.status(400).json({ error: "Missing ?path=<cid>/<subpath>" });
    return;
  }

  // Even server-side (no CORS involved at all here - that's purely a
  // browser restriction) all 5 gateways can still fail together under real
  // concurrent load - verified live, and matches the real h00dchan app's
  // own documented history with these exact same public gateways ("roughly
  // 60-70% failure rate... almost certainly rate-limiting from this app's
  // own burst traffic hitting them repeatedly"). One retry after a short
  // backoff catches the transient case cheaply; a collection whose public
  // gateways are failing for a structural reason (not just burst load)
  // would need a dedicated/paid gateway to fix properly - see this file's
  // own header comment for why that isn't wired up here.
  try {
    let upstream;
    try {
      upstream = await raceGateways(cidPath);
    } catch {
      await sleep(600);
      upstream = await raceGateways(cidPath);
    }
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    // Content addressed by CID is immutable - safe to cache aggressively at
    // the edge and in the browser, which is what keeps repeat visits fast
    // without every visitor re-racing gateways for content that never changes.
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, immutable");
    res.status(200).send(buffer);
  } catch (err) {
    console.error("[ipfs-proxy]", err);
    res.status(502).json({ error: "Could not fetch from IPFS right now" });
  }
};
