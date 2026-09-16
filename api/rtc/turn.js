// GET /api/rtc/turn?roomCode=... - short-lived TURN (or STUN-only) ICE
// credentials for one match's WebRTC connection.
//
// Requires a session (Authorization: Bearer <token>) AND that the session's
// wallet is a participant in the given room (403 NOT_A_PARTICIPANT
// otherwise) - TURN relay time/bandwidth is a real cost, so credentials are
// only ever handed to someone actually playing in that room, and capped at
// 6 requests per session per hour (429 TURN_CAP) on top of that.
//
// When TURN_URLS (comma-separated) and TURN_SECRET are both configured,
// returns REST-style TURN credentials (the coturn/Twilio-style
// time-limited username scheme: "<expiryUnix>:<sid>" + HMAC-SHA1(secret,
// username) as the credential, base64-encoded) good for TURN_CRED_TTL_SECONDS.
// Otherwise (no TURN configured on this deployment) still returns 200 with
// STUN-only iceServers - a match without TURN can still connect peer-to-peer
// directly for two players not behind a symmetric NAT, so this is never a
// hard failure.

const crypto = require("node:crypto");
const { enforceRateLimit, countAndCap } = require("../_lib/rate-limit");
const { requireSession } = require("../_lib/auth");
const { loadRoom, isParticipant } = require("../_lib/room");

const TURN_CRED_TTL_SECONDS = 600;
const TURN_REQUESTS_PER_SESSION_PER_HOUR = 6;
const STUN_URLS = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];

function parseTurnUrls() {
  return (process.env.TURN_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Use GET" }); return; }
  if (!(await enforceRateLimit(req, res, "rtc-turn", 60, 600))) return;

  const session = await requireSession(req, res);
  if (!session) return; // requireSession already wrote 401 {code:"UNAUTHENTICATED"}

  const roomCode = (req.query?.roomCode || "").trim();
  if (!roomCode) {
    res.status(400).json({ error: "roomCode query param is required" });
    return;
  }

  try {
    const room = await loadRoom(roomCode);
    if (!room) {
      res.status(404).json({ error: "Room not found or expired", code: "NOT_FOUND" });
      return;
    }
    if (!isParticipant(room, session.wallet)) {
      res.status(403).json({ error: "Not a participant in this room", code: "NOT_A_PARTICIPANT" });
      return;
    }

    const cap = await countAndCap(`rl:turn:${session.sid}`, TURN_REQUESTS_PER_SESSION_PER_HOUR, 3600);
    if (!cap.allowed) {
      res.status(429).json({ error: "Too many TURN credential requests this hour", code: "TURN_CAP" });
      return;
    }

    const turnUrls = parseTurnUrls();
    const turnSecret = process.env.TURN_SECRET;
    if (turnUrls.length && turnSecret) {
      const expiry = Math.floor(Date.now() / 1000) + TURN_CRED_TTL_SECONDS;
      const username = `${expiry}:${session.sid}`;
      const credential = crypto.createHmac("sha1", turnSecret).update(username).digest("base64");
      res.status(200).json({ username, credential, urls: turnUrls, ttl: TURN_CRED_TTL_SECONDS });
      return;
    }

    // TURN not configured on this deployment - STUN-only still lets two
    // players behind ordinary (non-symmetric) NATs connect directly.
    res.status(200).json({ iceServers: [{ urls: STUN_URLS }], turn: null });
  } catch (err) {
    console.error("[rtc/turn]", err);
    res.status(502).json({ error: "Could not get TURN credentials right now" });
  }
};
