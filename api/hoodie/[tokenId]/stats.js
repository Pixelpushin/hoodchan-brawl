const { redisCommand } = require("../../_lib/redis");
const { statsKeys, MAX_TOKEN_ID, isValidAdapterKey, LEGACY_ADAPTER_KEY } = require("../../_lib/stats-keys");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const id = Number(req.query.tokenId);
  const adapterKey = req.query.adapter === undefined ? LEGACY_ADAPTER_KEY : req.query.adapter;

  if (!isValidAdapterKey(adapterKey)) {
    res.status(400).json({ error: "adapter must match /^[a-z0-9-]{1,64}$/" });
    return;
  }
  if (!Number.isInteger(id) || id < 0 || id > MAX_TOKEN_ID) {
    res.status(400).json({ error: `tokenId must be an integer 0-${MAX_TOKEN_ID}` });
    return;
  }

  const keys = statsKeys(adapterKey, id);
  try {
    const [wins, losses] = await redisCommand("mget", keys.wins, keys.losses);
    const w = Number(wins) || 0;
    const l = Number(losses) || 0;
    res.status(200).json({ tokenId: id, wins: w, losses: l, matches: w + l });
  } catch (err) {
    console.error("[hoodie-stats]", err);
    res.status(502).json({ error: "Could not load stats right now" });
  }
};
