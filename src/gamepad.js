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

function isPressed(gp, index) {
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

// A=uppercut, B=block, X=punch, Y=kick, LB=slide, RB/RT=special, left
// stick/D-pad=movement+crouch/jump. No "up" action exists in this game
// outside jump (no vertical walk), so stick-up/D-pad-up maps straight to
// jump instead of needing its own face button.
export function buildGamepadInput(gp) {
  const input = emptyInput();
  const stickX = gp.axes[0] ?? 0;
  const stickY = gp.axes[1] ?? 0;

  input.left = stickX < -STICK_DEADZONE || isPressed(gp, 14);
  input.right = stickX > STICK_DEADZONE || isPressed(gp, 15);
  input.crouch = stickY > STICK_DEADZONE || isPressed(gp, 13);
  input.jump = stickY < -STICK_DEADZONE || isPressed(gp, 12);
  input.uppercut = isPressed(gp, 0);
  input.block = isPressed(gp, 1);
  input.punch = isPressed(gp, 2);
  input.kick = isPressed(gp, 3);
  input.slide = isPressed(gp, 4);
  input.special = isPressed(gp, 5) || isPressed(gp, 7);

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
