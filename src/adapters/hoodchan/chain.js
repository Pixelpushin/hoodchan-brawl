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

// Gateway order verified live against this collection's actual CIDs (see
// the source h00dchan app's lib/chain.ts) - ipfs.io and Pinata's shared
// public gateway are both known-congested/slow for this content, listed
// last as fallbacks rather than led with. dweb.link/w3s.link/nftstorage.link
// consistently answered fastest. No dedicated/paid gateway here (unlike the
// source app) - this is a public, zero-config static site, not something
// that should ship someone else's paid API token.
const PUBLIC_IPFS_GATEWAYS = [
  (cidPath) => `https://dweb.link/ipfs/${cidPath}`,
  (cidPath) => `https://w3s.link/ipfs/${cidPath}`,
  (cidPath) => `https://nftstorage.link/ipfs/${cidPath}`,
  (cidPath) => `https://ipfs.io/ipfs/${cidPath}`,
  (cidPath) => `https://gateway.pinata.cloud/ipfs/${cidPath}`,
];

function ipfsUriToPath(uri) {
  return uri.replace(/^ipfs:\/\//, "").replace(/^ipfs\//, "");
}

// Races every gateway concurrently rather than trying them one at a time -
// a sequential fallback at an 8s timeout each could take up to 40s to fail
// on a single slow CID (this exact failure mode is documented as having
// happened in production against the source h00dchan app). Racing bounds
// the worst case to ~8s and usually resolves much faster, since whichever
// gateway is fastest right now wins instead of always paying for a fixed
// first choice even on days it's the slow one.
async function fetchIpfsJson(uri) {
  const cidPath = ipfsUriToPath(uri);
  const attempts = PUBLIC_IPFS_GATEWAYS.map(async (gateway) => {
    const res = await fetch(gateway(cidPath), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`IPFS gateway responded ${res.status}`);
    return res.json();
  });
  try {
    return await Promise.any(attempts);
  } catch (err) {
    throw new Error(`All IPFS gateways failed: ${err instanceof AggregateError ? err.errors.map((e) => e?.message ?? String(e)).join("; ") : String(err)}`);
  }
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

// Same Promise.any gateway race as fetchIpfsJson, but for the actual image
// bytes rather than JSON - a plain <img src="https://gateway/..."> has no
// equivalent fallback of its own (it just uses whichever single URL it's
// given), and individual gateways are observably flaky per-CID for this
// collection even though the content itself is available elsewhere (see
// the module header comment) - verified live: dweb.link alone hung
// indefinitely on some of this collection's image CIDs while the JSON
// metadata (a different CID) loaded fine. Returns a data: URI so the
// result is also safe to draw onto a <canvas> and read back
// (toDataURL/getImageData) without cross-origin taint, which the circle/
// crop head-image processing in ../shared/head-image.js needs to do.
async function fetchIpfsImageDataUri(uri) {
  const cidPath = ipfsUriToPath(uri);
  const attempts = PUBLIC_IPFS_GATEWAYS.map(async (gateway) => {
    const res = await fetch(gateway(cidPath), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`IPFS gateway responded ${res.status}`);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  });
  try {
    return await Promise.any(attempts);
  } catch (err) {
    throw new Error(`All IPFS gateways failed for image: ${err instanceof AggregateError ? err.errors.map((e) => e?.message ?? String(e)).join("; ") : String(err)}`);
  }
}

export async function fetchTokenMetadata(tokenId) {
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
