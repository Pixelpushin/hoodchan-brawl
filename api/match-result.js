const { redisCommand } = require("./_lib/redis");
const { statsKeys, recentMatchesKey, MAX_TOKEN_ID, isValidAdapterKey, LEGACY_ADAPTER_KEY } = require("./_lib/stats-keys");

// Recent-match feed is a rolling window, not a full archive - old entries
// fall off the end via LTRIM rather than growing the list forever.
const RECENT_MATCHES_CAP = 200;

// Unauthenticated by design, same trust model as the rest of the game (no
// wallet writes, nothing on-chain, purely social) - anyone can POST a fake
// result. Stats here are a fun ambient signal, not a competitive record, so
// that tradeoff is fine; see openapi.json's description for this endpoint.
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const { tokenId, opponentTokenId, result, adapter } = req.body || {};
  const id = Number(tokenId);
  const oppId = opponentTokenId === undefined || opponentTokenId === null ? null : Number(opponentTokenId);
  // Defaults to the legacy adapter rather than rejecting the request - an
  // older/unmodified client build (or a fork that hasn't picked up this
  // field yet) should still record stats somewhere sane instead of 400ing.
  const adapterKey = adapter === undefined ? LEGACY_ADAPTER_KEY : adapter;

  if (!isValidAdapterKey(adapterKey)) {
    res.status(400).json({ error: "adapter must match /^[a-z0-9-]{1,64}$/" });
    return;
  }
  if (!Number.isInteger(id) || id < 0 || id > MAX_TOKEN_ID) {
    res.status(400).json({ error: `tokenId must be an integer 0-${MAX_TOKEN_ID}` });
    return;
  }
  if (result !== "win" && result !== "loss") {
    res.status(400).json({ error: 'result must be "win" or "loss"' });
    return;
  }
  if (oppId !== null && (!Number.isInteger(oppId) || oppId < 0 || oppId > MAX_TOKEN_ID)) {
    res.status(400).json({ error: `opponentTokenId must be an integer 0-${MAX_TOKEN_ID}` });
    return;
  }

  const field = result === "win" ? "wins" : "losses";
  const keys = statsKeys(adapterKey, id);
  const recentKey = recentMatchesKey(adapterKey);
  try {
    const [count] = await Promise.all([
      redisCommand("incr", keys[field]),
      redisCommand(
        "lpush",
        recentKey,
        JSON.stringify({ tokenId: id, opponentTokenId: oppId, result, ts: Date.now() }),
      ),
    ]);
    await redisCommand("ltrim", recentKey, "0", String(RECENT_MATCHES_CAP - 1));
    res.status(200).json({ ok: true, tokenId: id, [field]: count });
  } catch (err) {
    console.error("[match-result]", err);
    res.status(502).json({ error: "Could not record match result right now" });
  }
};
