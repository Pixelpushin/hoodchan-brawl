const { redisCommand } = require("../../_lib/redis");

const MAX_TOKEN_ID = 5999;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const id = Number(req.query.tokenId);
  if (!Number.isInteger(id) || id < 0 || id > MAX_TOKEN_ID) {
    res.status(400).json({ error: `tokenId must be an integer 0-${MAX_TOKEN_ID}` });
    return;
  }

  try {
    const [wins, losses] = await redisCommand("mget", `hoodie:${id}:wins`, `hoodie:${id}:losses`);
    const w = Number(wins) || 0;
    const l = Number(losses) || 0;
    res.status(200).json({ tokenId: id, wins: w, losses: l, matches: w + l });
  } catch (err) {
    console.error("[hoodie-stats]", err);
    res.status(502).json({ error: "Could not load stats right now" });
  }
};
