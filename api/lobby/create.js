// POST /api/lobby/create
//
// Creates a new remote PVP room, returns a roomCode.
// Room state is stored in Redis with a 10-minute TTL - enough for a match to
// set up; expired rooms clean themselves up without a separate cron.
//
// Uses 6-char uppercase alphanumeric codes (no 0/O/I/1 lookalikes) that are
// easy to read and type. Collision resistance: up to 5 attempts with NX so
// we never overwrite an active room.

const { redisCommand } = require("../_lib/redis");

const LOBBY_TTL_SECONDS = 600; // 10 minutes

function generateRoomCode() {
  // 6 uppercase alphanumeric chars, URL-safe and easy to read/type.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/I/1 lookalikes
  let code = "";
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  for (const byte of arr) {
    code += chars[byte % chars.length];
  }
  return code;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  try {
    // Try up to 5 codes to avoid the (vanishingly rare) collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const roomCode = generateRoomCode();
      const key = `lobby:${roomCode}`;
      // SET NX: only sets if the key doesn't already exist.
      const set = await redisCommand(
        "SET",
        key,
        JSON.stringify({ status: "waiting", p1: null, p2: null, createdAt: Date.now() }),
        "EX",
        String(LOBBY_TTL_SECONDS),
        "NX",
      );
      if (set === "OK") {
        res.status(200).json({ roomCode, expiresIn: LOBBY_TTL_SECONDS });
        return;
      }
      // Key already exists (collision) - try next code.
    }
    res.status(503).json({ error: "Could not generate a unique room code, try again" });
  } catch (err) {
    console.error("[lobby/create]", err);
    res.status(502).json({ error: "Could not create lobby right now" });
  }
};
