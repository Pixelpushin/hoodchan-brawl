# Contributing to Hood Vs Hood

This is meant to be built on, not gatekept. No permission needed for anything the [CC0 license](LICENSE) already grants you — but if you'd rather send it upstream instead of maintaining your own fork, PRs are welcome.

## Getting set up

No build step, no package manager, no dependencies to install.

```bash
git clone https://github.com/Pixelpushin/hoodies-fight.git
cd hoodies-fight
python3 -m http.server 8420
```

Open `http://localhost:8420`. Edit a file, refresh the tab - that's the whole loop.

## What's useful to work on

- New moves, archetypes, or rebalancing existing ones
- Better/replacement sprite animations (see `src/body.js` for how sheets and anchors are wired up)
- AI opponent improvements (`src/ai.js`)
- Bug fixes - if something looks wrong in a fight, it probably is
- Accessibility, mobile/touch controls, remappable keys

Please don't open a PR for wallet-write functionality, wagering, or anything that puts real value at stake - this game intentionally stays read-only on-chain.

## Code conventions

- Plain ES modules, no build tooling, no npm dependencies - keep it that way
- No comments unless the *why* is genuinely non-obvious (a subtle invariant, a workaround for a specific bug) - well-named code should speak for itself
- Match the existing style in whichever file you're touching rather than introducing a new pattern

## Sprite sheets and assets

Most animations are single-row sprite sheets sliced by a fixed `frameSize` (see the `SHEETS` map in `src/body.js`). If you're adding a new animation:

1. Drop the sheet in `assets/sprites/` (or `assets/fx/` for effects)
2. Add it to `SHEETS` with its frame size
3. Add a matching entry in `ANIMS` (frame count, duration, loop)
4. If it needs a head anchor (most character animations do), sample the neck/collar position per frame and add it to `HEAD_ANCHORS`

## Reporting bugs

Open an issue with what you did, what you expected, and what actually happened. A screenshot or short clip helps a lot for anything visual (animation timing, hitboxes, positioning).

## Credit

CC0 means you never have to, but a mention in your own README/credits if you build on this is genuinely appreciated.
