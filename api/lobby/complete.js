// POST /api/lobby/complete
//
// Body: { roomCode, winnerId, loserId, p1Score, p2Score, roundsPlayed,
//         wallet, issuedAt, signature }
//
// Called at match end for a verified PvP lobby match. Each player's client
// submits its OWN signed attestation of the result - this is a two-phase,
// both-players-must-agree protocol, not a single trusted report:
//
//   1st caller (either side): recorded into lobby.sub[side], lobby stays
//     non-terminal, response is { recorded: false, waitingFor: otherSide }.
//   2nd caller (the other side): now both lobby.sub.p1 and lobby.sub.p2
//     exist.
//     - If their winnerId/loserId AGREE: stats are written, the lobby is
//       marked "complete", readyToMint is set, and a mintqueue entry is
//       written - same as before, just now gated on both players signing
//       off instead of trusting whichever client happened to POST first
//       (which let either player mint an outcome the other never saw).
//     - If they DISAGREE: the lobby is marked "disputed". Nothing is
//       written to stats or the mint queue - a contested match should never
//       silently mint or pollute the leaderboard.
//
// Every submission must be an EIP-191 personal_sign signature, from the
// wallet that actually holds that side's slot, over a message this route
// rebuilds itself (see buildResultMessage) - never over client-supplied
// text. That's what makes "both players agree" mean something: a signature
// is proof a specific wallet asserted a specific result, not just that some
// POST arrived. Signatures are single-use (sigused:<hash> NX) so a captured
// request can't be replayed to re-trigger a mint or flip a dispute.
//
// The lobby key is NOT deleted on complete — it stays in Redis (with its
// TTL refreshed) so the soulbound mint worker can read readyToMint and pull
// both players' wallet/tokenId pairs for the on-chain call.

const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { redisMultiExec, redisCommand, redisCompareAndSet } = require("../_lib/redis");
const { enforceRateLimit } = require("../_lib/rate-limit");
const {
  MAX_TOKEN_ID,
  statsKeys,
  recentMatchesKey,
  rivalryKey,
  leaderboardKey,
  isValidAdapterKey,
  DEFAULT_ADAPTER_KEY,
} = require("../_lib/stats-keys");

const RECENT_MATCHES_CAP = 200;

const MAX_ROUND_SCORE = 100;
const MAX_ROUNDS = 99; // sanity cap

// How long a wallet's signed result attestation is remembered as "used" -
// comfortably longer than the 10-minute issuedAt freshness window below, so
// a replay is impossible for the entire time the signature could otherwise
// still pass the timestamp check.
const SIG_REPLAY_TTL_SECONDS = 660;
const ISSUED_AT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes in the past
const ISSUED_AT_MAX_SKEW_MS = 60 * 1000; // 60s clock skew tolerance into the future

const SUBMIT_TTL_SECONDS = 600; // refreshed while waiting on the other side
const COMPLETE_TTL_SECONDS = 3600; // same "give the mint worker an hour" window as before
const MINTQUEUE_TTL_SECONDS = 7200;

const CAS_ATTEMPTS = 4;

// Must match src/lobby.js's buildResultMessage byte-for-byte - the client
// signs this exact text and this route re-derives it from the same request
// fields rather than trusting whatever message the client says it signed.
// (test/lobby-complete.test.mjs cross-checks the two builders directly.)
function buildResultMessage({ roomCode, winnerId, loserId, p1Score, p2Score, roundsPlayed, wallet, issuedAt }) {
  const winnerLabel = winnerId === null || winnerId === undefined ? "none" : winnerId;
  const loserLabel = loserId === null || loserId === undefined ? "none" : loserId;
  return [
    "HOODCHAN Brawl result",
    `room: ${String(roomCode).toUpperCase()}`,
    `winner: HOODCHAN #${winnerLabel}`,
    `loser: HOODCHAN #${loserLabel}`,
    `score: ${p1Score}-${p2Score} in ${roundsPlayed}`,
    `address: ${wallet}`,
    `issued: ${issuedAt}`,
  ].join("\n");
}

function isValidAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
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
  if (p1Score === maxPossible && p2Score === maxPossible) return true;
  if (p1Score === 0 && p2Score === 0 && roundsPlayed > 1) return true;
  return false;
}

function otherSideOf(side) {
  return side === "p1" ? "p2" : "p1";
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  // Mint-adjacent route - a Redis outage should throttle submissions rather
  // than wave an unlimited flood through (see api/_lib/rate-limit.js's table).
  if (!(await enforceRateLimit(req, res, "complete", 10, 600, { failOpen: false }))) return;

  const body = req.body || {};
  const {
    roomCode,
    winnerId: rawWinnerId,
    loserId: rawLoserId,
    p1Score,
    p2Score,
    roundsPlayed,
    wallet,
    issuedAt,
    signature,
  } = body;

  if (!roomCode || typeof roomCode !== "string") {
    res.status(400).json({ error: "roomCode is required" }); return;
  }
  if (!isValidAddress(wallet)) {
    res.status(400).json({ error: "wallet must be a valid 0x address" }); return;
  }
  if (typeof signature !== "string" || !signature) {
    res.status(400).json({ error: "signature is required" }); return;
  }
  if (typeof issuedAt !== "string" || !issuedAt) {
    res.status(400).json({ error: "issuedAt is required" }); return;
  }

  const winnerSide = validateSide(rawWinnerId, "winnerId");
  if (!winnerSide.ok) { res.status(400).json({ error: winnerSide.error }); return; }
  const loserSide = validateSide(rawLoserId, "loserId");
  if (!loserSide.ok) { res.status(400).json({ error: loserSide.error }); return; }

  const winnerId = winnerSide.value;
  const loserId = loserSide.value;

  if (winnerId === null && loserId === null) {
    res.status(400).json({ error: "winnerId and loserId cannot both be null" }); return;
  }

  if (
    typeof p1Score !== "number" ||
    typeof p2Score !== "number" ||
    typeof roundsPlayed !== "number" ||
    !Number.isFinite(p1Score) ||
    !Number.isFinite(p2Score) ||
    !Number.isFinite(roundsPlayed)
  ) {
    res.status(400).json({ error: "p1Score, p2Score, and roundsPlayed must be finite numbers" }); return;
  }
  const scoreCheck = validateScores(p1Score, p2Score, roundsPlayed);
  if (!scoreCheck.ok) {
    res.status(400).json({ error: scoreCheck.reason }); return;
  }

  const walletLc = wallet.toLowerCase();

  // --- Rebuild the message server-side and verify the signature over it ---
  // Never trust a client-sent message - only the fields above, reassembled
  // the one canonical way (see buildResultMessage's doc comment).
  const message = buildResultMessage({ roomCode, winnerId, loserId, p1Score, p2Score, roundsPlayed, wallet, issuedAt });
  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch (err) {
    res.status(403).json({ code: "INVALID_SIGNATURE", error: "Could not verify signature" }); return;
  }
  if (recovered.toLowerCase() !== walletLc) {
    res.status(403).json({ code: "INVALID_SIGNATURE", error: "Signature does not match wallet" }); return;
  }

  // --- Freshness window ---
  const issuedMs = Date.parse(issuedAt);
  if (Number.isNaN(issuedMs)) {
    res.status(403).json({ code: "INVALID_TIMESTAMP", error: "issuedAt is not a valid timestamp" }); return;
  }
  const ageMs = Date.now() - issuedMs;
  if (ageMs > ISSUED_AT_MAX_AGE_MS || ageMs < -ISSUED_AT_MAX_SKEW_MS) {
    res.status(403).json({ code: "INVALID_TIMESTAMP", error: "issuedAt is too old or too far in the future" }); return;
  }

  try {
    // --- Load and validate lobby (once, up front) ---
    const key = `lobby:${roomCode.trim().toUpperCase()}`;
    const raw = await redisCommand("GET", key);
    if (!raw) {
      res.status(404).json({ error: "Room not found or expired" }); return;
    }
    const lobby = JSON.parse(raw);

    if (lobby.status === "complete" || lobby.status === "disputed") {
      res.status(409).json({ error: "Match already marked complete" }); return;
    }

    const p1Wallet = lobby.p1?.wallet ?? null;
    const p2Wallet = lobby.p2?.wallet ?? null;
    let side;
    if (p1Wallet && p1Wallet === walletLc) side = "p1";
    else if (p2Wallet && p2Wallet === walletLc) side = "p2";
    else {
      res.status(403).json({ code: "NOT_A_PARTICIPANT", error: "Wallet is not a participant in this lobby" }); return;
    }
    const otherSide = otherSideOf(side);

    // Verify both submitted token IDs match what's actually in the lobby.
    const p1TokenId = lobby.p1 ? lobby.p1.tokenId : null;
    const p2TokenId = lobby.p2 ? lobby.p2.tokenId : null;
    const lobbyIds = new Set([p1TokenId, p2TokenId].filter((x) => x !== null));

    if (winnerId !== null && !lobbyIds.has(winnerId)) {
      res.status(400).json({ error: `winnerId ${winnerId} was not a player in this lobby` }); return;
    }
    if (loserId !== null && !lobbyIds.has(loserId)) {
      res.status(400).json({ error: `loserId ${loserId} was not a player in this lobby` }); return;
    }

    // --- Single-use signature ---
    // Consumed only now that every other check has passed - a request that
    // was always going to 4xx (bad participant, bad score range, etc.)
    // shouldn't burn the caller's one legitimate signature for this result.
    const canonicalSig = ethers.Signature.from(signature).serialized;
    const sigHash = crypto.createHash("sha256").update(canonicalSig).digest("hex");
    const consumed = await redisCommand("SET", `sigused:${sigHash}`, "1", "NX", "EX", String(SIG_REPLAY_TTL_SECONDS));
    if (consumed !== "OK") {
      res.status(409).json({ code: "REPLAYED", error: "This signed result was already submitted" }); return;
    }

    // --- CAS loop: record this side's submission ---
    // Mirrors api/lobby/join.js's compare-and-set retry - two players
    // submitting in the same instant must not let one write clobber the
    // other's slot in lobby.sub.
    let finalLobby = null;
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const freshRaw = await redisCommand("GET", key);
      if (!freshRaw) { res.status(404).json({ error: "Room not found or expired" }); return; }
      const current = JSON.parse(freshRaw);
      if (current.status === "complete" || current.status === "disputed") {
        res.status(409).json({ error: "Match already marked complete" }); return;
      }

      current.sub = current.sub || {};
      current.sub[side] = { winnerId, loserId, p1Score, p2Score, roundsPlayed, at: Date.now() };
      current.submittedAt = current.submittedAt || {};
      current.submittedAt[side] = Date.now();

      const wrote = await redisCompareAndSet(key, freshRaw, JSON.stringify(current), SUBMIT_TTL_SECONDS);
      if (wrote) { finalLobby = current; break; }
      // Someone else (the other side, or a retry of this same side) wrote
      // in between - loop and re-apply on the fresh copy.
    }
    if (!finalLobby) {
      res.status(503).json({ error: "Room is busy, try again" }); return;
    }

    const otherSub = finalLobby.sub[otherSide];
    if (!otherSub) {
      res.status(200).json({ recorded: false, waitingFor: otherSide });
      return;
    }

    // --- Both sides have submitted: decide agree vs. disputed ---
    // Score fields are compared too, not just winnerId/loserId - otherwise
    // whichever side happens to be room-p1 unilaterally dictates the
    // recorded score (p2's signature attested to different numbers that
    // then never get checked against what's actually stored). This only
    // produces the intended "same match, same result" comparison because
    // main.js maps its local wins.p1/wins.p2 onto the room's actual p1/p2
    // sides before calling lobbyComplete (see src/lobby.js's caller) -
    // without that mapping p1Score/p2Score describe "the reporting client's
    // own score" instead of "the room's p1 vs p2", and every match would
    // spuriously disagree here.
    const mySub = finalLobby.sub[side];
    const agree =
      mySub.winnerId === otherSub.winnerId &&
      mySub.loserId === otherSub.loserId &&
      mySub.p1Score === otherSub.p1Score &&
      mySub.p2Score === otherSub.p2Score &&
      mySub.roundsPlayed === otherSub.roundsPlayed;

    if (!agree) {
      finalLobby.status = "disputed";
      finalLobby.disputedAt = Date.now();
      await redisCommand("SET", key, JSON.stringify(finalLobby), "EX", String(COMPLETE_TTL_SECONDS));
      res.status(200).json({ recorded: false, disputed: true });
      return;
    }

    // Canonical values come from p1's own submission (both p1Score/p2Score
    // always describe the room's p1 vs p2, regardless of which side is
    // reporting - see src/main.js's lobbyComplete call) - p1's sub always
    // exists here since both sides have submitted.
    const canonical = finalLobby.sub.p1;
    const agreedWinnerId = mySub.winnerId;
    const agreedLoserId = mySub.loserId;
    const adapterKey = isValidAdapterKey(finalLobby.adapter) ? finalLobby.adapter : DEFAULT_ADAPTER_KEY;

    // --- Atomic finalization claim ---
    // The CAS loop above only protects the `sub` field, not "am I the one
    // request that gets to write stats". Every concurrent request here
    // carries its OWN valid signature (distinct issuedAt -> distinct
    // sigused: hash), so the sigused: NX guard doesn't stop a participant
    // from firing N concurrently-signed requests that all reach this point
    // with agree === true and all pass the `status === "complete"` checks
    // above (none of them have flipped it yet). A single NX SET on a
    // dedicated key claims the exclusive right to finalize before any stats
    // are written - every loser of this race gets a clean 409 instead of
    // silently inflating win/loss counts N times over.
    const finalizeKey = `lobbyfinal:${roomCode.trim().toUpperCase()}`;
    const wonFinalize = await redisCommand("SET", finalizeKey, "1", "NX", "EX", String(COMPLETE_TTL_SECONDS));
    if (wonFinalize !== "OK") {
      res.status(409).json({ error: "Match already marked complete" }); return;
    }

    // --- Atomic stat writes, namespaced by adapter (LESSON: the old
    // single-report version of this route wrote to unprefixed hoodie:*/
    // matches:recent/leaderboard:wins/rivalry:* keys - orphaned data nothing
    // else reads, since /api/hoodie/[tokenId]/stats, /api/leaderboard,
    // /api/rivalry/*, and /api/matches/recent all read the adapter-namespaced
    // form via stats-keys.js. Using those same helpers here is what makes a
    // PVP win actually show up anywhere. ---
    const commands = [];
    if (agreedWinnerId !== null) {
      const wKeys = statsKeys(adapterKey, agreedWinnerId);
      commands.push(["INCR", wKeys.wins]);
      commands.push(["ZINCRBY", leaderboardKey(adapterKey), "1", String(agreedWinnerId)]);
    }
    if (agreedLoserId !== null) {
      const lKeys = statsKeys(adapterKey, agreedLoserId);
      commands.push(["INCR", lKeys.losses]);
    }
    if (agreedWinnerId !== null && agreedLoserId !== null) {
      commands.push(["HINCRBY", rivalryKey(adapterKey, agreedWinnerId, agreedLoserId), String(agreedWinnerId), "1"]);
    }
    const recentKey = recentMatchesKey(adapterKey);
    commands.push([
      "LPUSH",
      recentKey,
      JSON.stringify({
        winnerId: agreedWinnerId,
        loserId: agreedLoserId,
        ts: Date.now(),
        pvp: true,
        p1Score: canonical.p1Score,
        p2Score: canonical.p2Score,
        roundsPlayed: canonical.roundsPlayed,
      }),
    ]);
    commands.push(["LTRIM", recentKey, "0", String(RECENT_MATCHES_CAP - 1)]);

    await redisMultiExec(commands);

    // --- Mark lobby complete + set readyToMint flag ---
    finalLobby.status = "complete";
    finalLobby.readyToMint = true;
    finalLobby.completedAt = Date.now();
    finalLobby.winnerId = agreedWinnerId;
    finalLobby.loserId = agreedLoserId;
    finalLobby.p1Score = canonical.p1Score;
    finalLobby.p2Score = canonical.p2Score;
    finalLobby.roundsPlayed = canonical.roundsPlayed;
    finalLobby.flaggedForReview = shouldFlagForReview(canonical.p1Score, canonical.p2Score, canonical.roundsPlayed);

    // Extend TTL by 1 hour so the mint worker has time to pick it up even if
    // it runs on a delay.
    await redisCommand("SET", key, JSON.stringify(finalLobby), "EX", String(COMPLETE_TTL_SECONDS));

    // --- Enqueue for soulbound mint ---
    if (finalLobby.p1?.wallet && finalLobby.p2?.wallet) {
      const mintEntry = {
        roomCode: roomCode.trim().toUpperCase(),
        wallet1: finalLobby.p1.wallet,
        nft1: finalLobby.p1.tokenId,
        wallet2: finalLobby.p2.wallet,
        nft2: finalLobby.p2.tokenId,
        adapter: adapterKey,
        queuedAt: Date.now(),
      };
      await redisCommand(
        "SET",
        `mintqueue:${roomCode.trim().toUpperCase()}`,
        JSON.stringify(mintEntry),
        "EX",
        String(MINTQUEUE_TTL_SECONDS)
      );
    }

    res.status(200).json({ recorded: true, minted: "queued", flaggedForReview: finalLobby.flaggedForReview });
  } catch (err) {
    console.error("[lobby/complete]", err);
    res.status(502).json({ error: "Could not record match result right now" });
  }
};

// Exposed for test/lobby-complete.test.mjs's cross-check against
// src/lobby.js's buildResultMessage - not used by the Vercel runtime, which
// only ever calls the default export.
module.exports.buildResultMessage = buildResultMessage;
