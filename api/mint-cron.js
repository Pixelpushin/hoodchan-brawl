// GET /api/mint-cron
//
// Called by Vercel cron every minute. Scans for completed lobbies with
// readyToMint: true and mints their soulbound tokens. After a successful
// mint it also increments bar:total in Redis so the community bar reflects
// every on-chain match.
//
// Protected by CRON_SECRET (same pattern as other cron-protected endpoints).
// Vercel sets the Authorization header automatically for cron invocations.

const { redisCommand } = require("./_lib/redis");
const { mintMatchRecord } = require("./_lib/mint");

// Redis key prefix for mint queue entries. Each entry is a JSON-serialised
// lobby object stored as  mintqueue:<roomCode>  when complete.js fires.
// We scan for them here and remove them after a successful mint.
const QUEUE_PREFIX = "mintqueue:";
const BAR_KEY = "bar:total";

module.exports = async (req, res) => {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(503).json({ error: "CRON_SECRET not configured" });
    return;
  }
  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Use GET" });
    return;
  }

  try {
    // Scan for pending mint queue entries
    const keys = await scanMintQueue();
    if (!keys.length) {
      res.status(200).json({ processed: 0 });
      return;
    }

    const results = [];
    for (const key of keys) {
      const raw = await redisCommand("GET", key);
      if (!raw) { await redisCommand("DEL", key); continue; }

      let entry;
      try { entry = JSON.parse(raw); } catch { await redisCommand("DEL", key); continue; }

      const { wallet1, nft1, wallet2, nft2, roomCode } = entry;
      if (!wallet1 || nft1 == null || !wallet2 || nft2 == null) {
        console.error("[mint-cron] bad entry, skipping", key, entry);
        await redisCommand("DEL", key);
        results.push({ roomCode, status: "skipped:bad-data" });
        continue;
      }

      try {
        const { txHash, alreadyMinted } = await mintMatchRecord(wallet1, nft1, wallet2, nft2);
        if (!alreadyMinted) {
          // Increment the community bar (unique wallet pairs only)
          await redisCommand("INCR", BAR_KEY);
          // Record the fought pairing so the frontend can grey out already-fought
          // opponents in the collection picker. Stored as Redis Sets:
          //   fought:{wallet}  →  Set of "{nft}:{opponentWallet}:{opponentNft}"
          const w1 = wallet1.toLowerCase();
          const w2 = wallet2.toLowerCase();
          await redisCommand("SADD", `fought:${w1}`, `${nft1}:${w2}:${nft2}`);
          await redisCommand("SADD", `fought:${w2}`, `${nft2}:${w1}:${nft1}`);
        }
        await redisCommand("DEL", key);
        results.push({ roomCode, status: alreadyMinted ? "already-minted" : "minted", txHash });
      } catch (mintErr) {
        console.error("[mint-cron] mint failed for", key, mintErr.message);
        // Leave in queue for next cron run — will retry
        results.push({ roomCode, status: "error", error: mintErr.message });
      }
    }

    res.status(200).json({ processed: keys.length, results });
  } catch (err) {
    console.error("[mint-cron]", err);
    res.status(502).json({ error: "Cron failed" });
  }
};

async function scanMintQueue() {
  // Upstash REST API SCAN — fetch up to 100 mint queue keys per run
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return [];

  const resp = await fetch(`${url}/scan/0/match/${QUEUE_PREFIX}*/count/100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  // Upstash SCAN returns [cursor, [keys]]
  const keys = data.result?.[1] ?? [];
  return keys;
}
