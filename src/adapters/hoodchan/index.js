// HOODCHAN collection adapter - the actual "fork this and plug in a real
// collection" test case (see ADAPTERS.md). Real contract on the same
// Robinhood Chain as the default OnChainHoodies adapter, ported from the
// real h00dchan app (github.com/Pixelpushin/h00dchan)'s own on-chain read
// code - see chain.js's header comment for exactly what was independently
// verified live there.
//
// Two real differences from the onchainhoodies adapter, both worth reading
// if you're writing your own adapter next:
//
// 1. headStyle: "circle" instead of "cropped" - HOODCHAN's art is a
//    photographic/collage JPEG (a real meme photo as the background layer,
//    cartoon face art pasted on top), not isolated vector art with a flat
//    background to strip. There's no clean way to cut out just "the head" -
//    see ../shared/head-image.js's header comment for the actual criterion
//    (can the background be cleanly removed? no -> use "circle").
// 2. archetypeKeyFrom is a plain tokenId%4 split, not a real trait mapping -
//    HOODCHAN's traits (Backgrounds/Bodies/Faces/Hats) don't naturally
//    bucket into this engine's 4 combat archetypes the way OnChainHoodies'
//    own "hoodie" trait already did. When a collection has no natural
//    4-way split, a deterministic hash of the token ID is a reasonable
//    fallback - every token still always gets the same archetype, it's
//    just not thematically meaningful the way a real trait mapping would be.

import { CHAIN_ID_HEX, RPC_URL, fetchTokenMetadata, fetchWalletTokenIdsOnChain, readOwnerOf } from "./chain.js";
import { prepareHeadImage } from "../shared/head-image.js";

export const config = {
  key: "hoodchan",
  name: "HOODCHAN",
  siteTitle: "HOODCHAN Brawl",
  unitName: "Anon",
  unitNamePlural: "Anons",
  hypeLines: [
    "Choose how you want to play:",
    "Two Anons enter. One AI leaves in pieces.",
    "Free to play, or bring your own Anon.",
  ],
  collectionUrl: "https://opensea.io/collection/h00dchan",
  collectionCta: "GET AN ANON ON OPENSEA",
  walletPlayDesc: "Use your own HOODCHAN NFT to fight.",
  headStyle: "circle",
  chain: {
    chainIdHex: CHAIN_ID_HEX,
    chainName: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [RPC_URL],
    blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
  },
};

const ARCHETYPE_ORDER = ["Builder", "Flipper", "Hodler", "Collector"];

function archetypeKeyFrom(tokenId) {
  return ARCHETYPE_ORDER[Number(tokenId) % ARCHETYPE_ORDER.length];
}

export async function fetchTokenPreview(tokenId) {
  const token = await fetchTokenMetadata(tokenId);
  return {
    tokenId,
    name: token.name,
    archetypeKey: archetypeKeyFrom(tokenId),
    // No rarity-tier data exposed in HOODCHAN's metadata (unlike
    // OnChainHoodies' indexer-computed tiers) - honest 0 rather than a
    // guess. A collection with real rarity data would compute this from it,
    // same as onchainhoodies/index.js's rareTraitCountFrom.
    rareTraitCount: 0,
    previewImageUrl: token.image,
  };
}

export async function fetchFighterData(tokenId) {
  const token = await fetchTokenMetadata(tokenId);
  const imageUrl = await prepareHeadImage(token.image, config.headStyle);
  return {
    tokenId,
    name: token.name,
    archetypeKey: archetypeKeyFrom(tokenId),
    rareTraitCount: 0,
    imageUrl,
    avatarUrl: token.image,
    // h00dchan's own board/quote system doesn't exist yet at the contract
    // level (see the source app's README - "No AI, no posting, no database
    // yet") - nothing to pull a taunt from.
    taunt: null,
    talkHistory: [],
  };
}

export async function fetchWalletTokenIds(address) {
  return fetchWalletTokenIdsOnChain(address);
}

// Sequential 1-1200 range (totalSupply at mint - a couple of tokens have
// since been burned, see chain.js's header comment; hitting a burned ID
// just fails that one card's fetch, which renderPanel already handles by
// skipping it - no special-casing needed here).
const MAX_TOKEN_ID = 1200;

export function getFreePlayTokenIds(count) {
  const pool = new Set();
  while (pool.size < count) {
    pool.add(1 + Math.floor(Math.random() * MAX_TOKEN_ID));
  }
  return [...pool];
}

// Optional, not one of the 4 required exports (see ADAPTERS.md and
// onchainhoodies/index.js's own verifyOwnership for why this checks the
// contract directly rather than a REST/indexer source).
export async function verifyOwnership(tokenId, address) {
  const owner = await readOwnerOf(tokenId);
  return owner.toLowerCase() === address.toLowerCase();
}
