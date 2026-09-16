// POST /api/lobby/create
//
// Creates a new remote PVP room, returns a roomCode.
// Room state is stored in Redis with a status-dependent TTL (see
// api/_lib/room.js's TTL_BY_STATE - "waiting" is 600s, enough for a match
// to set up; expired rooms clean themselves up without a separate cron.
//
// Requires a session (Authorization: Bearer <token>, see api/_lib/auth.js /
// POST /api/auth/session) - p1 is filled from the session's wallet/tokenId
// immediately, never taken from the request body. A room created before the
// creator has picked their actual fighter uses whatever tokenId the session
// was minted for (typically the wallet's first owned token - see
// src/lobby.js); if they pick a different fighter at register time,
// src/wallet.js's getSession() mints a NEW session for that tokenId and
// api/lobby/join.js's explicit-`side` re-registration updates p1 to match.
//
// Uses 6-char uppercase alphanumeric codes (no 0/O/I/1 lookalikes) that are
// easy to read and type. Collision resistance: up to 5 attempts with NX so
// we never overwrite an active room.

const { redisCommand } = require("../_lib/redis");
const { enforceRateLimit, countAndCap } = require("../_lib/rate-limit");
const { requireSession } = require("../_lib/auth");
const { TTL_BY_STATE, generateMatchId, readEngineVersion } = require("../_lib/room");
const { DEFAULT_ADAPTER_KEY, isValidAdapterKey } = require("../_lib/stats-keys");

// How many rooms one wallet may CREATE per rolling hour. This is a simple
// INCR-with-EX counter, not a live "currently open rooms" gauge - it is
// NEVER decremented when a room closes/expires, on purpose (matching the
// spec exactly): decrementing would need to happen from every possible way
// a room stops being "open" (TTL expiry, complete, abandoned, ...), and
// getting that wrong in one path would let the cap silently leak upward
// forever. A flat "N creates per hour" cap is simpler to reason about and
// plenty to stop a single wallet from spamming empty rooms.
const OPEN_ROOMS_PER_WALLET = 2;
const OPEN_ROOMS_WINDOW_SECONDS = 3600;

// uint32 seed for the deterministic-engine work (server-authoritative RNG) -
// generated once at room creation so both clients can eventually derive the
// same match from it instead of trusting either client's own Math.random.
function generateSeed() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0];
}

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }
  if (!(await enforceRateLimit(req, res, "create", 10, 600))) return;

  const session = await requireSession(req, res);
  if (!session) return; // requireSession already wrote 401 {code:"UNAUTHENTICATED"}

  try {
    const openKey = `rooms:open:${session.wallet}`;
    const cap = await countAndCap(openKey, OPEN_ROOMS_PER_WALLET, OPEN_ROOMS_WINDOW_SECONDS);
    if (!cap.allowed) {
      res.status(429).json({
        error: `Max ${OPEN_ROOMS_PER_WALLET} rooms created per hour per wallet`,
        code: "ROOM_CAP",
      });
      return;
    }

    const adapterKey = isValidAdapterKey(session.adapter) ? session.adapter : DEFAULT_ADAPTER_KEY;
    const seed = generateSeed();
    const matchId = generateMatchId();
    const engineVersion = readEngineVersion();
    const now = Date.now();

    // Try up to 5 codes to avoid the (vanishingly rare) collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const roomCode = generateRoomCode();
      const key = `lobby:${roomCode}`;
      const record = {
        v: 0,
        status: "waiting",
        adapter: adapterKey,
        seed,
        matchId,
        engineVersion,
        p1: { wallet: session.wallet, tokenId: session.tokenId, sid: session.sid, joinedAt: now },
        p2: null,
        createdAt: now,
        updatedAt: now,
      };
      // SET NX: only sets if the key doesn't already exist.
      const set = await redisCommand("SET", key, JSON.stringify(record), "EX", String(TTL_BY_STATE.waiting), "NX");
      if (set === "OK") {
        res.status(200).json({ roomCode, seed, expiresIn: TTL_BY_STATE.waiting });
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
