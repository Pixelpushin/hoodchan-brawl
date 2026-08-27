// GET /api/lobby/poll?roomCode=xxx
//
// Returns current lobby state. Client polls every 2 seconds until
// status === 'ready', then starts the match.
//
// Pure read — no writes, no TTL refresh. Cheap Redis GET per call.
//
// Response shape:
//   { status: 'waiting'|'ready'|'complete',
//     p1: null | { wallet, tokenId },
//     p2: null | { wallet, tokenId } }
//
// Only wallet and tokenId are exposed - signatures and internal timestamps
// are never leaked to clients.

const { redisCommand } = require("../_lib/redis");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Use GET" }); return; }

  const roomCode = (req.query.roomCode || "").trim().toUpperCase();
  if (!roomCode) {
    res.status(400).json({ error: "roomCode query param is required" }); return;
  }

  const key = `lobby:${roomCode}`;
  try {
    const raw = await redisCommand("GET", key);
    if (!raw) {
      res.status(404).json({ error: "Room not found or expired" }); return;
    }
    let lobby;
    try { lobby = JSON.parse(raw); } catch {
      res.status(502).json({ error: "Corrupted room state" }); return;
    }
    // Only expose the fields clients need - don't leak signatures or internal timestamps.
    res.status(200).json({
      status: lobby.status,
      p1: lobby.p1 ? { wallet: lobby.p1.wallet, tokenId: lobby.p1.tokenId } : null,
      p2: lobby.p2 ? { wallet: lobby.p2.wallet, tokenId: lobby.p2.tokenId } : null,
    });
  } catch (err) {
    console.error("[lobby/poll]", err);
    res.status(502).json({ error: "Could not poll lobby right now" });
  }
};
