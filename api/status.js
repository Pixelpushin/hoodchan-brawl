// GET /api/status
//
// Public, read-only ops dashboard endpoint: is Redis up, is the RPC up, is
// the mint pipeline healthy (minter funded, queue not backing up, cron
// still running, nothing stuck in the dead-letter list), and what commit is
// actually deployed. No auth — nothing here is sensitive (env values are
// never included; the minter's address is public on-chain data anyway) —
// just rate limited like every other route.
//
// mint:minter:address / mint:cron:last / mint:cron:lastError / mint:dead /
// mint:alert:minter-low are all written by api/mint-cron.js; this route
// only ever reads them, so it never needs MINTER_PRIVATE_KEY itself.

const fs = require("node:fs");
const path = require("node:path");
const { redisCommand } = require("./_lib/redis");
const { blockNumber, getBalance } = require("./_lib/chain");
const { enforceRateLimit } = require("./_lib/rate-limit");
const { logger } = require("./_lib/log");

const QUEUE_PREFIX = "mintqueue:";
const CRON_STALE_SECONDS = 180;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_SEC = 600;

function readCommit() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "version.json"), "utf8");
    const data = JSON.parse(raw);
    return data.commit || null;
  } catch {
    // No version.json (local dev, or a build that hasn't stamped one yet) —
    // not an error, just "can't verify" like the front end's own handling.
    return null;
  }
}

// wei (decimal string from chain.getBalance) -> a plain "1.234567" ETH
// string, 6 decimal places. Pure integer math (no floats) so it's exact
// regardless of magnitude; chain.js stays zero-dependency (no ethers there),
// so this small formatter lives here instead of pulling ethers in just for
// display formatting.
function weiToEthString(weiStr) {
  try {
    const wei = BigInt(weiStr);
    const ONE_ETH = 1000000000000000000n;
    const whole = wei / ONE_ETH;
    const frac = (wei % ONE_ETH).toString().padStart(18, "0").slice(0, 6);
    return `${whole}.${frac}`;
  } catch {
    return null;
  }
}

// Same cursor-complete SCAN loop as api/mint-cron.js's scanQueueKeys — kept
// as its own copy rather than a shared import since this route only needs
// the keys (for depth/oldest-age), never the entries it would delete.
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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Use GET" }); return; }

  if (!(await enforceRateLimit(req, res, "status", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SEC, { failOpen: true }))) {
    return;
  }

  const log = logger(req, "status");
  const alerts = [];

  // --- redis ---
  let redisOk = false;
  const redisStart = Date.now();
  try {
    await redisCommand("GET", "mint:cron:last");
    redisOk = true;
  } catch (err) {
    log.error("status.redisDown", { error: err.message });
  }
  const redisLatencyMs = Date.now() - redisStart;
  if (!redisOk) alerts.push("redis.down");

  // --- rpc ---
  let rpcOk = false;
  let rpcBlock = null;
  let rpcEndpoint = null;
  const rpcStart = Date.now();
  try {
    const result = await blockNumber();
    rpcOk = true;
    rpcBlock = result.block;
    rpcEndpoint = result.endpoint;
  } catch (err) {
    log.error("status.rpcDown", { error: err.message });
  }
  const rpcLatencyMs = Date.now() - rpcStart;
  if (!rpcOk) alerts.push("rpc.down");

  // --- minter --- (only meaningful once Redis has told us the address)
  let minterAddress = null;
  let minterBalanceEth = null;
  let minterLow = false;
  if (redisOk) {
    try {
      minterAddress = await redisCommand("GET", "mint:minter:address");
    } catch (err) {
      log.error("status.minterAddressLookupFailed", { error: err.message });
    }
    try {
      minterLow = (await redisCommand("GET", "mint:alert:minter-low")) === "1";
    } catch (err) {
      log.error("status.minterLowFlagFailed", { error: err.message });
    }
  }
  if (minterAddress) {
    try {
      minterBalanceEth = weiToEthString(await getBalance(minterAddress));
    } catch (err) {
      log.error("status.minterBalanceFailed", { error: err.message });
    }
  }
  if (minterLow) alerts.push("minter.low");

  // --- queue / dead-letter ---
  let queueDepth = 0;
  let oldestAgeSec = null;
  let deadCount = 0;
  if (redisOk) {
    try {
      const keys = await scanQueueKeys();
      queueDepth = keys.length;
      let oldestQueuedAt = null;
      for (const key of keys) {
        const raw = await redisCommand("GET", key);
        if (!raw) continue;
        try {
          const entry = JSON.parse(raw);
          if (typeof entry.queuedAt === "number" && (oldestQueuedAt === null || entry.queuedAt < oldestQueuedAt)) {
            oldestQueuedAt = entry.queuedAt;
          }
        } catch {
          // Malformed entry — mint-cron.js will clean it up on its next
          // pass; not this route's job to mutate anything.
        }
      }
      if (oldestQueuedAt !== null) {
        oldestAgeSec = Math.max(0, Math.floor((Date.now() - oldestQueuedAt) / 1000));
      }
    } catch (err) {
      log.error("status.queueScanFailed", { error: err.message });
    }
    try {
      // LRANGE (not LLEN) — same command set the hermetic fake Redis
      // supports, and Upstash charges this the same either way at this
      // list's expected size. Bounded to match mint-cron.js's own LTRIM cap
      // on mint:dead (500) rather than "0 -1" — this route is unauthenticated
      // (see file header), so its own cost per request should never scale
      // with how large an unbounded list could otherwise grow to.
      deadCount = (await redisCommand("LRANGE", "mint:dead", "0", "499")).length;
    } catch (err) {
      log.error("status.deadLetterCountFailed", { error: err.message });
    }
  }
  if (deadCount > 0) alerts.push("mint.dead");

  // --- cron freshness ---
  let lastRunAgoSec = null;
  let stale = true;
  let lastError = null;
  if (redisOk) {
    try {
      const last = await redisCommand("GET", "mint:cron:last");
      if (last) {
        lastRunAgoSec = Math.max(0, Math.floor((Date.now() - Number(last)) / 1000));
        stale = lastRunAgoSec > CRON_STALE_SECONDS;
      }
    } catch (err) {
      log.error("status.cronLastFailed", { error: err.message });
    }
    try {
      // Belt and braces: the cron already scrubs what it stores, but this is a
      // public endpoint, so scrub again on the way out (api/_lib/log.js).
      const rawLastError = await redisCommand("GET", "mint:cron:lastError");
      lastError = rawLastError ? require("./_lib/log").redactSecrets(rawLastError, 300) : null;
    } catch (err) {
      log.error("status.cronLastErrorFailed", { error: err.message });
    }
  }
  if (stale) alerts.push("cron.stale");

  const ok = redisOk && rpcOk;

  res.status(200).json({
    ok,
    commit: readCommit(),
    redis: { ok: redisOk, latencyMs: redisLatencyMs },
    rpc: { ok: rpcOk, block: rpcBlock, endpoint: rpcEndpoint, latencyMs: rpcLatencyMs },
    minter: { address: minterAddress, balanceEth: minterBalanceEth, low: minterLow },
    queue: { depth: queueDepth, oldestAgeSec, dead: deadCount },
    cron: { lastRunAgoSec, stale, lastError },
    alerts,
  });
};
