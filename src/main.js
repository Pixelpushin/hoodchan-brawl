import { loadFighterData, fetchWalletHoodies, fetchToken } from "./api.js";
import { Fighter, ARCHETYPES, RARE_TRAIT_HEALTH_BONUS } from "./fighter.js";
import { createGame } from "./game.js";
import { initSound, playSound, playRandomTrack, stopMusic } from "./sound.js";
import { pickRandomArena, drawArena, drawFighter } from "./body.js";
import { speakTaunt } from "./tts.js";
import { connectWallet, hasInjectedWallet, getConnectedAccount, disconnectWallet } from "./wallet.js";
import { initBloodCode } from "./blood-code.js";

initBloodCode();

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
  const scale = Math.min(availW / 800, availH / 360);
  canvasWrap.style.width = `${Math.floor(800 * scale)}px`;
  canvasWrap.style.height = `${Math.floor(360 * scale)}px`;
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

// Rotated randomly per visit so the same line doesn't go stale. Both play
// options read clearly on their own now (see index.html's #play-options),
// so this no longer needs to be split by mode - one clear line setting up
// the card(s) below is enough either way.
const HYPE_LINES = [
  "Choose how you want to play:",
  "Two Hoodies enter. One AI leaves in pieces.",
  "Free to play, or bring your own Hoodie.",
];
function setHype() {
  if (!hypeEl) return;
  hypeEl.textContent = HYPE_LINES[Math.floor(Math.random() * HYPE_LINES.length)];
}
setHype();

// Connect Wallet only makes sense to show if a wallet extension actually
// exists - offering it otherwise just leads to a "no wallet found, install
// one" error on click. Play Free always stays visible either way; this
// only ever hides the wallet option, never the free one.
function hideWalletOption() {
  document.getElementById("wallet-play").classList.add("hidden");
  // Some HYPE_LINES mention bringing a Hoodie - not a real option once the
  // wallet card is gone, so replace whichever one setHype already picked.
  if (hypeEl) hypeEl.textContent = "Pick two fighters and jump in.";
}

if (hasInjectedWallet()) {
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
// P1's pool is the connected wallet's real Hoodies (paginated - see
// fetchWalletHoodies's own pagination fix) if one's connected, otherwise a
// random sample same as P2 always is (P2 is always AI for now - there's no
// second wallet to pull from). Deliberately built as two symmetric,
// independent panels rather than one shared grid both sides pick from in
// turn - that's not a stylistic choice, it's the shape the future shared-
// lobby system needs (P2's pool source becomes "the other real connected
// player" instead of a random sample; nothing else about this screen has
// to change).

const PANEL_PAGE_SIZE = 12;
const RANDOM_POOL_SIZE = 48;
const MAX_TOKEN_ID = 5999;
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

function randomTokenPool(count) {
  const pool = new Set();
  while (pool.size < count) {
    pool.add(1 + Math.floor(Math.random() * MAX_TOKEN_ID));
  }
  return [...pool];
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
  const ctx = canvas.getContext("2d");
  let visual = null;
  let raf = null;

  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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

async function selectFighter(side, tokenId, token) {
  const grid = side === "p1" ? p1Grid : p2Grid;
  for (const card of grid.querySelectorAll(".character-card")) {
    card.classList.toggle("selected", Number(card.dataset.tokenId) === tokenId);
  }
  panelState[side].selectedId = tokenId;
  const label = side === "p1" ? p1Label : p2Label;
  const type = token.traits?.hoodie ?? "Builder";
  label.textContent = `${token.token?.name ?? `#${tokenId}`} - ${type}`;
  fitSelectScreen();

  try {
    const data = await loadFighterData(tokenId);
    panelState[side].selectedData = data;
    portraits[side].setHead(data.imageUrl);
    updateReadyState();
  } catch {
    label.textContent = "Couldn't load that Hoodie - try another.";
    fitSelectScreen();
  }
}

async function renderPanel(side) {
  const state = panelState[side];
  const grid = side === "p1" ? p1Grid : p2Grid;
  const pageIds = state.pool.slice(state.page * PANEL_PAGE_SIZE, (state.page + 1) * PANEL_PAGE_SIZE);

  grid.innerHTML = `<div class="grid-loading"><div class="spinner"></div></div>`;

  const tokens = await Promise.all(
    pageIds.map(async (id) => {
      try {
        return await fetchToken(id);
      } catch {
        return null;
      }
    }),
  );

  grid.innerHTML = "";
  tokens.forEach((token, i) => {
    if (!token) return;
    const id = pageIds[i];
    const type = token.traits?.hoodie ?? "Builder";
    const { dress, mouth, top, eyes } = token.traits ?? {};
    const rareTraitCount = [dress, mouth, top, eyes].filter((t) => t?.tier === "Rare").length;
    const info = ARCHETYPE_INFO[type];
    const card = document.createElement("div");
    card.className = "character-card";
    card.dataset.tokenId = id;
    if (state.selectedId === id) card.classList.add("selected");
    card.innerHTML = `
      <img src="${token.image?.svg ?? ""}" alt="${type}" />
      <div class="card-label">${type}</div>
      ${info ? `<div class="card-badge">${info.emoji}</div>` : ""}
    `;
    card.addEventListener("click", () => selectFighter(side, id, token));
    if (info) attachBadgeTooltip(card.querySelector(".card-badge"), archetypeTooltip(type, rareTraitCount));
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

  panelState.p1 = { pool: walletTokenIds?.length ? walletTokenIds : randomTokenPool(RANDOM_POOL_SIZE), page: 0, selectedId: null, selectedData: null };
  panelState.p2 = { pool: randomTokenPool(RANDOM_POOL_SIZE), page: 0, selectedId: null, selectedData: null };
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
  const data1 = panelState.p1.selectedData;
  const data2 = panelState.p2.selectedData;
  await startMatch(data1, data2, { p2AI: true, practiceMode: practiceToggle.checked });
});

async function startMatch(data1, data2, opts) {
  selectScreen.classList.add("hidden");
  document.getElementById("arena").classList.remove("hidden");
  fitArenaCanvas();
  document.getElementById("p1-name").textContent = `${data1.name} (${data1.hoodieType})`;
  document.getElementById("p2-name").textContent = `${data2.name} (${data2.hoodieType})`;
  document.getElementById("p1-pfp").src = data1.avatarUrl;
  document.getElementById("p2-pfp").src = data2.avatarUrl;
  // Universal for any match, not just practice - a normal AI match had no
  // way to bail early either before this existed, only a post-match Back
  // to Menu button.
  exitMatchBtn.classList.remove("hidden");

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");

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
  enterSelectScreen(null);
});

// Shared by both the manual "Connect Wallet" click and the silent
// auto-resume path below - the only difference is whether a real user
// gesture backs this call (unlockSound), since initSound()/an audible
// click sound both need one and the resume path doesn't have one to spend.
async function proceedWithWallet(address, { unlockSound }) {
  walletStatus.textContent = "Scanning the chain for your Hoodies...";
  showWalletChip(address);
  const soundReady = unlockSound ? initSound() : Promise.resolve();

  try {
    const tokenIds = await fetchWalletHoodies(address);
    await soundReady;
    if (unlockSound) playSound("uiclick");

    if (!tokenIds.length) {
      walletStatus.textContent = "No Hoodies in this wallet yet - grab one and come back swinging.";
      openseaBtn.classList.remove("hidden");
      // Not everyone with a wallet wants to buy in just to try it out - this
      // drops them straight into the same free select-screen flow as
      // someone with no wallet at all, no NFT required.
      freePlayBtn.classList.remove("hidden");
      connectWalletBtn.disabled = false;
      return;
    }

    openseaBtn.classList.add("hidden");
    freePlayBtn.classList.add("hidden");
    walletStatus.textContent = `${tokenIds.length} Hoodie${tokenIds.length === 1 ? "" : "s"} found - pick your fighter.`;
    enterSelectScreen(tokenIds);
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
    const address = await connectWallet();
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

    const stopPreFightRender = startPreFightRender(ctx, canvas, p1, p2);

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
        canvas,
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

    return showMatchOverActions(p2AI);
  }
}

// Resolves once the player picks a way forward. true only for "Play
// Again", which is only ever offered for a vs-AI match - see the comment
// on startMatch's while loop for why a PvP "Back" doesn't try to hand-reset
// UI state itself.
function showMatchOverActions(p2AI) {
  return new Promise((resolve) => {
    const actions = document.getElementById("result-actions");
    const againBtn = document.getElementById("result-again");
    const backBtn = document.getElementById("result-back");
    actions.classList.remove("hidden");
    againBtn.classList.toggle("hidden", !p2AI);

    function onAgain() {
      cleanup();
      resolve(true);
    }
    function onBack() {
      cleanup();
      resolve(false);
    }
    function cleanup() {
      actions.classList.add("hidden");
      document.getElementById("result").classList.add("hidden");
      againBtn.removeEventListener("click", onAgain);
      backBtn.removeEventListener("click", onBack);
    }

    againBtn.addEventListener("click", onAgain);
    backBtn.addEventListener("click", onBack);
  });
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

function startPreFightRender(ctx, canvas, p1, p2) {
  let raf = requestAnimationFrame(function frame() {
    drawArena(ctx, canvas.width, canvas.height);
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
