// GET /api/lobby/poll?roomCode=xxx
//
// Returns current lobby state. Client polls every 2 seconds until
// status === 'ready', then starts the match.
//
// Pure read — no writes, no TTL refresh (besides keep-alive below). Cheap
// Redis GET per call.
//
// Response shape:
//   { status: 'waiting'|'connected'|'ready'|'complete'|...,
//     p1: null | { present: true, tokenId } | { wallet, tokenId },
//     p2: null | { present: true, tokenId } | { wallet, tokenId } }
//
// Session is OPTIONAL here (unlike create/join/complete, which require
// one) - anyone holding the share link can poll a room's shape, just not
// see full wallet addresses unless they prove they're one of the two
// players.
//
// Wallet exposure is staged, not just field-filtered:
//   - pre-"ready" (waiting/connected): { present: true, tokenId } only - no
//     wallet. The room code lives in the share URL (see lobby/create.js),
//     so anyone with that link can poll a room they aren't playing in; a
//     wallet address isn't needed before a match actually commits, so it's
//     simply not sent yet.
//   - "ready" and later (e.g. "complete"): wallets are revealed but
//     truncated (0xabcd…1234) UNLESS the caller proves they're one of the
//     two players in THIS room by sending a valid session
//     (Authorization: Bearer <token>, see api/_lib/auth.js) whose wallet
//     matches p1 or p2 - the old x-brawl-wallet header (an UNPROVEN,
//     client-asserted address) is gone; a session is cryptographically
//     bound to a wallet via POST /api/auth/session, so this is the first
//     version of this check that can't just be spoofed by sending someone
//     else's address in a header.
// The `sid` stamped onto a slot by create/join is never sent to any
// caller, participant or not - it's an internal pointer, not player-facing
// data. Signatures and internal timestamps are never leaked either, at any
// stage.

const { redisCommand } = require("../_lib/redis");
const { enforceRateLimit } = require("../_lib/rate-limit");
const { getSession } = require("../_lib/auth");
const { TTL_BY_STATE } = require("../_lib/room");

function truncateWallet(wallet) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

// Builds the p1/p2 field for the response given the room's current status
// and whether this caller has proven (via session) that they're one of the
// two players. Never includes `sid` or `signature`, participant or not.
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
    // refreshed the TTL, so two players deliberating for the full window
    // got a 404 on READY. Terminal statuses keep their own (longer) TTL -
    // never shorten those here.
    if (lobby.status === "waiting" || lobby.status === "connected" || lobby.status === "ready") {
      redisCommand("EXPIRE", key, String(TTL_BY_STATE[lobby.status])).catch(() => {});
    }

    // Session is optional for poll - a missing/invalid bearer just means
    // "not a proven participant", not a 401.
    const session = await getSession(req);
    const isParticipant =
      !!session && (session.wallet === lobby.p1?.wallet || session.wallet === lobby.p2?.wallet);

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
