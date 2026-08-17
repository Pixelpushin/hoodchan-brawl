# Writing a collection adapter

The engine (`src/fighter.js`, `src/game.js`, `src/body.js`, `src/ai.js`, `src/main.js`) knows nothing about any specific NFT collection. Everything collection-specific - what a token's art looks like, where it comes from, what its traits mean, how wallet ownership is checked - lives behind a single **adapter** module. Swapping the game to a different collection means writing one new adapter and changing one import line (`src/adapters/index.js`); nothing else in the codebase needs to change.

Two adapters exist today:

- `src/adapters/onchainhoodies/` - the real thing this game was built for. REST API + on-chain fallback, real trait data, wallet-connect on Robinhood Chain.
- `src/adapters/template/` - a minimal, fully working example with zero network calls (a static in-repo list, placeholder art generated on the fly). Copy this folder as your starting point.

Switch which one is active by editing `src/adapters/index.js`:

```js
import * as onchainhoodies from "./onchainhoodies/index.js";
import * as yourCollection from "./your-collection/index.js";

export const activeAdapter = yourCollection; // was onchainhoodies
```

## The 4 fixed archetypes

The engine has exactly 4 archetype slots, each with its own stat multipliers and special attack (see `fighter.js`'s `ARCHETYPES` map and `body.js`'s sprite states): **Builder**, **Flipper**, **Hodler**, **Collector**. These are not adapter-configurable - they're baked into the combat system and the sprite sheets. Every token your adapter returns must be assigned to exactly one of these 4 names via `archetypeKey`.

If your collection's traits don't already map cleanly onto 4 buckets, you decide the mapping - by rarity tier, by a specific trait, by token ID range, whatever makes sense. That logic lives entirely inside your adapter (see `onchainhoodies/index.js`'s `archetypeKeyFrom` for the simplest possible case, where the mapping is already 1:1).

## What an adapter exports

A `config` object (branding/behavior flags) plus 4 functions. See `src/adapters/template/index.js` for a fully working, heavily-commented reference implementation of all of it.

### `config`

| Field | Required | Meaning |
| --- | --- | --- |
| `key` | yes | Short internal id, e.g. `"onchainhoodies"` |
| `name` | yes | Collection display name |
| `siteTitle` | yes | Page `<title>` and hero heading |
| `unitName` / `unitNamePlural` | yes | Singular/plural noun used in UI copy ("No Fighters in this wallet yet") |
| `hypeLines` | yes | Array of strings, one shown at random above the play buttons |
| `collectionUrl` / `collectionCta` | no | Marketplace link + button text. Omit `collectionUrl` (empty string) to hide that link entirely |
| `walletPlayDesc` | yes | One-line description on the wallet-connect card |
| `chain` | no | `{chainIdHex, chainName, nativeCurrency, rpcUrls, blockExplorerUrls}` - **omit this field entirely if your collection has no wallet-connect support yet**. `main.js` hides "Connect Wallet" whenever `config.chain` is missing, and `wallet.js` never gets called without one |

### `fetchTokenPreview(tokenId)`

Cheap, used for the character-select grid thumbnails (dozens fetched per page load). Returns:

```js
{ tokenId, name, archetypeKey, rareTraitCount, previewImageUrl }
```

### `fetchFighterData(tokenId)`

Expensive, called once for whichever token a player actually selects. Returns everything `fetchTokenPreview` does, plus:

```js
{
  ...previewFields,
  imageUrl,      // head art composited onto the body sprite during a match
  avatarUrl,     // full art shown as the HUD portrait (can equal imageUrl)
  taunt,         // string shown as the pre-fight speech bubble, or null
  talkHistory,   // array of past quote strings for the post-round victory line, or []
}
```

`imageUrl` doesn't need to be pre-cropped to a head shape - `onchainhoodies/api.js`'s `fetchTransparentHeadDataUri` shows one way to do that at fetch time if your source art is a full bust/portrait rather than an isolated head.

### `fetchWalletTokenIds(address)`

Returns an array of token IDs a wallet address owns. Return `[]` (not an error) for "connected fine, owns nothing" - `main.js` already treats an empty array as the wallet-play-but-no-tokens case, dropping the visitor into free play instead. Only reject/throw for an actual failure (RPC down, address malformed).

### `getFreePlayTokenIds(count)`

Returns up to `count` token IDs to populate the "Play Free" random-sample pool. For a large sequential ID range, sample randomly (see `onchainhoodies/index.js`). For a small fixed collection, shuffle/cycle the known list instead (see `template/index.js`) - whichever makes sense for how your collection's IDs actually work.

## What never needs to change

`body.js`'s sprite sheets/animations, `fighter.js`'s combat constants and the `ARCHETYPES` multiplier table, and all of `game.js`/`ai.js` - none of it reads anything adapter-specific. They only ever see the normalized shape above.
