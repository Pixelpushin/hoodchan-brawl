// Structured JSON-line logging for api/** routes. One line per event, easy
// to grep/ingest from Vercel's log drain — no log library, matches the
// zero-npm-dependency approach the rest of api/_lib takes.
//
// logger(req, route) returns { info, warn, error }, each printing one JSON
// object: { ts, level, route, reqId, ip, event, ...fields }.
//   - reqId comes from Vercel's own x-vercel-id header (null off-Vercel/in
//     tests) — free correlation id, no need to mint our own.
//   - ip reuses rate-limit.js's clientIp() so the trust order (and its
//     defensiveness around a missing/partial req in tests) is defined in
//     exactly one place.
//   - fields is caller-supplied and gets shallow-scanned for anything that
//     looks like a secret (signature/token/authorization/privateKey, case-
//     insensitive, substring match so signedToken/AuthorizationHeader etc.
//     are also caught) and replaced with "[redacted]" — logging call sites
//     shouldn't have to remember not to pass the wrong field through.

const { clientIp } = require("./rate-limit");

const SECRET_KEY_RE = /signature|token|authorization|privatekey/i;

function redact(fields) {
  if (!fields || typeof fields !== "object") return fields;
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : value;
  }
  return out;
}

function write(level, route, req, event, fields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    route,
    reqId: req?.headers?.["x-vercel-id"] ?? null,
    ip: clientIp(req),
    event,
    ...redact(fields),
  };
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  out(JSON.stringify(line));
}

function logger(req, route) {
  return {
    info: (event, fields) => write("info", route, req, event, fields),
    warn: (event, fields) => write("warn", route, req, event, fields),
    error: (event, fields) => write("error", route, req, event, fields),
  };
}

module.exports = { logger };
