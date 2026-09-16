// Remote PVP lobby + Community bar frontend module.
//
// Lobby flow:
//   Host: CREATE ROOM -> POST /api/lobby/create -> get roomCode -> show code
//         -> poll GET /api/lobby/poll?roomCode=... every 2s until status=ready
//   Guest: paste roomCode -> POST /api/lobby/join -> poll same endpoint
//   Both:  onMatchReady fires -> main.js tears down modal, enters select screen
//   On match end: lobbyComplete signs a result attestation with the caller's
//                 wallet and awaits POST /api/lobby/complete. Both players'
//                 clients call this independently; the server only finalizes
//                 the match once both signed submissions agree (see
//                 api/lobby/complete.js) - lobbyComplete's return value tells
//                 the caller which of those states it landed in.
//
// Community bar:
//   initCommunityBar fetches GET /api/bar once, renders progress + milestones.
//   Handles 404/network errors gracefully (shows 0, doesn't throw).

import { signMessage, getSession, getConnectedAccount, connectWallet } from "./wallet.js";
import { activeAdapter } from "./adapters/index.js";

const POLL_INTERVAL_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 10000;

let _onMatchReady = null; // set by initLobby({ onMatchReady })
let _onLobbyError = null; // set by initLobby({ onLobbyError }) - room gone while in fighter select
let _pollTimer = null;
let _pollRoomCode = null;
let _pollSide = null;     // 'p1' | 'p2'
let _connectedNotified = false; // "connected" is announced once per room; polling continues until "ready"

// Most recently minted/reused session (see _ensureLobbySession) - reused for
// poll's optional Authorization header and for the heartbeat, instead of
// re-deriving one on every 2s poll tick or 10s heartbeat tick. Reflects
// whichever tokenId was last sessioned: the wallet's first owned token at
// create/initial-join time, then the ACTUALLY chosen fighter's tokenId once
// lobbyRegisterFighter re-sessions at register time (see its doc comment).
let _activeSession = null;

let _heartbeatTimer = null;
let _heartbeatFrame = 0;

// The engine build this client was served - sent as `engineVersion` on
// create/join so the server can refuse a stale client with 426 rather than
// starting a match two different engine builds disagree about the rules of
// (see api/lobby/join.js's ENGINE_VERSION_MISMATCH). Loaded via a dynamic
// import with its own catch, per the spec, so a repo state where
// src/engine-version.js doesn't exist (or fails to load) never blocks the
// lobby flow - engineVersion is just omitted, and the server's own gate is
// a no-op when a room has no engineVersion stamped either.
let _engineVersion = null;
import("./engine-version.js")
  .then((mod) => { _engineVersion = mod?.ENGINE_VERSION ?? null; })
  .catch(() => {});

// Turns a failed fetch's {status, body} into copy a player should actually
// see, for the two status codes that mean something specific here - every
// other status falls back to the server's own `error` message (or a plain
// "status <code>").
function _friendlyError(status, body) {
  if (status === 401) return "Your session expired - reconnect your wallet and try again.";
  if (status === 426) return "New version available, reload";
  return body?.error ?? `status ${status}`;
}

async function _throwFriendly(res) {
  const body = await res.json().catch(() => ({}));
  throw new Error(_friendlyError(res.status, body));
}

// Establishes (or reuses - see src/wallet.js's getSession sessionStorage
// cache) a backend session (POST /api/auth/session) for this device's
// connected wallet, prompting a wallet connection first if none is active
// yet. `tokenId` is optional:
//   - omitted (create, and the guest's initial pre-fighter-select join):
//     the wallet's FIRST owned token is used as a placeholder, just so the
//     session has SOME real, currently-owned token to bind to - the room
//     doesn't care which token created/pre-joined it, only the eventually
//     REGISTERED fighter matters for the match itself.
//   - provided (lobbyRegisterFighter, at actual fighter-select register
//     time): re-sessions for that exact tokenId. getSession() caches per
//     (wallet, tokenId), so a different tokenId than the placeholder always
//     mints a fresh session here rather than reusing the placeholder one.
async function _ensureLobbySession(tokenId) {
  let address = await getConnectedAccount().catch(() => null);
  if (!address) {
    address = await connectWallet(activeAdapter.config.chain);
  }
  let effectiveTokenId = tokenId;
  if (effectiveTokenId === undefined || effectiveTokenId === null) {
    const owned = await activeAdapter.fetchWalletTokenIds(address).catch(() => []);
    if (!owned?.length) {
      throw new Error(`Connect a wallet that holds a ${activeAdapter.config.unitName} to play online.`);
    }
    effectiveTokenId = owned[0];
  }
  const session = await getSession({ tokenId: effectiveTokenId, adapter: activeAdapter.config.key });
  _activeSession = session;
  return session;
}

function _authHeader(session) {
  return { Authorization: `Bearer ${session.token}` };
}

// Liveness ping for a PVP match in progress (see api/match/heartbeat.js) -
// started once this device reaches fighter select for a PVP room, every
// 10s, stopped on exit (closeLobby, or the match result being submitted -
// see lobbyComplete below). `frame` is a local tick counter, not yet a real
// synced simulation frame - the rollback netcode that would give this a
// true meaning is later engine-rebuild work (see
// docs/PLAN-2026-09-engine-rebuild.md); this only needs to prove liveness.
function _startHeartbeat(roomCode) {
  _stopHeartbeat();
  _heartbeatFrame = 0;
  _heartbeatTimer = setInterval(() => {
    if (!_activeSession) return;
    fetch("/api/match/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ..._authHeader(_activeSession) },
      body: JSON.stringify({ roomCode, frame: _heartbeatFrame++ }),
    }).catch((err) => console.warn("[lobby] heartbeat failed", err));
  }, HEARTBEAT_INTERVAL_MS);
}

function _stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

// ===== Lobby init (called once from main.js) =====

export function initLobby({ onMatchReady, onLobbyError } = {}) {
  _onMatchReady = onMatchReady ?? null;
  _onLobbyError = onLobbyError ?? null;

  const remotePvpBtn = document.getElementById("remote-pvp-btn");
  const lobbyModal = document.getElementById("lobby-modal");
  const lobbyCloseBtn = document.getElementById("lobby-close-btn");
  const lobbyCreateBtn = document.getElementById("lobby-create-btn");
  const lobbyJoinBtn = document.getElementById("lobby-join-btn");
  const lobbyCodeInput = document.getElementById("lobby-code-input");

  if (!remotePvpBtn || !lobbyModal) return;

  // GATED until real netcode ships. The lobby exchanges fighters correctly,
  // but the match itself is still two separate local sims (game.js reads P2
  // from the local keys) - that is not a real or fair PVP match, so the
  // button is hidden and share links are ignored unless the page is opened
  // with ?pvp=1 (testing the lobby flow). Share links carry the flag along.
  const params = new URLSearchParams(window.location.search);
  // params.has("pvp") alone also unlocks this for ?pvp=0 or a bare ?pvp= -
  // the flag is specifically "1" everywhere else it's set (see the share
  // link and history.pushState below), so check the value, not just presence.
  if (params.get("pvp") !== "1") {
    remotePvpBtn.hidden = true;
    return;
  }

  // Auto-join if URL contains ?room=XXXXXX — guest just clicked a share link.
  const urlRoom = params.get("room");
  if (urlRoom) {
    _resetLobbyUI();
    lobbyModal.classList.remove("hidden");
    _autoJoin(urlRoom.trim().toUpperCase());
  }

  remotePvpBtn.addEventListener("click", () => {
    _resetLobbyUI();
    lobbyModal.classList.remove("hidden");
  });

  lobbyCloseBtn?.addEventListener("click", () => {
    closeLobby();
  });

  lobbyCreateBtn?.addEventListener("click", async () => {
    _setLobbyLoading(true);
    try {
      const session = await _ensureLobbySession();
      const res = await fetch("/api/lobby/create", { method: "POST", headers: _authHeader(session) });
      if (!res.ok) await _throwFriendly(res);
      const { roomCode } = await res.json();
      _showLobbyWaiting(roomCode);
      _startPolling(roomCode, "p1");
    } catch (err) {
      console.error("[lobby] create failed", err);
      _showLobbyError(err.message || "Couldn't create room. Try again.");
      _setLobbyLoading(false);
    }
  });

  lobbyJoinBtn?.addEventListener("click", async () => {
    const code = (lobbyCodeInput?.value ?? "").trim().toUpperCase();
    if (!code) { lobbyCodeInput?.focus(); return; }
    _setLobbyLoading(true);
    try {
      const session = await _ensureLobbySession();
      const res = await fetch("/api/lobby/join", {
        method: "POST",
        headers: { "Content-Type": "application/json", ..._authHeader(session) },
        body: JSON.stringify({ roomCode: code, engineVersion: _engineVersion ?? undefined }),
      });
      if (!res.ok) await _throwFriendly(res);
      // The server decides which slot this device is; don't assume p2.
      const { slot } = await res.json().catch(() => ({}));
      _showLobbyJoined();
      _startPolling(code, slot === "p1" ? "p1" : "p2");
    } catch (err) {
      console.error("[lobby] join failed", err);
      _showLobbyError(err.message || "Couldn't join room. Check the code and try again.");
      _setLobbyLoading(false);
    }
  });

  // Enter key submits join input.
  lobbyCodeInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") lobbyJoinBtn?.click();
  });

  // Click-outside-to-close (same convention as controls/leaderboard panels).
  document.addEventListener("click", (e) => {
    if (lobbyModal.classList.contains("hidden")) return;
    const panel = document.getElementById("lobby-panel");
    if (panel?.contains(e.target) || e.target === remotePvpBtn) return;
    closeLobby();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (lobbyModal.classList.contains("hidden")) return;
    closeLobby();
  });
}

// ===== Public API used by main.js =====

export function closeLobby() {
  _stopPolling();
  _stopHeartbeat();
  document.getElementById("lobby-modal")?.classList.add("hidden");
  _resetLobbyUI();
  // Clear the ?room= param from the URL when the lobby is dismissed.
  if (window.location.search.includes("room=")) {
    history.replaceState({}, "", location.pathname);
  }
}

// Expose current room code so main.js can pass it to lobbyComplete.
export function getCurrentRoomCode() {
  return _pollRoomCode;
}

// Starts the 10s match/heartbeat ping (see api/match/heartbeat.js) for the
// current room - called from main.js once this device reaches fighter
// select for a PVP room. A no-op if there's no active room to heartbeat for.
export function startLobbyHeartbeat() {
  if (_pollRoomCode) _startHeartbeat(_pollRoomCode);
}

// Called from main.js readyBtn click when _pvpMode is active. Re-sessions
// for the ACTUALLY chosen fighter's tokenId (see _ensureLobbySession's doc
// comment) - this is the point where the placeholder session minted at
// create/initial-join time gets replaced with the real one.
export async function lobbyRegisterFighter({ side, tokenId, walletAddress }) {
  const session = await _ensureLobbySession(tokenId);
  const res = await fetch("/api/lobby/join", {
    method: "POST",
    headers: { "Content-Type": "application/json", ..._authHeader(session) },
    body: JSON.stringify({ roomCode: _pollRoomCode, side, tokenId, wallet: walletAddress, engineVersion: _engineVersion ?? undefined }),
  });
  if (!res.ok) await _throwFriendly(res);
  // Continue or start polling for ready state after fighter registration.
  if (_pollRoomCode) _startPolling(_pollRoomCode, _pollSide ?? side);
}

// Called from main.js when something recoverable happened in fighter select
// (e.g. the opponent's fighter failed to load) and the room should be watched
// again for a fresh "ready".
export function lobbyResumePolling() {
  if (_pollRoomCode) _startPolling(_pollRoomCode, _pollSide ?? "p1");
}

// Builds the exact message the caller's wallet signs and api/lobby/complete.js
// re-derives server-side to verify it - both sides MUST produce identical
// bytes for the same inputs (see test/lobby-complete.test.mjs's cross-check
// against the server's copy of this same builder). winnerId/loserId of
// null render as the literal word "none", never omitted or left as "null".
export function buildResultMessage({ roomCode, winnerId, loserId, p1Score, p2Score, roundsPlayed, wallet, issuedAt }) {
  const winnerLabel = winnerId === null || winnerId === undefined ? "none" : winnerId;
  const loserLabel = loserId === null || loserId === undefined ? "none" : loserId;
  return [
    "HOODCHAN Brawl result",
    `room: ${String(roomCode).toUpperCase()}`,
    `winner: HOODCHAN #${winnerLabel}`,
    `loser: HOODCHAN #${loserLabel}`,
    `score: ${p1Score}-${p2Score} in ${roundsPlayed}`,
    `address: ${wallet}`,
    `issued: ${issuedAt}`,
  ].join("\n");
}

// Called from main.js when match ends. Signs a result attestation with
// `wallet` and awaits the server's verdict instead of firing-and-forgetting -
// the caller needs to know whether this match actually got recorded before
// it tells the player anything about a mint (see mint-celebration.js's
// resultStatus). Returns { recorded, disputed?, waitingFor? } on a real
// server response, or { recorded: false, error } if signing or the request
// itself failed (no wallet connected, user rejected the signature, network
// error, etc).
export async function lobbyComplete({ roomCode, winnerId, loserId, p1Score, p2Score, roundsPlayed, wallet }) {
  _stopPolling();
  _stopHeartbeat(); // match is over - exiting the live-match phase
  const issuedAt = new Date().toISOString();
  const message = buildResultMessage({ roomCode, winnerId, loserId, p1Score, p2Score, roundsPlayed, wallet, issuedAt });
  try {
    const signature = await signMessage(wallet, message);
    // Reuses _activeSession (the session for this device's REGISTERED
    // fighter, set by lobbyRegisterFighter's _ensureLobbySession call) -
    // api/lobby/complete.js requires session.wallet === the signing wallet
    // (403 SESSION_MISMATCH otherwise), so this must be the same wallet as
    // `wallet` above, which it always is in the normal flow.
    const headers = { "Content-Type": "application/json" };
    if (_activeSession) Object.assign(headers, _authHeader(_activeSession));
    const res = await fetch("/api/lobby/complete", {
      method: "POST",
      headers,
      body: JSON.stringify({ roomCode, winnerId, loserId, p1Score, p2Score, roundsPlayed, wallet, issuedAt, signature }),
    });
    const responseBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { recorded: false, error: _friendlyError(res.status, responseBody) };
    }
    return {
      recorded: !!responseBody.recorded,
      disputed: !!responseBody.disputed,
      waitingFor: responseBody.waitingFor ?? null,
    };
  } catch (err) {
    console.warn("[lobby] complete call failed", err);
    return { recorded: false, error: err?.message || "Couldn't record the result." };
  }
}

// ===== Internal lobby UI helpers =====

function _resetLobbyUI() {
  const els = {
    options: document.getElementById("lobby-options"),
    waiting: document.getElementById("lobby-waiting"),
    joined: document.getElementById("lobby-joined"),
    createBtn: document.getElementById("lobby-create-btn"),
    joinBtn: document.getElementById("lobby-join-btn"),
    codeInput: document.getElementById("lobby-code-input"),
    desc: document.getElementById("lobby-desc"),
    errorEl: document.getElementById("lobby-error"),
  };
  els.options?.classList.remove("hidden");
  els.waiting?.classList.add("hidden");
  els.joined?.classList.add("hidden");
  if (els.createBtn) els.createBtn.disabled = false;
  if (els.joinBtn) els.joinBtn.disabled = false;
  if (els.codeInput) els.codeInput.value = "";
  if (els.desc) els.desc.textContent = "Connect wallets on both devices. Create a room or join one with a code.";
  if (els.errorEl) els.errorEl.remove();
}

function _setLobbyLoading(on) {
  const createBtn = document.getElementById("lobby-create-btn");
  const joinBtn = document.getElementById("lobby-join-btn");
  if (createBtn) createBtn.disabled = on;
  if (joinBtn) joinBtn.disabled = on;
}

function _showLobbyError(msg) {
  // Remove any previous error.
  document.getElementById("lobby-error")?.remove();
  const el = document.createElement("p");
  el.id = "lobby-error";
  el.className = "lobby-error-text";
  el.textContent = msg;
  document.getElementById("lobby-options")?.appendChild(el);
}

function _showLobbyWaiting(roomCode) {
  document.getElementById("lobby-options")?.classList.add("hidden");
  const waiting = document.getElementById("lobby-waiting");
  if (waiting) waiting.classList.remove("hidden");

  // Show the room code and push it into the URL so the host can copy/share.
  const codeEl = document.getElementById("lobby-room-code");
  if (codeEl) codeEl.textContent = roomCode;
  const shareUrl = `${location.origin}${location.pathname}?pvp=1&room=${roomCode}`;
  history.pushState({}, "", `?pvp=1&room=${roomCode}`);

  const statusEl = document.getElementById("lobby-wait-status");
  if (statusEl) statusEl.textContent = "Waiting for opponent...";

  // Copy link button.
  const copyBtn = document.getElementById("lobby-copy-link-btn");
  if (copyBtn) {
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(shareUrl);
        copyBtn.textContent = "COPIED!";
        setTimeout(() => { copyBtn.textContent = "COPY LINK"; }, 2000);
      } catch {
        // Fallback: select a temporary input.
        const tmp = document.createElement("input");
        tmp.value = shareUrl;
        document.body.appendChild(tmp);
        tmp.select();
        document.execCommand("copy");
        tmp.remove();
        copyBtn.textContent = "COPIED!";
        setTimeout(() => { copyBtn.textContent = "COPY LINK"; }, 2000);
      }
    };
  }
}

async function _autoJoin(roomCode) {
  _setLobbyLoading(true);
  try {
    const session = await _ensureLobbySession();
    const res = await fetch("/api/lobby/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", ..._authHeader(session) },
      body: JSON.stringify({ roomCode, engineVersion: _engineVersion ?? undefined }),
    });
    if (!res.ok) await _throwFriendly(res);
    const { slot } = await res.json().catch(() => ({}));
    _showLobbyJoined();
    _startPolling(roomCode, slot === "p1" ? "p1" : "p2");
  } catch (err) {
    console.error("[lobby] auto-join failed", err);
    _showLobbyError(err.message || "Couldn't join room. It may have expired.");
    _setLobbyLoading(false);
    // Show the manual join UI so they can retry.
    document.getElementById("lobby-options")?.classList.remove("hidden");
  }
}

function _showLobbyJoined() {
  document.getElementById("lobby-options")?.classList.add("hidden");
  document.getElementById("lobby-joined")?.classList.remove("hidden");
}

// ===== Polling =====

function _startPolling(roomCode, side) {
  _stopPolling();
  if (_pollRoomCode !== roomCode) _connectedNotified = false;
  _pollRoomCode = roomCode;
  _pollSide = side;
  _poll();
}

function _stopPolling() {
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
}

async function _poll() {
  if (!_pollRoomCode) return;
  try {
    // Optional on poll (see api/lobby/poll.js) - reuses whatever session is
    // already active rather than minting/prompting one on every 2s tick;
    // a missing session just means this poll won't see full wallets for a
    // room this device is itself a participant in.
    const headers = _activeSession ? _authHeader(_activeSession) : {};
    const res = await fetch(`/api/lobby/poll?roomCode=${encodeURIComponent(_pollRoomCode)}`, { headers });
    if (res.status === 404) {
      // Room expired or doesn't exist.
      _stopPolling();
      const msg = "Room not found or expired. Create a new one.";
      _showLobbyError(msg);
      _setLobbyLoading(false);
      document.getElementById("lobby-options")?.classList.remove("hidden");
      document.getElementById("lobby-waiting")?.classList.add("hidden");
      document.getElementById("lobby-joined")?.classList.add("hidden");
      // The modal is already closed once both players reached fighter
      // select, so the message above would be invisible there - let main.js
      // show it on the select screen too.
      _onLobbyError?.(msg);
      return;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const lobbyState = await res.json();

    // "ready" (both wallets registered) is terminal for polling: launch.
    if (lobbyState.status === "ready") {
      _stopPolling();
      _onMatchReady?.({
        roomCode: _pollRoomCode,
        side: _pollSide,
        lobbyState,
      });
      return;
    }
    // "connected" (both players present, pre-wallet) transitions out of the
    // join modal into fighter select - announced ONCE, and polling keeps
    // going. It used to stop here too, which meant whoever clicked READY
    // first restarted polling, saw "connected" again, stopped for good, and
    // never learned the room became "ready" when the other player readied.
    if (lobbyState.status === "connected" && !_connectedNotified) {
      _connectedNotified = true;
      _onMatchReady?.({
        roomCode: _pollRoomCode,
        side: _pollSide,
        lobbyState,
      });
    }

    // Update waiting text if we're the host.
    const statusEl = document.getElementById("lobby-wait-status");
    if (statusEl && _pollSide === "p1") {
      statusEl.textContent = lobbyState.p2
        ? "Opponent connected - waiting for fighter pick..."
        : "Waiting for opponent...";
    }
  } catch (err) {
    console.warn("[lobby] poll error", err);
    // Non-fatal - keep retrying.
  }

  // Schedule next poll only if still active.
  if (_pollRoomCode) {
    _pollTimer = setTimeout(_poll, POLL_INTERVAL_MS);
  }
}

// ===== Community bar =====

export async function initCommunityBar() {
  const wrap = document.getElementById("community-bar-wrap");
  if (!wrap) return;

  try {
    const res = await fetch("/api/bar");
    if (!res.ok) {
      if (res.status === 404) { _renderBar(0, []); return; }
      throw new Error(`status ${res.status}`);
    }
    const { total, milestones } = await res.json();
    _renderBar(total ?? 0, milestones ?? []);
  } catch (err) {
    console.warn("[community-bar] fetch failed", err);
    _renderBar(0, []);
  }
}

function _renderBar(total, milestones) {
  const countEl = document.getElementById("community-bar-count");
  const fillEl = document.getElementById("community-bar-fill");
  const milestonesEl = document.getElementById("community-bar-milestones");
  const milestoneLabelEl = document.getElementById("community-bar-milestone-label");

  if (!countEl || !fillEl || !milestonesEl) return;

  // Find the next milestone to fill toward (first unreached), or last if all reached.
  const nextMilestone = milestones.find((m) => !m.reached) ?? milestones[milestones.length - 1];
  const target = nextMilestone?.threshold ?? 100;
  const pct = target > 0 ? Math.min(100, (total / target) * 100) : 100;

  countEl.textContent = `${total.toLocaleString()} MINTED`;

  if (nextMilestone && milestoneLabelEl) {
    milestoneLabelEl.textContent = nextMilestone.reached
      ? `${nextMilestone.label} - UNLOCKED`
      : `Next: ${nextMilestone.label} at ${nextMilestone.threshold.toLocaleString()}`;
  }

  fillEl.style.width = `${pct}%`;
  fillEl.classList.toggle("bar-full", pct >= 100);

  // Render milestone markers on the track.
  milestonesEl.innerHTML = "";
  if (milestones.length) {
    const maxThreshold = milestones[milestones.length - 1]?.threshold ?? 1;
    milestones.forEach((m) => {
      const marker = document.createElement("div");
      marker.className = `community-bar-marker${m.reached ? " reached" : ""}`;
      marker.style.left = `${Math.min(100, (m.threshold / maxThreshold) * 100)}%`;
      marker.title = `${m.label}: ${m.threshold.toLocaleString()}`;
      milestonesEl.appendChild(marker);
    });
  }
}
