// POST /api/lobby/join
//
// Body: { roomCode, wallet, tokenId, signature?, side? }
//
// Verifies that `wallet` owns `tokenId` on Robinhood Chain (same eth_call
// pattern as src/chain.js readOwnerOf), assigns p1 or p2 slot, and returns
// the updated lobby state. When both slots are filled, status flips to
// 'ready' and the polling client can start the match.
//
// Slot assignment is first-come, first-served unless `side` is explicitly
// provided:
//   first caller  → p1
//   second caller → p2
//
// `signature` is accepted in the body for future SIWE/EIP-191 verification
// but is not validated server-side today — same trust model as the rest of
// the game (client-side ownerOf check is the cosmetic source of truth; see
// chain.js comment on verifyOwnership). The on-chain ownerOf call here IS
// enforced — you must own the NFT to join.

const { redisCommand } = require("../_lib/redis");
const { MAX_TOKEN_ID } = require("../_lib/stats-keys");

const LOBBY_TTL_SECONDS = 600; // refresh TTL on every join so active rooms survive

// --- On-chain ownerOf (mirrors src/chain.js, CJS version for server routes) ---
const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const HOODIES_CONTRACT = "0x9ec6c5b9f572a9b02138e553bc5f5882da735f45";
const SELECTOR_OWNER_OF = "6352211e";

function encodeUint256(n) {
  return BigInt(n).toString(16).padStart(64, "0");
}

function decodeAddress(hex) {
  const clean = hex.replace(/^0x/, "");
  return `0x${clean.slice(-40)}`;
}

async function ownerOf(tokenId) {
  const data = `0x${SELECTOR_OWNER_OF}${encodeUint256(tokenId)}`;
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: HOODIES_CONTRACT, data }, "latest"],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "eth_call failed");
  return decodeAddress(body.result).toLowerCase();
}

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

  let tokenId = null;
  if (rawTokenId !== undefined) {
    tokenId = parseTokenId(rawTokenId);
    if (tokenId === null || tokenId < 0 || tokenId > MAX_TOKEN_ID) {
      res.status(400).json({ error: `tokenId must be an integer 0-${MAX_TOKEN_ID}` }); return;
    }
  }

  try {
    // --- On-chain ownership check (only when both wallet and tokenId provided) ---
    if (wallet && tokenId !== null) {
      let actualOwner;
      try {
        actualOwner = await ownerOf(tokenId);
      } catch (chainErr) {
        console.error("[lobby/join] ownerOf RPC failed", chainErr);
        res.status(502).json({ error: "Could not verify token ownership — RPC unavailable" });
        return;
      }
      if (actualOwner !== wallet.toLowerCase()) {
        res.status(403).json({ error: `Wallet ${wallet} does not own token ${tokenId}` });
        return;
      }
    }

    // --- Load lobby ---
    const key = `lobby:${roomCode.trim().toUpperCase()}`;
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
      slot = side;
    } else if (!lobby.p1) {
      slot = "p1";
    } else if (!lobby.p2) {
      slot = "p2";
    } else {
      // Both slots occupied - check if this wallet is already in a slot (re-join)
      const filledSlot =
        lobby.p1?.wallet === wallet?.toLowerCase() && lobby.p1?.tokenId === tokenId ? "p1" :
        lobby.p2?.wallet === wallet?.toLowerCase() && lobby.p2?.tokenId === tokenId ? "p2" :
        null;
      if (filledSlot) {
        res.status(200).json({ slot: filledSlot, lobbyState: lobby }); return;
      }
      res.status(409).json({ error: "Lobby is full" }); return;
    }

    // Update the slot with whatever data was provided.
    const slotData = lobby[slot] ?? {};
    if (wallet) slotData.wallet = wallet.toLowerCase();
    if (tokenId !== null) slotData.tokenId = tokenId;
    if (signature) slotData.signature = signature;
    slotData.joinedAt = Date.now();
    lobby[slot] = slotData;

    // Two-stage status. "connected" fires as soon as both slots are
    // occupied at all (even pre-wallet) - this is what lets BOTH clients
    // leave the join modal and reach fighter select (see lobby.js's _poll(),
    // main.js's onMatchReady). "ready" only once both wallets are actually
    // registered - the real match-launch signal (main.js only calls
    // maybeLaunchPvpMatch() on "ready", never on "connected"). Previously
    // this only ever set "ready" or "waiting" - there was no signal for
    // "both people are here, go pick fighters" that didn't ALSO require a
    // wallet, which is what created the deadlock: the fighter-select screen
    // (where a wallet gets registered) was only reachable via a status this
    // same handler couldn't produce without a wallet already being set.
    if (lobby.p1?.wallet && lobby.p2?.wallet) {
      lobby.status = "ready";
    } else if (lobby.p1 && lobby.p2) {
      lobby.status = "connected";
    } else {
      lobby.status = "waiting";
    }

    // Refresh TTL so an active room doesn't expire mid-session
    await redisCommand("SET", key, JSON.stringify(lobby), "EX", String(LOBBY_TTL_SECONDS));

    res.status(200).json({ slot, lobbyState: lobby });
  } catch (err) {
    console.error("[lobby/join]", err);
    res.status(502).json({ error: "Could not join lobby right now" });
  }
};
