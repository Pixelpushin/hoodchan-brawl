# Hood Vs Hood

![Hood Vs Hood logo](assets/branding/logo.png)

A browser fighting game built on top of [OnChainHoodies](https://onchainhoodies.xyz) — pick a Hoodie token ID (or connect a wallet and fight as one you actually hold), their real on-chain art becomes the fighter's head, and their archetype and Hood Talk quotes drive gameplay. No wallet writes, no wagering, nothing on-chain from this game itself — purely social.

Play: [hoodvshood.lol](https://hoodvshood.lol)

## How it works

- **Free play**: pick any two Hoodie token IDs and fight the AI. No wallet needed.
- **Wallet play**: connect a wallet, and if it holds any OnChainHoodies, pick one to fight as against the AI. Ownership is read directly from-chain (Robinhood Chain, contract `0x9ec6c5...735f45`) if the OnChainHoodies API is down, so wallet play still works either way.
- Archetype (Builder/Flipper/Hodler/Collector) drives a fighter's stats *and* their special attack:
  - **Builder** — hits harder, and their special is a big flying high kick.
  - **Flipper** — moves faster, and their special is a Hood Rat Rush (a rat swarm charging along the ground).
  - **Hodler** — more health, and their special is a low sweep kick that blocks incoming hits and stops an opponent's slide dead.
  - **Collector** — blocks better, and their special is the long-range bolt.
  - Rare-tier traits add a small health bonus on top.
- Punch is free and builds your power meter slowly; landing hits and successful blocks build it faster. Kick, slide, uppercut, and special all spend power or carry real risk on a whiff.
- Jump high enough to cross over an opponent; slide low enough to pass under one who jumps. See the in-game controls legend for the full move list.

## Run it locally

No build step, no dependencies — plain HTML/JS/Canvas, ES modules throughout.

```bash
python3 -m http.server 8420
```

Then open `http://localhost:8420`.

## Verifying the live site

This matters most if you're deciding whether to connect a wallet: [hoodvshood.lol](https://hoodvshood.lol) never writes to your wallet or requests a signature for anything beyond reading your address, but you shouldn't have to take that on faith.

- **Quick check**: every page load shows a footer at the bottom - "Running commit `<sha>`" - linking straight to that exact commit on GitHub. Click through and read the real source, particularly `src/wallet.js` (all it does is `eth_requestAccounts` and a chain switch) and `src/chain.js`/`src/api.js` (read-only lookups, no writes).
- **Byte-for-byte check**: this is a zero-build static site - the deployed JS *is* the source JS, nothing is bundled or transformed. Pick any file and diff it against the commit shown in the footer:

  ```bash
  curl -s https://hoodvshood.lol/src/wallet.js -o live.js
  curl -s https://raw.githubusercontent.com/Pixelpushin/hoodies-fight/<commit-sha>/src/wallet.js -o repo.js
  diff live.js repo.js  # no output = identical
  ```

- **Cryptographic check**: every deploy is built inside a GitHub Actions runner (not on Vercel's own infra) and signed with a [build provenance attestation](https://github.com/Pixelpushin/hoodies-fight/attestations) before that exact build is pushed to Vercel unmodified (`vercel deploy --prebuilt`) - so the attestation actually covers what's live, not just what GitHub happened to build somewhere. See [docs/SITE-INTEGRITY-RESEARCH.md](docs/SITE-INTEGRITY-RESEARCH.md) for what this does and doesn't cover.

## Project layout

```text
index.html          Markup + setup/arena screens
style.css            All styling
src/main.js          Setup flow, wallet/local routing, round loop
src/game.js           Per-frame combat loop: hit detection, physics, FX
src/fighter.js        Fighter state machine (moves, damage, archetypes)
src/body.js           Sprite sheets, animation lookup, canvas drawing
src/ai.js             AI opponent controller
src/api.js            OnChainHoodies API client + head-art cropping
src/chain.js          Raw JSON-RPC on-chain fallback (no wallet needed)
src/wallet.js         EIP-1193 wallet connect + chain switching
src/sound.js           SFX playback
src/tts.js             Spoken taunts/victory lines
assets/               Sprite sheets, backgrounds, FX, sounds, branding
api/                  Serverless functions backing the match-record API (see below)
openapi.json          API spec for api/
```

## Hood Vs Hood API

The game keeps a lightweight, ambient win/loss record per Hoodie token ID - full spec at [openapi.json](https://hoodie.wtf/openapi.json).

- `GET /api/hoodie/{tokenId}/stats` - wins/losses/matches for one Hoodie
- `GET /api/matches/recent?limit=25` - newest completed matches across all Hoodies
- `POST /api/match-result` - called by the game client itself when a match ends

Unauthenticated by design, same trust model as everything else here (no wallet writes, nothing on-chain) - treat it as a fun social signal, not a verified competitive record. Backed by a small Redis store (`api/_lib/redis.js` talks to it over plain REST - no npm client, same zero-dependency approach as the rest of the repo).

## License

The **code** in this repo is public domain (CC0) — see [LICENSE](LICENSE). Fork it, remix it, ship your own version, no permission needed.

**Assets are not all CC0** - licensing is per-asset, not blanket:

- Character head art: pulled live from the OnChainHoodies API at runtime and never bundled in this repo - CC0, same as the collection itself.
- **All sound effects** are paid [Splice](https://splice.com) samples, and **all music tracks** are [Suno](https://suno.com)-generated - licensed for use *in* this game, but neither license permits redistributing the raw files. They're gitignored (never committed) and served from a Vercel Blob store instead of `assets/sounds/`/`assets/music/` (see `src/sound.js`'s `AUDIO_BASE`) - keeps the raw files out of git entirely, and out of the [build-attestation pipeline](docs/SITE-INTEGRITY-RESEARCH.md), which only ever sees what's actually committed. (An earlier version of this README incorrectly credited the sound effects as CC0 Kenney packs - that was wrong, fixed here.) If you fork this repo, swap `AUDIO_BASE` for your own storage and supply your own audio, or leave it as-is and it'll just hotlink our copy - the game already treats a missing/failed clip as a soft warning, not a crash, so it degrades fine either way.
- Fighter sprite sheets (idle/walk/attack/kick/jump/hurt/crouch/block/spellcast, `assets/sprites/`) and both arena backgrounds (`assets/backgrounds/arena-2.png`, `arena-3.png`): AI-generated via SpriteCook.
- `assets/backgrounds/arena.png` (unused, kept for reference): generated on Pixellab.
- A handful of other sprite sheets (slide/knockback/uppercut/flex/rat-rush) have **unconfirmed provenance/licensing** and should not be assumed reusable - don't lift these into your own project without checking first. If you're forking this repo, swap them for something you know the rights to.

CC0 (on the code) means credit is never legally required - if you build on this, a mention is appreciated but entirely up to you.

## Contributing

This is meant to be built on, not gatekept. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up and what kinds of PRs are useful.

## Credits

- Built by [Pixelpushin](https://github.com/Pixelpushin) - vibe-coded with [Claude Code](https://claude.com/claude-code), for better or worse
- Character art: [OnChainHoodies](https://onchainhoodies.xyz) (CC0)
- Sound effects: [Splice](https://splice.com) (licensed, not redistributed - see License section)
- Music: [Suno](https://suno.com) (licensed, not redistributed - see License section)
