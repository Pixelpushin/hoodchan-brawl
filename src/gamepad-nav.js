// Controller-driven UI navigation for every non-combat screen (setup,
// character select, controls/remap panels, post-match result screen) - live
// in-fight input is handled entirely by game.js's own withGamepad/
// buildGamepadInput (see gamepad.js) and this file goes completely inert
// during an actual live round so D-pad/A/B aren't double-claimed by both
// systems at once (see currentScope() - it returns null during live
// combat, and the main loop below skips everything except Start/Select
// whenever that happens).
//
// Moves real DOM focus (document.activeElement) rather than tracking a
// separate "selected element" concept of its own - .character-card gets
// tabIndex=0 in main.js specifically so this works uniformly across real
// <button>s and the card <div>s alike, and the :focus-visible CSS rule
// (style.css) is what actually renders the result on screen. A (confirm)
// and B (back) always mean confirm/back for menu purposes regardless of
// whatever a player has rebound uppercut/block to for combat - remapping
// combat buttons shouldn't also remap "what activates a menu item",
// matching how most games keep menu confirm/cancel fixed even with
// rebindable gameplay controls.

import { findGamepad, isPressed, getGamepadMap, setGamepadAction, resetGamepadMap, buttonName, waitForButtonPress, REMAPPABLE_ACTIONS } from "./gamepad.js";

const CONFIRM_BUTTON = 0; // A / Cross
const BACK_BUTTON = 1; // B / Circle
const START_BUTTON = 9;
const SELECT_BUTTON = 8;

const DIRECTION_REPEAT_DELAY_MS = 350; // how long a held direction waits before auto-repeating
const DIRECTION_REPEAT_INTERVAL_MS = 130; // repeat rate once it starts
const STICK_DEADZONE = 0.5; // higher than gameplay's own axis deadzone - UI nav shouldn't fire on a light tilt

const FOCUSABLE_SELECTOR = 'button:not([disabled]), .character-card, input[type="checkbox"]';

function isVisible(el) {
  if (!el) return false;
  if (el.offsetParent !== null) return true;
  // offsetParent is spec'd to always return null for position:fixed
  // elements, even when they're genuinely on screen (#exit-match-btn,
  // among others, here) - getClientRects catches that blind spot without
  // losing the fast/common-case check above.
  return el.getClientRects().length > 0;
}

function isHiddenScreen(el) {
  return !el || el.classList.contains("hidden");
}

// Which single element (if any) is the active navigation scope right now,
// highest-priority first - two of these can never be relevant at once
// except the remap/controls overlays, which sit on top of whatever
// setup/select/arena screen is behind them.
function currentScope() {
  const remapPanel = document.getElementById("gamepad-remap-panel");
  if (!isHiddenScreen(remapPanel)) return remapPanel;
  const controlsPanel = document.getElementById("controls-panel");
  if (controlsPanel && controlsPanel.classList.contains("open")) return controlsPanel;

  const arena = document.getElementById("arena");
  if (!isHiddenScreen(arena)) {
    const result = document.getElementById("result");
    if (!isHiddenScreen(result)) return result;
    return null; // live combat - no menu-nav scope at all
  }
  const selectScreen = document.getElementById("select-screen");
  if (!isHiddenScreen(selectScreen)) return selectScreen;
  const setup = document.getElementById("setup");
  if (!isHiddenScreen(setup)) return setup;
  return null;
}

function getFocusables(scope) {
  return Array.from(scope.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisible);
}

// auto-fill grids (see .panel-grid in style.css) don't have a fixed column
// count - it depends on the current viewport width. Reading the browser's
// own resolved gridTemplateColumns (one length per actual rendered column)
// is the only way to know the real number for up/down-by-row math below.
function gridColumnCount(gridEl) {
  const cols = getComputedStyle(gridEl).gridTemplateColumns.split(" ").filter(Boolean);
  return Math.max(1, cols.length);
}

// dx/dy are -1/0/1. Grid-aware when focus is currently on a character
// card (moves by row/column within that card's own .panel-grid, clamped to
// its bounds), otherwise - or when a grid move would fall off that grid's
// edge - falls through to flat DOM-order nav across every focusable in the
// scope, wrapping at the ends. That fallthrough is what lets a controller
// reach pagination/START BATTLE/practice-toggle/the other side's grid at
// all, since grid nav alone would otherwise dead-end at the grid's edges.
function moveFocus(scope, dx, dy) {
  const focusables = getFocusables(scope);
  if (focusables.length === 0) return;
  const current = document.activeElement;
  const grid = current?.classList?.contains("character-card") ? current.closest(".panel-grid") : null;

  if (grid) {
    const cards = Array.from(grid.querySelectorAll(".character-card")).filter(isVisible);
    const idx = cards.indexOf(current);
    if (idx !== -1) {
      const cols = gridColumnCount(grid);
      if (dx !== 0) {
        const row = Math.floor(idx / cols);
        const newCol = (idx % cols) + dx;
        const target = row * cols + newCol;
        if (newCol >= 0 && newCol < cols && target < cards.length) {
          cards[target].focus();
          return;
        }
      } else if (dy !== 0) {
        const target = idx + dy * cols;
        if (target >= 0 && target < cards.length) {
          cards[target].focus();
          return;
        }
      }
      // Fell off the grid's own edge - drop through to flat nav below.
    }
  }

  const forward = dx > 0 || dy > 0;
  let idx = focusables.indexOf(current);
  idx = idx === -1 ? 0 : (idx + (forward ? 1 : -1) + focusables.length) % focusables.length;
  focusables[idx].focus();
}

function readDirection(gp) {
  const x = gp.axes[0] ?? 0;
  const y = gp.axes[1] ?? 0;
  if (y < -STICK_DEADZONE || isPressed(gp, 12)) return { dx: 0, dy: -1 };
  if (y > STICK_DEADZONE || isPressed(gp, 13)) return { dx: 0, dy: 1 };
  if (x < -STICK_DEADZONE || isPressed(gp, 14)) return { dx: -1, dy: 0 };
  if (x > STICK_DEADZONE || isPressed(gp, 15)) return { dx: 1, dy: 0 };
  return null;
}

// ===== Controller map display + remap UI =====

function renderGamepadKeyList() {
  const map = getGamepadMap();
  document.querySelectorAll("#gamepad-key-list [data-gp-action]").forEach((el) => {
    el.textContent = buttonName(map[el.dataset.gpAction]);
  });
}

let rebindInProgress = false;

function renderRemapList() {
  const list = document.getElementById("gamepad-remap-list");
  const map = getGamepadMap();
  list.innerHTML = "";
  for (const action of REMAPPABLE_ACTIONS) {
    const row = document.createElement("li");
    row.className = "key-row";
    const label = document.createElement("span");
    label.className = "key-label";
    label.textContent = action.charAt(0).toUpperCase() + action.slice(1);
    const btn = document.createElement("button");
    btn.className = "rebind-btn";
    btn.textContent = buttonName(map[action]);
    btn.addEventListener("click", async () => {
      if (rebindInProgress) return;
      rebindInProgress = true;
      btn.classList.add("waiting");
      btn.textContent = "Press a button…";
      const pressedIndex = await waitForButtonPress();
      rebindInProgress = false;
      btn.classList.remove("waiting");
      if (pressedIndex !== null) {
        setGamepadAction(action, pressedIndex);
        renderGamepadKeyList();
      }
      renderRemapList();
    });
    row.append(label, btn);
    list.appendChild(row);
  }
}

function initRemapUI() {
  const remapBtn = document.getElementById("gamepad-remap-btn");
  const remapPanel = document.getElementById("gamepad-remap-panel");
  const doneBtn = document.getElementById("gamepad-remap-done");
  const resetBtn = document.getElementById("gamepad-remap-reset");
  if (!remapBtn || !remapPanel) return;

  remapBtn.addEventListener("click", () => {
    renderRemapList();
    remapPanel.classList.remove("hidden");
  });
  doneBtn.addEventListener("click", () => remapPanel.classList.add("hidden"));
  resetBtn.addEventListener("click", () => {
    resetGamepadMap();
    renderGamepadKeyList();
    renderRemapList();
  });

  renderGamepadKeyList();
}

// ===== Main loop =====

export function initGamepadNav() {
  initRemapUI();

  let prevA = false;
  let prevB = false;
  let prevStart = false;
  let prevSelect = false;
  let lastScope = null;
  let directionHeldSince = 0;
  let nextRepeatAt = 0;
  let lastDirectionKey = null;

  function tick() {
    requestAnimationFrame(tick);
    const gp = findGamepad();
    if (!gp) return;

    // A rebind is actively waiting for the next button press - that press
    // needs to land as a new binding, not get double-interpreted as a menu
    // confirm/back/nav action on the same frame.
    if (rebindInProgress) return;

    const start = isPressed(gp, START_BUTTON);
    const select = isPressed(gp, SELECT_BUTTON);
    const exitBtn = document.getElementById("exit-match-btn");
    const scope = currentScope();
    const liveCombat = scope === null && !isHiddenScreen(document.getElementById("arena"));

    if (start && !prevStart) {
      document.getElementById("controls-info-btn")?.click();
    }
    if (select && !prevSelect) {
      if (liveCombat && isVisible(exitBtn)) {
        exitBtn.click();
      } else if (!liveCombat) {
        document.getElementById("controls-info-btn")?.click();
      }
    }
    prevStart = start;
    prevSelect = select;

    if (!scope) {
      // Live combat, or genuinely no screen matched - direction/A/B belong
      // to gameplay (or nothing) here, not menu nav.
      prevA = isPressed(gp, CONFIRM_BUTTON);
      prevB = isPressed(gp, BACK_BUTTON);
      return;
    }

    if (scope !== lastScope) {
      // Entering a new scope - focus its first focusable so a controller
      // user always has something visibly selected instead of nothing
      // focused at all. Doesn't fight for focus on every frame, only on
      // the transition.
      lastScope = scope;
      if (!scope.contains(document.activeElement)) {
        getFocusables(scope)[0]?.focus();
      }
    }

    const direction = readDirection(gp);
    const now = performance.now();
    const directionKey = direction ? `${direction.dx},${direction.dy}` : null;
    if (directionKey && directionKey !== lastDirectionKey) {
      moveFocus(scope, direction.dx, direction.dy);
      directionHeldSince = now;
      nextRepeatAt = now + DIRECTION_REPEAT_DELAY_MS;
    } else if (directionKey && now >= nextRepeatAt) {
      moveFocus(scope, direction.dx, direction.dy);
      nextRepeatAt = now + DIRECTION_REPEAT_INTERVAL_MS;
    }
    lastDirectionKey = directionKey;

    const a = isPressed(gp, CONFIRM_BUTTON);
    if (a && !prevA) document.activeElement?.click?.();
    prevA = a;

    const b = isPressed(gp, BACK_BUTTON);
    if (b && !prevB) {
      const remapPanel = document.getElementById("gamepad-remap-panel");
      if (!isHiddenScreen(remapPanel)) {
        remapPanel.classList.add("hidden");
      } else {
        document.getElementById("controls-panel")?.classList.remove("open");
      }
    }
    prevB = b;
  }
  requestAnimationFrame(tick);
}
