// Every clip here is a paid Splice sample (music is Suno-generated) - not
// bundled in the repo, see the README's licensing note. Served from Vercel
// Blob instead of a repo-relative path specifically so they never have to
// touch git: the CI pipeline (.github/workflows/deploy.yml) only ever sees
// what's actually committed, and these can't be (see
// docs/SITE-INTEGRITY-RESEARCH.md for why that pipeline exists at all).
// Missing/failed clips degrade to silence, not a crash - see
// initSound/playSound below.
const AUDIO_BASE = "https://bjnsuc8wmkpgnt3k.public.blob.vercel-storage.com";

const CLIPS = {
  punch: `${AUDIO_BASE}/punch.mp3`,
  kick: `${AUDIO_BASE}/kick.mp3`,
  jump: `${AUDIO_BASE}/jump.mp3`,
  hit: `${AUDIO_BASE}/hit.mp3`,
  block: `${AUDIO_BASE}/block.mp3`,
  ko: `${AUDIO_BASE}/ko.mp3`,
  powerfull: `${AUDIO_BASE}/powerfull.mp3`,
  uiclick: `${AUDIO_BASE}/uiclick.mp3`,
  boltWhoosh: `${AUDIO_BASE}/bolt-whoosh.mp3`,
  boltImpact: `${AUDIO_BASE}/bolt-impact.mp3`,
};

const TRACKS = [
  `${AUDIO_BASE}/garbage-world.mp3`,
  `${AUDIO_BASE}/lets-go.mp3`,
  `${AUDIO_BASE}/missed-calls.mp3`,
  `${AUDIO_BASE}/muppet-trash.mp3`,
  `${AUDIO_BASE}/trash-panda.mp3`,
  `${AUDIO_BASE}/when-trash-cans-dance.mp3`,
  `${AUDIO_BASE}/waste-management.mp3`,
];

let ctx = null;
const buffers = {};
// Music streams through a plain <audio> element instead of decoded Web
// Audio buffers - these are full tracks (3-5MB each), not short SFX, so
// decoding them all into memory up front would be wasteful.
let musicEl = null;

async function loadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return ctx.decodeAudioData(arrayBuffer);
}

// Browsers block audio until a user gesture. Call this from the click
// handler that starts the fight so everything is ready in time.
export async function initSound() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Some browsers still create the context in a "suspended" state even
  // when constructed inside a gesture handler - resume() is a no-op if
  // it's already running, so this is safe to call unconditionally.
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => {});
  }
  await Promise.all(
    Object.entries(CLIPS).map(async ([name, url]) => {
      if (buffers[name]) return;
      try {
        buffers[name] = await loadBuffer(url);
      } catch (err) {
        console.warn(`[sound] failed to load "${name}" from ${url}:`, err);
        buffers[name] = null;
      }
    }),
  );
}

export function playSound(name, { volume = 0.7, rate = 1 } = {}) {
  const buffer = buffers[name];
  if (!ctx) {
    console.warn("[sound] playSound called before initSound completed:", name);
    return;
  }
  if (!buffer) {
    console.warn(`[sound] no buffer loaded for "${name}"`);
    return;
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain).connect(ctx.destination);
  source.start();
}

// Picks a new random track each call so a rematch doesn't repeat the same
// song - swaps musicEl's src directly rather than creating a new element
// each time, so there's only ever one music track playing.
export function playRandomTrack({ volume = 0.35 } = {}) {
  if (!musicEl) {
    musicEl = new Audio();
    musicEl.loop = true;
  }
  let next = TRACKS[Math.floor(Math.random() * TRACKS.length)];
  if (TRACKS.length > 1 && next === musicEl.dataset.src) {
    next = TRACKS[(TRACKS.indexOf(next) + 1) % TRACKS.length];
  }
  musicEl.dataset.src = next;
  musicEl.src = next;
  musicEl.volume = volume;
  musicEl.currentTime = 0;
  musicEl.play().catch((err) => console.warn("[sound] music playback failed:", err));
}

export function stopMusic() {
  if (musicEl) musicEl.pause();
}
