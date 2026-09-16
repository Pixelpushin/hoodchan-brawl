// Zero-dependency Upstash Redis client - plain fetch() against their REST
// API instead of the @upstash/redis npm package, matching the rest of this
// repo's zero-npm-dependency approach. KV_REST_API_URL/KV_REST_API_TOKEN are
// injected automatically by the Upstash-for-Redis Vercel integration.
// Prefixed with an underscore (like the whole _lib dir) so Vercel doesn't
// treat this as a route of its own - it's imported by the real handlers.
function creds() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("Redis is not configured (KV_REST_API_URL/KV_REST_API_TOKEN missing)");
  }
  return { url, token };
}

async function redisCommand(cmd, ...args) {
  const { url, token } = creds();
  // Path-style form (command + every arg as its own URL segment) rather than
  // command-in-path + args-in-body - the latter looked plausible but Upstash
  // rejected it ("wrong number of arguments") for anything past a single arg.
  const path = [cmd, ...args].map((s) => encodeURIComponent(s)).join("/");
  const res = await fetch(`${url}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// Runs several commands as one MULTI/EXEC transaction via Upstash's
// /multi-exec endpoint (body = JSON array of command arrays). Returns the
// array of results in order. api/lobby/complete.js has required this since
// the lobby shipped, but it was never implemented - every PVP match-end threw
// "redisMultiExec is not a function" (unreachable while join 403'd).
async function redisMultiExec(commands) {
  const { url, token } = creds();
  if (!Array.isArray(commands) || commands.length === 0) return [];
  const res = await fetch(`${url}/multi-exec`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(commands.map((c) => c.map(String))),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.error ?? "multi-exec failed");
  const failed = data.find((d) => d && d.error);
  if (failed) throw new Error(failed.error);
  return data.map((d) => d?.result);
}

// Compare-and-set for a JSON record: only writes `next` if the key still
// holds exactly `expected` (null = must not exist). Returns true on success,
// false if someone else wrote in between - callers re-read and retry. Upstash
// REST has no WATCH, so this is a tiny Lua script instead; it's what keeps two
// players' simultaneous READY clicks from overwriting each other's slot in
// the lobby record (api/lobby/join.js).
const CAS_SCRIPT =
  "local cur = redis.call('GET', KEYS[1]) " +
  "if (cur == false and ARGV[1] == '') or cur == ARGV[1] then " +
  "redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1 else return 0 end";
async function redisCompareAndSet(key, expected, next, ttlSeconds) {
  const r = await redisCommand("EVAL", CAS_SCRIPT, "1", key, expected ?? "", next, String(ttlSeconds));
  return Number(r) === 1;
}

// Named Lua scripts, keyed by a short name so callers (and hermetic tests -
// see test/_helpers/fake-redis.js's CAS_SIGNATURE substring match) don't
// need to carry the script body around. "cas" is exactly CAS_SCRIPT above
// (redisCompareAndSet's own EVAL call is untouched, kept as its own literal
// rather than routed through this registry, so its signature/behavior can't
// drift by editing this object). "cdel" is compare-and-delete: only removes
// KEYS[1] if it still holds ARGV[1] - e.g. mint-cron.js releasing its
// mint:lock only when the lock still holds the runId that acquired it, so
// one run's release can never clobber a later run's lock after this run
// overran its own EX.
// "rpushcap" makes api/rtc/signal.js's queue-length cap atomic - the old
// LRANGE-to-count then RPUSH sequence was two round trips with no lock
// between them, so two POSTs racing past the LRANGE at the same instant
// could both see room under the 32-message cap and both push, exceeding it
// (see docs/PLAN-2026-09-engine-rebuild.md's review notes). Checks LLEN and
// pushes in the same script instead: returns -1 (queue stays untouched) once
// KEYS[1] is already at ARGV[1] (maxLen) entries, otherwise RPUSHes ARGV[2],
// refreshes the TTL to ARGV[3], and returns the new length.
const RPUSHCAP_SCRIPT =
  "local len = redis.call('LLEN', KEYS[1]) " +
  "if len >= tonumber(ARGV[1]) then return -1 end " +
  "redis.call('RPUSH', KEYS[1], ARGV[2]) " +
  "redis.call('EXPIRE', KEYS[1], ARGV[3]) " +
  "return redis.call('LLEN', KEYS[1])";

const SCRIPTS = {
  cas: CAS_SCRIPT,
  cdel:
    "local cur = redis.call('GET', KEYS[1]) " +
    "if cur == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 else return 0 end",
  rpushcap: RPUSHCAP_SCRIPT,
};

// EVAL a registered script by name. `keys`/`args` are plain arrays (KEYS/ARGV
// respectively) - this just fills in the EVAL <script> <numkeys> <keys...>
// <args...> shape redisCommand already expects.
async function redisEval(name, keys = [], args = []) {
  const script = SCRIPTS[name];
  if (!script) throw new Error(`redisEval: unknown script "${name}"`);
  return redisCommand("EVAL", script, String(keys.length), ...keys, ...args);
}

module.exports = { redisCommand, redisMultiExec, redisCompareAndSet, redisEval, SCRIPTS };
