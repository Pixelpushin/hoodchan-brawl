// POST /api/match/heartbeat { roomCode, frame }
//
// Requires a session AND that the session's wallet is a participant in the
// room. Plain SETs, no compare-and-set - a heartbeat is a liveness ping,
// not a state-machine transition, and the last writer within the TTL
// window is exactly the value that should win:
//   - hb:<CODE>:<side>          = <frame>   EX 25  (liveness - api/match's
//     future forfeit-detection reads this: no fresh heartbeat means the
//     peer dropped)
//   - rejoin:<CODE>:<wallet>    = <side>    EX 120 (reconnect hint - a
//     dropped client can look this up to find which slot to rejoin as,
//     without re-deriving it from the room record)

const { redisCommand } = require("../_lib/redis");
const { enforceRateLimit, countAndCap } = require("../_lib/rate-limit");
const { requireSession } = require("../_lib/auth");
const { loadRoom, isParticipant, normalizeCode, roomKey, TTL_BY_STATE } = require("../_lib/room");

const HEARTBEAT_TTL_SECONDS = 25;
const REJOIN_TTL_SECONDS = 120;
// Coarse, IP-scoped backstop against unauthenticated flooding (same shape as
// every other route's enforceRateLimit call) - loose enough that two real
// players sharing one NAT (each pinging every 10s, ~60 pings/600s) never get
// anywhere near it even stacked together. The limit that actually matters
// per-player is the per-session cap below.
const IP_BACKSTOP_MAX = 400;
const IP_BACKSTOP_WINDOW_SEC = 600;
// Per-session cap, same numbers the old IP-scoped limit used (120/600s -
// double a 10s-interval client's expected ~60 pings/window) but keyed on
// session.sid like api/rtc/turn.js's TURN_REQUESTS_PER_SESSION_PER_HOUR cap -
// two players behind the same public IP each get their own budget instead of
// splitting one shared 120/600 bucket and 429ing each other out on a reload
// or retry storm.
const SESSION_CAP_MAX = 120;
const SESSION_CAP_WINDOW_SEC = 600;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }
  if (!(await enforceRateLimit(req, res, "match-heartbeat", IP_BACKSTOP_MAX, IP_BACKSTOP_WINDOW_SEC))) return;

  const session = await requireSession(req, res);
  if (!session) return; // requireSession already wrote 401 {code:"UNAUTHENTICATED"}

  const sessionCap = await countAndCap(`rl:match-heartbeat:${session.sid}`, SESSION_CAP_MAX, SESSION_CAP_WINDOW_SEC).catch(
    // Same fail-closed posture the rest of this route already has (every
    // Redis op below is inside the try/catch that 502s on error) - a Redis
    // outage shouldn't silently wave an uncapped-per-session flood through.
    (err) => { console.error("[match/heartbeat] rate cap check failed", err); return { allowed: false }; },
  );
  if (!sessionCap.allowed) {
    res.status(429).json({ error: "Too many heartbeats this session", code: "HEARTBEAT_CAP" });
    return;
  }

  const body = req.body || {};
  const { roomCode, frame } = body;
  if (typeof roomCode !== "string" || !roomCode.trim()) {
    res.status(400).json({ error: "roomCode is required" });
    return;
  }
  if (typeof frame !== "number" || !Number.isFinite(frame) || frame < 0) {
    res.status(400).json({ error: "frame must be a non-negative number" });
    return;
  }

  try {
    const room = await loadRoom(roomCode);
    if (!room) {
      res.status(404).json({ error: "Room not found or expired", code: "NOT_FOUND" });
      return;
    }
    const side = isParticipant(room, session.wallet);
    if (!side) {
      res.status(403).json({ error: "Not a participant in this room", code: "NOT_A_PARTICIPANT" });
      return;
    }

    const code = normalizeCode(roomCode);
    await redisCommand("SET", `hb:${code}:${side}`, String(Math.trunc(frame)), "EX", String(HEARTBEAT_TTL_SECONDS));
    await redisCommand("SET", `rejoin:${code}:${session.wallet}`, side, "EX", String(REJOIN_TTL_SECONDS));

    // Keep the room record itself alive while a match is actually live -
    // before this, only api/lobby/poll.js refreshed lobby:<CODE>'s TTL, and
    // it stops polling once the room reaches "ready" (src/lobby.js), so a
    // room's whole budget was the original ~600s from the last join no
    // matter how long fighter-select + best-of-3 + a rematch actually took.
    // Heartbeat fires every 10s for the entire live-match duration, so it's
    // the natural place to extend it. Never touches a terminal status (only
    // the three states a live match can actually be in while heartbeating);
    // best-effort, same as poll.js's own EXPIRE.
    if (room.status === "ready" || room.status === "signaling" || room.status === "in_match") {
      redisCommand("EXPIRE", roomKey(roomCode), String(TTL_BY_STATE[room.status])).catch(() => {});
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[match/heartbeat]", err);
    res.status(502).json({ error: "Could not record heartbeat right now" });
  }
};
