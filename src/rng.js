// Deterministic RNG primitives for the sim (Design A step c). Two streams
// share this module but stay strictly separate at the call site: an
// "outcome" stream (AI decisions - see ai.js) whose state lives on the round
// object so a future replay/rollback can snapshot it, and a "cosmetic"
// stream (blood/splat/spatter/swish/shake/victory-quote/arena FX - see
// game.js/body.js) that never affects who wins. Mixing the two would let a
// player's blood-FX setting (BLOOD_SPOTS.length, splat variant count, ...)
// change how many random draws the match consumes and desync remote peers
// who have blood off - see PLAN-2026-09-engine-rebuild.md's Design A "RNG,
// input, loop, snapshot" section.
//
// mulberry32 (bryc's public-domain constants) rather than Math.random()
// because it's a pure, seedable, bit-exact function of a single uint32
// state - the same seed produces the same sequence on every machine/engine,
// which is the whole point of a deterministic sim. Every operation here is
// restricted to +, ^, Math.imul and the bitwise shifts, all of which are
// IEEE-754/ECMAScript-spec-exact (no transcendental functions, no float
// accumulation) - see the module doc comment in ai.js and Design A's
// "Numeric policy" section for why that restriction matters.

// One mulberry32 step: (state) -> [newState, u32]. Split out from float()
// so callers that need the raw state (round.rngState - see game.js) can
// read/write it as plain data instead of hiding it in a closure.
export function nextU32(state) {
  let a = ((state | 0) + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), a | 1);
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
  const u32 = (t ^ (t >>> 14)) >>> 0;
  return [a >>> 0, u32];
}

// Stateful convenience wrapper over nextU32 for callers that don't need
// their state to live on shared plain data (cosmetic FX, arena pick, tests).
// The outcome stream (ai.js via game.js) deliberately does NOT use this -
// see game.js's own round-rng adapter, which reads/writes round.rngState
// directly so it stays snapshot-able.
export function makeRng(seed) {
  let state = seed >>> 0;
  return {
    // [0, 1)
    float() {
      const [next, u32] = nextU32(state);
      state = next;
      return u32 / 4294967296;
    },
    // [0, n) integer
    int(n) {
      return Math.floor(this.float() * n);
    },
    pick(array) {
      return array[this.int(array.length)];
    },
    get state() {
      return state;
    },
    set state(v) {
      state = v >>> 0;
    },
  };
}

// FNV-1a over a string, used only to fold a human-readable tag into derive()
// below - not part of the outcome/cosmetic streams themselves.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// One splitmix32 step - a different (and differently-biased) mixer than
// mulberry32, used here only to spread `seed ^ fnv1a(tag)` across the full
// uint32 range before it becomes a fresh mulberry32 seed. Using a distinct
// algorithm for this mixing step (rather than just calling nextU32 again)
// avoids correlating derive()'s output with the mulberry32 stream a caller
// then seeds from it.
function splitmix32(state) {
  const next = (state + 0x9e3779b9) >>> 0;
  let z = next;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  z = (z ^ (z >>> 15)) >>> 0;
  return z;
}

// Derives a fresh, well-mixed uint32 seed from a match seed + a tag string
// ("round:2:0", "fx", "arena", ...) - this is how one matchSeed (main.js)
// fans out into every independent stream the match needs without those
// streams ever sharing state. Same (seed, tag) always produces the same
// output, on any machine - that's what lets two future netcode peers (or a
// replay) agree on e.g. the arena pick without exchanging it over the wire.
export function derive(seed, tag) {
  const mixed = ((seed >>> 0) ^ fnv1a(String(tag))) >>> 0;
  return splitmix32(mixed);
}

// A real, non-deterministic uint32 for starting a fresh match (matchSeed -
// see main.js's runMatch). crypto.getRandomValues is available on
// globalThis in both the browser and Node 22+, so this needs no fallback.
export function randomSeed() {
  const arr = new Uint32Array(1);
  globalThis.crypto.getRandomValues(arr);
  return arr[0];
}
