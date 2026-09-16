// POST /api/ai-match-complete
//
// Called by the game client when a vs-AI match ends with two verified NFTs.
// Records stats and enqueues a soulbound mint — same mint queue mint-cron.js
// picks up every minute. The mint is paid for by the operator's minter key
// (api/_lib/mint.js), so every check below exists to stop this route being
// used as a free real-money faucet: IP rate limiting, a signed attestation
// from wallet1, live on-chain ownership verification, per-pair idempotency,
// and a per-wallet daily cap.
//
// Body: { wallet1, nft1, wallet2, nft2, winnerId?, adapter?, issuedAt, signature }
//   wallet1/wallet2 — NFT owner addresses (not TBAs), must be different
//   nft1/nft2       — HOODCHAN token IDs (1..MAX_HOODCHAN_TOKEN_ID)
//   winnerId        — null (no winner recorded) or one of nft1/nft2
//   adapter         — stats namespace only (see stats-keys.js); the mint
//                     itself always targets the HOODCHAN contract regardless
//                     of adapter, since api/_lib/chain.js + mint.js hardcode it
//   issuedAt        — ISO timestamp the message below was built at
//   signature       — EIP-191 personal_sign over buildAiMatchMessage(...),
//                     from wallet1 - see the comment on that function
//
// wallet1 is always the connected player's own wallet (src/api.js's
// submitAiMatchComplete signs with it - see selectFighter's ownerAddress
// stamp in src/main.js, which is only ever the connected wallet). wallet2 is
// the AI-controlled opponent (also owned by the player, or any NFT they
// chose to fight against) and is NOT required to sign anything - ownerOf is
// public data either way, so requiring wallet2's signature would add
// nothing; what this route actually needed was proof that a REAL caller
// (not just an outside observer replaying public ownership data) requested
// the mint, and wallet1's signature is that proof.

const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { redisCommand } = require("./_lib/redis");
const { enforceRateLimit, countAndCap } = require("./_lib/rate-limit");
const { ownerOf } = require("./_lib/chain");
const {
  statsKeys,
  recentMatchesKey,
  rivalryKey,
  leaderboardKey,
  isValidAdapterKey,
  DEFAULT_ADAPTER_KEY,
} = require("./_lib/stats-keys");

// Same freshness/replay window as api/lobby/complete.js's identical
// constants - see that file's comment for the reasoning (SIG_REPLAY_TTL
// comfortably outlives the issuedAt window so a replay can never slip
// through after its timestamp would otherwise still pass).
const SIG_REPLAY_TTL_SECONDS = 660;
const ISSUED_AT_MAX_AGE_MS = 10 * 60 * 1000;
const ISSUED_AT_MAX_SKEW_MS = 60 * 1000;

// Must match src/api.js's buildAiMatchMessage byte-for-byte - the client
// signs this exact text and this route re-derives it from the validated
// request fields rather than trusting whatever message the client says it
// signed (same pattern as api/lobby/complete.js's buildResultMessage).
function buildAiMatchMessage({ nft1, nft2, winnerId, wallet1, issuedAt }) {
  const winnerLabel = winnerId === null || winnerId === undefined ? "none" : winnerId;
  return [
    "HOODCHAN Brawl AI match result",
    `nft1: HOODCHAN #${nft1}`,
    `nft2: HOODCHAN #${nft2}`,
    `winner: HOODCHAN #${winnerLabel}`,
    `address: ${wallet1}`,
    `issued: ${issuedAt}`,
  ].join("\n");
}

const RECENT_MATCHES_CAP = 200;
const QUEUE_PREFIX = "mintqueue:";

// HOODCHAN's actual totalSupply (see src/adapters/hoodchan/index.js and
// src/adapters/hoodchan/chain.js) — not stats-keys.js's generic MAX_TOKEN_ID
// sanity bound (10,000,000, shared by every adapter's stats keys). This
// route only ever mints against the HOODCHAN contract (api/_lib/chain.js,
// api/_lib/mint.js), so token IDs outside HOODCHAN's real range can never
// own anything and are rejected here before an RPC round trip.
const MAX_HOODCHAN_TOKEN_ID = 1200;

// Same limits table entry documented in api/_lib/rate-limit.js's header:
// "ai-match-complete  5  fail-CLOSED (mints a soulbound token)". Fail-closed
// (not the default fail-open) because a Redis outage here should throttle
// the mint path, not wave every request through to the chain call + queue.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SEC = 600;

// Per-wallet mints/day, independent of the IP-scoped limit above — stops a
// single wallet paired against many different opponents (or many IPs) from
// draining the minter key, even though each individual pair is distinct.
const DAILY_MINT_CAP = 3;
const DAILY_MINT_WINDOW_SEC = 86400;

// How long a given (adapter, unordered token pair) is locked out of being
// queued again after this route accepts it — long enough to cover mint-cron
// retries and manual investigation of a stuck mint, short enough that a
// wallet cap reset next day isn't permanently shadowed by a stale lock.
const IDEMPOTENCY_TTL_SECONDS = 2592000; // 30 days

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function parseTokenId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_HOODCHAN_TOKEN_ID ? n : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  // 1) Per-IP rate limit, fail-closed — this is the cheapest check and the
  // one most worth enforcing even when Redis itself is unhealthy.
  if (!(await enforceRateLimit(req, res, "ai-match-complete", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SEC, { failOpen: false }))) {
    return;
  }

  const { wallet1, nft1: rawNft1, wallet2, nft2: rawNft2, winnerId: rawWinner, adapter, issuedAt, signature } = req.body || {};

  // 2) Validate body shape.
  if (typeof wallet1 !== "string" || typeof wallet2 !== "string" || !ADDRESS_RE.test(wallet1) || !ADDRESS_RE.test(wallet2)) {
    res.status(400).json({ error: "wallet1 and wallet2 must be valid 0x addresses" }); return;
  }
  const nft1 = parseTokenId(rawNft1);
  const nft2 = parseTokenId(rawNft2);
  if (nft1 === null || nft2 === null) {
    res.status(400).json({ error: `nft1 and nft2 must be integers in 1..${MAX_HOODCHAN_TOKEN_ID}` }); return;
  }
  let winnerId = null;
  if (rawWinner !== undefined && rawWinner !== null) {
    const w = parseTokenId(rawWinner);
    if (w === null || (w !== nft1 && w !== nft2)) {
      res.status(400).json({ error: "winnerId must be null or one of nft1/nft2" }); return;
    }
    winnerId = w;
  }
  if (typeof issuedAt !== "string" || !issuedAt) {
    res.status(400).json({ error: "issuedAt is required" }); return;
  }
  if (typeof signature !== "string" || !signature) {
    res.status(400).json({ error: "signature is required" }); return;
  }

  // Deployment default (env ADAPTER_KEY, falling back to the legacy key) -
  // must match every READER's default (api/leaderboard.js,
  // api/matches/recent.js, api/rivalry/*, api/hoodie/*/stats.js), all of
  // which changed from a hardcoded legacy fallback to this same constant.
  // This route used to hardcode "hoodchan" here specifically, which agreed
  // with the readers only by coincidence of this fork's own deployment
  // value - a fork with a different ADAPTER_KEY (or none) would silently
  // write vs-AI stats nothing else reads.
  const adapterKey = adapter || DEFAULT_ADAPTER_KEY;
  if (!isValidAdapterKey(adapterKey)) {
    res.status(400).json({ error: "invalid adapter" }); return;
  }

  const w1 = wallet1.toLowerCase();
  const w2 = wallet2.toLowerCase();

  // 3) Same wallet on both sides is rejected outright now (previously only
  // same-wallet + same-token was — a wallet can't "fight itself" for a real
  // on-chain mint regardless of which two tokens it holds).
  if (w1 === w2) {
    res.status(400).json({ error: "wallet1 and wallet2 must be different" }); return;
  }

  // 3.5) Signed attestation from wallet1 — ownerOf is public data, so
  // knowing a real (wallet, tokenId) pairing proves nothing about who's
  // actually calling this route. Without this, an attacker who enumerates
  // HOODCHAN owners off-chain could POST any two real owners' addresses and
  // get a soulbound token minted (at the operator's expense) into two
  // strangers' TBAs. Requiring wallet1's signature means at minimum the
  // caller controls the wallet the client always treats as "the connected
  // player" (see selectFighter in src/main.js) - checked before the RPC
  // ownership calls below so a bad signature never pays for those.
  const message = buildAiMatchMessage({ nft1, nft2, winnerId, wallet1, issuedAt });
  let recoveredSigner;
  try {
    recoveredSigner = ethers.verifyMessage(message, signature);
  } catch (err) {
    res.status(403).json({ code: "INVALID_SIGNATURE", error: "Could not verify signature" }); return;
  }
  if (recoveredSigner.toLowerCase() !== w1) {
    res.status(403).json({ code: "INVALID_SIGNATURE", error: "Signature does not match wallet1" }); return;
  }

  const issuedMs = Date.parse(issuedAt);
  if (Number.isNaN(issuedMs)) {
    res.status(403).json({ code: "INVALID_TIMESTAMP", error: "issuedAt is not a valid timestamp" }); return;
  }
  const ageMs = Date.now() - issuedMs;
  if (ageMs > ISSUED_AT_MAX_AGE_MS || ageMs < -ISSUED_AT_MAX_SKEW_MS) {
    res.status(403).json({ code: "INVALID_TIMESTAMP", error: "issuedAt is too old or too far in the future" }); return;
  }

  // Single-use — a captured request can't be replayed to queue a second
  // mint for the same signed attestation (the pairKey idempotency check
  // below covers the same pair generally, but this is cheap and closes the
  // gap for the moment between "signed" and "pairKey claimed").
  const canonicalSig = ethers.Signature.from(signature).serialized;
  const sigHash = crypto.createHash("sha256").update(canonicalSig).digest("hex");
  const sigConsumed = await redisCommand("SET", `sigused:aimatch:${sigHash}`, "1", "NX", "EX", String(SIG_REPLAY_TTL_SECONDS));
  if (sigConsumed !== "OK") {
    res.status(409).json({ code: "REPLAYED", error: "This signed result was already submitted" }); return;
  }

  const loserId = winnerId === nft1 ? nft2 : nft1;

  // Hoisted so the catch block below can release an already-claimed
  // idempotency key on any later failure (stats write, mint-queue SET) -
  // see S6's dead-lock note: without this, a mid-request throw leaves the
  // pair locked out for the full 30-day IDEMPOTENCY_TTL with no mint ever
  // queued and no way for the same real pairing to retry sooner.
  let pairKey = null;

  try {
    // 4) Live ownership check — never trust the client's claimed pairing for
    // something that pays for an on-chain mint. An RPC failure must be a 502
    // ("can't verify"), never silently treated as ownership confirmed.
    let owner1, owner2;
    try {
      [owner1, owner2] = await Promise.all([ownerOf(nft1), ownerOf(nft2)]);
    } catch (err) {
      console.error("[ai-match-complete] ownership check failed", err.message);
      res.status(502).json({ error: "Could not verify ownership" });
      return;
    }
    const failedSides = [];
    if (owner1 !== w1) failedSides.push("wallet1/nft1");
    if (owner2 !== w2) failedSides.push("wallet2/nft2");
    if (failedSides.length) {
      res.status(403).json({ error: "Ownership mismatch", failed: failedSides });
      return;
    }

    // 5) Idempotency — one claim per (adapter, unordered token pair), so a
    // retried/duplicated client request (or two players racing the same
    // pairing) can't enqueue two real mints for the same match. Canonical
    // min/max ordering, same convention as stats-keys.js's rivalryKey.
    const lower = Math.min(nft1, nft2);
    const higher = Math.max(nft1, nft2);
    pairKey = `mintidem:${adapterKey}:${lower}:${higher}`;
    const claimed = await redisCommand("SET", pairKey, "1", "NX", "EX", String(IDEMPOTENCY_TTL_SECONDS));
    if (claimed !== "OK") {
      res.status(409).json({ error: "already minted or pending for this pair" });
      return;
    }

    // 6) Per-wallet daily cap. Checked after the idempotency claim (per spec
    // ordering) but if either wallet is over cap we release the claim below
    // — the pair itself was never actually queued, so it shouldn't stay
    // locked out for the full 30-day idempotency TTL over a cap that resets
    // in at most 24h.
    //
    // Sequential, not Promise.all — checking both in parallel meant a
    // request that was always going to be rejected for wallet1 being over
    // cap still burned one of wallet2's daily slots (countAndCap increments
    // unconditionally). Checking wallet1 first and short-circuiting means a
    // wallet that's already at its cap can no longer cost its opponent
    // anything just by being paired against them.
    const w1Cap = await countAndCap(`rl:aimint:${w1}`, DAILY_MINT_CAP, DAILY_MINT_WINDOW_SEC);
    if (!w1Cap.allowed) {
      await redisCommand("DEL", pairKey);
      res.status(429).json({ error: "daily mint cap reached" });
      return;
    }
    const w2Cap = await countAndCap(`rl:aimint:${w2}`, DAILY_MINT_CAP, DAILY_MINT_WINDOW_SEC);
    if (!w2Cap.allowed) {
      await redisCommand("DEL", pairKey);
      res.status(429).json({ error: "daily mint cap reached" });
      return;
    }

    // Record stats
    const writes = [];
    if (winnerId !== null) {
      const wKeys = statsKeys(adapterKey, winnerId);
      const lKeys = statsKeys(adapterKey, loserId);
      writes.push(
        redisCommand("incr", wKeys.wins),
        redisCommand("incr", lKeys.losses),
        redisCommand("zincrby", leaderboardKey(adapterKey), "1", String(winnerId)),
      );
      if (nft1 !== nft2) {
        writes.push(redisCommand("hincrby", rivalryKey(adapterKey, nft1, nft2), String(winnerId), "1"));
      }
    }
    const recentKey = recentMatchesKey(adapterKey);
    // winnerId === null is a real, valid draw (see the winnerId validation
    // above) - `winnerId === nft1 ? "win" : "loss"` silently recorded every
    // draw as a loss for nft1 and never wrote a matching entry for nft2 at
    // all.
    const nft1Result = winnerId === null ? "draw" : winnerId === nft1 ? "win" : "loss";
    writes.push(
      redisCommand("lpush", recentKey, JSON.stringify({ tokenId: nft1, opponentTokenId: nft2, result: nft1Result, ts: Date.now(), pvp: false })),
    );
    await Promise.all(writes);
    await redisCommand("ltrim", recentKey, "0", String(RECENT_MATCHES_CAP - 1));

    // 7) Enqueue soulbound mint — mint-cron picks this up within 1 minute
    // and is the one that SADDs fought: sets, only after a real mint
    // succeeds (or is confirmed already-minted). Doing that here, before
    // the mint has even been attempted, used to grey out a pairing in the
    // collection picker for a mint that might still fail or never run.
    const roomCode = `AI-${Date.now()}-${nft1}-${nft2}`;
    const mintEntry = {
      roomCode,
      wallet1,
      nft1,
      wallet2,
      nft2,
      queuedAt: Date.now(),
      source: "ai-match",
      adapter: adapterKey,
      idempotencyKey: pairKey,
    };
    await redisCommand("SET", `${QUEUE_PREFIX}${roomCode}`, JSON.stringify(mintEntry), "EX", String(7200));

    res.status(200).json({ success: true, queued: true, adapter: adapterKey, pair: [lower, higher] });
  } catch (err) {
    console.error("[ai-match-complete]", err);
    // If the idempotency key was already claimed (ownership passed, cap
    // passed) and something failed AFTER that - the stats writes, the
    // mint-queue SET - it must be released here. Otherwise a transient
    // Redis hiccup on the very last write permanently dead-locks this real
    // pairing out of ever being retried for the full 30-day
    // IDEMPOTENCY_TTL, with no mint ever actually queued for it.
    if (pairKey) {
      try {
        await redisCommand("DEL", pairKey);
      } catch (delErr) {
        console.error("[ai-match-complete] failed to release pairKey after error", delErr);
      }
    }
    res.status(502).json({ error: "Could not record match result" });
  }
};

// Exposed for test cross-checks against src/api.js's client-side copy of
// this same builder - not used by the Vercel runtime, which only ever calls
// the default export.
module.exports.buildAiMatchMessage = buildAiMatchMessage;
