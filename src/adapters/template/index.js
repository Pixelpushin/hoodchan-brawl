// Template collection adapter - a working, fully self-contained example
// (no API, no chain, no network calls) showing exactly what an adapter must
// export to plug a new collection into the engine. Copy this whole folder,
// rename it, and replace the pieces marked TODO with real calls against
// your own collection's API/subgraph/contract. See ADAPTERS.md at the repo
// root for the full contract this file implements.
//
// Point src/adapters/index.js at this adapter (instead of onchainhoodies)
// to try it live - `python3 -m http.server 8420` and play, no wallet, no
// API keys, nothing to configure.

import { COLLECTION } from "./collection.js";

export const config = {
  key: "template",
  name: "Template Collection",
  siteTitle: "PFP Brawl",
  unitName: "Fighter",
  unitNamePlural: "Fighters",
  hypeLines: ["Choose how you want to play:", "Pick two fighters and go."],
  // TODO: real marketplace link for your collection.
  collectionUrl: "",
  collectionCta: "GET ONE",
  walletPlayDesc: "Use your own NFT to fight.",
  // No `chain` field at all - this tells main.js to hide the "Connect
  // Wallet" option entirely, since this template has nothing to check
  // ownership against. Add one (see onchainhoodies/index.js's config.chain)
  // once you have a real contract + chain to read from.
};

const byId = new Map(COLLECTION.map((entry) => [entry.tokenId, entry]));

// Renders a flat placeholder head (colored circle + initial) as a data URI
// so this template needs zero image assets of its own. A real adapter
// returns an actual image URL here instead (see onchainhoodies/api.js's
// fetchTransparentHeadDataUri for a worked example that crops real art down
// to a head shape).
function placeholderImage(entry) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
    <circle cx="100" cy="100" r="95" fill="${entry.color}" />
    <text x="100" y="120" font-size="90" font-family="sans-serif" text-anchor="middle" fill="#fff">${entry.name[0]}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// This template's own trait ("rare: true/false") already maps 1:1 onto
// this engine's fixed 4 archetypes via `archetypeKey` stored directly on
// each entry (see collection.js) - a real collection would instead compute
// this from whatever trait/class/rarity system it actually has, same idea
// as onchainhoodies/index.js's archetypeKeyFrom.
function toPreview(entry) {
  return {
    tokenId: entry.tokenId,
    name: entry.name,
    archetypeKey: entry.archetypeKey,
    rareTraitCount: entry.rare ? 1 : 0,
    previewImageUrl: placeholderImage(entry),
  };
}

export async function fetchTokenPreview(tokenId) {
  const entry = byId.get(Number(tokenId));
  if (!entry) throw new Error(`No fighter #${tokenId} in the template collection`);
  return toPreview(entry);
}

export async function fetchFighterData(tokenId) {
  const entry = byId.get(Number(tokenId));
  if (!entry) throw new Error(`No fighter #${tokenId} in the template collection`);
  const imageUrl = placeholderImage(entry);
  return {
    tokenId: entry.tokenId,
    name: entry.name,
    archetypeKey: entry.archetypeKey,
    rareTraitCount: entry.rare ? 1 : 0,
    imageUrl,
    avatarUrl: imageUrl,
    // TODO: a real adapter can return a taunt line here (shown in the
    // pre-fight speech bubble and spoken via tts.js) if your collection has
    // anything like OnChainHoodies' Hood Talk quotes. null is fine - main.js
    // already treats a missing taunt as "don't show a speech bubble".
    taunt: null,
    talkHistory: [],
  };
}

// TODO: wire this up to a real ownership check (REST API and/or an on-chain
// ownerOf/balanceOf read, see onchainhoodies/chain.js for a from-scratch
// eth_call example with no npm dependency) once you have a real contract.
// Returning [] here is what makes "Connect Wallet" behave correctly even
// before that's built - main.js treats an empty list as "no tokens in this
// wallet", not an error.
export async function fetchWalletTokenIds(_address) {
  return [];
}

// Fixed, small collection - just shuffle the real list rather than sampling
// a numeric range (see onchainhoodies/index.js's getFreePlayTokenIds for
// that version). Repeats to fill `count` if the collection is smaller than
// the requested pool size, so the select screen's page size still works.
export function getFreePlayTokenIds(count) {
  const ids = COLLECTION.map((e) => e.tokenId);
  const pool = [];
  while (pool.length < count) pool.push(...ids);
  return pool.slice(0, count);
}
