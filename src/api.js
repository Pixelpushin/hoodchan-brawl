const BASE = "https://api.onchainhoodies.xyz/v1";

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400; // doubles each retry: 400, 800, 1600

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fetch() throws a bare "Failed to fetch" TypeError for anything below the
// HTTP layer - DNS failure, connection refused, or (what we've actually
// been seeing) their API dropping the TLS handshake entirely. Most of what
// we've observed looks like transient blips rather than sustained downtime,
// so retry with backoff before surfacing anything to the user - only the
// last attempt's failure actually gets thrown, with a message that says
// what's really wrong instead of a bare "Failed to fetch".
async function apiFetch(path) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetch(`${BASE}${path}`);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_ATTEMPTS - 1) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
  }
  if (lastErr instanceof TypeError) {
    throw new Error("Can't reach the OnChainHoodies API right now - it may be temporarily down. Try again in a moment.");
  }
  throw lastErr;
}

// Confirmed live: the real response shape is {address, count, items: [{tokenId, ...}], next} -
// `items` is what actually comes back, not `hoodies`/`tokens` (both guesses
// from before this was ever confirmed against a live wallet - the API was
// always returning real data under `items`, so every wallet was silently
// reading as empty regardless of what it actually held). Kept the old
// guesses as a fallback in case the shape ever varies, but `items` is the
// one to trust.
//
// `next` was previously ignored entirely - a wallet holding more than one
// page's worth (the API defaults to 100/request, 200 max) silently lost
// everything past the first page, with no error or indication anything was
// missing. Now walks every page. WALLET_HOODIES_HARD_CAP is a backstop
// against a pathological wallet (or a misbehaving API) making this loop
// forever, not a real expected limit - the character-select screen pages
// through whatever comes back either way.
const WALLET_HOODIES_HARD_CAP = 2000;

export async function fetchWalletHoodies(address) {
  try {
    const list = [];
    let next = null;
    do {
      const path = `/wallet/${address}/hoodies?limit=200${next ? `&next=${encodeURIComponent(next)}` : ""}`;
      const res = await apiFetch(path);
      if (!res.ok) throw new Error(`Could not load Hoodies for ${address}`);
      const data = await res.json();
      const page = data?.items ?? data?.hoodies ?? data?.tokens ?? (Array.isArray(data) ? data : []);
      list.push(...page);
      next = data?.next ?? null;
    } while (next && list.length < WALLET_HOODIES_HARD_CAP);
    return list.map((entry) => (typeof entry === "object" ? entry.tokenId ?? entry.id : entry));
  } catch (err) {
    // Same "only once retries are exhausted" gate as fetchToken - a real
    // 404/error from the API stays as-is, only its own connectivity failure
    // falls back to reading the chain directly.
    if (!(err instanceof Error) || !err.message.startsWith("Can't reach")) throw err;
    console.warn(`[api] REST API unreachable, falling back to on-chain lookup for wallet ${address}`);
    const { fetchWalletHoodiesOnChain } = await import("./chain.js");
    return fetchWalletHoodiesOnChain(address);
  }
}

export async function fetchToken(tokenId) {
  try {
    const res = await apiFetch(`/token/${tokenId}`);
    if (!res.ok) throw new Error(`Hoodie #${tokenId} not found`);
    return await res.json();
  } catch (err) {
    // Only fall back to reading the chain directly once retries are
    // exhausted (apiFetch's own error, not a real 404 - a token that
    // genuinely doesn't exist should stay a 404, not silently succeed via
    // a different path).
    if (!(err instanceof Error) || !err.message.startsWith("Can't reach")) throw err;
    console.warn(`[api] REST API unreachable, falling back to on-chain read for #${tokenId}`);
    const { fetchTokenOnChain } = await import("./chain.js");
    return fetchTokenOnChain(tokenId);
  }
}

export async function fetchHoodTalk(tokenId) {
  try {
    const res = await fetch(`${BASE}/token/${tokenId}/hood-talk`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.current?.quote ?? null;
  } catch {
    return null;
  }
}

// Full quote history for a token, oldest first. Used so the victory line
// can be a different real quote than whatever was already shown as the
// pre-fight taunt, instead of repeating it.
export async function fetchHoodTalkHistory(tokenId) {
  try {
    const res = await fetch(`${BASE}/token/${tokenId}/hood-talk/history`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.talks ?? []).map((t) => t.quote).filter(Boolean);
  } catch {
    return [];
  }
}

// Every Hoodie SVG opens with a <g><rect x="0" y="0" width="20" height="20"/></g>
// full-canvas fill as its background layer. Stripping that one element gives a
// transparent head for free instead of paying per-image background removal.
function stripSvgBackground(svgText) {
  return svgText.replace(
    /<g fill="[^"]*" fill-opacity="1"><rect x="0" y="0" width="20" height="20"\/><\/g>/,
    "",
  );
}

function loadImageAsync(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// The source art is a bust (head + shoulders), not just a head, so pasting
// it whole onto a fighter's neck duplicates shoulder pixels against the
// body sprite's own shoulders. Rasterize it and clip to a home-plate shape:
// full width for the face, tapering to a point lower down so a bit of neck
// survives but the shoulder corners are cut away.
async function cropToHeadShape(svgDataUri) {
  const img = await loadImageAsync(svgDataUri);
  const size = 200;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, size, size);

  const neckY = size * 0.62;
  const bottomY = size * 0.85;
  const centerX = size / 2;
  ctx.globalCompositeOperation = "destination-in";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(size, 0);
  ctx.lineTo(size, neckY);
  ctx.lineTo(centerX, bottomY);
  ctx.lineTo(0, neckY);
  ctx.closePath();
  ctx.fill();

  return canvas.toDataURL("image/png");
}

async function fetchTransparentHeadDataUri(svgUrl) {
  const res = await fetch(svgUrl);
  const svgText = await res.text();
  const transparent = stripSvgBackground(svgText);
  const svgDataUri = `data:image/svg+xml;base64,${btoa(transparent)}`;
  return cropToHeadShape(svgDataUri);
}

// Our own backend (api/match-result.js), not the OnChainHoodies API - hence
// no BASE prefix. Fire-and-forget by design: the match result already
// finished playing out client-side by the time this fires, so a slow or
// failed request should never hold up or break the result screen. Same
// fail-soft philosophy as fetchHoodTalk above.
export function reportMatchResult(tokenId, opponentTokenId, result) {
  fetch("/api/match-result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenId, opponentTokenId, result }),
  }).catch(() => {});
}

export async function loadFighterData(tokenId) {
  const [token, talk, talkHistory] = await Promise.all([
    fetchToken(tokenId),
    fetchHoodTalk(tokenId),
    fetchHoodTalkHistory(tokenId),
  ]);
  const imageUrl = await fetchTransparentHeadDataUri(token.image.svg);
  const { hoodie, dress, mouth, top, eyes } = token.traits;
  const rareTraitCount = [dress, mouth, top, eyes].filter(
    (t) => t?.tier === "Rare",
  ).length;
  return {
    tokenId,
    name: token.token.name,
    hoodieType: hoodie,
    rareTraitCount,
    imageUrl,
    // The original, unmodified token art - NOT the background-stripped/
    // head-shape-cropped imageUrl above (that's built for compositing a
    // floating head onto the body sprite, not for standing alone). The HUD
    // PFP just wants the real image circle-cropped via CSS, background and
    // all, like any normal avatar.
    avatarUrl: token.image.svg,
    taunt: talk,
    talkHistory,
  };
}
