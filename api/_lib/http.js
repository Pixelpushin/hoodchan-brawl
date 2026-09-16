// Small route wrapper for NEW routes only (api/auth/session.js and
// anything else built alongside it) - existing routes each hand-roll their
// own CORS/OPTIONS/method-check/rate-limit boilerplate and are NOT to be
// refactored onto this (they belong to other agents working this tree
// concurrently). This exists so new routes stop repeating that boilerplate
// without touching anything already shipped.
//
// Usage:
//   const { withRoute } = require("../_lib/http");
//   module.exports = withRoute(
//     async (req, res) => {
//       // req.body is always a plain object (never undefined/a raw string)
//       // req.session is set per the `session` option below
//       res.status(200).json({ ok: true });
//     },
//     {
//       methods: ["POST"],                 // default ["GET"]
//       cors: "public",                    // "public" | "browser" (default "public")
//       rateLimit: { scope: "auth/session", max: 20, windowSec: 600, failOpen: false },
//       session: "required",               // "required" | "optional" | "none" (default "none")
//     },
//   );
//
// cors "public" sets Access-Control-Allow-Origin: * (matches every existing
// route's current CORS header, e.g. api/lobby/join.js). cors "browser"
// echoes the request's Origin header back ONLY when it's in the
// ALLOWED_ORIGINS env var (comma-separated) or is https://fight.hoodchan.org
// - a request with no Origin header at all (curl, an agent, server-to-server)
// is never blocked by this, since CORS is a browser-enforced concept and
// there's nothing to echo back.
//
// Thrown errors from the wrapped handler are caught and turned into a 502
// {error} - a handler's own res.status(...).json(...) calls still win if it
// already responded before throwing.
"use strict";

const { enforceRateLimit } = require("./rate-limit");
const { getSession, requireSession } = require("./auth");

const DEFAULT_SITE_ORIGIN = "https://fight.hoodchan.org";

function allowedBrowserOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...extra, DEFAULT_SITE_ORIGIN]);
}

function applyCors(req, res, mode, methods) {
  const allowMethods = Array.from(new Set([...methods, "OPTIONS"])).join(", ");
  res.setHeader("Access-Control-Allow-Methods", allowMethods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (mode === "browser") {
    const origin = req.headers?.origin;
    if (origin && allowedBrowserOrigins().has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    return;
  }
  // "public" (default)
  res.setHeader("Access-Control-Allow-Origin", "*");
}

// Normalizes req.body to a plain object: Vercel's default body parser
// already gives us a parsed object for application/json, but a defensive
// second pass keeps this wrapper correct even against a hermetic test's raw
// req.body or a client that sent a string body without the right header.
function normalizeJsonBody(req) {
  if (req.body === undefined || req.body === null) {
    req.body = {};
    return { ok: true };
  }
  if (typeof req.body === "string") {
    const trimmed = req.body.trim();
    if (trimmed === "") {
      req.body = {};
      return { ok: true };
    }
    try {
      req.body = JSON.parse(trimmed);
    } catch {
      return { ok: false };
    }
  }
  return { ok: true };
}

function withRoute(handler, opts = {}) {
  const {
    methods = ["GET"],
    cors = "public",
    rateLimit: rateLimitOpts = null,
    session: sessionMode = "none",
    json = true,
  } = opts;

  return async (req, res) => {
    // Track whether anything has already written a response, so the
    // catch-all error handler below never double-sends.
    let sent = false;
    const originalJson = res.json.bind(res);
    const originalEnd = res.end.bind(res);
    res.json = (body) => {
      sent = true;
      return originalJson(body);
    };
    res.end = (...args) => {
      sent = true;
      return originalEnd(...args);
    };

    applyCors(req, res, cors, methods);

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    if (!methods.includes(req.method)) {
      res.status(405).json({ error: `Use ${methods.join(", ")}` });
      return;
    }

    if (rateLimitOpts) {
      const { scope, max, windowSec, failOpen = true } = rateLimitOpts;
      const allowed = await enforceRateLimit(req, res, scope, max, windowSec, { failOpen });
      if (!allowed) return;
    }

    if (json) {
      const parsed = normalizeJsonBody(req);
      if (!parsed.ok) {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
      }
    }

    if (sessionMode === "required") {
      const session = await requireSession(req, res);
      if (!session) return; // requireSession already wrote 401
      req.session = session;
    } else if (sessionMode === "optional") {
      req.session = await getSession(req);
    }

    try {
      await handler(req, res);
    } catch (err) {
      console.error("[http] route handler threw", err);
      if (!sent) {
        res.status(502).json({ error: err?.message ? String(err.message) : "Unexpected error" });
      }
    }
  };
}

module.exports = { withRoute };
