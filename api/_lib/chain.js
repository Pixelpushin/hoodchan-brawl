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

// ownerOf(tokenId) on NFT_CONTRACT, lowercase. Throws if the RPC itself
// fails so callers can distinguish "can't verify" (502) from "not the owner"
// (403). Returns null if the token has no owner.
async function ownerOf(tokenId) {
  const data = `0x${SELECTOR_OWNER_OF}${encodeUint256(tokenId)}`;
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The public Robinhood RPC rejects bare/non-browser clients from some
      // networks; these two headers are what its own frontends send.
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      origin: "https://vibechain.com",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: NFT_CONTRACT, data }, "latest"],
    }),
    // Same budget as the client twin (src/adapters/hoodchan/chain.js). A hung
    // RPC socket must become a 502 "can't verify" from join.js, not a
    // bodyless Vercel 504.
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "eth_call failed");
  return decodeAddress(body.result);
}

module.exports = { RPC_URL, CHAIN_ID, NFT_CONTRACT, ownerOf };
