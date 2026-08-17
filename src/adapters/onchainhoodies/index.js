// OnChainHoodies collection adapter - see ../../../ADAPTERS.md for the
// contract this (and any other adapter) must satisfy. This is the original
// collection pfp-brawl was built for; everything OnChainHoodies-specific
// (their REST API, their on-chain contract, their trait schema) lives only
// in this folder.

import * as restApi from "./api.js";
import * as chain from "./chain.js";

export const config = {
  key: "onchainhoodies",
  name: "OnChainHoodies",
  siteTitle: "Hood Vs Hood",
  unitName: "Hoodie",
  unitNamePlural: "Hoodies",
  hypeLines: [
    "Choose how you want to play:",
    "Two Hoodies enter. One AI leaves in pieces.",
    "Free to play, or bring your own Hoodie.",
  ],
  collectionUrl: "https://opensea.io/collection/onchainhoodies-",
  collectionCta: "GET A HOODIE ON OPENSEA",
  walletPlayDesc: "Use your own Hoodie NFT to fight.",
  // Wallet-connect requires switching the visitor's wallet to this chain -
  // omit this whole field for a collection/adapter that doesn't support
  // wallet-connect at all (main.js hides that option when it's missing).
  chain: {
    chainIdHex: "0x1237", // 4663
    chainName: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
  },
};

// The trait that actually holds one of this engine's 4 fixed archetype
// names (Builder/Flipper/Hodler/Collector, see fighter.js's ARCHETYPES) -
// OnChainHoodies' own "hoodie" trait already lines up 1:1, so no real
// mapping is needed here. A collection whose traits DON'T already match
// those 4 names needs to translate here instead (e.g. a rarity tier or
// class trait bucketed into one of the 4 slots) - see the template adapter
// for a worked example of that.
function archetypeKeyFrom(traits) {
  return traits?.hoodie ?? "Builder";
}

function rareTraitCountFrom(traits) {
  const { dress, mouth, top, eyes } = traits ?? {};
  return [dress, mouth, top, eyes].filter((t) => t?.tier === "Rare").length;
}

// Only the REST API's own connectivity failures fall back to on-chain reads
// - a real 404/error response (token genuinely doesn't exist) stays as-is
// rather than silently retrying a different way.
async function withChainFallback(restCall, chainCall) {
  try {
    return await restCall();
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("Can't reach")) throw err;
    console.warn("[onchainhoodies] REST API unreachable, falling back to on-chain read");
    return chainCall();
  }
}

export async function fetchTokenPreview(tokenId) {
  const token = await withChainFallback(
    () => restApi.fetchToken(tokenId),
    () => chain.fetchTokenOnChain(tokenId),
  );
  return {
    tokenId,
    name: token.token?.name ?? `#${tokenId}`,
    archetypeKey: archetypeKeyFrom(token.traits),
    rareTraitCount: rareTraitCountFrom(token.traits),
    previewImageUrl: token.image?.svg ?? "",
  };
}

export async function fetchFighterData(tokenId) {
  const token = await withChainFallback(
    () => restApi.fetchToken(tokenId),
    () => chain.fetchTokenOnChain(tokenId),
  );
  const [imageUrl, taunt, talkHistory] = await Promise.all([
    restApi.fetchTransparentHeadDataUri(token.image.svg),
    restApi.fetchHoodTalk(tokenId).catch(() => null),
    restApi.fetchHoodTalkHistory(tokenId).catch(() => []),
  ]);
  return {
    tokenId,
    name: token.token?.name ?? `#${tokenId}`,
    archetypeKey: archetypeKeyFrom(token.traits),
    rareTraitCount: rareTraitCountFrom(token.traits),
    imageUrl,
    // The original, unmodified token art - NOT the background-stripped/
    // head-shape-cropped imageUrl above (that's built for compositing a
    // floating head onto the body sprite, not for standing alone). The HUD
    // PFP just wants the real image circle-cropped via CSS, background and
    // all, like any normal avatar.
    avatarUrl: token.image?.svg ?? "",
    taunt,
    talkHistory,
  };
}

export async function fetchWalletTokenIds(address) {
  return withChainFallback(
    () => restApi.fetchWalletHoodies(address),
    () => chain.fetchWalletTokenIdsOnChain(address),
  );
}

// Sequential 0-5999 range (see their own openapi.json) - 1-based sampling is
// carried over unchanged from the original free-play pool (#0 exists
// on-chain but was never actually offered here). A collection whose IDs
// aren't a clean numeric range - the template adapter's fixed list, for
// instance - would sample from its own known ID list here instead.
const MAX_TOKEN_ID = 5999;

export function getFreePlayTokenIds(count) {
  const pool = new Set();
  while (pool.size < count) {
    pool.add(1 + Math.floor(Math.random() * MAX_TOKEN_ID));
  }
  return [...pool];
}
