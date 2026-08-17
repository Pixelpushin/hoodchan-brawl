const { redisCommand } = require("../_lib/redis");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 25;

  try {
    const raw = await redisCommand("lrange", "matches:recent", "0", String(limit - 1));
    const matches = (raw || [])
      .map((entry) => {
        try {
          return JSON.parse(entry);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    res.status(200).json({ matches });
  } catch (err) {
    console.error("[matches-recent]", err);
    res.status(502).json({ error: "Could not load recent matches right now" });
  }
};
