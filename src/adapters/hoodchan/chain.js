// Direct on-chain reads for the HOODCHAN collection on Robinhood Chain -
// same chain as the OnChainHoodies adapter, different contract. Raw
// JSON-RPC eth_call, no npm dependency, ported from the real h00dchan app's
// own lib/chain.ts (github.com/Pixelpushin/h00dchan), whose comments
// document exactly how each of these was independently verified live
// (name="HOODCHAN", symbol="HC", totalSupply=1200, no ERC721Enumerable
// support - tokenOfOwnerByIndex reverts, confirmed against a real holder).
//
// Unlike OnChainHoodies (fully on-chain, tokenURI returns inline SVG via a
// data: URI), HOODCHAN's tokenURI resolves to an ipfs:// URI pointing at
// standard OpenSea-schema JSON, and the art itself is a photographic/
// collage JPEG - not something a background can be cleanly stripped from.
// That's exactly why this adapter uses headStyle: "circle" (see index.js).

export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const CONTRACT = "0x774Db2207D26570F5638028839c816702A40aBC2";
export const CHAIN_ID_HEX = "0x1237"; // 4663

const SELECTOR_OWNER_OF = "6352211e"; // ownerOf(uint256)
const SELECTOR_TOKEN_URI = "c87b56dd"; // tokenURI(uint256)

const FETCH_TIMEOUT_MS = 8000;

function encodeUint256(tokenId) {
  return BigInt(tokenId).toString(16).padStart(64, "0");
}

async function ethCall(selector, tokenId) {
  const data = `0x${selector}${encodeUint256(tokenId)}`;
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: CONTRACT, data }, "latest"],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "eth_call failed");
  return body.result;
}

function decodeAddress(hex) {
  const clean = hex.replace(/^0x/, "");
  return `0x${clean.slice(-40)}`;
}

function decodeString(hex) {
  const clean = hex.replace(/^0x/, "");
  const length = parseInt(clean.slice(64, 128), 16);
  const dataHex = clean.slice(128, 128 + length * 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export async function readOwnerOf(tokenId) {
  return decodeAddress(await ethCall(SELECTOR_OWNER_OF, tokenId));
}

export async function readTokenURI(tokenId) {
  return decodeString(await ethCall(SELECTOR_TOKEN_URI, tokenId));
}

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  return body.result;
}

const TRANSFER_EVENT_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function addressToTopic(address) {
  return `0x${"0".repeat(24)}${address.replace(/^0x/, "").toLowerCase()}`;
}

function decodeUint256(hex) {
  return BigInt(hex).toString();
}

// No ERC721Enumerable - tokenOfOwnerByIndex reverts (verified live against
// a real holder) - so wallet ownership is derived from Transfer event logs
// (candidates) confirmed one-by-one with a live ownerOf() call, same
// approach as the onchainhoodies adapter's own chain fallback.
const OWNERSHIP_CHECK_CONCURRENCY = 15;
const MAX_CANDIDATES = 300;

export async function fetchWalletTokenIdsOnChain(address) {
  const logs = await rpcCall("eth_getLogs", [
    {
      address: CONTRACT,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [TRANSFER_EVENT_TOPIC, null, addressToTopic(address)],
    },
  ]);

  const candidateIds = [...new Set(logs.map((log) => decodeUint256(log.topics[3])))].slice(0, MAX_CANDIDATES);

  const owned = [];
  for (let i = 0; i < candidateIds.length; i += OWNERSHIP_CHECK_CONCURRENCY) {
    const batch = candidateIds.slice(i, i + OWNERSHIP_CHECK_CONCURRENCY);
    const owners = await Promise.all(batch.map((id) => readOwnerOf(id).catch(() => null)));
    batch.forEach((id, j) => {
      if (owners[j] && owners[j].toLowerCase() === address.toLowerCase()) owned.push(id);
    });
  }
  return owned;
}

// Routed through our own /api/ipfs proxy (see api/ipfs/[...path].js) rather
// than hitting public IPFS gateways directly from the browser. CORS is a
// browser-only restriction - verified live that 4 of 5 public gateways
// (w3s.link, nftstorage.link, ipfs.io, gateway.pinata.cloud) send no CORS
// header at all for this collection's content, on effectively every
// request, not intermittently. That made a client-side gateway race mostly
// a race against guaranteed failures: every fetch paid for those 4
// failures before whichever gateway actually worked won anyway. The proxy
// runs server-to-server (no CORS exposure there at all, by definition) and
// does that same multi-gateway racing itself, invisibly - this file no
// longer needs to know which gateways exist or whether they support CORS.
//
// Trade-off worth knowing: this means the hoodchan adapter needs the /api
// routes to actually be running to load any art - `python3 -m http.server`
// (the plain static-file workflow every other adapter here supports) won't
// serve them, so local testing needs `vercel dev` instead. Every other
// adapter still works with the plain static server; this is the one
// exception, and it's inherent to HOODCHAN's own IPFS-based storage, not
// something a from-scratch adapter for a different collection would
// necessarily need.
function ipfsUriToPath(uri) {
  return uri.replace(/^ipfs:\/\//, "").replace(/^ipfs\//, "");
}

function ipfsProxyUrl(uri) {
  return `/api/ipfs?path=${encodeURIComponent(ipfsUriToPath(uri))}`;
}

async function fetchIpfsJson(uri) {
  const res = await fetch(ipfsProxyUrl(uri), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`IPFS proxy responded ${res.status}`);
  return res.json();
}

function parseTokenURI(uri) {
  if (uri.startsWith("data:application/json;base64,")) {
    return JSON.parse(atob(uri.slice("data:application/json;base64,".length)));
  }
  if (uri.startsWith("data:application/json,")) {
    return JSON.parse(decodeURIComponent(uri.slice("data:application/json,".length)));
  }
  if (uri.startsWith("ipfs://") || uri.startsWith("ipfs/")) {
    return fetchIpfsJson(uri);
  }
  return fetch(uri).then((r) => r.json());
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

// Same proxy as fetchIpfsJson, but for the actual image bytes rather than
// JSON. Returns a data: URI so the result is also safe to draw onto a
// <canvas> and read back (toDataURL/getImageData) without cross-origin
// taint, which the circle/crop head-image processing in
// ../shared/head-image.js needs to do - our own /api/ipfs proxy sets an
// Access-Control-Allow-Origin header (see api/ipfs/[...path].js), so this
// would actually be canvas-safe even without the data: URI conversion, but
// the conversion is kept anyway since it's what makes this cacheable as a
// plain string on the returned fighter-data object.
async function fetchIpfsImageDataUri(uri) {
  const res = await fetch(ipfsProxyUrl(uri), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`IPFS proxy responded ${res.status}`);
  const blob = await res.blob();
  return blobToDataUri(blob);
}

async function fetchTokenMetadataUnthrottled(tokenId) {
  const uri = await readTokenURI(tokenId);
  const metadata = await parseTokenURI(uri);
  const image = typeof metadata.image === "string" ? metadata.image : "";
  return {
    tokenId: String(tokenId),
    name: typeof metadata.name === "string" ? metadata.name : `Anon #${tokenId}`,
    image: image ? await fetchIpfsImageDataUri(image) : "",
    attributes: Array.isArray(metadata.attributes) ? metadata.attributes : [],
  };
}

// The character-select grid can request up to 24 tokens at once (12 per
// panel × 2 panels loading their first page together), and each one needs
// 2 sequential /api/ipfs proxy round-trips (metadata, then image) - left
// uncoordinated, that's dozens of requests hitting our own proxy (which
// itself is racing 5 upstream gateways per request) all at once. Verified
// live: even server-side, with no CORS involved at all, those upstream
// gateways still fail under real concurrent load for this collection's
// CIDs - matches the real h00dchan app's own documented history with these
// same public gateways. Queuing to a small, steady number in flight at a
// time reduces that pressure; same idea as this file's own
// OWNERSHIP_CHECK_CONCURRENCY batching for wallet ownership checks, just as
// a general-purpose queue instead of a fixed-size batch loop, since callers
// here (main.js's Promise.all over a page of cards) don't chunk their own
// requests. Kept low (2, not higher) since the proxy's own retry-on-failure
// (see api/ipfs.js) already doubles each token's worst-case request count.
const MAX_CONCURRENT_TOKEN_FETCHES = 2;
let activeTokenFetches = 0;
const tokenFetchQueue = [];

function runQueued(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeTokenFetches++;
      task().then(resolve, reject).finally(() => {
        activeTokenFetches--;
        const next = tokenFetchQueue.shift();
        if (next) next();
      });
    };
    if (activeTokenFetches < MAX_CONCURRENT_TOKEN_FETCHES) {
      run();
    } else {
      tokenFetchQueue.push(run);
    }
  });
}

export function fetchTokenMetadata(tokenId) {
  return runQueued(() => fetchTokenMetadataUnthrottled(tokenId));
}
