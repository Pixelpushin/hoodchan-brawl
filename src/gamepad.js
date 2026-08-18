// Web Gamepad API support, polled once per frame from game.js's main loop -
// the API has no event-based "button held" notion, only a connect/
// disconnect event plus per-frame Gamepad snapshots via
// navigator.getGamepads(). Uses the W3C Standard Gamepad mapping
// (https://w3c.github.io/gamepad/#remapping) that every major controller
// (Xbox, PlayStation, most third-party USB pads) reports as once the
// browser recognizes it - no per-controller-brand special-casing needed.
//
// Purely additive to keyboard input (see mergeInput in game.js) - a
// controller plugged in mid-match just starts working alongside the
// keyboard immediately, nothing to configure or switch into. Gamepad index
// 0 drives p1, index 1 drives p2 (browser-assigned by connection order).

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

// A=uppercut, B=block, X=punch, Y=kick, LB=slide, RB/RT=special, left
// stick/D-pad=movement+crouch/jump. No "up" action exists in this game
// outside jump (no vertical walk), so stick-up/D-pad-up maps straight to
// jump instead of needing its own face button.
export function readGamepadInput(index) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads[index];
  // Not gating on gp.connected - it's supposed to flip false on disconnect,
  // but some browser/OS/driver combos leave it undefined rather than true
  // even while the pad is live and reporting real button data. A missing
  // gp (nothing at this index at all) is the only case that actually means
  // "no pad here."
  if (!gp) return null;
  logGamepadOnce(gp);

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

// Opt-in live readout (add ?gamepaddebug to the URL) showing every raw
// button/axis value for whatever's connected at index 0/1, updated every
// frame - the fastest way to tell "browser sees nothing at all" apart from
// "sees it, but button 2 doesn't mean punch on this pad" apart from "it's
// working, the player just hasn't pressed anything yet." Not shown by
// default so it doesn't clutter the game for everyone.
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
    return `"${gp.id}"\n  mapping: ${gp.mapping || "(none)"}\n  buttons pressed: [${pressed.join(", ")}]\n  axes: [${axes}]`;
  }

  function tick() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    el.textContent = `GAMEPAD DEBUG\np1 (index 0): ${describe(pads[0])}\np2 (index 1): ${describe(pads[1])}`;
    requestAnimationFrame(tick);
  }
  tick();
}
