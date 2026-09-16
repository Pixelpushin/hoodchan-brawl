// In-memory stand-in for api/_lib/chain.js's ownerOf(), so route tests never
// touch a real RPC. Same require.cache-swap pattern as fake-redis.js /
// scripts/test-lobby-join.mjs.
"use strict";

const path = require("node:path");

// owners: { [tokenId]: "0x..." } (any casing in, lowercased out - matches
// the real ownerOf's contract). failFor: Set of tokenIds that should throw,
// simulating an RPC outage (real ownerOf throws rather than 403ing when it
// can't reach the chain at all).
function createFakeChain({ owners = {}, failFor = new Set() } = {}) {
  async function ownerOf(tokenId) {
    if (failFor.has(tokenId)) throw new Error("fake chain: rpc down");
    const addr = owners[tokenId];
    return addr ? addr.toLowerCase() : null;
  }

  function installFakeChain(require, repoRoot) {
    const p = require.resolve(path.join(repoRoot, "api/_lib/chain.js"));
    require.cache[p] = {
      id: p,
      filename: p,
      loaded: true,
      exports: {
        // Real constants aren't needed for ownership logic, but callers that
        // destructure the full chain.js shape (e.g. api/_lib/mint.js) get a
        // consistent module rather than undefined.
        RPC_URL: "https://fake-rpc.invalid",
        CHAIN_ID: 4663,
        NFT_CONTRACT: "0x0000000000000000000000000000000000dEaD",
        ownerOf,
      },
    };
  }

  return { ownerOf, installFakeChain };
}

module.exports = { createFakeChain };
