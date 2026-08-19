const { redisCommand } = require("../../_lib/redis");
const { rivalryKey, MAX_TOKEN_ID, isValidAdapterKey, LEGACY_ADAPTER_KEY } = require("../../_lib/stats-keys");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const a = Number(req.query.tokenIdA);
  const b = Number(req.query.tokenIdB);
  const adapterKey = req.query.adapter === undefined ? LEGACY_ADAPTER_KEY : req.query.adapter;

  if (!isValidAdapterKey(adapterKey)) {
    res.status(400).json({ error: "adapter must match /^[a-z0-9-]{1,64}$/" });
    return;
  }
  if (!Number.isInteger(a) || a < 0 || a > MAX_TOKEN_ID || !Number.isInteger(b) || b < 0 || b > MAX_TOKEN_ID) {
    res.status(400).json({ error: `tokenIdA/tokenIdB must be integers 0-${MAX_TOKEN_ID}` });
    return;
  }
  // No self-pairing - a token can't have a head-to-head record against itself.
  if (a === b) {
    res.status(400).json({ error: "tokenIdA and tokenIdB must differ" });
    return;
  }

  try {
    const [winsA, winsB] = await redisCommand("hmget", rivalryKey(adapterKey, a, b), String(a), String(b));
    const wa = Number(winsA) || 0;
    const wb = Number(winsB) || 0;
    res.status(200).json({ tokenIdA: a, tokenIdB: b, wins: { [a]: wa, [b]: wb }, matches: wa + wb });
  } catch (err) {
    console.error("[rivalry]", err);
    res.status(502).json({ error: "Could not load rivalry record right now" });
  }
};
