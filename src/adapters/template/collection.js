// Stand-in "collection" for the template adapter - plain data, no API, no
// contract, no network calls at all. Swap this for a real fetch() against
// your own API/subgraph, or keep something like this if your collection's
// metadata is small enough to just ship as a static file.
//
// Each entry only needs to carry enough to satisfy the engine's fixed
// 4-archetype system (see ../../fighter.js's ARCHETYPES) - archetypeKey
// must be exactly one of "Builder"/"Flipper"/"Hodler"/"Collector". Map
// whatever trait/rarity/class system your own collection actually has onto
// those 4 slots (see index.js's archetypeKeyFrom for where that mapping
// would go once you're pulling from a real source).
export const COLLECTION = [
  { tokenId: 1, name: "Ironhead", archetypeKey: "Builder", color: "#e8643c", rare: false },
  { tokenId: 2, name: "Rivet", archetypeKey: "Builder", color: "#c8502e", rare: true },
  { tokenId: 3, name: "Foreman", archetypeKey: "Builder", color: "#f2814f", rare: false },
  { tokenId: 4, name: "Zipline", archetypeKey: "Flipper", color: "#3ca8e8", rare: false },
  { tokenId: 5, name: "Quickswap", archetypeKey: "Flipper", color: "#2e8ac8", rare: true },
  { tokenId: 6, name: "Turnstile", archetypeKey: "Flipper", color: "#4fb8f2", rare: false },
  { tokenId: 7, name: "Vault", archetypeKey: "Hodler", color: "#4ce87c", rare: false },
  { tokenId: 8, name: "Diamond Paws", archetypeKey: "Hodler", color: "#2ec860", rare: true },
  { tokenId: 9, name: "Bedrock", archetypeKey: "Hodler", color: "#6ff29c", rare: false },
  { tokenId: 10, name: "Curator", archetypeKey: "Collector", color: "#c86ce8", rare: false },
  { tokenId: 11, name: "Archivist", archetypeKey: "Collector", color: "#a84ec8", rare: true },
  { tokenId: 12, name: "Cataloguer", archetypeKey: "Collector", color: "#e08ff2", rare: false },
];
