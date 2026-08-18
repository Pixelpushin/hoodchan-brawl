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

// A=uppercut, B=block, X=punch, Y=kick, LB=slide, RB/RT=special, left
// stick/D-pad=movement+crouch/jump. No "up" action exists in this game
// outside jump (no vertical walk), so stick-up/D-pad-up maps straight to
// jump instead of needing its own face button.
export function readGamepadInput(index) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads[index];
  if (!gp || !gp.connected) return null;

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
