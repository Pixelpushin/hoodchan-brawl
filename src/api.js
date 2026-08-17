// Our own backend (api/match-result.js), not any collection's API - every
// collection-specific fetch now lives behind src/adapters/index.js instead.
// Fire-and-forget by design: the match result already finished playing out
// client-side by the time this fires, so a slow or failed request should
// never hold up or break the result screen.
export function reportMatchResult(tokenId, opponentTokenId, result) {
  fetch("/api/match-result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenId, opponentTokenId, result }),
  }).catch(() => {});
}
