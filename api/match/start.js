// POST /api/match/start { roomCode }
//
// Requires a session AND that the session's wallet is a participant in the
// room. Transitions signaling|ready -> in_match, stamping `startedAt`.
// Idempotent: if the room is ALREADY in_match (either because this is a
// retry, or because the other player's client called start first), this
// returns 200 with the SAME matchId/startedAt rather than erroring - both
// players' clients call this independently once their WebRTC connection
// comes up, with no coordination over who "wins" the race.

const { enforceRateLimit } = require("../_lib/rate-limit");
const { requireSession } = require("../_lib/auth");
const { transition, loadRoom, isParticipant } = require("../_lib/room");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }
  if (!(await enforceRateLimit(req, res, "match-start", 60, 600))) return;

  const session = await requireSession(req, res);
  if (!session) return; // requireSession already wrote 401 {code:"UNAUTHENTICATED"}

  const body = req.body || {};
  const { roomCode } = body;
  if (typeof roomCode !== "string" || !roomCode.trim()) {
    res.status(400).json({ error: "roomCode is required" });
    return;
  }

  try {
    const result = await transition(roomCode, ["signaling", "ready"], (room) => {
      if (!isParticipant(room, session.wallet)) {
        return { error: "Not a participant in this room", status: 403, code: "NOT_A_PARTICIPANT" };
      }
      room.status = "in_match";
      room.startedAt = Date.now();
      return room;
    });

    if (result.ok) {
      res.status(200).json({ matchId: result.room.matchId, status: "in_match", startedAt: result.room.startedAt });
      return;
    }

    // Idempotency: the room may already be in_match (a retry, or the other
    // side's own start() call landed first) - transition() 409s on that
    // (status not in fromStates), but that's success from this caller's
    // point of view, not an error, as long as they're a real participant.
    if (result.status === 409) {
      const fresh = await loadRoom(roomCode);
      if (fresh?.status === "in_match" && isParticipant(fresh, session.wallet)) {
        res.status(200).json({ matchId: fresh.matchId, status: "in_match", startedAt: fresh.startedAt });
        return;
      }
    }

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[match/start]", err);
    res.status(502).json({ error: "Could not start match right now" });
  }
};
