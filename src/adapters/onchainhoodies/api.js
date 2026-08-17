// Raw OnChainHoodies REST client - internal to this adapter. Returns their
// own response shapes as-is; index.js normalizes into this engine's fixed
// fighter-data contract (see ../../../ADAPTERS.md).

import { cropToHeadShape } from "../shared/head-image.js";

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
// from before this was ever confirmed against a live wallet). `next` walks
// every page - the API defaults to 100/request, 200 max - so a wallet
// holding more than one page's worth doesn't silently lose anything past
// the first. WALLET_HOODIES_HARD_CAP is a backstop against a pathological
// wallet (or a misbehaving API) making this loop forever, not a real
// expected limit.
const WALLET_HOODIES_HARD_CAP = 2000;

export async function fetchWalletHoodies(address) {
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
}

export async function fetchToken(tokenId) {
  const res = await apiFetch(`/token/${tokenId}`);
  if (!res.ok) throw new Error(`Hoodie #${tokenId} not found`);
  return await res.json();
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
// This part is genuinely OnChainHoodies-specific (their exact SVG structure) -
// the actual head-shape clipping below is shared, see ../shared/head-image.js.
function stripSvgBackground(svgText) {
  return svgText.replace(
    /<g fill="[^"]*" fill-opacity="1"><rect x="0" y="0" width="20" height="20"\/><\/g>/,
    "",
  );
}

export async function fetchTransparentHeadDataUri(svgUrl) {
  const res = await fetch(svgUrl);
  const svgText = await res.text();
  const transparent = stripSvgBackground(svgText);
  const svgDataUri = `data:image/svg+xml;base64,${btoa(transparent)}`;
  return cropToHeadShape(svgDataUri);
}
