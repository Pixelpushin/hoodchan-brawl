// Soulbound mint helper — calls mintMatchRecord on HoodieBrawlSoulbound.
//
// Uses ethers v6 (the only npm dep in this project) because raw secp256k1
// signing is not available in Node.js built-ins.
//
// Environment vars required:
//   SOULBOUND_CONTRACT_ADDRESS  — deployed HoodieBrawlSoulbound address
//   MINTER_PRIVATE_KEY          — private key of the trusted minter wallet
//
// The Robinhood Chain RPC is hardcoded since it's a fixed deploy target.
//
// Tokens are minted to each fighter's ERC-6551 TBA (token-bound account),
// not the owner's EOA — ties the achievement to the specific Hoodie, not
// the person who happened to own it at fight time.

const { ethers } = require("ethers");

const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663n;
const CHAIN_ID_HEX = "0x1237";

// HOODCHAN NFT contract on Robinhood Chain - the one shared constant (see
// api/_lib/chain.js; scripts/test-lobby-ownership.mjs fails on any other copy).
const { NFT_CONTRACT: HOODCHAN_CONTRACT } = require("./chain");

// ERC-6551 registry — same canonical address on every chain
const REGISTRY_ADDRESS = "0x000000006551c19487814612e58FE06813775758";
// V3 implementation — confirmed live on Robinhood Chain
const IMPLEMENTATION_ADDRESS = "0x41C8f39463A868d3A88af00cd0fe7102F30E44eC";

// Registry ABI — only the account() view we need
const REGISTRY_ABI = [
  "function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) external view returns (address)",
];

// Soulbound contract ABI — only what we call
const SOULBOUND_ABI = [
  "function mintMatchRecord(address wallet1, uint256 nft1, address wallet2, uint256 nft2) external",
  "function usedPairings(bytes32) external view returns (bool)",
  "function pairHash(address walletA, uint256 nftA, address walletB, uint256 nftB) external pure returns (bytes32)",
];

function getProvider() {
  return new ethers.JsonRpcProvider(RPC_URL, {
    chainId: CHAIN_ID,
    name: "robinhoodchain",
  });
}

function getContract(provider) {
  const address = process.env.SOULBOUND_CONTRACT_ADDRESS;
  const key = process.env.MINTER_PRIVATE_KEY;
  if (!address || !key) throw new Error("SOULBOUND_CONTRACT_ADDRESS or MINTER_PRIVATE_KEY not set");
  const wallet = new ethers.Wallet(key, provider);
  return new ethers.Contract(address, SOULBOUND_ABI, wallet);
}

// Memoized minter address, derived from MINTER_PRIVATE_KEY without touching
// the network. api/mint-cron.js writes this to Redis (mint:minter:address)
// once per run so api/status.js can report the minter's address/balance
// without ever loading the private key itself. Memoized because
// ethers.Wallet's key derivation is the same cost every call and this key
// never changes mid-process; a bad/missing key throws (never returns a
// stale/blank address) and is NOT cached, so a later fix to the env var
// (or a first successful call after cold start) works without a restart.
let cachedMinterAddress = null;
function getMinterAddress() {
  if (cachedMinterAddress) return cachedMinterAddress;
  const key = process.env.MINTER_PRIVATE_KEY;
  if (!key) throw new Error("MINTER_PRIVATE_KEY not set");
  cachedMinterAddress = new ethers.Wallet(key).address;
  return cachedMinterAddress;
}

/**
 * Compute the ERC-6551 TBA address for a HOODCHAN token.
 * The salt is always bytes32(0) — same convention used across all
 * Pixelpushin projects on Robinhood Chain.
 */
async function computeTba(provider, tokenId) {
  const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
  return registry.account(
    IMPLEMENTATION_ADDRESS,
    ethers.ZeroHash, // salt = bytes32(0)
    CHAIN_ID,
    HOODCHAN_CONTRACT,
    BigInt(tokenId),
  );
}

/**
 * Mint a soulbound match record for a completed match.
 * Tokens go to each fighter's TBA, not the owner's EOA.
 *
 * @deprecated wallet1/wallet2 - the contract call path only ever uses each
 *   token's computed TBA (tba1/tba2) for both the pairHash dedup check and
 *   the mint recipient; these two params are accepted for call-site
 *   compatibility (api/mint-cron.js, api/ai-match-complete.js's queued entry
 *   shape) but are not read here. Slated for removal once every caller stops
 *   passing them.
 * @param {string} wallet1       - unused, see @deprecated above
 * @param {number|bigint} nft1   - token ID of player 1's NFT
 * @param {string} wallet2       - unused, see @deprecated above
 * @param {number|bigint} nft2   - token ID of player 2's NFT
 * @returns {Promise<{txHash: string, alreadyMinted: boolean}>}
 */
async function mintMatchRecord(wallet1, nft1, wallet2, nft2) {
  const provider = getProvider();
  const contract = getContract(provider);

  // Resolve TBA addresses first — contract uses them for both pairHash dedup
  // AND as the mint recipient, so we need them before any check.
  const [tba1, tba2] = await Promise.all([
    computeTba(provider, nft1),
    computeTba(provider, nft2),
  ]);

  // Check if already minted — avoids a revert on duplicate.
  // Must use the same addresses (TBAs) that mintMatchRecord will hash.
  const hash = await contract.pairHash(tba1, BigInt(nft1), tba2, BigInt(nft2));
  const used = await contract.usedPairings(hash);
  if (used) {
    return { txHash: null, alreadyMinted: true };
  }

  const tx = await contract.mintMatchRecord(tba1, BigInt(nft1), tba2, BigInt(nft2));
  const receipt = await tx.wait(1);
  return { txHash: receipt.hash, alreadyMinted: false, tba1, tba2 };
}

module.exports = { mintMatchRecord, computeTba, getMinterAddress };
