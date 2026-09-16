// Cheap counters on top of Upstash Redis (api/_lib/redis.js), same
// zero-npm-dependency approach as the rest of api/_lib.
//
// count(name, n=1) bumps two counters in one redisMultiExec:
//   metric:d:<yyyymmdd>:<name>  — daily bucket, EX 777600 (9 days — outlives
//                                  a long weekend of not checking dashboards
//                                  without keeping every counter forever)
//   metric:t:<name>             — all-time running total, no expiry
// Both via INCRBY so a caller can report n>1 in one call instead of looping.
//
// Never throws — a metrics write failing must never fail (or even log noise
// into) the request that triggered it; callers fire-and-forget this.

const { redisMultiExec } = require("./redis");

const DAILY_TTL_SECONDS = 777600; // 9 days

function dayBucket(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

async function count(name, n = 1) {
  try {
    await redisMultiExec([
      ["INCRBY", `metric:d:${dayBucket()}:${name}`, String(n)],
      ["EXPIRE", `metric:d:${dayBucket()}:${name}`, String(DAILY_TTL_SECONDS)],
      ["INCRBY", `metric:t:${name}`, String(n)],
    ]);
  } catch (err) {
    console.error(`[metrics] count(${name}) failed`, err.message);
  }
}

module.exports = { count, dayBucket };
