const { redisCommand } = require("./_lib/redis");
const { leaderboardKey, isValidAdapterKey, DEFAULT_ADAPTER_KEY } = require("./_lib/stats-keys");

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= MAX_LIMIT ? limitRaw : DEFAULT_LIMIT;
  // Default must match every WRITER's default (api/lobby/complete.js,
  // api/ai-match-complete.js), both of which fall back to
  // DEFAULT_ADAPTER_KEY (env ADAPTER_KEY, or the legacy key if unset) - not
  // hardcode the legacy key here, or a PVP win written under a deployment's
  // real ADAPTER_KEY becomes invisible on this read path.
  const adapterKey = req.query.adapter === undefined ? DEFAULT_ADAPTER_KEY : req.query.adapter;

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
