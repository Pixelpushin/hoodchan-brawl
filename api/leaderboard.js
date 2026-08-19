const { redisCommand } = require("./_lib/redis");
const { leaderboardKey, isValidAdapterKey, LEGACY_ADAPTER_KEY } = require("./_lib/stats-keys");

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= MAX_LIMIT ? limitRaw : DEFAULT_LIMIT;
  const adapterKey = req.query.adapter === undefined ? LEGACY_ADAPTER_KEY : req.query.adapter;

  if (!isValidAdapterKey(adapterKey)) {
    res.status(400).json({ error: "adapter must match /^[a-z0-9-]{1,64}$/" });
    return;
  }

  try {
    // WITHSCORES flattens to [member, score, member, score, ...] - Upstash's
    // REST layer doesn't restructure this into pairs for us.
    const raw = await redisCommand(
      "zrevrange",
      leaderboardKey(adapterKey),
      "0",
      String(limit - 1),
      "WITHSCORES",
    );
    const fighters = [];
    for (let i = 0; i < (raw || []).length; i += 2) {
      fighters.push({ tokenId: Number(raw[i]), wins: Number(raw[i + 1]) || 0 });
    }
    res.status(200).json({ fighters });
  } catch (err) {
    console.error("[leaderboard]", err);
    res.status(502).json({ error: "Could not load leaderboard right now" });
  }
};
