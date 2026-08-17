const { redisCommand } = require("../../_lib/redis");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const address = typeof req.query.address === "string" ? req.query.address.toLowerCase() : "";
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    res.status(400).json({ error: "address must be a valid 0x-prefixed wallet address" });
    return;
  }

  try {
    const handle = await redisCommand("get", `wallet:${address}:xHandle`);
    res.status(200).json({ address, xHandle: handle || null });
  } catch (err) {
    console.error("[wallet-x-handle]", err);
    res.status(502).json({ error: "Could not load X handle right now" });
  }
};
