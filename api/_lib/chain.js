// Server-side chain reads for the API routes (CJS, zero deps beyond fetch).
//
// ONE place for the NFT contract the server verifies against. This game is a
// fork of pfp-brawl; api/lobby/join.js used to carry its own copy of the
// OnChainHoodies contract address from the fork, so every PVP join was
// checked against a collection nobody in this game holds and 403'd
// ("Wallet … does not own token N") even for tokens the wallet plainly owns.
// The client adapter (src/adapters/hoodchan/chain.js) is the source of truth
// for which collection this deployment is; scripts/test-lobby-ownership.mjs
// asserts the two never drift apart again.
const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663;

// HOODCHAN on Robinhood Chain - must equal CONTRACT in src/adapters/hoodchan/chain.js.
const NFT_CONTRACT = "0x774Db2207D26570F5638028839c816702A40aBC2";

const SELECTOR_OWNER_OF = "6352211e";

function encodeUint256(n) {
  return BigInt(n).toString(16).padStart(64, "0");
}

function decodeAddress(hex) {
  const clean = String(hex ?? "").replace(/^0x/, "");
  // A call against a contract that doesn't exist (or a burned/nonexistent
  // token) returns "0x"/short data - never let that decode to a bogus address.
  if (clean.length < 40) return null;
  return `0x${clean.slice(-40)}`.toLowerCase();
}

// RPC endpoints, in order. Alchemy first when the project has a key (same
// Alchemy-first-then-public pattern as hoodchan.org's lib/rpc.ts; Alchemy
// supports Robinhood Chain), the public RPC otherwise/as fallback.
function rpcEndpoints() {
  const key = process.env.ALCHEMY_API_KEY;
  const list = [];
  if (key) list.push({ name: "alchemy", url: `https://robinhood-mainnet.g.alchemy.com/v2/${key}` });
  list.push({ name: "public", url: RPC_URL });
  return list;
}

// One eth_call against one endpoint. Resolves ONLY with a real hex result;
// anything else (HTTP error, HTML challenge page, JSON without a result,
// JSON-RPC error) throws with enough detail to see what the endpoint actually
// answered. This matters: a bad answer must never decode to "some other
// address" and turn into a 403 "does not own" for the real owner.
// One JSON-RPC call against one endpoint. Resolves ONLY with a real hex
// result; anything else (HTTP error, HTML challenge page, JSON without a
// result, JSON-RPC error) throws with enough detail to see what the endpoint
// actually answered. This matters: a bad answer must never decode to "some
// other address" and turn into a 403 "does not own" for the real owner.
// Factored out of ethCall so getBalance/blockNumber below share the exact
// same request shape, timeout, and error/validation behavior instead of a
// second hand-copied fetch — ethCall itself is unchanged (same signature,
// same error strings) since it just delegates to this for "eth_call".
async function rpcCall(endpoint, method, params) {
  const res = await fetch(endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    // Same budget as the client twin (src/adapters/hoodchan/chain.js). A hung
    // RPC socket must become a 502 "can't verify" from join.js, not a
    // bodyless Vercel 504.
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON: reported below */ }
  const snippet = text.replace(/\s+/g, " ").slice(0, 80);
  if (!res.ok) throw new Error(`${endpoint.name} rpc HTTP ${res.status}: ${snippet}`);
  if (!body || typeof body !== "object") throw new Error(`${endpoint.name} rpc non-JSON: ${snippet}`);
  if (body.error) throw new Error(`${endpoint.name} rpc error: ${body.error.message ?? snippet}`);
  if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(body.result)) {
    throw new Error(`${endpoint.name} rpc no result: ${snippet}`);
  }
  return body.result;
}

async function ethCall(endpoint, to, data) {
  return rpcCall(endpoint, "eth_call", [{ to, data }, "latest"]);
}

// ownerOf(tokenId) on NFT_CONTRACT, lowercase. Tries each endpoint in turn;
// throws (with every endpoint's reason) only if all of them fail, so callers
// can distinguish "can't verify" (502) from "not the owner" (403). Returns
// null if the call succeeded but the token has no owner.
async function ownerOf(tokenId) {
  const data = `0x${SELECTOR_OWNER_OF}${encodeUint256(tokenId)}`;
  const reasons = [];
  for (const endpoint of rpcEndpoints()) {
    try {
      return decodeAddress(await ethCall(endpoint, NFT_CONTRACT, data));
    } catch (err) {
      reasons.push(err.message);
    }
  }
  throw new Error(reasons.join(" | "));
}

// eth_getBalance(address) in wei, as a decimal string (BigInt-safe - the hex
// result can exceed Number.MAX_SAFE_INTEGER). Same endpoint list/fallback/
// error-aggregation shape as ownerOf, for api/mint-cron.js's minter-balance
// preflight and api/status.js's minter panel.
async function getBalance(address) {
  const reasons = [];
  for (const endpoint of rpcEndpoints()) {
    try {
      const hex = await rpcCall(endpoint, "eth_getBalance", [address, "latest"]);
      return BigInt(hex).toString();
    } catch (err) {
      reasons.push(err.message);
    }
  }
  throw new Error(reasons.join(" | "));
}

// eth_blockNumber. Returns which endpoint answered alongside the number so
// api/status.js can report it (Alchemy vs the public RPC) rather than just
// "some endpoint, we don't know which."
async function blockNumber() {
  const reasons = [];
  for (const endpoint of rpcEndpoints()) {
    try {
      const hex = await rpcCall(endpoint, "eth_blockNumber", []);
      return { block: Number(BigInt(hex)), endpoint: endpoint.name };
    } catch (err) {
      reasons.push(err.message);
    }
  }
  throw new Error(reasons.join(" | "));
}

module.exports = { RPC_URL, CHAIN_ID, NFT_CONTRACT, ownerOf, getBalance, blockNumber };
