# Writing a collection adapter

The engine (`src/fighter.js`, `src/game.js`, `src/body.js`, `src/ai.js`, `src/main.js`) knows nothing about any specific NFT collection. Everything collection-specific - what a token's art looks like, where it comes from, what its traits mean, how wallet ownership is checked - lives behind a single **adapter** module. Swapping the game to a different collection means writing one new adapter and changing one import line (`src/adapters/index.js`); nothing else in the codebase needs to change.

Three adapters exist today:

- `src/adapters/onchainhoodies/` - the real thing this game was built for. REST API + on-chain fallback, real trait data, wallet-connect on Robinhood Chain, `headStyle: "cropped"`.
- `src/adapters/hoodchan/` - a second real collection (HOODCHAN, same chain, different contract), added specifically to test how this adapter system holds up against a collection with none of OnChainHoodies' conveniences: no REST API (on-chain only), no natural 4-archetype trait, and photographic/collage art instead of isolated vector art - hence `headStyle: "circle"` (see below).
- `src/adapters/template/` - a minimal, fully working example with zero network calls (a static in-repo list, placeholder art generated on the fly). Copy this folder as your starting point if you don't have a real collection wired up yet.

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
| `headStyle` | yes | `"cropped"` or `"circle"` - see below |
| `chain` | no | `{chainIdHex, chainName, nativeCurrency, rpcUrls, blockExplorerUrls}` - **omit this field entirely if your collection has no wallet-connect support yet**. `main.js` hides "Connect Wallet" whenever `config.chain` is missing, and `wallet.js` never gets called without one |

### `headStyle` - the one question that decides it: can this art's background be cleanly removed?

- **Yes** (isolated vector art, a flat/solid background layer you can programmatically strip) → `"cropped"`. Produces a tight head+shoulders cutout that sits seamlessly on the body sprite's neck. See `onchainhoodies/index.js` + `api.js`'s `fetchTransparentHeadDataUri` for a full worked example (strip a known SVG background pattern, then hand off to the shared cropper).
- **No** (photographic art, busy collage art, anything with a background you can't isolate) → `"circle"`. Skips background removal entirely and circle-crops the whole image with a border, like a normal avatar badge. This is the safe default for a collection you haven't written custom background-removal logic for - see `hoodchan/index.js`, whose art is a real meme photo with a cartoon face pasted on top and no way to cut out "just the head."

Both styles are one-line calls into `src/adapters/shared/head-image.js`, which every adapter should use rather than reimplementing:

```js
import { prepareHeadImage } from "../shared/head-image.js";
// ...
const imageUrl = await prepareHeadImage(alreadyBackgroundFreeImageUrl, config.headStyle); // "cropped"
const imageUrl = await prepareHeadImage(rawImageUrl, config.headStyle); // "circle" - no prep needed
```

`prepareHeadImage` just dispatches to `cropToHeadShape` or `circleFrameImage` based on the string - swapping a collection's `headStyle` from `"cropped"` to `"circle"` (or back) is genuinely that one-word change, nothing else in the adapter needs to know or care.

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

## If your collection's art lives on IPFS

Skip this whole section if your collection is fully on-chain (like OnChainHoodies) or hosted on a normal HTTP server you control - you don't need any of this, just `fetch()` it directly.

If your `tokenURI` returns an `ipfs://` link instead (very common), read this first - **don't fetch IPFS gateways directly from the browser.** Two real problems show up immediately if you do, both hit and fixed while building the HOODCHAN adapter:

1. **CORS.** Most public IPFS gateways don't send an `Access-Control-Allow-Origin` header, so the browser silently blocks the request. Verified live: 4 of 5 major public gateways (`w3s.link`, `nftstorage.link`, `ipfs.io`, `gateway.pinata.cloud`) failed this way on every single request, for every CID tested - not occasionally, always.
2. **Reliability under load.** Even the one gateway that *does* work reliably fails sometimes under real traffic (a character-select page loading a dozen cards at once easily fires 20+ requests). Free public gateways are shared and rate-limited; this isn't a bug, it's just what "free and shared" means.

The fix already built into this repo: **`api/ipfs.js`**, a tiny serverless function that fetches from IPFS *server-side* (no browser, no CORS, ever) and hands the result back to your adapter over your own domain. Your adapter code never touches a gateway URL directly - it just calls this:

```js
// Instead of fetch(`https://some-gateway.io/ipfs/${cid}`) - don't do this
const res = await fetch(`/api/ipfs?path=${encodeURIComponent(cid)}`);
```

That's the entire integration. It works with **zero configuration** - `api/ipfs.js` already races 5 public gateways for you and retries once on failure. Ship it as-is and it'll work.

### Making it fast (recommended for any real deployment)

The zero-config path above is fine for trying things out, but free public gateways are genuinely not fast or reliable enough for a real, shipped game - people will sit on a loading spinner. The fix takes about 5 minutes and costs a few dollars a month:

1. Go to **[pinata.cloud](https://pinata.cloud)** and make an account (or use one you already have).
2. In the Pinata dashboard, go to **Gateways** and create a new **Dedicated Gateway**. Pinata gives it a domain that looks like `something-something-123.mypinata.cloud` - copy that.
3. Still in the dashboard, go to **API Keys** (or your gateway's own settings) and create a **Gateway Access Token** - this is different from a regular Pinata API key, look specifically for "gateway access token." Copy it.
4. In your Vercel project (Settings → Environment Variables), add two variables:

   | Variable | Value |
   | --- | --- |
   | `PINATA_GATEWAY_DOMAIN` | the domain from step 2, e.g. `something-something-123.mypinata.cloud` |
   | `PINATA_GATEWAY_TOKEN` | the token from step 3 |

5. Redeploy. That's it - `api/ipfs.js` automatically detects these two variables and tries your dedicated gateway first, before ever touching a public one. Nothing in your adapter code changes; you don't need to know this happened.

If you don't set these two variables, the app still works - it just falls back to the free public gateways (slower, occasionally flaky) instead of failing. There is no scenario where forgetting this step breaks the app; it only makes it faster.

Using a different dedicated-gateway provider than Pinata? `api/ipfs.js` is one small function - swap the URL template in `dedicatedGateway()` for whatever your provider's docs show, same idea either way (a domain + a token/query-param, appended to the CID path).

## What never needs to change

`body.js`'s sprite sheets/animations, `fighter.js`'s combat constants and the `ARCHETYPES` multiplier table, and all of `game.js`/`ai.js` - none of it reads anything adapter-specific. They only ever see the normalized shape above.
