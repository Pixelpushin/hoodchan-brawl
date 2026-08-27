// GET /api/fought?wallet=0x...
//
// Returns the set of opponents this wallet has already minted a soulbound
// record against. The frontend uses this to grey out already-fought Hoodies
// in the collection picker — you can still fight them for fun, but no second
// mint is issued (the contract enforces this on-chain too).
//
// Response:
//   { fought: ["<nft>:<opponentWallet>:<opponentNft>", ...] }
//
// Each entry encodes one fought pairing: the caller's own NFT id, the
// opponent's wallet address, and the opponent's NFT id. The frontend can
// match on opponentWallet + opponentNft to identify which cards to grey out.

const { redisCommand } = require("./_lib/redis");

function isValidAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=30");
  if (req.method !== "GET") { res.status(405).json({ error: "Use GET" }); return; }

  const { wallet } = req.query || {};
  if (!wallet || !isValidAddress(wallet)) {
    res.status(400).json({ error: "wallet must be a valid 0x address" });
    return;
  }

  try {
    const members = await redisCommand("SMEMBERS", `fought:${wallet.toLowerCase()}`);
    res.status(200).json({ fought: members ?? [] });
  } catch (err) {
    console.error("[fought]", err);
    res.status(502).json({ fought: [] });
  }
};
