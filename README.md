# HOODCHAN Brawl

![HOODCHAN Brawl logo](assets/branding/logo.png)

A browser fighting game for holders of the [HOODCHAN](https://opensea.io/collection/h00dchan) collection — pick an Anon (or connect a wallet and fight as one you actually hold), their real art becomes the fighter's head, and one of 4 fixed archetypes (Builder/Flipper/Hodler/Collector) drives their stats and special attack. No wallet writes, no wagering, nothing on-chain from this game itself — purely social.

Play: [brawl.hoodchan.org](https://brawl.hoodchan.org)

Built on [pfp-brawl](https://github.com/Pixelpushin/pfp-brawl), a generalized version of this same engine that can plug in any NFT collection - this repo is that engine with the [HOODCHAN adapter](src/adapters/hoodchan/) (`src/adapters/index.js`) as the only thing swapped in. See pfp-brawl's own [ADAPTERS.md](https://github.com/Pixelpushin/pfp-brawl/blob/main/ADAPTERS.md) if you want to do the same thing for a different collection - genuinely just fork, write one adapter file, change one import line.

## How it works

- **Free play**: pick any two tokens from the active adapter's collection and fight the AI. No wallet needed.
- **Wallet play** (if the active adapter supports it): connect a wallet, and if it holds any tokens from that collection, pick one to fight as against the AI.
- Archetype (Builder/Flipper/Hodler/Collector) drives a fighter's stats *and* their special attack - fixed by the engine, not by whichever collection is plugged in:
  - **Builder** — hits harder, and their special is a big flying high kick.
  - **Flipper** — moves faster, and their special is a rat-rush-style swarm charging along the ground.
  - **Hodler** — more health, and their special is a low sweep kick that blocks incoming hits and stops an opponent's slide dead.
  - **Collector** — blocks better, and their special is the long-range bolt.
  - Rare-tier traits (if the active collection has them) add a small health bonus on top.
- Punch is free and builds your power meter slowly; landing hits and successful blocks build it faster. Kick, slide, uppercut, and special all spend power or carry real risk on a whiff.
- Jump high enough to cross over an opponent; slide low enough to pass under one who jumps. See the in-game controls legend for the full move list.

## Run it locally

No build step, no dependencies — plain HTML/JS/Canvas, ES modules throughout.

```bash
python3 -m http.server 8420
```

Then open `http://localhost:8420`. Ships with the OnChainHoodies adapter active by default (`src/adapters/index.js`) - swap the one import there to try `src/adapters/template/` instead, no API/wallet/keys needed for that one.

## Deploying

Live at [brawl.hoodchan.org](https://brawl.hoodchan.org) - a dedicated Vercel project (separate from both hoodies-fight's and pfp-brawl's own), with `brawl.hoodchan.org` as a custom domain and `VERCEL_TOKEN`/`VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` set as repo secrets so [.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds/attests/deploys on every push to `main` (see that file's own comments - it deliberately fails closed rather than falling back to any other project). The HOODCHAN adapter needs no API keys of its own (on-chain + public IPFS gateways only). If X account linking is wanted later, set the env vars documented below.

## Verifying a live deploy

Once deployed, the same verification story hoodies-fight uses applies here unchanged - worth checking before connecting a wallet to any instance of this game, this repo included:

- **Quick check**: every page load shows a footer at the bottom - "Running commit `<sha>`" - linking straight to that exact commit on GitHub. Click through and read the real source, particularly `src/wallet.js` (all it does is `eth_requestAccounts` and a chain switch) and the active adapter's own fetch code (read-only lookups, no writes).
- **Byte-for-byte check**: this is a zero-build static site - the deployed JS *is* the source JS, nothing is bundled or transformed. Pick any file and diff it against the commit shown in the footer:

  ```bash
  curl -s https://<your-deployment-domain>/src/wallet.js -o live.js
  curl -s https://raw.githubusercontent.com/Pixelpushin/hoodchan-brawl/<commit-sha>/src/wallet.js -o repo.js
  diff live.js repo.js  # no output = identical
  ```

- **Cryptographic check**: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds inside a GitHub Actions runner (not on Vercel's own infra) and signs a build provenance attestation before that exact build is pushed to Vercel unmodified (`vercel deploy --prebuilt`) - so the attestation actually covers what's live, not just what GitHub happened to build somewhere. See [docs/SITE-INTEGRITY-RESEARCH.md](docs/SITE-INTEGRITY-RESEARCH.md) for what this does and doesn't cover.

## Project layout

```text
index.html               Markup + setup/arena screens
style.css                All styling
src/main.js               Setup flow, wallet/local routing, round loop
src/game.js                Per-frame combat loop: hit detection, physics, FX
src/fighter.js              Fighter state machine (moves, damage, archetypes)
src/body.js                 Sprite sheets, animation lookup, canvas drawing
src/ai.js                   AI opponent controller
src/api.js                  This project's own match-record backend client only
src/wallet.js                EIP-1193 wallet connect + chain switching (chain-agnostic)
src/sound.js                  SFX playback
src/tts.js                    Spoken taunts/victory lines
src/adapters/                 Collection adapters - see ADAPTERS.md
  adapters/index.js             Single swap point - which adapter is active
  adapters/onchainhoodies/      Default adapter: REST API + on-chain fallback
  adapters/template/            Minimal working example, zero network calls
assets/                    Sprite sheets, backgrounds, FX, sounds, branding
api/                       Serverless functions backing this project's own backend (see below)
openapi.json               API spec for api/
ADAPTERS.md                How to plug in a different NFT collection
```

## This project's own API

A lightweight, ambient win/loss record per token ID, plus optional X account linking - full spec at [openapi.json](openapi.json).

- `GET /api/hoodie/{tokenId}/stats?adapter=<key>` - wins/losses/matches for one token
- `GET /api/matches/recent?limit=25&adapter=<key>` - newest completed matches for one adapter's collection
- `POST /api/match-result` - called by the game client itself when a match ends, body includes `adapter`

Namespaced per adapter (`adapter` matches that adapter's own `config.key` from `src/adapters/*/index.js`) so two different collections' token #42 never share a record. `adapter` is optional on every route and defaults to `onchainhoodies` - that adapter specifically keeps its original unprefixed Redis keys rather than moving to the new `stats:{adapter}:...` scheme, since hoodies-fight's live deployment already has real accumulated win/loss data under those exact keys (see `api/_lib/stats-keys.js`).

Unauthenticated by design, same trust model as everything else here (no wallet writes, nothing on-chain) - treat it as a fun social signal, not a verified competitive record. Backed by a small Redis store (`api/_lib/redis.js` talks to it over plain REST - no npm client, same zero-dependency approach as the rest of the repo). The active adapter needs `KV_REST_API_URL`/`KV_REST_API_TOKEN` set (Vercel's Upstash-for-Redis integration) for this API to work at all - without it, `reportMatchResult` calls still fire from the client (fire-and-forget, never blocks a match) but just fail silently server-side.

### X account linking

Lets a visitor attach their X (Twitter) handle to whatever wallet address they connected, so it can be shown as a display label elsewhere in the app - same ambient/unauthenticated trust model as the rest of this API, not an account system.

- `GET /api/x-auth/start?address=0x...` - kicks off X's OAuth 2.0 Authorization Code + PKCE flow, redirects to X's consent screen
- `GET /api/x-auth/callback` - X redirects back here with a code; exchanged for the account's `@handle`, stored against the wallet address, then redirects to `/?xLinked=<handle>` (or `/?xLinkError=<reason>`)
- `GET /api/wallet/{address}/x-handle` - read the linked handle for a wallet, if any

Requires these environment variables (Vercel project settings, not committed anywhere):

| Variable | Where it comes from |
| --- | --- |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash-for-Redis Vercel integration (auto-injected) |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | console.x.com → app → Keys & Tokens → OAuth 2.0 Keys |
| `X_AUTH_REDIRECT_URI` | This deployment's own `/api/x-auth/callback` URL - must exactly match a callback URL registered in that same X app's User authentication settings |

### IPFS proxy

`api/ipfs.js` is a general-purpose server-side IPFS proxy (see [ADAPTERS.md](https://github.com/Pixelpushin/pfp-brawl/blob/main/ADAPTERS.md)'s "If your collection's art lives on IPFS" section for the full why/how) - HOODCHAN's art lives on IPFS, so this deployment needs it. Works with zero configuration; this deployment also sets two optional variables that make it meaningfully faster and more reliable by trying a paid dedicated gateway before the free public ones:

| Variable | Where it comes from |
| --- | --- |
| `PINATA_GATEWAY_DOMAIN` / `PINATA_GATEWAY_TOKEN` | pinata.cloud → Gateways → dedicated gateway's domain + a Gateway Access Token |

## License

The **code** in this repo is [AGPL-3.0](LICENSE), not the CC0/public-domain license hoodies-fight uses - a deliberate choice for this fork specifically. AGPL means if you run a modified version of this game as a network service (host it for others to play), you have to make your modified source available too - it closes the "clone it, reskin it, host a competitor, never give anything back" loophole that a plain permissive license leaves open for a web app like this. You can still fork it, remix it, and run it privately with no obligations; the copyleft only kicks in once you're serving a modified version to others over a network.

**Assets are not all under the code's license** - licensing is per-asset, not blanket, and doesn't change based on which repo the files sit in:

- Character head art for the default OnChainHoodies adapter: pulled live from the OnChainHoodies API at runtime and never bundled in this repo - CC0, same as the collection itself. (A different adapter's art has whatever license that collection/source uses - see its own config/code.)
- **All sound effects** are paid [Splice](https://splice.com) samples, and **all music tracks** are [Suno](https://suno.com)-generated - licensed for use *in* this game, but neither license permits redistributing the raw files. They're gitignored (never committed) and served from a Vercel Blob store instead of `assets/sounds/`/`assets/music/` (see `src/sound.js`'s `AUDIO_BASE`) - keeps the raw files out of git entirely, and out of the build-attestation pipeline, which only ever sees what's actually committed. If you fork this repo, swap `AUDIO_BASE` for your own storage and supply your own audio, or leave it as-is and it'll just hotlink the original's copy - the game already treats a missing/failed clip as a soft warning, not a crash, so it degrades fine either way.
- Fighter sprite sheets (idle/walk/attack/kick/jump/hurt/crouch/block/spellcast, `assets/sprites/`) and both arena backgrounds (`assets/backgrounds/arena-2.png`, `arena-3.png`): AI-generated via SpriteCook.
- `assets/backgrounds/arena.png` (unused, kept for reference): generated on Pixellab.
- A handful of other sprite sheets (slide/knockback/uppercut/flex/rat-rush) have **unconfirmed provenance/licensing** and should not be assumed reusable - don't lift these into your own project without checking first. If you're forking this repo, swap them for something you know the rights to.

## Contributing

This is meant to be built on, not gatekept. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up and what kinds of PRs are useful, and [ADAPTERS.md](ADAPTERS.md) if you're plugging in your own collection.

## Credits

- Built by [Pixelpushin](https://github.com/Pixelpushin) - vibe-coded with [Claude Code](https://claude.com/claude-code), for better or worse
- Forked from [hoodies-fight](https://github.com/Pixelpushin/hoodies-fight)
- Default adapter's character art: [OnChainHoodies](https://onchainhoodies.xyz) (CC0)
- Sound effects: [Splice](https://splice.com) (licensed, not redistributed - see License section)
- Music: [Suno](https://suno.com) (licensed, not redistributed - see License section)
