// Mortal Kombat-style secret code - blood/gore is hidden by default and
// only shows up once this exact sequence is entered, Konami-code style
// (same 10-key sequence, arrows + B + A, regardless of P1/P2's own WASD/
// arrow-key bindings - this is a cheat code, not a player control).
// Persisted in localStorage so it stays unlocked once found instead of
// needing to be re-entered every visit.
const SEQUENCE = [
  "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight",
  "KeyB", "KeyA",
];
const STORAGE_KEY = "hoodBloodUnlocked";

export function isBloodUnlocked() {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

function setBloodUnlocked(value) {
  localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
}

let toastTimer = null;
function showToast(unlocked) {
  const el = document.getElementById("cheat-toast");
  if (!el) return;
  el.textContent = unlocked ? "BLOOD CODE ACCEPTED" : "BLOOD CODE: OFF";
  el.classList.remove("hidden");
  // Restart the pop-in animation even if a toast is already showing.
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

// Call once at startup. Only armed while the setup screen (character
// pick, pre-match) is actually showing - not during a live match, where
// arrow keys/B/A are real P2 controls and could false-trigger it mid-fight.
export function initBloodCode() {
  let progress = 0;
  window.addEventListener("keydown", (e) => {
    const setupEl = document.getElementById("setup");
    if (!setupEl || setupEl.classList.contains("hidden")) {
      progress = 0;
      return;
    }
    const expected = SEQUENCE[progress];
    if (e.code === expected) {
      progress++;
      if (progress === SEQUENCE.length) {
        progress = 0;
        const next = !isBloodUnlocked();
        setBloodUnlocked(next);
        showToast(next);
      }
    } else {
      // Don't require a totally clean restart - if this wrong key happens
      // to also be the sequence's own first key, count it as a fresh start
      // instead of losing that keypress entirely.
      progress = e.code === SEQUENCE[0] ? 1 : 0;
    }
  });
}
