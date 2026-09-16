// GET /api/mint-cron
//
// Called by Vercel cron every minute. Scans for completed lobbies with
// readyToMint: true and mints their soulbound tokens. After a successful
// mint it also increments bar:total in Redis so the community bar reflects
// every on-chain match.
//
// Protected by CRON_SECRET (same pattern as other cron-protected endpoints).
// Vercel sets the Authorization header automatically for cron invocations.
//
// Hardening (docs/PLAN-2026-09-engine-rebuild.md, Design B Tier 1):
//   - per-run lock (mint:lock) so two overlapping invocations (a slow run
//     still finishing when the next minute's cron fires) never both try to
//     send the same mint.
//   - cursor-complete SCAN (not a single page) so a queue deeper than one
//     SCAN page doesn't silently strand its tail forever.
//   - a 5-strikes dead-letter so one permanently-broken entry (bad chain
//     state, a wallet that will never resolve) doesn't retry forever and
//     crowd out entries that would actually succeed.
//   - a minter-balance preflight so an empty minter wallet fails loudly
//     (an alert key + a clean {skipped:"minter-low"} response) instead of
//     every entry burning an attempt on a tx that was always going to fail
//     "insufficient funds for gas".
//   - api/status.js reads mint:cron:last/lastError, mint:minter:address, and
//     mint:dead's length — this file is the only writer for all of them.

const crypto = require("node:crypto");
const { redisCommand, redisMultiExec, redisEval } = require("./_lib/redis");
const { mintMatchRecord, getMinterAddress } = require("./_lib/mint");
const { getBalance } = require("./_lib/chain");
const { countAndCap } = require("./_lib/rate-limit");
const { logger } = require("./_lib/log");
const { count } = require("./_lib/metrics");

// Redis key prefix for mint queue entries. Each entry is a JSON-serialised
// lobby object stored as  mintqueue:<roomCode>  when complete.js fires.
// We scan for them here and remove them after a successful mint.
const QUEUE_PREFIX = "mintqueue:";
const BAR_KEY = "bar:total";
const LOCK_KEY = "mint:lock";
// Must exceed vercel.json's functions["api/mint-cron.js"].maxDuration (55s) -
// otherwise a run that's still legitimately executing (e.g. a slow
// tx.wait(1) on a laggard block) can have its lock expire out from under it
// while it's still alive, letting the next minute's invocation acquire the
// SAME lock and re-process the same queue entries concurrently (two mints
// racing mintMatchRecord for one match - the loser's tx reverts, burning
// gas and an attempts-counter visit on what would otherwise have succeeded).
// cdel in the finally block below only protects against clobbering a NEWER
// holder's lock; it does nothing to prevent this overlap in the first
// place, which is why the TTL itself has to outlive maxDuration.
const LOCK_TTL_SECONDS = 70;
const MAX_PER_RUN = 3;
const MAX_ATTEMPTS = 5; // countAndCap max is MAX_ATTEMPTS - 1 (see below)
const ATTEMPTS_TTL_SECONDS = 604800; // 7 days
const CRON_LAST_ERROR_TTL_SECONDS = 86400;
const MINTER_LOW_ALERT_TTL_SECONDS = 3600;
// mint:dead is LPUSHed on every dead-letter and never otherwise trimmed - a
// deployment that dead-letters faster than anyone reviews it grows this list
// forever, and api/status.js's own LRANGE 0 -1 over it (see there) would
// grow right along with it. Bounding it here (oldest entries drop off the
// tail, newest — the ones worth reviewing — stay at the head) keeps both
// sides bounded.
const MAX_DEAD_LETTER_ENTRIES = 500;
// 0.002 ETH in wei, as a decimal string (BigInt-safe) — overridable per
// deploy via MINTER_MIN_WEI (e.g. to tune for a chain with different gas
// economics without a code change).
const DEFAULT_MINTER_MIN_WEI = "2000000000000000";

function minterMinWei() {
  const raw = process.env.MINTER_MIN_WEI;
  try {
    return raw ? BigInt(raw) : BigInt(DEFAULT_MINTER_MIN_WEI);
  } catch {
    return BigInt(DEFAULT_MINTER_MIN_WEI);
  }
}

// Cursor-complete SCAN — Upstash (like real Redis) SCAN is a cursor
// iterator, not a "give me everything" call; a single page (the old
// behavior) silently stranded any queue entry past the first ~100 keys.
// Loops until the server reports cursor "0" again.
async function scanQueueKeys() {
  let cursor = "0";
  let keys = [];
  let first = true;
  while (first || cursor !== "0") {
    first = false;
    const [next, page] = await redisCommand("SCAN", cursor, "MATCH", `${QUEUE_PREFIX}*`, "COUNT", "100");
    keys = keys.concat(page ?? []);
    cursor = next;
  }
  return keys;
}

// Strips anything URL-shaped before truncating - api/status.js publishes
// this value with no auth (it's meant to be a public ops dashboard), and
// while nothing in this codebase's error paths currently embeds an RPC key
// in a URL (mint.js's provider uses the plain RPC_URL, never an Alchemy
// keyEnv URL), a future error source easily could. Defense in depth, not a
// response to a proven leak today.
function sanitizeErrorForPublish(msg) {
  // See api/_lib/log.js's redactSecrets: an ethers error once carried the raw
  // MINTER_PRIVATE_KEY into this key and out through /api/status. Nothing
  // that isn't scrubbed may be stored here.
  return require("./_lib/log").redactSecrets(msg, 300);
}

async function setCronLastError(msg) {
  try {
    await redisCommand(
      "SET",
      "mint:cron:lastError",
      sanitizeErrorForPublish(msg),
      "EX",
      String(CRON_LAST_ERROR_TTL_SECONDS),
    );
  } catch {
    // Best-effort — a Redis outage here shouldn't throw a second error on
    // top of whatever we were already trying to report.
  }
}

module.exports = async (req, res) => {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(503).json({ error: "CRON_SECRET not configured" });
    return;
  }
  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Use GET" });
    return;
  }

  const log = logger(req, "mint-cron");

  // (e) SET mint:cron:last at the start of every run, before the lock check
  // — a run that finds itself locked out still counts as "the cron fired",
  // which is what api/status.js's cron.stale check actually cares about.
  try {
    await redisCommand("SET", "mint:cron:last", String(Date.now()));
  } catch (err) {
    // Redis is down — nothing below can work either. Report and bail.
    await setCronLastError(err.message);
    res.status(502).json({ error: "Redis unavailable" });
    return;
  }

  const runId = crypto.randomUUID();
  let lockAcquired = false;

  try {
    // (a) per-run lock
    const lockResult = await redisCommand("SET", LOCK_KEY, runId, "NX", "EX", String(LOCK_TTL_SECONDS));
    if (lockResult !== "OK") {
      res.status(200).json({ skipped: "locked" });
      return;
    }
    lockAcquired = true;

    // (f)/(g) minter preflight — resolve + publish the address before the
    // balance check so api/status.js always has an address to show even on
    // a minter-low run, then skip sending if the balance preflight fails.
    let minterAddress;
    try {
      minterAddress = getMinterAddress();
    } catch (err) {
      await setCronLastError(err.message);
      res.status(200).json({ error: "minter not configured" });
      return;
    }
    await redisCommand("SET", "mint:minter:address", minterAddress);

    let balanceWei;
    try {
      balanceWei = BigInt(await getBalance(minterAddress));
    } catch (err) {
      await setCronLastError(err.message);
      res.status(502).json({ error: "Could not read minter balance" });
      return;
    }
    if (balanceWei < minterMinWei()) {
      await redisCommand("SET", "mint:alert:minter-low", "1", "EX", String(MINTER_LOW_ALERT_TTL_SECONDS));
      await count("mint.skipped.minterLow");
      log.warn("mint.skipped.minterLow", { minterAddress, balanceWei: balanceWei.toString() });
      res.status(200).json({ skipped: "minter-low" });
      return;
    }

    // (b) cursor-complete scan, oldest-first, capped per run
    const keys = await scanQueueKeys();
    if (!keys.length) {
      res.status(200).json({ processed: 0 });
      return;
    }

    const entries = [];
    for (const key of keys) {
      const raw = await redisCommand("GET", key);
      if (!raw) { await redisCommand("DEL", key); continue; }
      let entry;
      try { entry = JSON.parse(raw); } catch { await redisCommand("DEL", key); continue; }
      entries.push({ key, entry });
    }
    entries.sort((a, b) => (a.entry.queuedAt ?? 0) - (b.entry.queuedAt ?? 0));
    const toProcess = entries.slice(0, MAX_PER_RUN);

    const results = [];
    for (const { key, entry } of toProcess) {
      const { wallet1, nft1, wallet2, nft2, roomCode } = entry;
      if (!wallet1 || nft1 == null || !wallet2 || nft2 == null) {
        console.error("[mint-cron] bad entry, skipping", key, entry);
        await redisCommand("DEL", key);
        results.push({ roomCode, status: "skipped:bad-data" });
        continue;
      }

      // (c) attempts / dead-letter. countAndCap increments first and
      // reports allowed=false once the count exceeds `max` — max
      // MAX_ATTEMPTS-1 (4) means the 5th visit to this entry (whether or not
      // any prior visit actually got as far as calling mintMatchRecord) is
      // the one that dead-letters it, matching "attempts >= 5".
      const attemptsKey = `mint:attempts:${key}`;
      const lastErrorKey = `mint:lasterr:${key}`;
      const { count: attempts, allowed } = await countAndCap(attemptsKey, MAX_ATTEMPTS - 1, ATTEMPTS_TTL_SECONDS);
      if (!allowed) {
        const lastError = (await redisCommand("GET", lastErrorKey)) ?? "max attempts reached";
        const deadPayload = JSON.stringify({ key, entry, lastError, at: new Date().toISOString() });
        await redisCommand("LPUSH", "mint:dead", deadPayload);
        await redisCommand("LTRIM", "mint:dead", "0", String(MAX_DEAD_LETTER_ENTRIES - 1));
        await redisCommand("DEL", key);
        await count("mint.dead");
        log.error("mint.dead", { matchKey: key, roomCode, attempts });
        results.push({ roomCode, status: "dead-lettered" });
        continue;
      }

      try {
        const { txHash, alreadyMinted, tba1, tba2 } = await mintMatchRecord(wallet1, nft1, wallet2, nft2);
        const w1 = wallet1.toLowerCase();
        const w2 = wallet2.toLowerCase();

        // (d) one multi-exec for the whole success write — ledger entry,
        // queue-key delete, the bar increment (only for a real new mint,
        // never for an already-minted replay), and the existing fought:
        // pairing records, all-or-nothing instead of five separate round
        // trips any one of which could fail and leave a half-written state.
        const multiCommands = [
          ["HSET", "mint:ledger", key, JSON.stringify({ txHash, tba1, tba2, nft1, nft2, at: new Date().toISOString() })],
          ["DEL", key],
        ];
        if (!alreadyMinted) {
          multiCommands.push(["INCR", BAR_KEY]);
        }
        multiCommands.push(["SADD", `fought:${w1}`, `${nft1}:${w2}:${nft2}`]);
        multiCommands.push(["SADD", `fought:${w2}`, `${nft2}:${w1}:${nft1}`]);
        await redisMultiExec(multiCommands);

        await count("mint.sent");
        log.info("mint.processed", { matchKey: key, roomCode, txHash, alreadyMinted });
        results.push({ roomCode, status: alreadyMinted ? "already-minted" : "minted", txHash });
      } catch (mintErr) {
        console.error("[mint-cron] mint failed for", key, mintErr.message);
        log.error("mint.failed", { matchKey: key, roomCode, error: mintErr.message, attempts });
        // Remember the failure so a later dead-letter (if this entry keeps
        // failing until MAX_ATTEMPTS) reports the real reason instead of a
        // generic placeholder. Best-effort — losing this write just means a
        // less informative (but still correct) dead-letter payload later.
        await redisCommand("SET", lastErrorKey, require("./_lib/log").redactSecrets(mintErr.message, 500), "EX", String(ATTEMPTS_TTL_SECONDS)).catch(() => {});
        // Leave in queue for next cron run — will retry (up to MAX_ATTEMPTS
        // visits total, tracked by attemptsKey above).
        results.push({ roomCode, status: "error", error: mintErr.message });
      }
    }

    res.status(200).json({ processed: toProcess.length, results });
  } catch (err) {
    console.error("[mint-cron]", err);
    await setCronLastError(err.message);
    res.status(502).json({ error: "Cron failed" });
  } finally {
    // Release the lock only if it still holds *our* runId — a run that
    // overran LOCK_TTL_SECONDS may have already had its lock claimed by the
    // next invocation, and releasing unconditionally would delete THAT
    // run's lock instead of ours.
    if (lockAcquired) {
      try {
        await redisEval("cdel", [LOCK_KEY], [runId]);
      } catch (err) {
        console.error("[mint-cron] lock release failed", err.message);
      }
    }
  }
};
