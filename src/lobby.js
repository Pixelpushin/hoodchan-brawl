// Remote PVP lobby + Community bar frontend module.
//
// Lobby flow:
//   Host: CREATE ROOM -> POST /api/lobby/create -> get roomCode -> show code
//         -> poll GET /api/lobby/poll?roomCode=... every 2s until status=ready
//   Guest: paste roomCode -> POST /api/lobby/join -> poll same endpoint
//   Both:  onMatchReady fires -> main.js tears down modal, enters select screen
//   On match end: lobbyComplete -> POST /api/lobby/complete
//
// Community bar:
//   initCommunityBar fetches GET /api/bar once, renders progress + milestones.
//   Handles 404/network errors gracefully (shows 0, doesn't throw).

const POLL_INTERVAL_MS = 2000;

let _onMatchReady = null; // set by initLobby({ onMatchReady })
let _pollTimer = null;
let _pollRoomCode = null;
let _pollSide = null;     // 'p1' | 'p2'

// ===== Lobby init (called once from main.js) =====

export function initLobby({ onMatchReady } = {}) {
  _onMatchReady = onMatchReady ?? null;

  const remotePvpBtn = document.getElementById("remote-pvp-btn");
  const lobbyModal = document.getElementById("lobby-modal");
  const lobbyCloseBtn = document.getElementById("lobby-close-btn");
  const lobbyCreateBtn = document.getElementById("lobby-create-btn");
  const lobbyJoinBtn = document.getElementById("lobby-join-btn");
  const lobbyCodeInput = document.getElementById("lobby-code-input");

  if (!remotePvpBtn || !lobbyModal) return;

  // Auto-join if URL contains ?room=XXXXXX — guest just clicked a share link.
  const urlRoom = new URLSearchParams(window.location.search).get("room");
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
      const res = await fetch("/api/lobby/create", { method: "POST" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const { roomCode } = await res.json();
      _showLobbyWaiting(roomCode);
      _startPolling(roomCode, "p1");
    } catch (err) {
      console.error("[lobby] create failed", err);
      _showLobbyError("Couldn't create room. Try again.");
      _setLobbyLoading(false);
    }
  });

  lobbyJoinBtn?.addEventListener("click", async () => {
    const code = (lobbyCodeInput?.value ?? "").trim().toUpperCase();
    if (!code) { lobbyCodeInput?.focus(); return; }
    _setLobbyLoading(true);
    try {
      const res = await fetch("/api/lobby/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomCode: code }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `status ${res.status}`);
      }
      _showLobbyJoined();
      _startPolling(code, "p2");
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

// Called from main.js readyBtn click when _pvpMode is active.
export async function lobbyRegisterFighter({ side, tokenId, walletAddress }) {
  const res = await fetch("/api/lobby/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomCode: _pollRoomCode, side, tokenId, wallet: walletAddress }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `status ${res.status}`);
  }
  // Continue or start polling for ready state after fighter registration.
  if (_pollRoomCode) _startPolling(_pollRoomCode, _pollSide ?? side);
}

// Called from main.js when match ends.
export function lobbyComplete({ roomCode, winnerId, loserId, p1Score, p2Score, roundsPlayed }) {
  // Fire and forget - match is over, we just clean up server state.
  fetch("/api/lobby/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomCode, winnerId, loserId, p1Score, p2Score, roundsPlayed }),
  }).catch((err) => console.warn("[lobby] complete call failed", err));
  _stopPolling();
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
  const shareUrl = `${location.origin}${location.pathname}?room=${roomCode}`;
  history.pushState({}, "", `?room=${roomCode}`);

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
    const res = await fetch("/api/lobby/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `status ${res.status}`);
    }
    _showLobbyJoined();
    _startPolling(roomCode, "p2");
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
    const res = await fetch(`/api/lobby/poll?roomCode=${encodeURIComponent(_pollRoomCode)}`);
    if (res.status === 404) {
      // Room expired or doesn't exist.
      _stopPolling();
      _showLobbyError("Room not found or expired. Create a new one.");
      _setLobbyLoading(false);
      document.getElementById("lobby-options")?.classList.remove("hidden");
      document.getElementById("lobby-waiting")?.classList.add("hidden");
      document.getElementById("lobby-joined")?.classList.add("hidden");
      return;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const lobbyState = await res.json();

    if (lobbyState.status === "ready") {
      _stopPolling();
      _onMatchReady?.({
        roomCode: _pollRoomCode,
        side: _pollSide,
        lobbyState,
      });
      return;
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
