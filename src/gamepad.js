// Web Gamepad API support, polled once per frame from game.js's main loop -
// the API has no event-based "button held" notion, only a connect/
// disconnect event plus per-frame Gamepad snapshots via
// navigator.getGamepads(). Uses the W3C Standard Gamepad mapping
// (https://w3c.github.io/gamepad/#remapping) that every major controller
// (Xbox, PlayStation, most third-party USB pads) reports as once the
// browser recognizes it - no per-controller-brand special-casing needed.
//
// Purely additive to keyboard input (see withGamepad in game.js) - a
// controller plugged in mid-match just starts working alongside the
// keyboard immediately, nothing to configure or switch into.
//
// Does NOT assume a single connected pad lands at browser index 0 - verified
// live that a lone controller can show up at index 1 (likely a leftover
// phantom/virtual entry at index 0 from the OS or another app), which with a
// naive "index 0 = p1" mapping meant the pad was live and correctly read,
// just never assigned to either fighter. findGamepad() scans for whichever
// index actually has a pad instead of assuming one.

const STICK_DEADZONE = 0.35;
// A trigger (buttons[6]/[7] on most pads) reports 0-1 as an analog value,
// not a boolean - treat "mostly pressed" as pressed so a worn/imprecise
// trigger doesn't need to be floored all the way to register.
const TRIGGER_THRESHOLD = 0.5;

// Only the discrete button-triggered actions are remappable (see
// getGamepadMap/setGamepadAction below) - movement (left/right/crouch) stays
// tied to the left stick + D-pad, same as keyboard's WASD-style movement
// keys are never offered for rebinding either. Jump used to double as
// stick-up, which read as accidental jumps whenever a player was just
// tilting the stick to move/crouch - it's its own dedicated button now,
// same as every other action.
export const REMAPPABLE_ACTIONS = ["jump", "uppercut", "block", "punch", "kick", "slide", "special"];

const DEFAULT_GAMEPAD_MAP = {
  jump: 6, // LT
  uppercut: 0, // A / Cross
  block: 1, // B / Circle
  punch: 2, // X / Square
  kick: 3, // Y / Triangle
  slide: 4, // LB / L1
  special: 5, // RB / R1
};

// RT (button 7) always works as an alternate special trigger regardless of
// the configured map - not offered as its own remappable action (special
// already has one), just a convenience second input since RB/RT are
// naturally paired on every pad.
const SPECIAL_ALT_BUTTON = 7;

const STORAGE_KEY = "pfpbrawl-gamepad-map";

// W3C Standard Gamepad button-index names, for the controls-panel display
// and the remap UI's "press a button" prompt - covers every index a real
// standard-mapped pad reports (face buttons, bumpers/triggers, stick
// clicks, D-pad, start/select). Anything outside this list (a pad with more
// buttons than the standard 17) just shows its raw index instead of a name.
const BUTTON_NAMES = [
  "A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Select", "Start",
  "L Stick Click", "R Stick Click", "D-Up", "D-Down", "D-Left", "D-Right", "Home",
];

export function buttonName(index) {
  return BUTTON_NAMES[index] ?? `Button ${index}`;
}

function loadGamepadMap() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return { ...DEFAULT_GAMEPAD_MAP, ...saved };
  } catch {
    return { ...DEFAULT_GAMEPAD_MAP };
  }
}

let gamepadMap = loadGamepadMap();

export function getGamepadMap() {
  return gamepadMap;
}

export function setGamepadAction(action, buttonIndex) {
  gamepadMap = { ...gamepadMap, [action]: buttonIndex };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(gamepadMap));
}

export function resetGamepadMap() {
  gamepadMap = { ...DEFAULT_GAMEPAD_MAP };
  localStorage.removeItem(STORAGE_KEY);
}

// Exported (not just used internally) so gamepad-nav.js's menu/UI
// navigation can read raw button state the same way buildGamepadInput does,
// instead of re-implementing the same trigger-analog-value handling twice.
export function isPressed(gp, index) {
  const b = gp.buttons[index];
  if (!b) return false;
  return typeof b === "object" ? b.pressed || b.value > TRIGGER_THRESHOLD : b > TRIGGER_THRESHOLD;
}

function emptyInput() {
  return {
    left: false, right: false, block: false, crouch: false, jump: false,
    uppercut: false, slide: false, punch: false, kick: false, special: false,
  };
}

// Logged once per gamepad (not every frame) so opening devtools console
// immediately shows whether the browser detected the device at all, and
// whether it got recognized as "standard" mapping - the W3C button-index
// layout this file assumes only holds for pads Chrome/Firefox actually
// map that way. A non-standard pad (older/unusual hardware, some
// Bluetooth pads, some OS/driver combos) still shows up in
// navigator.getGamepads() but its button indices can mean anything,
// which reads to a player as "nothing happens" even though the pad is
// technically detected.
const loggedIndices = new Set();
function logGamepadOnce(gp) {
  if (loggedIndices.has(gp.index)) return;
  loggedIndices.add(gp.index);
  console.log(`[gamepad] detected index ${gp.index}: "${gp.id}", mapping="${gp.mapping || "(none)"}"`);
  if (gp.mapping !== "standard") {
    console.warn(
      `[gamepad] "${gp.id}" did not report standard mapping - button positions (A/B/X/Y/etc) ` +
        "may not match what this game assumes. Try a different USB port/cable, or a different pad " +
        "if this one is older/unusual hardware.",
    );
  }
}

// Returns whichever connected Gamepad object comes first in browser index
// order, skipping excludeIndex (already claimed by the other player, in a
// real 2-controller local match). Not gating on gp.connected - it's
// supposed to flip false on disconnect, but some browser/OS/driver combos
// leave it undefined rather than true even while the pad is live and
// reporting real button data. A missing entry (nothing at that index at
// all) is the only case that actually means "no pad here."
export function findGamepad(excludeIndex = -1) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (let i = 0; i < pads.length; i++) {
    const gp = pads[i];
    if (gp && i !== excludeIndex) {
      logGamepadOnce(gp);
      return gp;
    }
  }
  return null;
}

// Movement/crouch stay on the left stick + D-pad (not remappable, see
// REMAPPABLE_ACTIONS above); every other action reads from the current
// gamepadMap so a player's rebinds apply immediately without needing a
// page reload.
export function buildGamepadInput(gp) {
  const input = emptyInput();
  const map = gamepadMap;
  const stickX = gp.axes[0] ?? 0;
  const stickY = gp.axes[1] ?? 0;

  input.left = stickX < -STICK_DEADZONE || isPressed(gp, 14);
  input.right = stickX > STICK_DEADZONE || isPressed(gp, 15);
  input.crouch = stickY > STICK_DEADZONE || isPressed(gp, 13);
  input.jump = isPressed(gp, map.jump);
  input.uppercut = isPressed(gp, map.uppercut);
  input.block = isPressed(gp, map.block);
  input.punch = isPressed(gp, map.punch);
  input.kick = isPressed(gp, map.kick);
  input.slide = isPressed(gp, map.slide);
  input.special = isPressed(gp, map.special) || isPressed(gp, SPECIAL_ALT_BUTTON);

  return input;
}

// The Gamepad API fires this the moment the browser recognizes a pad -
// independent of navigator.getGamepads() ever returning anything, and
// independent of the "press a button once to activate" quirk some browsers
// have. Wiring this up unconditionally (not just under the debug overlay)
// means opening devtools console alone answers "did the browser see this
// at all" without needing to add a URL param first.
window.addEventListener("gamepadconnected", (e) => logGamepadOnce(e.gamepad));
window.addEventListener("gamepaddisconnected", (e) => {
  loggedIndices.delete(e.gamepad.index);
  console.log(`[gamepad] disconnected index ${e.gamepad.index}: "${e.gamepad.id}"`);
});

// Opt-in live readout (add ?gamepaddebug to the URL) showing what's
// actually driving each fighter right now - using the same findGamepad()
// scan the real game loop uses, not a raw index 0/1 dump, so this can't
// show "nothing at index 0" while a pad that IS driving p1 sits at some
// other index. Updated every frame - the fastest way to tell "browser sees
// nothing at all" apart from "sees it, but button 2 doesn't mean punch on
// this pad" apart from "it's working, the player just hasn't pressed
// anything yet." Not shown by default so it doesn't clutter the game.
export function initGamepadDebugOverlay() {
  if (!new URLSearchParams(location.search).has("gamepaddebug")) return;
  const el = document.createElement("pre");
  el.style.cssText =
    "position:fixed;bottom:8px;left:8px;z-index:9999;background:#000c;color:#0f0;" +
    "font:11px monospace;padding:8px;max-width:90vw;white-space:pre-wrap;pointer-events:none;";
  document.body.appendChild(el);

  function describe(gp) {
    if (!gp) return "(none)";
    const pressed = gp.buttons.map((b, i) => (isPressed(gp, i) ? i : null)).filter((i) => i !== null);
    const axes = gp.axes.map((a) => a.toFixed(2)).join(", ");
    return `index ${gp.index}: "${gp.id}"\n  mapping: ${gp.mapping || "(none)"}\n  buttons pressed: [${pressed.join(", ")}]\n  axes: [${axes}]`;
  }

  function tick() {
    const p1Gamepad = findGamepad();
    const p2Gamepad = findGamepad(p1Gamepad ? p1Gamepad.index : -1);
    el.textContent = `GAMEPAD DEBUG\np1: ${describe(p1Gamepad)}\np2: ${describe(p2Gamepad)}`;
    requestAnimationFrame(tick);
  }
  tick();
}

// Used by the remap UI (src/gamepad-nav.js) - resolves to a Promise for the
// index of the next button pressed on any connected pad, or null if the
// player waits out the timeout without pressing anything (so a remap
// prompt can't get stuck open forever). Polls via requestAnimationFrame
// rather than a gamepadconnected-style event, since there's no
// "buttondown" event in this API at all - per-frame snapshots are the only
// way to detect a press.
export function waitForButtonPress(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    // Buttons already held down when the prompt opens shouldn't immediately
    // resolve it - a player holding a bumper while navigating into the
    // remap screen would otherwise instantly "press" whatever they were
    // already holding. Require a release-then-press instead.
    const alreadyHeld = new Set();
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      gp.buttons.forEach((_, i) => {
        if (isPressed(gp, i)) alreadyHeld.add(`${gp.index}:${i}`);
      });
    }

    function tick() {
      if (performance.now() - startedAt > timeoutMs) {
        resolve(null);
        return;
      }
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gp of pads) {
        if (!gp) continue;
        for (let i = 0; i < gp.buttons.length; i++) {
          const key = `${gp.index}:${i}`;
          if (isPressed(gp, i)) {
            if (!alreadyHeld.has(key)) {
              resolve(i);
              return;
            }
          } else {
            alreadyHeld.delete(key);
          }
        }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}
