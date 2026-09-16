// Our own backend (api/match-result.js), not any collection's API - every
// collection-specific fetch now lives behind src/adapters/index.js instead.
import { activeAdapter } from "./adapters/index.js";
import { signMessage } from "./wallet.js";

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

// Must match api/ai-match-complete.js's buildAiMatchMessage byte-for-byte -
// wallet1 (the connected player - see selectFighter's ownerAddress stamp in
// main.js) signs this and the server re-derives it from the validated
// request fields, never trusting client-supplied text (same pattern as
// src/lobby.js's buildResultMessage / api/lobby/complete.js). Exported so a
// test can cross-check this against the server's own copy.
export function buildAiMatchMessage({ nft1, nft2, winnerId, wallet1, issuedAt }) {
  const winnerLabel = winnerId === null || winnerId === undefined ? "none" : winnerId;
  return [
    "HOODCHAN Brawl AI match result",
    `nft1: HOODCHAN #${nft1}`,
    `nft2: HOODCHAN #${nft2}`,
    `winner: HOODCHAN #${winnerLabel}`,
    `address: ${wallet1}`,
    `issued: ${issuedAt}`,
  ].join("\n");
}

// Records a vs-AI match result and enqueues a soulbound mint. wallet1 must
// sign an attestation over the pairing - api/ai-match-complete.js rejects
// an unsigned request now (an earlier version let anyone who knew two real
// owners' addresses queue a free mint for strangers at the operator's
// expense, since ownerOf is public data and proved nothing about who was
// actually calling this route).
//
// Awaited (not fire-and-forget) so the caller can show an honest result
// instead of always claiming a mint happened:
//   "queued"  - mint accepted and queued
//   "already" - this pairing was already recorded/pending (409)
//   "capped"  - daily per-wallet mint cap reached (429)
//   "error"   - signing failed/rejected, or any other failure
export async function submitAiMatchComplete({ wallet1, nft1, wallet2, nft2, winnerId, adapter }) {
  const issuedAt = new Date().toISOString();
  const message = buildAiMatchMessage({ nft1, nft2, winnerId, wallet1, issuedAt });
  try {
    const signature = await signMessage(wallet1, message);
    const res = await fetch("/api/ai-match-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet1, nft1, wallet2, nft2, winnerId, adapter, issuedAt, signature }),
    });
    if (res.ok) return "queued";
    if (res.status === 409) return "already";
    if (res.status === 429) return "capped";
    return "error";
  } catch {
    return "error";
  }
}
