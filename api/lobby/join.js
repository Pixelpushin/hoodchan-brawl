// POST /api/lobby/join
//
// Body: { roomCode, wallet, tokenId, signature?, side? }
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
// `signature` is accepted in the body for future SIWE/EIP-191 verification
// but is not validated server-side today — same trust model as the rest of
// the game (client-side ownerOf check is the cosmetic source of truth; see
// chain.js comment on verifyOwnership). The on-chain ownerOf call here IS
// enforced — you must own the NFT to join.
//
// The lobby record is updated with a compare-and-set (see
// api/_lib/redis.js): two players clicking READY in the same instant used to
// read the same wallet-less record and the second write erased the first's
// slot, leaving the room stuck on "connected" forever.

const { redisCommand, redisCompareAndSet } = require("../_lib/redis");
const { MAX_TOKEN_ID } = require("../_lib/stats-keys");
const { ownerOf } = require("../_lib/chain");

const LOBBY_TTL_SECONDS = 600; // refresh TTL on every join so active rooms survive
const CAS_ATTEMPTS = 4;

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const body = req.body || {};
  const { roomCode, wallet, tokenId: rawTokenId, signature, side } = body;

  if (typeof roomCode !== "string" || !roomCode.trim()) {
    res.status(400).json({ error: "roomCode is required" }); return;
  }

  // wallet and tokenId are required when present (may be omitted for
  // pre-registration before fighter select, matching frontend flow).
  if (wallet !== undefined && !isValidAddress(wallet)) {
    res.status(400).json({ error: "wallet must be a valid 0x address" }); return;
  }
  const walletLc = wallet ? wallet.toLowerCase() : null;

  let tokenId = null;
  if (rawTokenId !== undefined) {
    tokenId = parseTokenId(rawTokenId);
    if (tokenId === null || tokenId < 0 || tokenId > MAX_TOKEN_ID) {
      res.status(400).json({ error: `tokenId must be an integer 0-${MAX_TOKEN_ID}` }); return;
    }
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

    const key = `lobby:${roomCode.trim().toUpperCase()}`;

    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      // --- Load lobby ---
      const raw = await redisCommand("GET", key);
      if (!raw) {
        res.status(404).json({ error: "Room not found or expired" }); return;
      }

      let lobby;
      try { lobby = JSON.parse(raw); } catch {
        res.status(502).json({ error: "Corrupted room state" }); return;
      }

      if (lobby.status === "complete") {
        res.status(409).json({ error: "Match already completed" }); return;
      }

      // --- Slot assignment ---
      // Explicit side takes priority; otherwise auto-assign by OCCUPANCY, not
      // wallet presence. This used to check `!lobby.p1.wallet`, which meant a
      // slot that was occupied-but-pre-wallet (the normal state for both
      // sides during the initial connect handshake, before either player has
      // picked a fighter) still looked "available" - a guest's side-less
      // auto-join (lobby.js's _autoJoin) could land in p1 even after the
      // creator already claimed it, and a third stranger opening the link
      // after both real players had connected but before either had a wallet
      // yet could silently steal a slot. Occupancy (`!lobby.p1`) is the
      // correct test for "is anyone sitting here at all".
      let slot;
      if (side === "p1" || side === "p2") {
        const taken = lobby[side]?.wallet;
        if (taken && taken !== walletLc) {
          res.status(409).json({ error: `Side ${side} is already registered to another wallet` }); return;
        }
        slot = side;
      } else if (!lobby.p1) {
        slot = "p1";
      } else if (!lobby.p2) {
        slot = "p2";
      } else {
        // Both slots occupied - check if this wallet is already in a slot (re-join)
        const filledSlot =
          lobby.p1?.wallet === walletLc && lobby.p1?.tokenId === tokenId ? "p1" :
          lobby.p2?.wallet === walletLc && lobby.p2?.tokenId === tokenId ? "p2" :
          null;
        if (filledSlot) {
          res.status(200).json({ slot: filledSlot, lobbyState: lobby }); return;
        }
        res.status(409).json({ error: "Lobby is full" }); return;
      }

      // Update the slot with whatever data was provided.
      const slotData = lobby[slot] ?? {};
      if (walletLc) slotData.wallet = walletLc;
      if (tokenId !== null) slotData.tokenId = tokenId;
      if (signature) slotData.signature = signature;
      slotData.joinedAt = Date.now();
      lobby[slot] = slotData;

      // Two-stage status. "connected" fires as soon as both slots are
      // occupied at all (even pre-wallet) - this is what lets BOTH clients
      // leave the join modal and reach fighter select (see lobby.js's _poll(),
      // main.js's onMatchReady). "ready" only once both wallets are actually
      // registered - the real match-launch signal (main.js only calls
      // maybeLaunchPvpMatch() on "ready", never on "connected").
      if (lobby.p1?.wallet && lobby.p2?.wallet) {
        lobby.status = "ready";
      } else if (lobby.p1 && lobby.p2) {
        lobby.status = "connected";
      } else {
        lobby.status = "waiting";
      }

      // Write only if nobody else touched the record since we read it;
      // otherwise loop and re-apply this player's change on the fresh copy.
      // Refreshes TTL so an active room doesn't expire mid-session.
      const wrote = await redisCompareAndSet(key, raw, JSON.stringify(lobby), LOBBY_TTL_SECONDS);
      if (wrote) {
        res.status(200).json({ slot, lobbyState: lobby });
        return;
      }
    }
    res.status(503).json({ error: "Room is busy, try again" });
  } catch (err) {
    console.error("[lobby/join]", err);
    res.status(502).json({ error: "Could not join lobby right now" });
  }
};
