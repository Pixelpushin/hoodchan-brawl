import { activeAdapter } from "./adapters/index.js";
import { Fighter, ARCHETYPES, RARE_TRAIT_HEALTH_BONUS, CANVAS_WIDTH, CANVAS_HEIGHT } from "./fighter.js";
import { createGame } from "./game.js";
import { initSound, playSound, playRandomTrack, stopMusic, getAudioCtx } from "./sound.js";
import { initLobby, initCommunityBar, lobbyComplete, closeLobby, lobbyRegisterFighter } from "./lobby.js";
import { showMintCelebration } from "./mint-celebration.js";
import { pickRandomArena, drawArena, drawFighter, drawFlash } from "./body.js";
import { speakTaunt } from "./tts.js";
import { connectWallet, hasInjectedWallet, getConnectedAccount, disconnectWallet } from "./wallet.js";
import { initBloodCode } from "./blood-code.js";
import { fetchFighterStats } from "./api.js";
import { initGamepadDebugOverlay } from "./gamepad.js";
import { initGamepadNav } from "./gamepad-nav.js";
import { renderKOShareCard, shareKOImage, castKOImage } from "./share-card.js";

initGamepadDebugOverlay();
initGamepadNav();

initBloodCode();

// Community bar — unique wallet pairs that have fought on-chain.
initCommunityBar();

// PVP lobby state (shared across setup/select/match flow).
let _pvpMode = false;
let _pvpRoomCode = null;
let _pvpSide = null;
// Wallet token IDs stored here so setup screen stays visible after connect
// (REMOTE PVP button needs to remain accessible).
let _walletTokenIds = null;

initLobby({
  async onMatchReady({ roomCode, side, lobbyState }) {
    _pvpMode = true;
    _pvpRoomCode = roomCode;
    _pvpSide = side;
    closeLobby();
    await enterSelectScreen(_walletTokenIds);
    if (lobbyState?.status === "ready") maybeLaunchPvpMatch();
  },
});

// Backing-store pixel density multiplier - see fighter.js's CANVAS_WIDTH/
// HEIGHT comment for why this exists (CSS's `image-rendering: pixelated`,
// needed for the body sprites' own low-res look, was also crushing
// adapter-supplied head art into blocky pixels at the same upscale step).
// 2x was enough to fix that visibly without a real performance cost - not
// tied to devicePixelRatio, this is about giving the canvas enough native
// pixels to survive a `pixelated` CSS upscale, not about retina sharpness.
const RENDER_SCALE = 2;

// Every canvas in this game (the arena + both character-select portraits)
// needs this same setup - real backing-store size scaled up, logical
// drawing space (CANVAS_WIDTH/HEIGHT) unchanged via ctx.scale, so nothing
// in body.js/game.js/fighter.js has to know or care this happened. Must set
// canvas.width/height BEFORE getContext - either resets the transform.
function setupCanvas(canvas) {
  canvas.width = CANVAS_WIDTH * RENDER_SCALE;
  canvas.height = CANVAS_HEIGHT * RENDER_SCALE;
  const ctx = canvas.getContext("2d");
  ctx.scale(RENDER_SCALE, RENDER_SCALE);
  return ctx;
}

// Reskins the static HTML for whichever collection src/adapters/index.js
// currently points at - title, hero copy, and the OpenSea/marketplace links
// all come from the adapter's config instead of being hardcoded, so
// swapping the active adapter reskins the page without touching index.html.
function applyCollectionBranding() {
  const { config } = activeAdapter;
  document.title = config.siteTitle;
  const h1 = document.querySelector("h1");
  if (h1) h1.lastChild.textContent = config.siteTitle.toUpperCase();
  const walletDesc = document.getElementById("wallet-play-desc");
  if (walletDesc) walletDesc.textContent = config.walletPlayDesc;
  for (const el of [openseaBtnEl(), document.getElementById("footer-collection-link")]) {
    if (!el) continue;
    if (config.collectionUrl) {
      el.href = config.collectionUrl;
    } else {
      el.classList.add("hidden");
    }
  }
  const openseaBtn = openseaBtnEl();
  if (openseaBtn) openseaBtn.textContent = config.collectionCta;
}
function openseaBtnEl() {
  return document.getElementById("opensea-btn");
}

// Space's default browser behavior is "scroll the page down" - game.js only
// guards against that once an actual match is running (its own keydown
// listener isn't attached until createGame() starts), which left a gap on
// the setup screen and during the pre-fight countdown/taunt window where
// jump's key still scrolled the page. Global and always-on instead, so
// there's no gap regardless of which screen is showing - except while an
// actual text/number input is focused, where space should behave normally.
window.addEventListener("keydown", (e) => {
  if (e.key !== " ") return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  e.preventDefault();
});

const startBtn = document.getElementById("start-btn");
const connectWalletBtn = document.getElementById("connect-wallet-btn");
const walletStatus = document.getElementById("wallet-status");
const openseaBtn = document.getElementById("opensea-btn");
const freePlayBtn = document.getElementById("free-play-btn");
const hypeEl = document.getElementById("hype");
const practiceToggle = document.getElementById("practice-toggle");
const readyBtn = document.getElementById("ready-btn");
const exitMatchBtn = document.getElementById("exit-match-btn");
const walletChip = document.getElementById("wallet-chip");
const walletChipAddress = document.getElementById("wallet-chip-address");
const disconnectBtn = document.getElementById("disconnect-btn");

function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Persists across the setup/select-screen/arena transition (fixed
// position, lives outside all three) since it's the only place a connected
// visitor can find Disconnect at all - proceedWithWallet moves on to the
// select screen almost immediately, so this can't just live on the setup
// screen and disappear with it.
function showWalletChip(address) {
  walletChipAddress.textContent = shortAddress(address);
  walletChip.classList.remove("hidden");
}

disconnectBtn.addEventListener("click", async () => {
  disconnectBtn.disabled = true;
  await disconnectWallet();
  // Simplest full reset back to the setup screen's initial state - same
  // "give up on hand-resetting every bit of state" call runMatch/
  // exitMatchBtn already make elsewhere in this file.
  location.reload();
});

// The social footer/build-verify line only make sense on the initial menu -
// once a visitor has actually moved into the select screen or a match,
// hiding them is what makes #arena/#select-screen genuinely full-screen
// instead of leaving something scrollable-into below them.
function hideLandingFooter() {
  document.getElementById("site-footer")?.classList.add("hidden");
  document.getElementById("integrity-check")?.classList.add("hidden");
}

const canvasStage = document.getElementById("canvas-stage");
const canvasWrap = document.getElementById("canvas-wrap");

// Same measure-and-fit approach the character-select screen's portraits
// use (fitSelectScreen) - sizes #canvas-wrap to the exact largest
// 800x360-ratio box that fits #canvas-stage, so the canvas (width/height
// 100% of that wrapper) always fills the screen without ever being cropped
// or leaving the HUD/taunt/countdown overlays (positioned against this
// same wrapper) misaligned with the canvas's actual visible pixels.
function fitArenaCanvas() {
  if (document.getElementById("arena").classList.contains("hidden")) return;
  const availW = canvasStage.clientWidth;
  const availH = canvasStage.clientHeight;
  const scale = Math.min(availW / CANVAS_WIDTH, availH / CANVAS_HEIGHT);
  canvasWrap.style.width = `${Math.floor(CANVAS_WIDTH * scale)}px`;
  canvasWrap.style.height = `${Math.floor(CANVAS_HEIGHT * scale)}px`;
}
window.addEventListener("resize", fitArenaCanvas);

const controlsInfoBtn = document.getElementById("controls-info-btn");
const controlsPanel = document.getElementById("controls-panel");
controlsInfoBtn.addEventListener("click", () => {
  controlsPanel.classList.toggle("open");
});
// Clicking anywhere outside the open panel (including the info button
// itself, which the toggle above already handles) closes it - a slide-out
// panel that only closes by re-hitting a tiny corner button is easy to get
// stuck open by accident mid-match.
document.addEventListener("click", (e) => {
  if (!controlsPanel.classList.contains("open")) return;
  if (controlsPanel.contains(e.target) || e.target === controlsInfoBtn) return;
  controlsPanel.classList.remove("open");
});

// Reload is the same "give up on trying to hand-reset every bit of setup
// state" call as the normal Back to Menu button (see runMatch/
// showMatchOverActions) - a universal bail-out for any match in progress
// (not just practice, which otherwise has no other way out at all since it
// never ends on its own - see createGame's practiceMode), so a visitor
// isn't stuck closing the tab to quit early.
exitMatchBtn.addEventListener("click", () => {
  stopMusic();
  location.reload();
});

// ===== Leaderboard panel (setup screen only) =====
//
// Reads GET /api/leaderboard, which is keyed per-adapter server-side (see
// api/leaderboard.js) - always passes activeAdapter.config.key rather than
// letting it fall back to the endpoint's own legacy default, so swapping
// src/adapters/index.js's active adapter also swaps which collection's
// board this shows, same as every other adapter-scoped fetch in this file.
const leaderboardBtn = document.getElementById("leaderboard-btn");
const leaderboardPanel = document.getElementById("leaderboard-panel");
const leaderboardCloseBtn = document.getElementById("leaderboard-close-btn");
const leaderboardList = document.getElementById("leaderboard-list");

async function loadLeaderboard() {
  leaderboardList.innerHTML = `<li class="leaderboard-loading"><div class="spinner"></div></li>`;
  try {
    const res = await fetch(`/api/leaderboard?limit=10&adapter=${encodeURIComponent(activeAdapter.config.key)}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { fighters } = await res.json();
    if (!fighters?.length) {
      leaderboardList.innerHTML = `<li class="leaderboard-empty">No wins recorded yet - be the first.</li>`;
      return;
    }
    leaderboardList.innerHTML = "";
    fighters.forEach((fighter, i) => {
      const row = document.createElement("li");
      row.className = "leaderboard-row";
      row.innerHTML = `
        <span class="leaderboard-rank">#${i + 1}</span>
        <span class="leaderboard-name">#${fighter.tokenId}</span>
        <span class="leaderboard-wins">${fighter.wins}W</span>
      `;
      leaderboardList.appendChild(row);
      // Best-effort name upgrade over the tokenId fallback already showing -
      // fetchTokenPreview is the same cheap per-card call the select-screen
      // grid already makes, just one-off here instead of paginated. A
      // failure leaves the #tokenId label in place rather than blocking the
      // rest of the row.
      activeAdapter.fetchTokenPreview(fighter.tokenId)
        .then((preview) => {
          if (preview?.name) row.querySelector(".leaderboard-name").textContent = preview.name;
        })
        .catch(() => {});
    });
  } catch {
    leaderboardList.innerHTML = `<li class="leaderboard-empty">Couldn't load the leaderboard right now.</li>`;
  }
}

leaderboardBtn.addEventListener("click", () => {
  playSound("uiclick");
  leaderboardPanel.classList.remove("hidden");
  loadLeaderboard();
});
leaderboardCloseBtn.addEventListener("click", () => leaderboardPanel.classList.add("hidden"));
// Same click-outside-to-close convention as #controls-panel above.
document.addEventListener("click", (e) => {
  if (leaderboardPanel.classList.contains("hidden")) return;
  if (leaderboardPanel.contains(e.target) || e.target === leaderboardBtn) return;
  leaderboardPanel.classList.add("hidden");
});

applyCollectionBranding();

// Rotated randomly per visit so the same line doesn't go stale. Both play
// options read clearly on their own now (see index.html's #play-options),
// so this no longer needs to be split by mode - one clear line setting up
// the card(s) below is enough either way. Lines themselves come from the
// active adapter's config, not hardcoded here.
function setHype() {
  if (!hypeEl) return;
  const lines = activeAdapter.config.hypeLines;
  hypeEl.textContent = lines[Math.floor(Math.random() * lines.length)];
}
setHype();

// Hide the wallet connect area if no wallet extension is present.
function hideWalletOption() {
  document.getElementById("wallet-area")?.classList.add("hidden");
}

// No config.chain at all means the active adapter has nothing to check
// wallet ownership against yet (see the template adapter) - wallet-connect
// isn't just empty in that case, it's not a real option, so skip straight
// past the "does this visitor have a wallet extension" check entirely.
if (!activeAdapter.config.chain) {
  hideWalletOption();
} else if (hasInjectedWallet()) {
  tryResumeWalletSession();
} else {
  // Some wallet extensions inject window.ethereum asynchronously, slightly
  // after this script runs - a single synchronous check at load time can
  // race and wrongly decide "no wallet" for someone who actually has one.
  // Give it a brief grace window via the event most wallets fire, with a
  // timeout fallback so a visitor with no wallet at all isn't left staring
  // at an option that never resolves either way.
  let decided = false;
  const onInit = () => {
    if (decided) return;
    decided = true;
    if (hasInjectedWallet()) {
      tryResumeWalletSession();
    } else {
      hideWalletOption();
    }
  };
  window.addEventListener("ethereum#initialized", onInit, { once: true });
  setTimeout(onInit, 300);
}

// ===== Character select screen =====
//
// MK-style: two independent panels (P1 left, P2 right), each its own pool
// of token IDs to page through, each with its own big animated portrait.
// P1's pool is the connected wallet's real tokens (paginated - see the
// active adapter's fetchWalletTokenIds) if one's connected, otherwise a
// random sample same as P2 always is (P2 is always AI for now - there's no
// second wallet to pull from). Deliberately built as two symmetric,
// independent panels rather than one shared grid both sides pick from in
// turn - that's not a stylistic choice, it's the shape the future shared-
// lobby system needs (P2's pool source becomes "the other real connected
// player" instead of a random sample; nothing else about this screen has
// to change).

const PANEL_PAGE_SIZE = 12;
const RANDOM_POOL_SIZE = 48;
const ARENA_BG_IMAGES = ["assets/backgrounds/arena-2.png", "assets/backgrounds/arena-3.png"];

const selectScreen = document.getElementById("select-screen");
const selectContent = document.getElementById("select-content");
const p1Grid = document.getElementById("p1-grid");
const p2Grid = document.getElementById("p2-grid");
const p1Pagination = document.getElementById("p1-pagination");
const p2Pagination = document.getElementById("p2-pagination");
const p1Label = document.getElementById("p1-select-label");
const p2Label = document.getElementById("p2-select-label");

// #select-content is sized naturally (comfortably roomy), then measured
// against the real screen and scaled down if it doesn't actually fit - a
// vh-only budget can't account for variable content height (e.g. a long
// trait name wrapping a fighter-label to two lines), and overflow:hidden
// alone just silently clips instead of shrinking. Measuring the real
// rendered size and scaling the whole block is the only way to guarantee
// nothing (a portrait, a panel, pagination controls) is ever cut off, no
// matter the screen size.
function fitSelectScreen() {
  if (selectScreen.classList.contains("hidden")) return;
  selectContent.style.transform = "none";
  const naturalW = selectContent.scrollWidth;
  const naturalH = selectContent.scrollHeight;
  const availW = selectScreen.clientWidth;
  const availH = selectScreen.clientHeight;
  const scale = Math.min(1, availW / naturalW, availH / naturalH);
  selectContent.style.transform = scale < 1 ? `scale(${scale})` : "none";
}
window.addEventListener("resize", fitSelectScreen);
// Belt-and-suspenders over the explicit fitSelectScreen() calls below: this
// catches ANY change to the content's natural (pre-transform) size - a
// webfont finishing loading after first paint, a label wrapping
// differently, anything - not just the specific moments (screen open, pick
// a fighter) already covered. transform doesn't affect layout box size, so
// this never re-fires from fitSelectScreen's own scale write.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => fitSelectScreen()).observe(selectContent);
}

const panelState = {
  p1: { pool: [], page: 0, selectedId: null, selectedData: null },
  p2: { pool: [], page: 0, selectedId: null, selectedData: null },
};

// Emoji + flavor text per archetype - the numbers (damage/speed/health/
// block multipliers) come straight from fighter.js's own ARCHETYPES so this
// can't drift out of sync with what actually happens in a fight.
const ARCHETYPE_INFO = {
  Builder: { emoji: "🔨", perk: "Hits harder", special: "Special: a big flying high kick" },
  Flipper: { emoji: "⚡", perk: "Moves faster", special: "Special: Hood Rat Rush - a rat swarm along the ground" },
  Hodler: { emoji: "💎", perk: "More health", special: "Special: a low sweep kick that blocks hits and stops slides cold" },
  Collector: { emoji: "🛡️", perk: "Blocks better", special: "Special: the long-range bolt" },
};

function archetypeTooltip(type, rareTraitCount) {
  const info = ARCHETYPE_INFO[type];
  if (!info) return "";
  const mult = ARCHETYPES[type];
  const lines = [`${type} - ${info.perk}`];
  if (mult) {
    if (mult.damageMult !== 1) lines.push(`+${Math.round((mult.damageMult - 1) * 100)}% damage`);
    if (mult.speedMult !== 1) lines.push(`+${Math.round((mult.speedMult - 1) * 100)}% move speed`);
    if (mult.healthMult !== 1) lines.push(`+${Math.round((mult.healthMult - 1) * 100)}% health`);
    if (mult.blockMult !== 1) lines.push(`${Math.round((1 - mult.blockMult) * 100)}% less chip damage blocking`);
  }
  lines.push(info.special);
  if (rareTraitCount > 0) {
    lines.push(`+${Math.round(rareTraitCount * RARE_TRAIT_HEALTH_BONUS * 100)}% health (${rareTraitCount} rare trait${rareTraitCount === 1 ? "" : "s"})`);
  }
  return lines.join("\n");
}

// One shared tooltip node, appended straight to <body> - NOT nested inside
// a card. position: fixed is supposed to escape all ancestor clipping, but
// .character-card:hover applies its own transform: scale(), and CSS hover
// state bubbles to ancestors, so while a badge is hovered its parent card
// is ALSO :hover and gets transformed - which per spec makes that card the
// containing block for any position:fixed descendant instead of the
// viewport, trapping the tooltip right back inside the grid's own overflow
// clip. Living outside every card (and being reused rather than one per
// card) sidesteps that entirely.
let sharedTooltip = null;
function getSharedTooltip() {
  if (sharedTooltip) return sharedTooltip;
  sharedTooltip = document.createElement("div");
  sharedTooltip.id = "badge-tooltip";
  document.body.appendChild(sharedTooltip);
  return sharedTooltip;
}

function attachBadgeTooltip(badge, text) {
  if (!badge) return;
  badge.addEventListener("mouseenter", () => {
    const tooltip = getSharedTooltip();
    tooltip.textContent = text;
    tooltip.classList.add("visible");
    const badgeRect = badge.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(
      badgeRect.left + badgeRect.width / 2 - tipRect.width / 2,
      window.innerWidth - tipRect.width - 8,
    ));
    const above = badgeRect.top - tipRect.height - 8;
    const top = above < 8 ? badgeRect.bottom + 8 : above;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  });
  badge.addEventListener("mouseleave", () => {
    getSharedTooltip().classList.remove("visible");
  });
}

// Drives one portrait canvas's idle-loop animation. Reuses the exact same
// drawFighter the real match/pre-fight screens use (same sprite sheets, no
// new art needed) rather than blowing up the flat NFT head art - `visual`
// is a plain object matching just the fields drawFighter actually reads
// (state/stateT/x/facing/headImg/jumpOffset), not a real Fighter, since
// this never needs to take input or deal damage. Manually increments
// stateT itself each frame - unlike a real match, nothing else is driving
// this object's clock.
function createPortraitRenderer(canvasId, playerNum, facing) {
  const canvas = document.getElementById(canvasId);
  const ctx = setupCanvas(canvas);
  let visual = null;
  let raf = null;

  function loop() {
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (visual) {
      visual.stateT++;
      drawFighter(ctx, visual, playerNum);
    }
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return {
    setHead(imageUrl) {
      // drawFighter checks headImg.complete before drawing it - a real
      // Fighter builds this same Image-from-data-URL itself (see fighter.js
      // constructor), but this visual is a plain object standing in for one,
      // so it needs to do that conversion itself. Passing the raw data-URL
      // string straight through (what this did before) meant
      // `headImg.complete` was always undefined - the head silently never
      // drew, body only.
      const headImg = new Image();
      headImg.crossOrigin = "anonymous";
      headImg.src = imageUrl;
      visual = { x: 347, facing, state: "idle", stateT: 0, headImg, jumpOffset: 0 };
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
    },
  };
}

const portraits = {
  p1: createPortraitRenderer("p1-portrait", 1, 1),
  p2: createPortraitRenderer("p2-portrait", 2, -1),
};

function updateReadyState() {
  readyBtn.disabled = !(panelState.p1.selectedData && panelState.p2.selectedData);
}

async function selectFighter(side, tokenId, preview) {
  const grid = side === "p1" ? p1Grid : p2Grid;
  for (const card of grid.querySelectorAll(".character-card")) {
    card.classList.toggle("selected", Number(card.dataset.tokenId) === tokenId);
  }
  panelState[side].selectedId = tokenId;
  const label = side === "p1" ? p1Label : p2Label;
  const baseLabel = `${preview.name ?? `#${tokenId}`} - ${preview.archetypeKey ?? "Builder"}`;
  label.textContent = baseLabel;
  fitSelectScreen();

  // Fire-and-forget alongside fetchFighterData below rather than chained
  // after it - stats and fighter art are independent, no reason to make one
  // wait on the other. Guarded on selectedId still matching tokenId in case
  // the user picks a different card before this resolves.
  fetchFighterStats(tokenId).then((stats) => {
    // Only apply if nothing else has touched the label since - a newer
    // selection (selectedId check) or the fetchFighterData failure below
    // (textContent check, since that overwrites baseLabel with an error).
    if (!stats || panelState[side].selectedId !== tokenId || label.textContent !== baseLabel) return;
    label.textContent = `${baseLabel} · ${stats.wins}W-${stats.losses}L`;
    fitSelectScreen();
  });

  try {
    const data = await activeAdapter.fetchFighterData(tokenId);
    // Stamp ownerAddress + verified so the post-match mint path knows who
    // owns this fighter. verifyOwnership is a lightweight on-chain read;
    // fire-and-forget is fine — if it fails, verified stays false and no
    // mint is attempted (safe default).
    const connectedAddr = await getConnectedAccount().catch(() => null);
    data.ownerAddress = connectedAddr ?? null;
    data.verified = false;
    if (connectedAddr && activeAdapter.verifyOwnership) {
      activeAdapter.verifyOwnership(tokenId, connectedAddr)
        .then((ok) => { if (ok) data.verified = true; })
        .catch(() => {});
    }
    panelState[side].selectedData = data;
    portraits[side].setHead(data.imageUrl);
    updateReadyState();
  } catch {
    label.textContent = `Couldn't load that ${activeAdapter.config.unitName} - try another.`;
    fitSelectScreen();
  }
}

async function renderPanel(side) {
  const state = panelState[side];
  const grid = side === "p1" ? p1Grid : p2Grid;
  const pageIds = state.pool.slice(state.page * PANEL_PAGE_SIZE, (state.page + 1) * PANEL_PAGE_SIZE);

  grid.innerHTML = `<div class="grid-loading"><div class="spinner"></div></div>`;

  const previews = await Promise.all(
    pageIds.map(async (id) => {
      try {
        return await activeAdapter.fetchTokenPreview(id);
      } catch {
        return null;
      }
    }),
  );

  grid.innerHTML = "";
  previews.forEach((preview, i) => {
    if (!preview) return;
    const id = pageIds[i];
    const type = preview.archetypeKey ?? "Builder";
    const info = ARCHETYPE_INFO[type];
    const card = document.createElement("div");
    card.className = "character-card";
    card.dataset.tokenId = id;
    // tabindex makes these natively focusable (they're <div>s, not
    // <button>s) - required for both real Tab-key keyboard nav and the
    // gamepad menu-nav system (src/gamepad-nav.js), which moves
    // document.activeElement around and calls .click() on whatever's
    // focused rather than needing its own per-element-type activation
    // logic.
    card.tabIndex = 0;
    if (state.selectedId === id) card.classList.add("selected");
    card.innerHTML = `
      <img src="${preview.previewImageUrl ?? ""}" alt="${type}" />
      <div class="card-label">${type}</div>
      ${info ? `<div class="card-badge">${info.emoji}</div>` : ""}
    `;
    card.addEventListener("click", () => selectFighter(side, id, preview));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        card.click();
      }
    });
    if (info) attachBadgeTooltip(card.querySelector(".card-badge"), archetypeTooltip(type, preview.rareTraitCount ?? 0));
    grid.appendChild(card);
  });

  renderPagination(side);
}

function renderPagination(side) {
  const state = panelState[side];
  const el = side === "p1" ? p1Pagination : p2Pagination;
  const totalPages = Math.max(1, Math.ceil(state.pool.length / PANEL_PAGE_SIZE));
  el.innerHTML = "";

  const prevBtn = document.createElement("button");
  prevBtn.textContent = "‹ PREV";
  prevBtn.disabled = state.page <= 0;
  prevBtn.addEventListener("click", () => {
    state.page--;
    renderPanel(side);
  });

  const pageLabel = document.createElement("span");
  pageLabel.textContent = `PAGE ${state.page + 1} / ${totalPages}`;

  const nextBtn = document.createElement("button");
  nextBtn.textContent = "NEXT ›";
  nextBtn.disabled = state.page >= totalPages - 1;
  nextBtn.addEventListener("click", () => {
    state.page++;
    renderPanel(side);
  });

  el.append(prevBtn, pageLabel, nextBtn);
}

// walletTokenIds is null for free play (both sides get a random sample) or
// the connected wallet's real Hoodies for P1 (P2 is still always a random
// sample - see the top-of-section comment on why this stays two symmetric
// pools instead of one shared list).
async function enterSelectScreen(walletTokenIds) {
  document.getElementById("setup").classList.add("hidden");
  document.querySelector("h1").classList.add("hidden");
  hideLandingFooter();
  selectScreen.classList.remove("hidden");
  selectScreen.style.setProperty(
    "--select-bg-image",
    `url(${ARENA_BG_IMAGES[Math.floor(Math.random() * ARENA_BG_IMAGES.length)]})`,
  );

  panelState.p1 = { pool: walletTokenIds?.length ? walletTokenIds : activeAdapter.getFreePlayTokenIds(RANDOM_POOL_SIZE), page: 0, selectedId: null, selectedData: null };
  panelState.p2 = { pool: activeAdapter.getFreePlayTokenIds(RANDOM_POOL_SIZE), page: 0, selectedId: null, selectedData: null };
  p1Label.textContent = "CHOOSE YOUR FIGHTER";
  p2Label.textContent = "CHOOSE YOUR OPPONENT";
  updateReadyState();
  await Promise.all([renderPanel("p1"), renderPanel("p2")]);
  // Never open on two blank portraits - auto-pick the top-left fighter in
  // each pool so both sides show something immediately, same as if the
  // visitor had just clicked the first card themselves.
  p1Grid.querySelector(".character-card")?.click();
  p2Grid.querySelector(".character-card")?.click();
  fitSelectScreen();
}

readyBtn.addEventListener("click", async () => {
  readyBtn.disabled = true;
  // Must be kicked off from this click handler - browsers block audio until
  // a real user gesture, and this is the closest one we get.
  await initSound();
  playSound("uiclick");

  if (_pvpMode && _pvpRoomCode) {
    // Remote PVP: register this device's fighter with the lobby, then poll
    // until the opponent also registers. Poll fires onMatchReady with
    // status:'ready' which calls maybeLaunchPvpMatch.
    const data1 = panelState.p1.selectedData;
    if (!data1) { readyBtn.disabled = false; return; }
    const address = await getConnectedAccount().catch(() => null);
    if (!address) { readyBtn.disabled = false; return; }
    try {
      await lobbyRegisterFighter({ side: _pvpSide ?? "p1", tokenId: data1.tokenId, walletAddress: address });
      // Poll result handled by lobby.js onMatchReady → maybeLaunchPvpMatch
    } catch (err) {
      console.error("[pvp] register fighter failed", err);
      readyBtn.disabled = false;
    }
    return;
  }

  const data1 = panelState.p1.selectedData;
  const data2 = panelState.p2.selectedData;
  await startMatch(data1, data2, { p2AI: true, practiceMode: practiceToggle.checked });
});

// Fires when lobby confirms both sides ready. If fighters are already
// selected on this device, starts immediately. Otherwise the user still
// needs to pick + click START BATTLE.
async function maybeLaunchPvpMatch() {
  const data1 = panelState.p1.selectedData;
  const data2 = panelState.p2.selectedData;
  if (!data1 || !data2) return;
  await startMatch(data1, data2, { p2AI: false, practiceMode: false });
}

async function startMatch(data1, data2, opts) {
  selectScreen.classList.add("hidden");
  document.getElementById("arena").classList.remove("hidden");
  fitArenaCanvas();
  document.getElementById("p1-name").textContent = `${data1.name} (${data1.archetypeKey})`;
  document.getElementById("p2-name").textContent = `${data2.name} (${data2.archetypeKey})`;
  document.getElementById("p1-pfp").src = data1.avatarUrl;
  document.getElementById("p2-pfp").src = data2.avatarUrl;
  // Universal for any match, not just practice - a normal AI match had no
  // way to bail early either before this existed, only a post-match Back
  // to Menu button.
  exitMatchBtn.classList.remove("hidden");

  const canvas = document.getElementById("canvas");
  const ctx = setupCanvas(canvas);

  // runMatch resolves once the whole match (not just a round) is decided,
  // with true if the vs-AI-only "Play Again" was clicked - see
  // showMatchOverActions. Anything else (Back, or a PvP match once that
  // exists) falls through to a full reload instead of trying to hand-reset
  // every bit of setup-screen state (wallet connection, select-screen
  // pools) - simpler and can't leave the UI in a half-reset state a real
  // reload wouldn't have.
  let playAgain = true;
  while (playAgain) {
    playRandomTrack();
    playAgain = await runMatch(data1, data2, canvas, ctx, opts);
  }
  stopMusic();
  location.reload();
}

startBtn.addEventListener("click", () => {
  playSound("uiclick");
  enterSelectScreen(_walletTokenIds);
});

// Shared by both the manual "Connect Wallet" click and the silent
// auto-resume path below - the only difference is whether a real user
// gesture backs this call (unlockSound), since initSound()/an audible
// click sound both need one and the resume path doesn't have one to spend.
async function proceedWithWallet(address, { unlockSound }) {
  const { unitName, unitNamePlural } = activeAdapter.config;
  walletStatus.textContent = `Scanning the chain for your ${unitNamePlural}...`;
  showWalletChip(address);
  const soundReady = unlockSound ? initSound() : Promise.resolve();

  try {
    const tokenIds = await activeAdapter.fetchWalletTokenIds(address);
    await soundReady;
    if (unlockSound) playSound("uiclick");

    if (!tokenIds.length) {
      walletStatus.textContent = `No ${unitNamePlural} found — hit FIGHT to play free or grab one below.`;
      openseaBtn.classList.remove("hidden");
      connectWalletBtn.disabled = false;
      return;
    }

    openseaBtn.classList.add("hidden");
    _walletTokenIds = tokenIds;
    connectWalletBtn.textContent = "✓ CONNECTED";
    walletStatus.textContent = `${tokenIds.length} ${tokenIds.length === 1 ? unitName : unitNamePlural} loaded — hit FIGHT to use them.`;
  } catch (err) {
    walletStatus.textContent = err.message;
    connectWalletBtn.disabled = false;
  }
}

connectWalletBtn.addEventListener("click", async () => {
  connectWalletBtn.disabled = true;
  walletStatus.textContent = "Connecting wallet...";
  openseaBtn.classList.add("hidden");
  freePlayBtn.classList.add("hidden");

  try {
    const address = await connectWallet(activeAdapter.config.chain);
    await proceedWithWallet(address, { unlockSound: true });
  } catch (err) {
    walletStatus.textContent = err.message;
    connectWalletBtn.disabled = false;
  }
});

// eth_accounts never prompts - if this site already has permission from an
// earlier visit/click, skip straight to "pick your fighter" instead of
// making a returning visitor click Connect again on every reload/back-
// navigation. unlockSound stays false here (no real gesture backs this
// call, initSound() would just start suspended) - the character-card click
// in renderPanel unlocks it instead, same as startBtn's own click already
// does for local play.
async function tryResumeWalletSession() {
  const address = await getConnectedAccount();
  if (!address) return;
  connectWalletBtn.disabled = true;
  await proceedWithWallet(address, { unlockSound: false });
}

// Drops a wallet-connected-but-no-Hoodie visitor straight into the same
// free select-screen flow local-play's own button already offers -
// duplicated here so the "no Hoodies yet" status message has its own
// obvious next step right below it, instead of pointing back up the page.
freePlayBtn.addEventListener("click", () => {
  playSound("uiclick");
  enterSelectScreen(null);
});

const ROUNDS_TO_WIN = 2;
// A drawn round (timeout tie or double-KO) replays instead of counting -
// best-of-3 needs a decisive result each round to make progress. Repeated
// draws shrink the clock each retry so two evenly-matched players can't
// stall the match forever; sudden-death floor guarantees it resolves.
const DRAW_RETRY_TIME_LIMITS = [45, 30, 15];

async function runMatch(data1, data2, canvas, ctx, { p2AI = false, practiceMode = false } = {}) {
  const wins = { p1: 0, p2: 0 };
  let roundNum = 1;
  let drawStreak = 0;

  while (wins.p1 < ROUNDS_TO_WIN && wins.p2 < ROUNDS_TO_WIN) {
    if (practiceMode) {
      document.getElementById("round-info").textContent = "PRACTICE MODE";
    } else {
      updateRoundInfo(roundNum, wins);
    }

    const p1 = new Fighter(data1, 200, 1);
    const p2 = new Fighter(data2, 600, -1);
    pickRandomArena();
    // Bars would otherwise still show the previous round's ending values
    // (e.g. the loser's empty health bar) through the whole next countdown.
    resetBars();

    const stopPreFightRender = startPreFightRender(ctx, p1, p2);

    // Taunts only play out on the very first round - hearing the same two
    // lines (spoken aloud, no less) every single round gets old fast.
    let tauntsSpoken = Promise.resolve();
    if (roundNum === 1) {
      showTaunt("taunt-p1", data1.taunt);
      showTaunt("taunt-p2", data2.taunt);
      tauntsSpoken = Promise.all([speakTaunt(data1.taunt), speakTaunt(data2.taunt)]);
    }

    await runCountdown(tauntsSpoken);

    stopPreFightRender();
    document.getElementById("taunt-p1").classList.add("hidden");
    document.getElementById("taunt-p2").classList.add("hidden");

    const timeLimit = drawStreak > 0
      ? DRAW_RETRY_TIME_LIMITS[Math.min(drawStreak - 1, DRAW_RETRY_TIME_LIMITS.length - 1)]
      : 60;

    const winner = await new Promise((resolve) => {
      const stopGame = createGame({
        ctx,
        p1,
        p2,
        timeLimit,
        p2AI,
        practiceMode,
        onEnd: (w) => {
          stopGame();
          resolve(w);
        },
      });
    });

    if (winner === p1) {
      wins.p1++;
      drawStreak = 0;
    } else if (winner === p2) {
      wins.p2++;
      drawStreak = 0;
    } else {
      drawStreak++;
    }

    const matchWinner = wins.p1 >= ROUNDS_TO_WIN ? p1 : wins.p2 >= ROUNDS_TO_WIN ? p2 : null;

    // game.js already held the round-result screen up for its own linger
    // window before resolving this promise. For a mid-match round that's
    // all it needs - clear it and move straight into the next round. The
    // match-deciding round instead keeps that same screen up and adds
    // buttons to it (see showMatchOverActions) - previously this just fell
    // through to nothing, leaving the match frozen with no way to leave.
    if (!matchWinner) {
      document.getElementById("result").classList.add("hidden");
      if (winner) roundNum++;
      // A draw replays the same round number rather than advancing it.
      continue;
    }

    const matchLoser = matchWinner === p1 ? p2 : p1;

    const winnerId = matchWinner.data.verified ? matchWinner.data.tokenId : null;
    const loserId = matchLoser.data.verified ? matchLoser.data.tokenId : null;
    // PVP lobby: lobbyComplete records result + cleans up room atomically.
    if (_pvpMode && _pvpRoomCode) {
      lobbyComplete({ roomCode: _pvpRoomCode, winnerId, loserId, p1Score: wins.p1, p2Score: wins.p2, roundsPlayed: roundNum });
      await showMintCelebration({
        winnerName: matchWinner.data.name,
        loserName: matchLoser.data.name,
        wins,
        matchCanvas: canvas,
        audioCtx: getAudioCtx(),
        walletAddress: getConnectedAccount(),
      });
    } else if (winnerId !== null || loserId !== null) {
      // vs-AI: record stats + enqueue soulbound mint for both verified fighters
      if (typeof reportMatchResult === "function") reportMatchResult(winnerId, loserId);
      // Mint only when both fighters are verified NFTs owned by real wallets
      const p1Wallet = p1.data.verified ? p1.data.ownerAddress : null;
      const p2Wallet = p2.data.verified ? p2.data.ownerAddress : null;
      if (p1Wallet && p2Wallet && p1.data.tokenId != null && p2.data.tokenId != null) {
        fetch("/api/ai-match-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wallet1: p1Wallet,
            nft1: p1.data.tokenId,
            wallet2: p2Wallet,
            nft2: p2.data.tokenId,
            winnerId,
            adapter: "hoodchan",
          }),
        }).catch(() => {});
        await showMintCelebration({
          winnerName: matchWinner.data.name,
          loserName: matchLoser.data.name,
          wins,
          matchCanvas: canvas,
          audioCtx: getAudioCtx(),
          walletAddress: getConnectedAccount(),
        });
      }
    }

    return showMatchOverActions(p2AI, matchWinner, matchLoser, matchWinner === p1, canvas, ctx, wins);
  }
}

// Resolves once the player picks a way forward. true only for "Play
// Again", which is only ever offered for a vs-AI match - see the comment
// on startMatch's while loop for why a PvP "Back" doesn't try to hand-reset
// UI state itself.
//
// canvas/ctx here are the same live match canvas startMatch already set up -
// game.js stops drawing once a match ends but never clears the canvas (see
// its own stopGame comment), so by the time this runs it's still showing the
// frozen winner-flex frame, exactly what the share card and flourish flash
// both want to capture/draw over.
function showMatchOverActions(p2AI, matchWinner, matchLoser, isP1Winner, canvas, ctx, wins) {
  return new Promise((resolve) => {
    const actions = document.getElementById("result-actions");
    const againBtn = document.getElementById("result-again");
    const backBtn = document.getElementById("result-back");
    const shareBtn = document.getElementById("result-share");
    const castBtn = document.getElementById("result-cast");
    const verifiedBadge = document.getElementById("result-verified-badge");
    actions.classList.remove("hidden");
    againBtn.classList.toggle("hidden", !p2AI);
    shareBtn.classList.remove("hidden");
    shareBtn.disabled = false;
    shareBtn.textContent = "SHARE YOUR WIN";
    if (castBtn) {
      castBtn.classList.remove("hidden");
      castBtn.disabled = false;
      castBtn.textContent = "CAST";
    }

    // Flips once cleanup() runs (Play Again/Back clicked) - guards the
    // flourish's own async ownership check and the share button's async
    // render/share call, both of which can still be in flight after the
    // result screen has already been dismissed, from touching DOM state
    // (badge, button label) that's moved on to the next round/match.
    let cancelled = false;

    // Cache the rendered canvas and upload result so both buttons (X and Cast)
    // share a single upload instead of POSTing the PNG twice.
    let cachedShareCanvas = null;
    let cachedResult = null; // { shareUrl, farcasterUrl } | { clipboardCopied } | null

    const tweetText = `${matchWinner.data.name} just KO'd ${matchLoser.data.name} 🥊\nfight.hoodchan.org`;
    const shareOptions = {
      title: `${matchWinner.data.name} won in HOODCHAN Brawl`,
      text: `${matchWinner.data.name} just KO'd ${matchLoser.data.name} in HOODCHAN Brawl!`,
      tweetText,
    };

    // Renders and uploads once; subsequent calls return the cached result.
    async function getOrUploadShareCard() {
      if (cachedResult !== null) return cachedResult;
      if (!cachedShareCanvas) {
        cachedShareCanvas = await renderKOShareCard({
          winnerName: matchWinner.data.name,
          loserName: matchLoser.data.name,
          roundScore: wins,
          winnerCanvas: canvas,
        });
      }
      cachedResult = await shareKOImage(cachedShareCanvas, shareOptions);
      return cachedResult;
    }

    async function onShare() {
      shareBtn.disabled = true;
      shareBtn.textContent = "UPLOADING…";
      try {
        const result = await getOrUploadShareCard();
        if (!cancelled && result && result.clipboardCopied) {
          shareBtn.disabled = false;
          shareBtn.textContent = "PASTE IMAGE IN TWEET (Ctrl+V)";
          setTimeout(() => {
            if (!cancelled) shareBtn.textContent = "SHARE YOUR WIN";
          }, 6000);
          return;
        }
      } finally {
        if (!cancelled && shareBtn.textContent === "UPLOADING…") {
          shareBtn.disabled = false;
          shareBtn.textContent = "SHARE YOUR WIN";
        }
      }
    }

    async function onCast() {
      if (!castBtn) return;
      castBtn.disabled = true;
      castBtn.textContent = "UPLOADING…";
      try {
        const result = await getOrUploadShareCard();
        if (cancelled) return;
        if (result && result.farcasterUrl) {
          // Upload succeeded - open pre-built Farcaster intent URL
          window.open(result.farcasterUrl, "_blank", "noopener,noreferrer");
        } else {
          // Fallback: open Farcaster compose with just text (no embed)
          castKOImage(tweetText, null);
        }
      } finally {
        if (!cancelled) {
          castBtn.disabled = false;
          castBtn.textContent = "CAST";
        }
      }
    }

    shareBtn.addEventListener("click", onShare);
    if (castBtn) castBtn.addEventListener("click", onCast);

    maybeShowVictoryFlourish(matchWinner, isP1Winner, ctx, verifiedBadge, () => cancelled);

    function onAgain() {
      cleanup();
      resolve(true);
    }
    function onBack() {
      cleanup();
      resolve(false);
    }
    function cleanup() {
      cancelled = true;
      actions.classList.add("hidden");
      document.getElementById("result").classList.add("hidden");
      againBtn.removeEventListener("click", onAgain);
      backBtn.removeEventListener("click", onBack);
      shareBtn.removeEventListener("click", onShare);
      shareBtn.classList.add("hidden");
      if (castBtn) {
        castBtn.removeEventListener("click", onCast);
        castBtn.classList.add("hidden");
      }
      verifiedBadge.classList.add("hidden");
    }

    againBtn.addEventListener("click", onAgain);
    backBtn.addEventListener("click", onBack);
  });
}

// Cosmetic flex, not a security boundary - a purely client-side game has no
// way to make a client-only win screen cheat-proof (a visitor could patch
// this function to always show the badge), and that's fine here because
// nothing of real value is gated behind it: no prize, no leaderboard/rivalry
// write depends on this check, it only ever changes what the result screen
// looks like. Every early-return below is a "degrade to the completely
// normal win screen" path, not an error case, which is exactly the point -
// the overwhelmingly common case (disconnected wallet, AI opponent, free
// play) should hit none of this and see zero behavior change.
async function maybeShowVictoryFlourish(matchWinner, isP1Winner, ctx, verifiedBadge, isCancelled) {
  if (!isP1Winner) return; // AI (p2) won - see runMatch's own comment on why p1 is "the real player" today
  if (!activeAdapter.config.chain) return; // no chain for this adapter to verify ownership against at all
  if (typeof activeAdapter.verifyOwnership !== "function") return; // optional export - see ADAPTERS.md

  let address = null;
  try {
    address = await getConnectedAccount();
  } catch {
    address = null;
  }
  if (!address || isCancelled()) return; // free play, or never connected

  let owns = false;
  try {
    owns = await activeAdapter.verifyOwnership(matchWinner.data.tokenId, address);
  } catch {
    // RPC hiccup, wrong chain mid-check, whatever - fail closed to the
    // normal screen rather than risk showing "verified" on an error.
    owns = false;
  }
  if (!owns || isCancelled()) return; // connected wallet doesn't actually hold this token

  verifiedBadge.classList.remove("hidden");
  playSound("ko", { volume: 0.9 });
  flashVictoryScreen(ctx, isCancelled);
}

// Two decaying pulses over the frozen final match frame rather than a flat
// single blink, so it reads as a deliberate flourish rather than a glitch.
// drawFlash only overlays semi-transparent white on top of whatever's
// already drawn (see body.js) - it never clears first - so the winner's
// flex pose and arena background underneath are untouched, just flashed
// over. Runs its own short rAF loop instead of hooking into game.js's, since
// that loop already stopped (createGame's returned stopGate) by the time
// this fires.
const VICTORY_FLASH_FRAMES = 30;
function flashVictoryScreen(ctx, isCancelled) {
  // Snapshot the frozen winner frame BEFORE the flash starts. drawFlash
  // stacks semi-transparent white on top of whatever is already on the canvas
  // without clearing first — calling it N times accumulates white (after 30
  // frames at alpha ~0.25 the canvas approaches solid white and stays there).
  // Restoring the snapshot on every frame lets the flash oscillate cleanly
  // over the frozen image instead of washing it out permanently.
  const snapshot = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  let frame = 0;
  function step() {
    // Bails the instant Play Again/Back is clicked (same cancelled flag
    // showMatchOverActions' cleanup() flips) - without this, a fast click
    // right as the flourish starts would leave this rAF loop still running
    // and painting white flash frames over whatever the NEXT match's own
    // loop is now drawing to this same ctx/canvas.
    if (isCancelled()) return;
    ctx.putImageData(snapshot, 0, 0);
    const t = frame / VICTORY_FLASH_FRAMES;
    const pulse = Math.abs(Math.sin(t * Math.PI * 2.5));
    drawFlash(ctx, CANVAS_WIDTH, CANVAS_HEIGHT, pulse * (1 - t) * 0.7);
    frame++;
    if (frame <= VICTORY_FLASH_FRAMES) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function resetBars() {
  for (const id of ["p1-health", "p2-health"]) {
    document.getElementById(id).style.width = "100%";
  }
  for (const id of ["p1-power", "p2-power"]) {
    const el = document.getElementById(id);
    el.style.width = "0%";
    el.classList.remove("power-ready");
  }
}

function updateRoundInfo(roundNum, wins) {
  document.getElementById("round-info").textContent =
    `ROUND ${roundNum} · ${wins.p1} - ${wins.p2}`;
}

function startPreFightRender(ctx, p1, p2) {
  let raf = requestAnimationFrame(function frame() {
    drawArena(ctx, CANVAS_WIDTH, CANVAS_HEIGHT);
    drawFighter(ctx, p1, 1);
    drawFighter(ctx, p2, 2);
    raf = requestAnimationFrame(frame);
  });
  return () => cancelAnimationFrame(raf);
}

function showTaunt(elId, text) {
  const el = document.getElementById(elId);
  if (!text) return;
  el.textContent = `"${text}"`;
  el.classList.remove("hidden");
}

function showStep(el, text) {
  el.textContent = text;
  el.classList.remove("hidden");
  // Restart the pop-in animation on every step (just toggling the class
  // wouldn't retrigger it since it'd already be "on").
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
}

// Ticks through 3/2/1 on a fixed clock, then holds on "1" until both taunts
// have actually finished playing before showing FIGHT! - a taunt can easily
// run past a bare 2-second countdown, and cutting it off mid-line felt
// broken. Capped so a stalled/blocked speechSynthesis can't hang the fight.
const TAUNT_WAIT_CAP_MS = 6000;

async function runCountdown(tauntsSpoken) {
  const el = document.getElementById("countdown");
  for (const step of ["3", "2", "1"]) {
    showStep(el, step);
    await new Promise((resolve) => setTimeout(resolve, 650));
  }
  await Promise.race([
    tauntsSpoken,
    new Promise((resolve) => setTimeout(resolve, TAUNT_WAIT_CAP_MS)),
  ]);
  showStep(el, "FIGHT!");
  await new Promise((resolve) => setTimeout(resolve, 650));
  el.classList.add("hidden");
}

// version.json is stamped at deploy time by scripts/stamp-version.sh
// (Vercel's buildCommand, see vercel.json) with the exact commit Vercel is
// serving - lets a visitor click straight through to the real source
// instead of taking "it's open source" on faith. 404s on local dev (no
// Vercel build ran) - that's expected, so this just stays empty rather
// than showing a broken or fake link.
async function showIntegrityCheck() {
  const el = document.getElementById("integrity-check");
  if (!el) return;
  try {
    const res = await fetch("version.json", { cache: "no-store" });
    if (!res.ok) return;
    const { commit, repo } = await res.json();
    if (!commit || !repo) return;
    const short = commit.slice(0, 7);
    // Can't link the *exact* attestation record for this build - its ID is
    // only assigned once actions/attest-build-provenance runs in CI, which
    // happens after this very file (part of the attested artifact) is
    // already built - a chicken-and-egg problem. Linking the repo's
    // attestations list instead; a visitor can cross-reference it against
    // the commit shown right here.
    el.innerHTML = `&#10003; Build verified &mdash; <a href="https://github.com/${repo}/commit/${commit}" target="_blank" rel="noopener noreferrer">commit ${short}</a> &middot; <a href="https://github.com/${repo}/attestations" target="_blank" rel="noopener noreferrer">Sigstore attestation</a>`;
  } catch {
    // No network, or not a Vercel deploy - leave it empty.
  }
}
showIntegrityCheck();
