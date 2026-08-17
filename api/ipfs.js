// Server-side IPFS gateway proxy - exists purely to dodge a browser-only
// restriction. CORS is enforced by browsers, not servers: a Vercel function
// fetching from a public IPFS gateway has zero CORS exposure regardless of
// whether that gateway sends an Access-Control-Allow-Origin header, since
// this is a plain server-to-server request. Racing all 5 public gateways
// here actually works as designed - verified live that 4 of 5 send no CORS
// header at all for HOODCHAN's content when called from a browser, which
// made racing them client-side pointless (guaranteed failures, wasted
// latency) even though the content itself was reachable the whole time.
// See src/adapters/hoodchan/chain.js, which calls this instead of hitting
// gateways directly, and ADAPTERS.md's "IPFS-based collections" section for
// the full writeup of when/why an adapter needs this at all.
//
// Optional dedicated gateway (recommended for any real collection): public
// IPFS gateways are free, shared, and rate-limited - verified live that
// even server-side, with no CORS involved, all 5 can still fail together
// under real concurrent load (a character-select grid loading a page of
// cards easily fires 20+ requests at once). This matches the real h00dchan
// app's own documented history with these exact same gateways ("roughly
// 60-70% failure rate... rate-limiting from this app's own burst traffic").
// A paid dedicated gateway (Pinata's, in this deployment's case) doesn't
// have that shared-rate-limit problem, gets tried first when configured,
// and is what makes this genuinely fast rather than just "eventually
// works." See ADAPTERS.md for how to set one up for your own collection -
// two env vars, no code changes needed.
const PINATA_GATEWAY_DOMAIN = process.env.PINATA_GATEWAY_DOMAIN;
const PINATA_GATEWAY_TOKEN = process.env.PINATA_GATEWAY_TOKEN;

function dedicatedGateway(p) {
  if (!PINATA_GATEWAY_DOMAIN || !PINATA_GATEWAY_TOKEN) return null;
  return `https://${PINATA_GATEWAY_DOMAIN}/ipfs/${p}?pinataGatewayToken=${PINATA_GATEWAY_TOKEN}`;
}

const PUBLIC_GATEWAYS = [
  (p) => `https://dweb.link/ipfs/${p}`,
  (p) => `https://w3s.link/ipfs/${p}`,
  (p) => `https://nftstorage.link/ipfs/${p}`,
  (p) => `https://ipfs.io/ipfs/${p}`,
  (p) => `https://gateway.pinata.cloud/ipfs/${p}`,
];

const FETCH_TIMEOUT_MS = 8000;

async function fetchOne(url) {
  const upstream = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!upstream.ok) throw new Error(`Gateway responded ${upstream.status}`);
  return upstream;
}

// Dedicated gateway first (if configured) since it's the reliable one - only
// pays the cost of racing the public gateways if that single request fails
// (or isn't configured at all, which is the zero-config default).
async function raceGateways(cidPath) {
  const dedicated = dedicatedGateway(cidPath);
  if (dedicated) {
    try {
      return await fetchOne(dedicated);
    } catch {
      // fall through to the public race below
    }
  }
  return Promise.any(PUBLIC_GATEWAYS.map((gateway) => fetchOne(gateway(cidPath))));
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

  // One retry after a short backoff catches the transient case cheaply -
  // gateways (dedicated or public) failing once under a burst often succeed
  // moments later once that burst has passed.
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
