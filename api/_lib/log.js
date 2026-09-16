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

// Scrubs secret-looking substrings out of free text that is about to be
// stored in Redis, printed to a log, or returned by an HTTP response. Exists
// because a library's error message can embed the very value it rejected -
// ethers: 'invalid BytesLike value (argument="value", value="0x…")' - which
// is exactly how a malformed MINTER_PRIVATE_KEY env var (trailing newline)
// surfaced through mint:cron:lastError and the public /api/status on
// 2026-09-16. Aggressive on purpose: any 32+ hex run or 0x-prefixed 40+ hex
// run is treated as a secret (tx hashes and addresses in ERROR text are an
// acceptable loss), key=value / key:"value" pairs whose key looks sensitive
// lose their value, URLs are collapsed, and the result is capped.
const HEX_SECRET_RE = /0x[0-9a-fA-F]{40,}|\b[0-9a-fA-F]{32,}\b/g;
const VALUE_ATTR_RE = /\b(value|key|secret|token|signature|authorization|privateKey|mnemonic)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,)]+)/gi;
function redactSecrets(text, max = 300) {
  return String(text ?? "")
    .replace(VALUE_ATTR_RE, (_, k) => `${k}=[redacted]`)
    .replace(HEX_SECRET_RE, "[redacted]")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Free-text-ish fields (error messages, reasons, details) get the same scrub
// so a call site logging { error: err.message } can't leak either.
const TEXT_KEY_RE = /error|message|reason|detail|stack/i;

function redact(fields) {
  if (!fields || typeof fields !== "object") return fields;
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY_RE.test(key)) out[key] = "[redacted]";
    else if (TEXT_KEY_RE.test(key) && typeof value === "string") out[key] = redactSecrets(value, 1000);
    else out[key] = value;
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

module.exports = { logger, redactSecrets };
