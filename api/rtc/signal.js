// POST/GET /api/rtc/signal - WebRTC signaling relay for one lobby room.
//
// Requires a session (Authorization: Bearer <token>, see api/_lib/auth.js)
// AND that the session's wallet is a participant (p1 or p2) in the given
// room - anyone else gets 403 NOT_A_PARTICIPANT, never a peek at signaling
// traffic for a match they aren't in.
//
// POST { roomCode, msg }: pushes `msg` (an object <= 16 KB, `type` one of
// offer|answer|candidate|end) onto the OTHER side's inbox
// (sig:<CODE>:<otherSide>), capped at 32 queued messages (429 QUEUE_FULL
// past that - a stalled/looping peer must not grow this list forever). The
// first signal in a room moves it from "ready" to "signaling" via
// api/_lib/room.js's transition() - a later signal (room already
// "signaling") is a no-op on room status, just another queued message.
//
// GET ?roomCode=...: atomically drains the CALLER's OWN inbox
// (sig:<CODE>:<mySide>) and returns { msgs }. "Atomically" here means one
// LRANGE 0 -1 + DEL via api/_lib/redis.js's redisMultiExec (a real Upstash
// MULTI/EXEC transaction) - api/_lib/redis.js's SCRIPTS registry has no
// registered "drain" Lua script (only "cas"/"cdel"), so this is the
// documented fallback rather than inventing a new EVAL script this file
// doesn't own.

const { redisCommand, redisMultiExec, redisEval } = require("../_lib/redis");
const { enforceRateLimit } = require("../_lib/rate-limit");
const { requireSession } = require("../_lib/auth");
const { loadRoom, isParticipant, transition, normalizeCode } = require("../_lib/room");

const MAX_MSG_BYTES = 16 * 1024;
const MAX_QUEUE_LEN = 32;
const SIGNAL_TTL_SECONDS = 300;
const ALLOWED_TYPES = new Set(["offer", "answer", "candidate", "end"]);

function otherSideOf(side) {
  return side === "p1" ? "p2" : "p1";
}

function signalKey(code, side) {
  return `sig:${code}:${side}`;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Use GET or POST" });
    return;
  }

  const scope = req.method === "POST" ? "rtc-signal-post" : "rtc-signal-get";
  const limit = req.method === "POST" ? 120 : 600;
  if (!(await enforceRateLimit(req, res, scope, limit, 600))) return;

  const session = await requireSession(req, res);
  if (!session) return; // requireSession already wrote 401 {code:"UNAUTHENTICATED"}

  const roomCode = req.method === "POST" ? req.body?.roomCode : req.query?.roomCode;
  if (typeof roomCode !== "string" || !roomCode.trim()) {
    res.status(400).json({ error: "roomCode is required" });
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

    if (req.method === "GET") {
      const myKey = signalKey(code, side);
      const [rawMsgs] = await redisMultiExec([
        ["LRANGE", myKey, "0", "-1"],
        ["DEL", myKey],
      ]);
      const msgs = (rawMsgs || [])
        .map((s) => {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        })
        .filter((m) => m !== null);
      res.status(200).json({ msgs });
      return;
    }

    // --- POST: relay a signaling message to the OTHER side ---
    if (room.status !== "ready" && room.status !== "signaling") {
      res.status(409).json({ error: `Room is in status "${room.status}", not ready for signaling`, status: room.status });
      return;
    }

    const body = req.body || {};
    const { msg } = body;
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      res.status(400).json({ error: "msg must be an object" });
      return;
    }
    if (!ALLOWED_TYPES.has(msg.type)) {
      res.status(400).json({ error: `msg.type must be one of ${Array.from(ALLOWED_TYPES).join(", ")}` });
      return;
    }
    const serialized = JSON.stringify(msg);
    if (Buffer.byteLength(serialized, "utf8") > MAX_MSG_BYTES) {
      res.status(400).json({ error: `msg must be <= ${MAX_MSG_BYTES} bytes` });
      return;
    }

    const targetKey = signalKey(code, otherSideOf(side));
    // Atomic check-and-push (api/_lib/redis.js's "rpushcap" script) - a
    // separate LRANGE-to-count then RPUSH left a window where two POSTs
    // racing at the same instant could both see room under MAX_QUEUE_LEN and
    // both push, exceeding the cap.
    const newLen = await redisEval(
      "rpushcap",
      [targetKey],
      [String(MAX_QUEUE_LEN), serialized, String(SIGNAL_TTL_SECONDS)],
    );
    if (Number(newLen) === -1) {
      res.status(429).json({ error: "Signal queue is full", code: "QUEUE_FULL" });
      return;
    }

    // First signal in the room: move ready -> signaling. Best-effort - if
    // this loses the race (the other side's own first signal already made
    // the same move a moment earlier), that's fine, the room is already
    // where it needs to be.
    if (room.status === "ready") {
      await transition(roomCode, ["ready"], (r) => ({ ...r, status: "signaling" }));
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[rtc/signal]", err);
    res.status(502).json({ error: "Could not relay signal right now" });
  }
};
