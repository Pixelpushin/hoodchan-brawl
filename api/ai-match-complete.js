// POST /api/ai-match-complete
//
// Called by the game client when a vs-AI match ends with two verified NFTs.
// Records stats and enqueues a soulbound mint — same mint queue mint-cron.js
// picks up every minute.
//
// Body: { wallet1, nft1, wallet2, nft2 }
//   wallet1/wallet2 — NFT owner addresses (not TBAs)
//   nft1/nft2       — token IDs
//
// One of wallet1/wallet2 will be the connected player's wallet. The other
// is the AI-controlled opponent (also owned by the player, or any NFT they
// chose to fight against). The soulbound mint records the pair regardless.

const { redisCommand } = require("./_lib/redis");
const { statsKeys, recentMatchesKey, rivalryKey, leaderboardKey, MAX_TOKEN_ID, isValidAdapterKey } = require("./_lib/stats-keys");

const RECENT_MATCHES_CAP = 200;
const QUEUE_PREFIX = "mintqueue:";

function parseTokenId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_TOKEN_ID ? n : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const { wallet1, nft1: rawNft1, wallet2, nft2: rawNft2, winnerId: rawWinner, adapter } = req.body || {};

  if (!wallet1 || !wallet2) {
    res.status(400).json({ error: "wallet1 and wallet2 required" }); return;
  }
  const nft1 = parseTokenId(rawNft1);
  const nft2 = parseTokenId(rawNft2);
  if (nft1 === null || nft2 === null) {
    res.status(400).json({ error: "nft1 and nft2 must be valid token IDs" }); return;
  }
  if (wallet1.toLowerCase() === wallet2.toLowerCase() && nft1 === nft2) {
    res.status(400).json({ error: "Cannot pair a token with itself" }); return;
  }

  const adapterKey = adapter || "hoodchan";
  if (!isValidAdapterKey(adapterKey)) {
    res.status(400).json({ error: "invalid adapter" }); return;
  }

  const winnerId = parseTokenId(rawWinner);
  const loserId = winnerId === nft1 ? nft2 : nft1;

  try {
    // Record stats
    const writes = [];
    if (winnerId !== null) {
      const wKeys = statsKeys(adapterKey, winnerId);
      const lKeys = statsKeys(adapterKey, loserId);
      writes.push(
        redisCommand("incr", wKeys.wins),
        redisCommand("incr", lKeys.losses),
        redisCommand("zincrby", leaderboardKey(adapterKey), "1", String(winnerId)),
      );
      if (nft1 !== nft2) {
        writes.push(redisCommand("hincrby", rivalryKey(adapterKey, nft1, nft2), String(winnerId), "1"));
      }
    }
    const recentKey = recentMatchesKey(adapterKey);
    writes.push(
      redisCommand("lpush", recentKey, JSON.stringify({ tokenId: nft1, opponentTokenId: nft2, result: winnerId === nft1 ? "win" : "loss", ts: Date.now(), pvp: false })),
    );
    await Promise.all(writes);
    await redisCommand("ltrim", recentKey, "0", String(RECENT_MATCHES_CAP - 1));

    // Enqueue soulbound mint — mint-cron picks this up within 1 minute
    const roomCode = `AI-${Date.now()}-${nft1}-${nft2}`;
    const mintEntry = {
      roomCode,
      wallet1,
      nft1,
      wallet2,
      nft2,
      queuedAt: Date.now(),
      source: "ai-match",
    };
    await redisCommand("SET", `${QUEUE_PREFIX}${roomCode}`, JSON.stringify(mintEntry), "EX", String(7200));

    // Also update fought: sets so collection picker can grey out this pair
    const w1 = wallet1.toLowerCase();
    const w2 = wallet2.toLowerCase();
    await redisCommand("SADD", `fought:${w1}`, `${nft1}:${w2}:${nft2}`);
    await redisCommand("SADD", `fought:${w2}`, `${nft2}:${w1}:${nft1}`);

    res.status(200).json({ success: true, roomCode });
  } catch (err) {
    console.error("[ai-match-complete]", err);
    res.status(502).json({ error: "Could not record match result" });
  }
};
