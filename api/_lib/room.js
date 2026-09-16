// Room state machine for HOODCHAN Brawl lobby/match records (Design B
// Tier 1 - see docs/PLAN-2026-09-engine-rebuild.md's "Room state machine").
//
// transition() is the ONE place that mutates a lobby:<CODE> record via a
// GET -> check fromStates -> mutate -> redisCompareAndSet(TTL_BY_STATE)
// cycle, retried up to CAS_ATTEMPTS times when another writer races it.
// api/lobby/join.js and api/rtc/signal.js and api/match/start.js all go
// through this instead of hand-rolling their own CAS loop, so TTL policy
// and the "wrong starting state" 409 live in exactly one place.
//
// api/lobby/complete.js predates this file and keeps its own CAS loop
// (its "sub" bookkeeping + agree/disputed branching doesn't fit the simple
// fromStates+mutate shape here, and it isn't owned by this slice of work) -
// only the routes built alongside room.js use transition().
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { redisCommand, redisCompareAndSet } = require("./redis");

const CAS_ATTEMPTS = 4;

// TTL per room status, seconds - matches the spec's table exactly:
//   - waiting/connected/ready: the original 10-minute lobby TTL, enough for
//     two players to find each other and pick fighters.
//   - signaling: short-lived on purpose, WebRTC setup only.
//   - in_match: long enough for a full match plus some slack.
//   - submitted: waiting on the other side's result attestation.
//   - verified/recorded/disputed/complete: a full day, so the mint worker,
//     dispute review, and replay tooling all have time to read a terminal
//     room.
//   - abandoned: short - nothing more should ever read this.
const TTL_BY_STATE = {
  waiting: 600,
  connected: 600,
  ready: 600,
  signaling: 300,
  in_match: 1800,
  submitted: 900,
  verified: 86400,
  recorded: 86400,
  disputed: 86400,
  complete: 86400,
  abandoned: 300,
};
// Fallback for any status not in the table above (shouldn't happen once
// every caller only ever sets a known status) - long enough to notice and
// debug rather than vanishing the room instantly.
const DEFAULT_TTL_SECONDS = 600;

function normalizeCode(code) {
  return String(code ?? "").trim().toUpperCase();
}

function roomKey(code) {
  return `lobby:${normalizeCode(code)}`;
}

// version.json lives at the repo root, a sibling of api/. Read fresh on
// every call (not cached at require time) so a redeploy's stamped version
// shows up without waiting on a cold start - same approach as
// api/auth/session.js's readEngineVersion, duplicated here (rather than
// imported) since that route doesn't export the function and this file
// must not edit api/auth/session.js (outside this slice's ownership).
function readEngineVersion() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "..", "version.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.version === "string") return parsed.version;
    if (typeof parsed.engineVersion === "string") return parsed.engineVersion;
    return null;
  } catch {
    return null;
  }
}

// m_<base36 timestamp>_<8 hex chars> - short, roughly time-ordered, and
// collision-resistant enough for a per-room match identifier (this is not a
// security token, just a stable id to correlate signaling/heartbeat/submit
// records for one match).
function generateMatchId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `m_${ts}_${rand}`;
}

// Pure read: the room record, or null if it doesn't exist or is corrupted.
// No CAS, no TTL touch - callers that need to mutate use transition().
async function loadRoom(code) {
  const raw = await redisCommand("GET", roomKey(code));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// wallet -> "p1" | "p2" | null, case-insensitive (callers may pass a
// checksummed or mixed-case address; room records always store lowercase).
function isParticipant(room, wallet) {
  if (!room || !wallet) return null;
  const walletLc = String(wallet).toLowerCase();
  if (room.p1?.wallet && room.p1.wallet === walletLc) return "p1";
  if (room.p2?.wallet && room.p2.wallet === walletLc) return "p2";
  return null;
}

// Runs one gated, retried compare-and-set mutation against lobby:<CODE>.
//
// fromStates: a status string or array of them - the CURRENT room.status
// must be one of these or the call is rejected with 409 before mutate()
// ever runs (mutate never sees a room in a state its caller didn't expect).
//
// mutate(room): receives a structuredClone of the freshly-loaded record (so
// it's safe to mutate in place) and must return either:
//   - the next record (object) - transition() stamps `v`/`updatedAt` onto
//     it and writes it with the TTL for its (possibly new) `status`.
//   - { error, status?, code?, ...rest } - aborts the transition with no
//     write, for a business-rule check that needed the freshly-loaded room
//     to decide (e.g. "is this wallet already the other slot" - see
//     api/lobby/join.js's SELF_PLAY check). Any extra fields beyond
//     error/status/code (e.g. join.js's `expected` on an
//     ENGINE_VERSION_MISMATCH) are passed straight through onto the
//     response body.
//
// Returns { ok: true, room } on success, or
// { ok: false, status, body } on any failure (missing room, wrong
// fromStates, mutate-rejected, corrupted record, or CAS exhaustion) - body
// is ready to hand straight to res.status(status).json(body).
async function transition(code, fromStates, mutate) {
  const key = roomKey(code);
  const allowed = Array.isArray(fromStates) ? fromStates : [fromStates];

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const raw = await redisCommand("GET", key);
    if (!raw) {
      return { ok: false, status: 404, body: { error: "Room not found or expired", code: "NOT_FOUND" } };
    }

    let room;
    try {
      room = JSON.parse(raw);
    } catch {
      return { ok: false, status: 502, body: { error: "Corrupted room state" } };
    }

    if (!allowed.includes(room.status)) {
      return {
        ok: false,
        status: 409,
        body: { error: `Room is in status "${room.status}"`, status: room.status },
      };
    }

    const result = mutate(structuredClone(room));
    if (!result || typeof result !== "object") {
      return { ok: false, status: 502, body: { error: "Room mutation produced no result" } };
    }
    if ("error" in result) {
      const { error, status, code, ...rest } = result;
      return { ok: false, status: status ?? 409, body: { error, code, ...rest } };
    }

    const next = result;
    next.v = (room.v ?? 0) + 1;
    next.updatedAt = Date.now();

    const ttl = TTL_BY_STATE[next.status] ?? DEFAULT_TTL_SECONDS;
    const wrote = await redisCompareAndSet(key, raw, JSON.stringify(next), ttl);
    if (wrote) return { ok: true, room: next };
    // Someone else (another player, another request) wrote to this key
    // between our GET and our CAS - reload the fresh record and retry.
  }

  return { ok: false, status: 503, body: { error: "Room is busy, try again" } };
}

module.exports = {
  TTL_BY_STATE,
  DEFAULT_TTL_SECONDS,
  transition,
  loadRoom,
  isParticipant,
  roomKey,
  normalizeCode,
  generateMatchId,
  readEngineVersion,
};
