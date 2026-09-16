// In-memory stand-in for api/_lib/redis.js, covering the subset of Redis
// commands the routes under api/** actually issue (see README-ish comment
// blocks in each command handler below for the exact call shapes this
// mirrors). Values ARE typed in memory here (arrays for lists, Maps for
// hashes/sorted sets, Sets for sets) rather than reimplementing Redis's
// single-string-encoding-of-everything - callers only see JSON strings or
// primitives back out, same as the real Upstash client.
//
// Mirrors scripts/test-lobby-join.mjs's stub-via-require.cache pattern so
// route handlers under test need zero awareness they're not hitting real
// Redis.
"use strict";

const path = require("node:path");

// CAS script fingerprint from api/_lib/redis.js's redisCompareAndSet - EVAL
// calls whose script contains this exact substring are treated as the
// compare-and-set primitive, not run through a real Lua interpreter.
const CAS_SIGNATURE = "redis.call('GET', KEYS[1])";

function createFakeRedis() {
  const store = new Map(); // key -> { type, value, expiresAt: ms|null }
  let queuedError = null; // set by failNext(), consumed by the next command

  function maybeThrow() {
    if (queuedError) {
      const err = queuedError;
      queuedError = null;
      throw err;
    }
  }

  function failNext(err) {
    queuedError = err ?? new Error("fake redis: forced failure");
  }

  // Reads an entry, evicting it (and returning undefined) if its TTL has
  // passed - keeps EXPIRE meaningful for tests that care, without a timer.
  function entry(key) {
    const e = store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return e;
  }

  function setEntry(key, type, value, ttlSec) {
    store.set(key, {
      type,
      value,
      expiresAt: ttlSec != null ? Date.now() + Number(ttlSec) * 1000 : null,
    });
  }

  function list(key) {
    const e = entry(key);
    return e && e.type === "list" ? e.value : [];
  }
  function hash(key) {
    const e = entry(key);
    return e && e.type === "hash" ? e.value : new Map();
  }
  function set(key) {
    const e = entry(key);
    return e && e.type === "set" ? e.value : new Set();
  }
  function zset(key) {
    const e = entry(key);
    return e && e.type === "zset" ? e.value : new Map(); // member -> score
  }

  // --- the CAS script api/_lib/redis.js's redisCompareAndSet() EVALs ---
  function runCas(key, expected, next, ttlSec) {
    const e = entry(key);
    const cur = e ? e.value : null;
    if ((cur === null && expected === "") || cur === expected) {
      setEntry(key, "string", next, Number(ttlSec));
      return 1;
    }
    return 0;
  }

  async function redisCommand(cmd, ...rawArgs) {
    maybeThrow();
    const args = rawArgs.map((a) => (a === undefined || a === null ? a : String(a)));
    switch (String(cmd).toUpperCase()) {
      case "GET": {
        const e = entry(args[0]);
        return e && e.type === "string" ? e.value : null;
      }
      case "SET": {
        const [key, value, ...rest] = args;
        const upper = rest.map((a) => a.toUpperCase());
        const nx = upper.includes("NX");
        const xx = upper.includes("XX");
        if (nx && entry(key)) return null;
        if (xx && !entry(key)) return null;
        let ttlSec = null;
        const exIdx = upper.indexOf("EX");
        const pxIdx = upper.indexOf("PX");
        if (exIdx !== -1) ttlSec = Number(rest[exIdx + 1]);
        else if (pxIdx !== -1) ttlSec = Number(rest[pxIdx + 1]) / 1000;
        setEntry(key, "string", value, ttlSec);
        return "OK";
      }
      case "DEL": {
        let n = 0;
        for (const key of args) if (store.delete(key)) n++;
        return n;
      }
      case "INCR":
      case "INCRBY": {
        const [key, byRaw] = args;
        const by = cmd.toUpperCase() === "INCRBY" ? Number(byRaw) : 1;
        const e = entry(key);
        const cur = e ? Number(e.value) : 0;
        const next = cur + by;
        // Preserve an existing TTL across INCR (matches real Redis) instead
        // of clearing it - rate-limit.js's INCR-then-EXPIRE-on-first pattern
        // only calls EXPIRE once, so a later INCR must not reset expiry.
        const ttlRemaining = e && e.expiresAt !== null ? (e.expiresAt - Date.now()) / 1000 : null;
        setEntry(key, "string", String(next), ttlRemaining);
        return next;
      }
      case "EXPIRE": {
        const [key, ttl] = args;
        const e = entry(key);
        if (!e) return 0;
        e.expiresAt = Date.now() + Number(ttl) * 1000;
        return 1;
      }
      case "LPUSH": {
        const [key, ...vals] = args;
        const l = list(key);
        for (const v of vals) l.unshift(v); // each value lands closer to the head, like real LPUSH
        store.set(key, { type: "list", value: l, expiresAt: entry(key)?.expiresAt ?? null });
        return l.length;
      }
      case "RPUSH": {
        const [key, ...vals] = args;
        const l = list(key);
        l.push(...vals);
        store.set(key, { type: "list", value: l, expiresAt: entry(key)?.expiresAt ?? null });
        return l.length;
      }
      case "LRANGE": {
        const [key, startRaw, stopRaw] = args;
        const l = list(key);
        const start = Number(startRaw);
        const stopIdx = Number(stopRaw) < 0 ? l.length + Number(stopRaw) + 1 : Number(stopRaw) + 1;
        return l.slice(start, stopIdx);
      }
      case "LTRIM": {
        const [key, startRaw, stopRaw] = args;
        const l = list(key);
        const start = Number(startRaw);
        const stopIdx = Number(stopRaw) < 0 ? l.length + Number(stopRaw) + 1 : Number(stopRaw) + 1;
        const trimmed = l.slice(start, stopIdx);
        if (entry(key)) store.set(key, { type: "list", value: trimmed, expiresAt: entry(key).expiresAt });
        return "OK";
      }
      case "SADD": {
        const [key, ...members] = args;
        const s = set(key);
        let added = 0;
        for (const m of members) if (!s.has(m)) { s.add(m); added++; }
        store.set(key, { type: "set", value: s, expiresAt: entry(key)?.expiresAt ?? null });
        return added;
      }
      case "SISMEMBER": {
        const [key, member] = args;
        return set(key).has(member) ? 1 : 0;
      }
      case "SMEMBERS": {
        return Array.from(set(args[0]));
      }
      case "HSET": {
        const [key, ...pairs] = args;
        const h = hash(key);
        let added = 0;
        for (let i = 0; i < pairs.length; i += 2) {
          if (!h.has(pairs[i])) added++;
          h.set(pairs[i], pairs[i + 1]);
        }
        store.set(key, { type: "hash", value: h, expiresAt: entry(key)?.expiresAt ?? null });
        return added;
      }
      case "HGET": {
        const [key, field] = args;
        const h = hash(key);
        return h.has(field) ? h.get(field) : null;
      }
      case "HINCRBY": {
        const [key, field, byRaw] = args;
        const h = hash(key);
        const next = (Number(h.get(field)) || 0) + Number(byRaw);
        h.set(field, String(next));
        store.set(key, { type: "hash", value: h, expiresAt: entry(key)?.expiresAt ?? null });
        return next;
      }
      case "HMGET": {
        const [key, ...fields] = args;
        const h = hash(key);
        return fields.map((f) => (h.has(f) ? h.get(f) : null));
      }
      case "MGET": {
        return args.map((key) => {
          const e = entry(key);
          return e && e.type === "string" ? e.value : null;
        });
      }
      case "ZADD": {
        const [key, ...pairs] = args;
        const z = zset(key);
        let added = 0;
        for (let i = 0; i < pairs.length; i += 2) {
          if (!z.has(pairs[i + 1])) added++;
          z.set(pairs[i + 1], Number(pairs[i]));
        }
        store.set(key, { type: "zset", value: z, expiresAt: entry(key)?.expiresAt ?? null });
        return added;
      }
      case "ZINCRBY": {
        const [key, byRaw, member] = args;
        const z = zset(key);
        const next = (Number(z.get(member)) || 0) + Number(byRaw);
        z.set(member, next);
        store.set(key, { type: "zset", value: z, expiresAt: entry(key)?.expiresAt ?? null });
        return String(next);
      }
      case "ZREM": {
        const [key, ...members] = args;
        const z = zset(key);
        let removed = 0;
        for (const m of members) if (z.delete(m)) removed++;
        return removed;
      }
      case "ZSCORE": {
        const [key, member] = args;
        const z = zset(key);
        return z.has(member) ? String(z.get(member)) : null;
      }
      case "ZREVRANGE": {
        const [key, startRaw, stopRaw, ...rest] = args;
        const withScores = rest.some((a) => a.toUpperCase() === "WITHSCORES");
        const z = zset(key);
        const ranked = Array.from(z.entries()).sort((a, b) => b[1] - a[1]); // desc by score
        const start = Number(startRaw);
        const stopIdx = Number(stopRaw) < 0 ? ranked.length + Number(stopRaw) + 1 : Number(stopRaw) + 1;
        const page = ranked.slice(start, stopIdx);
        return withScores ? page.flatMap(([member, score]) => [member, String(score)]) : page.map(([m]) => m);
      }
      case "SCAN": {
        // Single-page scan: everything matches, cursor "0" signals "done" -
        // enough for callers that just want "give me all keys".
        const matchIdx = args.findIndex((a) => a.toUpperCase() === "MATCH");
        const pattern = matchIdx !== -1 ? args[matchIdx + 1] : null;
        const re = pattern ? new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`) : null;
        const keys = Array.from(store.keys()).filter((k) => entry(k) && (!re || re.test(k)));
        return ["0", keys];
      }
      case "EVAL": {
        const [script, numkeys, ...rest] = args;
        if (String(script).includes(CAS_SIGNATURE)) {
          const n = Number(numkeys);
          const keys = rest.slice(0, n);
          const argv = rest.slice(n);
          // redisCompareAndSet's script: KEYS[1]=key, ARGV = [expected, next, ttl]
          return runCas(keys[0], argv[0], argv[1], argv[2]);
        }
        throw new Error("fake redis: EVAL script not recognized (only the CAS script is emulated)");
      }
      default:
        throw new Error(`fake redis: unhandled command ${cmd}`);
    }
  }

  async function redisMultiExec(commands) {
    if (!Array.isArray(commands) || commands.length === 0) return [];
    const results = [];
    for (const c of commands) {
      results.push(await redisCommand(...c));
    }
    return results;
  }

  async function redisCompareAndSet(key, expected, next, ttlSeconds) {
    maybeThrow();
    return runCas(key, expected ?? "", next, ttlSeconds) === 1;
  }

  return { redisCommand, redisMultiExec, redisCompareAndSet, store, failNext };
}

// Installs a fake into require.cache for api/_lib/redis.js, exactly the
// pattern scripts/test-lobby-join.mjs uses inline - factored out here so
// every test file doesn't hand-roll its own copy.
function installFakeRedis(require, repoRoot) {
  const fake = createFakeRedis();
  const p = require.resolve(path.join(repoRoot, "api/_lib/redis.js"));
  require.cache[p] = {
    id: p,
    filename: p,
    loaded: true,
    exports: {
      redisCommand: fake.redisCommand,
      redisMultiExec: fake.redisMultiExec,
      redisCompareAndSet: fake.redisCompareAndSet,
    },
  };
  return fake;
}

module.exports = { createFakeRedis, installFakeRedis };
