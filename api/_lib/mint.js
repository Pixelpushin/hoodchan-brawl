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

const { ethers } = require("ethers");

const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663n;

// Minimal ABI — only what we call
const ABI = [
  "function mintMatchRecord(address wallet1, uint256 nft1, address wallet2, uint256 nft2) external",
  "function usedPairings(bytes32) external view returns (bool)",
  "function pairHash(address walletA, uint256 nftA, address walletB, uint256 nftB) external pure returns (bytes32)",
];

function getContract() {
  const address = process.env.SOULBOUND_CONTRACT_ADDRESS;
  const key = process.env.MINTER_PRIVATE_KEY;
  if (!address || !key) throw new Error("SOULBOUND_CONTRACT_ADDRESS or MINTER_PRIVATE_KEY not set");

  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    chainId: CHAIN_ID,
    name: "robinhoodchain",
  });
  const wallet = new ethers.Wallet(key, provider);
  return new ethers.Contract(address, ABI, wallet);
}

/**
 * Mint a soulbound match record for a completed PvP match.
 *
 * @param {string} wallet1   - NFT owner wallet for player 1
 * @param {number|bigint} nft1 - token ID of player 1's NFT
 * @param {string} wallet2   - NFT owner wallet for player 2
 * @param {number|bigint} nft2 - token ID of player 2's NFT
 * @returns {Promise<{txHash: string, alreadyMinted: boolean}>}
 */
async function mintMatchRecord(wallet1, nft1, wallet2, nft2) {
  const contract = getContract();

  // Check if already minted — avoids a revert on duplicate
  const hash = await contract.pairHash(wallet1, BigInt(nft1), wallet2, BigInt(nft2));
  const used = await contract.usedPairings(hash);
  if (used) {
    return { txHash: null, alreadyMinted: true };
  }

  const tx = await contract.mintMatchRecord(wallet1, BigInt(nft1), wallet2, BigInt(nft2));
  const receipt = await tx.wait(1);
  return { txHash: receipt.hash, alreadyMinted: false };
}

module.exports = { mintMatchRecord };
