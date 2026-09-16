// GET /api/lobby/poll?roomCode=xxx
//
// Returns current lobby state. Client polls every 2 seconds until
// status === 'ready', then starts the match.
//
// Pure read — no writes, no TTL refresh (besides keep-alive below). Cheap
// Redis GET per call.
//
// Response shape:
//   { status: 'waiting'|'connected'|'ready'|'complete',
//     p1: null | { present: true, tokenId } | { wallet, tokenId },
//     p2: null | { present: true, tokenId } | { wallet, tokenId } }
//
// Wallet exposure is staged, not just field-filtered:
//   - pre-"ready" (waiting/connected): { present: true, tokenId } only - no
//     wallet. The room code lives in the share URL (see lobby/create.js),
//     so anyone with that link can poll a room they aren't playing in; a
//     wallet address isn't needed before a match actually commits, so it's
//     simply not sent yet.
//   - "ready" and later (e.g. "complete"): wallets are revealed but
//     truncated (0xabcd…1234) UNLESS the caller proves they're one of the
//     two players in THIS room by sending their own wallet in the
//     x-brawl-wallet header - matched case-insensitively against p1/p2,
//     since anyone with the share link can poll but only the two actual
//     players should see each other's full address.
// Signatures and internal timestamps are never leaked to clients, at any stage.

const { redisCommand } = require("../_lib/redis");
const { enforceRateLimit } = require("../_lib/rate-limit");

function truncateWallet(wallet) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

// Builds the p1/p2 field for the response given the room's current status
// and whether this caller has proven (via x-brawl-wallet) that they're one
// of the two players.
function playerView(slot, status, isParticipant) {
  if (!slot) return null;
  const preReady = status === "waiting" || status === "connected";
  if (preReady || !slot.wallet) {
    // Either the match hasn't committed yet, or this slot is occupied but
    // still pre-wallet (normal during the initial connect handshake) - same
    // "no wallet to show" outcome either way.
    return { present: true, tokenId: slot.tokenId };
  }
  return { wallet: isParticipant ? slot.wallet : truncateWallet(slot.wallet), tokenId: slot.tokenId };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-brawl-wallet");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Use GET" }); return; }
  if (!(await enforceRateLimit(req, res, "poll", 600, 600))) return;

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
    // Keep a live room alive while people are still picking: only join.js
    // refreshed the 600s TTL, so two players deliberating for ten minutes
    // got a 404 on READY. Completed rooms keep complete.js's longer TTL for
    // the mint worker - never shorten those.
    if (lobby.status === "waiting" || lobby.status === "connected" || lobby.status === "ready") {
      redisCommand("EXPIRE", key, "600").catch(() => {});
    }

    const headerWallet = req.headers?.["x-brawl-wallet"];
    const requesterWallet = typeof headerWallet === "string" ? headerWallet.toLowerCase() : null;
    const isParticipant =
      !!requesterWallet && (requesterWallet === lobby.p1?.wallet || requesterWallet === lobby.p2?.wallet);

    res.status(200).json({
      status: lobby.status,
      p1: playerView(lobby.p1, lobby.status, isParticipant),
      p2: playerView(lobby.p2, lobby.status, isParticipant),
    });
  } catch (err) {
    console.error("[lobby/poll]", err);
    res.status(502).json({ error: "Could not poll lobby right now" });
  }
};
