// Single swap point - change this one import to point the whole game at a
// different NFT collection. Nothing outside src/adapters/ should ever
// import a specific adapter directly; everything (main.js, fighter.js)
// goes through activeAdapter so swapping collections never touches game
// logic. See ADAPTERS.md at the repo root for what an adapter must export.
import * as onchainhoodies from "./onchainhoodies/index.js";
// import * as hoodchan from "./hoodchan/index.js"; // try this one instead

export const activeAdapter = onchainhoodies;
