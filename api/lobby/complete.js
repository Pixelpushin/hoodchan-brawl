// POST /api/lobby/complete
//
// Body: { roomCode, winnerId, loserId, p1Score, p2Score, roundsPlayed }
//
// Called at match end for a verified PvP lobby match. Validates:
//   - Both players were actually in this lobby (not a phantom roomCode)
//   - Scores are sane: each round score 0-100, no impossible values
//   - roundsPlayed is a positive integer
//
// On success:
//   - Records match stats (same atomic multi-exec as match-result.js)
//   - Sets readyToMint: true on the lobby record (soulbound mint trigger)
//   - Marks lobby status 'complete' so polls stop
//   - Flags for human review if scores look anomalous
//
// The lobby key is NOT deleted on complete — it stays in Redis (with its
// existing TTL) so the soulbound mint worker can read readyToMint and pull
// both players' wallet/tokenId pairs for the on-chain call.

const { redisMultiExec, redisCommand } = require("../_lib/redis");
const { MAX_TOKEN_ID } = require("../_lib/constants");

const RECENT_MATCHES_CAP = 200;
const LEADERBOARD_KEY = "leaderboard:wins";

const MAX_ROUND_SCORE = 100;
const MAX_ROUNDS = 99; // sanity cap

function rivalryKey(a, b) {
  return `rivalry:${Math.min(a, b)}:${Math.max(a, b)}`;
}

function parseStrictTokenId(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

function validateSide(raw, label) {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const parsed = parseStrictTokenId(raw);
  if (parsed === null || parsed < 0 || parsed > MAX_TOKEN_ID) {
    return { ok: false, error: `${label} must be null or an integer 0-${MAX_TOKEN_ID}` };
  }
  return { ok: true, value: parsed };
}

// Score sanity: each round score must be 0-100, roundsPlayed must be 1-MAX_ROUNDS.
// Returns { ok, reason } where reason is null on success.
function validateScores(p1Score, p2Score, roundsPlayed) {
  const rounds = typeof roundsPlayed === "number" ? roundsPlayed : Number(roundsPlayed);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
    return { ok: false, reason: `roundsPlayed must be an integer 1-${MAX_ROUNDS}` };
  }
  if (typeof p1Score !== "number" || p1Score < 0 || p1Score > MAX_ROUND_SCORE * rounds) {
    return { ok: false, reason: `p1Score out of range (max ${MAX_ROUND_SCORE * rounds} for ${rounds} rounds)` };
  }
  if (typeof p2Score !== "number" || p2Score < 0 || p2Score > MAX_ROUND_SCORE * rounds) {
    return { ok: false, reason: `p2Score out of range (max ${MAX_ROUND_SCORE * rounds} for ${rounds} rounds)` };
  }
  return { ok: true, reason: null };
}

// Flag for human review when scores look anomalous (both maxed, zero-round, etc.)
function shouldFlagForReview(p1Score, p2Score, roundsPlayed) {
  const maxPossible = MAX_ROUND_SCORE * roundsPlayed;
  // Both players at max score simultaneously is impossible in a real match
  if (p1Score === maxPossible && p2Score === maxPossible) return true;
  // Both at exactly zero for multiple rounds is suspicious
  if (p1Score === 0 && p2Score === 0 && roundsPlayed > 1) return true;
  return false;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const body = req.body || {};
  const {
    roomCode,
    winnerId: rawWinnerId,
    loserId: rawLoserId,
    p1Score,
    p2Score,
    roundsPlayed,
  } = body;

  if (!roomCode || typeof roomCode !== "string") {
    res.status(400).json({ error: "roomCode is required" }); return;
  }

  // --- Validate token IDs ---
  const winnerSide = validateSide(rawWinnerId, "winnerId");
  if (!winnerSide.ok) { res.status(400).json({ error: winnerSide.error }); return; }
  const loserSide = validateSide(rawLoserId, "loserId");
  if (!loserSide.ok) { res.status(400).json({ error: loserSide.error }); return; }

  const winnerId = winnerSide.value;
  const loserId = loserSide.value;

  if (winnerId === null && loserId === null) {
    res.status(400).json({ error: "winnerId and loserId cannot both be null" }); return;
  }

  // --- Validate scores (optional - gracefully skip if not provided) ---
  let flaggedForReview = false;
  if (
    typeof p1Score === "number" &&
    typeof p2Score === "number" &&
    typeof roundsPlayed === "number"
  ) {
    if (!Number.isFinite(p1Score) || !Number.isFinite(p2Score) || !Number.isFinite(roundsPlayed)) {
      res.status(400).json({ error: "p1Score, p2Score, and roundsPlayed must be finite numbers" }); return;
    }
    const scoreCheck = validateScores(p1Score, p2Score, roundsPlayed);
    if (!scoreCheck.ok) {
      res.status(400).json({ error: scoreCheck.reason }); return;
    }
    flaggedForReview = shouldFlagForReview(p1Score, p2Score, roundsPlayed);
  }

  try {
    // --- Load and validate lobby ---
    const key = `lobby:${roomCode.trim().toUpperCase()}`;
    const raw = await redisCommand("GET", key);
    if (!raw) {
      res.status(404).json({ error: "Room not found or expired" }); return;
    }
    const lobby = JSON.parse(raw);

    if (lobby.status === "complete") {
      res.status(409).json({ error: "Match already marked complete" }); return;
    }

    // Verify both submitted token IDs match what's actually in the lobby.
    const p1TokenId = lobby.p1 ? lobby.p1.tokenId : null;
    const p2TokenId = lobby.p2 ? lobby.p2.tokenId : null;
    const lobbyIds = new Set([p1TokenId, p2TokenId].filter((x) => x !== null));

    if (winnerId !== null && !lobbyIds.has(winnerId)) {
      res.status(400).json({
        error: `winnerId ${winnerId} was not a player in this lobby`,
      }); return;
    }
    if (loserId !== null && !lobbyIds.has(loserId)) {
      res.status(400).json({
        error: `loserId ${loserId} was not a player in this lobby`,
      }); return;
    }

    // --- Atomic stat writes ---
    const commands = [];
    if (winnerId !== null) {
      commands.push(["INCR", `hoodie:${winnerId}:wins`]);
      commands.push(["ZINCRBY", LEADERBOARD_KEY, "1", String(winnerId)]);
    }
    if (loserId !== null) {
      commands.push(["INCR", `hoodie:${loserId}:losses`]);
    }
    if (winnerId !== null && loserId !== null) {
      commands.push(["HINCRBY", rivalryKey(winnerId, loserId), String(winnerId), "1"]);
    }
    commands.push([
      "LPUSH",
      "matches:recent",
      JSON.stringify({ winnerId, loserId, ts: Date.now(), pvp: true, p1Score, p2Score, roundsPlayed }),
    ]);
    commands.push(["LTRIM", "matches:recent", "0", String(RECENT_MATCHES_CAP - 1)]);

    await redisMultiExec(commands);

    // --- Mark lobby complete + set readyToMint flag ---
    // Do NOT delete the key — the soulbound mint worker reads readyToMint and
    // pulls p1/p2 wallet+tokenId pairs. The existing TTL will evict it naturally.
    lobby.status = "complete";
    lobby.readyToMint = true;
    lobby.completedAt = Date.now();
    lobby.winnerId = winnerId;
    lobby.loserId = loserId;
    lobby.p1Score = p1Score ?? null;
    lobby.p2Score = p2Score ?? null;
    lobby.roundsPlayed = roundsPlayed ?? null;
    lobby.flaggedForReview = flaggedForReview;

    // Extend TTL by 1 hour so the mint worker has time to pick it up even if
    // it runs on a delay.
    await redisCommand("SET", key, JSON.stringify(lobby), "EX", String(3600));

    // --- Enqueue for soulbound mint ---
    // Writes a mintqueue:<roomCode> entry that mint-cron.js picks up every
    // minute. Both wallet addresses come from the lobby (set during join).
    if (lobby.p1?.wallet && lobby.p2?.wallet) {
      const mintEntry = {
        roomCode: roomCode.trim().toUpperCase(),
        wallet1: lobby.p1.wallet,
        nft1: lobby.p1.tokenId,
        wallet2: lobby.p2.wallet,
        nft2: lobby.p2.tokenId,
        queuedAt: Date.now(),
      };
      await redisCommand(
        "SET",
        `mintqueue:${roomCode.trim().toUpperCase()}`,
        JSON.stringify(mintEntry),
        "EX",
        String(7200) // 2h — enough for mint-cron to pick it up
      );
    }

    res.status(200).json({ success: true, flaggedForReview });
  } catch (err) {
    console.error("[lobby/complete]", err);
    res.status(502).json({ error: "Could not record match result right now" });
  }
};
