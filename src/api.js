// Our own backend (api/match-result.js), not any collection's API - every
// collection-specific fetch now lives behind src/adapters/index.js instead.
import { activeAdapter } from "./adapters/index.js";

// Fire-and-forget by design: the match result already finished playing out
// client-side by the time this fires, so a slow or failed request should
// never hold up or break the result screen.
export function reportMatchResult(tokenId, opponentTokenId, result) {
  fetch("/api/match-result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenId, opponentTokenId, result, adapter: activeAdapter.config.key }),
  }).catch(() => {});
}

// Used to show a fighter's win/loss record on the setup screen once
// selected. Returns null on any failure (missing KV, network error, bad
// response) rather than throwing - a stats fetch failing should never block
// picking a fighter.
export async function fetchFighterStats(tokenId) {
  try {
    const res = await fetch(`/api/hoodie/${tokenId}/stats?adapter=${activeAdapter.config.key}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
