// POST /api/lobby/join
//
// Body: { roomCode, wallet?, tokenId?, signature?, side?, engineVersion? }
//
// Requires a session (Authorization: Bearer <token>, see api/_lib/auth.js).
// When `wallet`/`tokenId` ARE present in the body they must equal the
// session's own wallet/tokenId (403 SESSION_MISMATCH otherwise) - a session
// only ever speaks for its own wallet, never lets a caller register someone
// else's slot. `wallet`/`tokenId` may still be omitted entirely for the
// side-less "I'm present in this room" pre-registration call src/lobby.js's
// auto-join makes before the visitor has picked a fighter (see below) - the
// slot's `wallet`/`sid` are ALWAYS taken from the session regardless
// (already proven at session-issuance time), so an omitted body wallet
// never leaves a slot anonymous. Only `tokenId` genuinely stays unset until
// the caller actually registers a fighter, and only tokenId (not wallet) is
// what gates the room's "ready" status below.
//
// Verifies that `wallet` owns `tokenId` on Robinhood Chain via
// api/_lib/chain.js (ONE shared contract constant - this route used to carry
// its own copy of the OnChainHoodies address from the pfp-brawl fork, so every
// join 403'd against a collection nobody here holds; see
// scripts/test-lobby-ownership.mjs), assigns p1 or p2 slot, and returns
// the updated lobby state. When both slots are filled, status flips to
// 'ready' and the polling client can start the match.
//
// Slot assignment is first-come, first-served unless `side` is explicitly
// provided:
//   first caller  → p1
//   second caller → p2
// An explicit `side` can only (re)claim a slot that is empty or already
// registered to the SAME wallet - it is not a way to overwrite the other
// player (anyone with the share link could otherwise swap themselves into
// the host's slot and the soulbound mint pairing).
//
// SELF_PLAY: a session's wallet can never occupy BOTH slots of the same
// room - if the session wallet already sits in the slot THIS call would not
// land in, the join is refused (409 SELF_PLAY) rather than letting one
// wallet play itself for a "match".
//
// ENGINE_VERSION_MISMATCH: when the caller sends `engineVersion` and the
// room was created under a different one (api/_lib/room.js's
// readEngineVersion, stamped at api/lobby/create.js time), the join is
// refused (426) with the room's `expected` version so the client can prompt
// a reload instead of playing a match two different engine builds disagree
// about the rules of.
//
// The lobby record is updated via api/_lib/room.js's transition() (a
// compare-and-set retry loop): two players clicking READY in the same
// instant used to read the same wallet-less record and the second write
// erased the first's slot, leaving the room stuck on "connected" forever.

const { redisCommand } = require("../_lib/redis");
const { MAX_TOKEN_ID } = require("../_lib/stats-keys");
const { ownerOf } = require("../_lib/chain");
const { enforceRateLimit } = require("../_lib/rate-limit");
const { requireSession } = require("../_lib/auth");
const { transition, isParticipant } = require("../_lib/room");

// --- Validation helpers ---
function isValidAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function parseTokenId(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

// --- Handler ---
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }
  if (!(await enforceRateLimit(req, res, "join", 30, 600))) return;

  const session = await requireSession(req, res);
  if (!session) return; // requireSession already wrote 401 {code:"UNAUTHENTICATED"}

  const body = req.body || {};
  const { roomCode, wallet, tokenId: rawTokenId, signature, side, engineVersion } = body;

  if (typeof roomCode !== "string" || !roomCode.trim()) {
    res.status(400).json({ error: "roomCode is required" }); return;
  }

  // wallet and tokenId are required to be VALID when present (may be
  // omitted for pre-registration before fighter select, matching the
  // frontend flow) - but when present they must be this session's own.
  if (wallet !== undefined && !isValidAddress(wallet)) {
    res.status(400).json({ error: "wallet must be a valid 0x address" }); return;
  }
  const walletLc = wallet ? wallet.toLowerCase() : null;
  if (walletLc && walletLc !== session.wallet) {
    res.status(403).json({ code: "SESSION_MISMATCH", error: "wallet does not match the authenticated session" }); return;
  }

  let tokenId = null;
  if (rawTokenId !== undefined) {
    tokenId = parseTokenId(rawTokenId);
    if (tokenId === null || tokenId < 0 || tokenId > MAX_TOKEN_ID) {
      res.status(400).json({ error: `tokenId must be an integer 0-${MAX_TOKEN_ID}` }); return;
    }
    if (tokenId !== session.tokenId) {
      res.status(403).json({ code: "SESSION_MISMATCH", error: "tokenId does not match the authenticated session" }); return;
    }
  }

  if (typeof engineVersion !== "undefined" && typeof engineVersion !== "string") {
    res.status(400).json({ error: "engineVersion must be a string" }); return;
  }

  try {
    // --- On-chain ownership check (only when both wallet and tokenId provided) ---
    if (walletLc && tokenId !== null) {
      let actualOwner;
      try {
        actualOwner = await ownerOf(tokenId);
      } catch (chainErr) {
        console.error("[lobby/join] ownerOf RPC failed", chainErr);
        // `detail` is the RPC's own status/snippet (no secrets) so an outage
        // is diagnosable from the response instead of only from function logs.
        res.status(502).json({
          error: "Could not verify token ownership — RPC unavailable",
          detail: String(chainErr.message ?? "").slice(0, 200),
        });
        return;
      }
      if (actualOwner !== walletLc) {
        res.status(403).json({ error: `Wallet ${wallet} does not own token ${tokenId}` });
        return;
      }
    }

    const result = await transition(roomCode, ["waiting", "connected", "ready"], (lobby) => {
      // --- Engine version gate ---
      if (engineVersion && lobby.engineVersion && engineVersion !== lobby.engineVersion) {
        return {
          error: "Client engine version does not match this room",
          status: 426,
          code: "ENGINE_VERSION_MISMATCH",
          expected: lobby.engineVersion,
        };
      }

      if (lobby.status === "complete" || lobby.status === "disputed") {
        return { error: "Match already completed", status: 409 };
      }

      // --- SELF_PLAY: this session's wallet can't occupy both slots ---
      const existingSlot = isParticipant(lobby, session.wallet);
      const requestedSlot = side === "p1" || side === "p2" ? side : null;
      if (existingSlot && requestedSlot && existingSlot !== requestedSlot) {
        return { error: "This wallet is already the other player in this room", status: 409, code: "SELF_PLAY" };
      }

      // --- Slot assignment ---
      // Explicit side takes priority; otherwise auto-assign by OCCUPANCY, not
      // wallet presence. This used to check `!lobby.p1.wallet`, which meant a
      // slot that was occupied-but-pre-wallet (the normal state for both
      // sides during the initial connect handshake, before either player has
      // picked a fighter) still looked "available" - a guest's side-less
      // auto-join could land in p1 even after the creator already claimed
      // it, and a third stranger opening the link after both real players
      // had connected but before either had a wallet yet could silently
      // steal a slot. Occupancy (`!lobby.p1`) is the correct test for "is
      // anyone sitting here at all".
      let slot;
      if (requestedSlot) {
        const taken = lobby[requestedSlot]?.wallet;
        if (taken && taken !== session.wallet) {
          return { error: `Side ${requestedSlot} is already registered to another wallet`, status: 409 };
        }
        slot = requestedSlot;
      } else if (existingSlot) {
        slot = existingSlot;
      } else if (!lobby.p1) {
        slot = "p1";
      } else if (!lobby.p2) {
        slot = "p2";
      } else {
        // Both slots occupied - check if this wallet is already in a slot (re-join)
        const filledSlot =
          lobby.p1?.wallet === session.wallet && (tokenId === null || lobby.p1?.tokenId === tokenId) ? "p1" :
          lobby.p2?.wallet === session.wallet && (tokenId === null || lobby.p2?.tokenId === tokenId) ? "p2" :
          null;
        if (filledSlot) {
          slot = filledSlot;
        } else {
          return { error: "Lobby is full", status: 409 };
        }
      }

      // Another wallet's session can't steal a self-play collision either -
      // re-check against the resolved slot (covers the occupancy-based
      // auto-assign path above, not just the explicit-`side` path).
      const otherSlot = slot === "p1" ? "p2" : "p1";
      if (lobby[otherSlot]?.wallet && lobby[otherSlot].wallet === session.wallet) {
        return { error: "This wallet is already the other player in this room", status: 409, code: "SELF_PLAY" };
      }

      // Update the slot. wallet/sid come from the SESSION, not the request
      // body - the session already proved ownership at issuance (see
      // api/auth/session.js), so every occupant of a slot always carries a
      // real, verified wallet, even the side-less "I'm present" pre-
      // registration call that never repeats it in the body. Before this
      // fix, a side-less join left `{joinedAt}` only in the slot - "has a
      // wallet" was being used as the proxy for "picked a fighter", so a
      // pre-registration occupant was indistinguishable from an unproven
      // one anywhere else that reads `.wallet` (isParticipant, poll,
      // reconnect matching).
      const slotData = lobby[slot] ?? {};
      slotData.wallet = session.wallet;
      slotData.sid = session.sid;
      if (tokenId !== null) slotData.tokenId = tokenId;
      if (signature) slotData.signature = signature;
      slotData.joinedAt = Date.now();
      lobby[slot] = slotData;

      // Two-stage status. "connected" fires as soon as both slots are
      // occupied at all (even pre-registration) - this is what lets BOTH
      // clients leave the join modal and reach fighter select (see
      // lobby.js's _poll(), main.js's onMatchReady). "ready" only once both
      // sides have actually REGISTERED a tokenId (lobbyRegisterFighter's
      // explicit side+tokenId call, i.e. "picked a fighter") - the real
      // match-launch signal (main.js only calls maybeLaunchPvpMatch() on
      // "ready", never on "connected"). Gating on tokenId (not wallet, which
      // is now always present the moment a session touches the slot) is
      // what stops a wallet-only join from prematurely flipping the room to
      // "ready" with an unregistered `tokenId: undefined` opponent that
      // api/lobby/complete.js could never resolve to a lobbyIds member.
      if (lobby.p1?.tokenId != null && lobby.p2?.tokenId != null) {
        lobby.status = "ready";
      } else if (lobby.p1 && lobby.p2) {
        lobby.status = "connected";
      } else {
        lobby.status = "waiting";
      }

      lobby.__slot = slot; // read back below, stripped before the response
      return lobby;
    });

    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }

    const { __slot: slot, ...lobbyState } = result.room;
    res.status(200).json({ slot, lobbyState });
  } catch (err) {
    console.error("[lobby/join]", err);
    res.status(502).json({ error: "Could not join lobby right now" });
  }
};
