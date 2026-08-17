# Contributing to PFP Brawl

This is meant to be built on, not gatekept. AGPL-3.0 (see [LICENSE](LICENSE)) already grants you the right to fork, remix, and run your own version — the license only asks that a modified version served to others over a network stays source-available too, not that you send anything back here. PRs are still very welcome if you'd rather contribute upstream.

## Getting set up

No build step, no package manager, no dependencies to install.

```bash
git clone https://github.com/Pixelpushin/pfp-brawl.git
cd pfp-brawl
python3 -m http.server 8420
```

Open `http://localhost:8420`. Edit a file, refresh the tab - that's the whole loop.

## What's useful to work on

- A new collection adapter (see [ADAPTERS.md](ADAPTERS.md)) - this is the single most useful kind of PR, and the whole point of this fork existing separately from hoodies-fight
- New moves, archetypes, or rebalancing existing ones
- Better/replacement sprite animations (see `src/body.js` for how sheets and anchors are wired up)
- AI opponent improvements (`src/ai.js`)
- Generalizing the match-record API (`api/`) so it's namespaced per-adapter instead of hardcoded to OnChainHoodies - see the README's "Known limitation" note
- Bug fixes - if something looks wrong in a fight, it probably is
- Accessibility, mobile/touch controls, remappable keys

Please don't open a PR for wallet-write functionality, wagering, or anything that puts real value at stake - this game intentionally stays read-only on-chain.

## Code conventions

- Plain ES modules, no build tooling, no npm dependencies - keep it that way
- No comments unless the *why* is genuinely non-obvious (a subtle invariant, a workaround for a specific bug) - well-named code should speak for itself
- Match the existing style in whichever file you're touching rather than introducing a new pattern
- Collection-specific logic belongs in `src/adapters/`, never in `src/main.js`/`src/fighter.js`/`src/game.js` directly - see ADAPTERS.md

## Sprite sheets and assets

Most animations are single-row sprite sheets sliced by a fixed `frameSize` (see the `SHEETS` map in `src/body.js`). If you're adding a new animation:

1. Drop the sheet in `assets/sprites/` (or `assets/fx/` for effects)
2. Add it to `SHEETS` with its frame size
3. Add a matching entry in `ANIMS` (frame count, duration, loop)
4. If it needs a head anchor (most character animations do), sample the neck/collar position per frame and add it to `HEAD_ANCHORS`

## Keeping your fork updated (balance patches, bug fixes, etc.)

This engine is going to change over time - move balance especially. Uppercut being free with no power cost was a real bug fixed here on 2026-08-17, and it won't be the last "hey, X move is broken" fix this repo needs. If you've forked this into your own repo for your own collection (which is exactly what [ADAPTERS.md](ADAPTERS.md) tells you to do), here's how to pull those fixes in without hand-copying files:

```bash
# One-time setup in your fork's clone
git remote add upstream https://github.com/Pixelpushin/pfp-brawl.git
git remote set-url --push upstream no_push   # never accidentally push here

# Whenever you want to pull in engine updates
git fetch upstream
git merge upstream/main
```

If your fork was created by copying files (`rsync`/download-and-recommit) rather than a real `git clone` + history, that first merge needs `--allow-unrelated-histories` and will conflict on whatever files you've customized (README, branding, `src/adapters/index.js` - anything with your collection's own info in it). That's expected and only happens once: resolve those conflicts by keeping your own version (`git checkout --ours <file>`) unless the upstream diff is something you actually want, commit, and push. Every merge after that first one is a normal, usually-conflict-free `git merge` - most of what changes in this repo over time is the engine (`src/fighter.js`/`src/game.js`/`src/body.js`/`src/ai.js`), which your fork almost certainly hasn't touched.

If you only want one specific fix rather than everything since your fork point, `git fetch upstream && git cherry-pick <commit-sha>` works too - find the commit on [pfp-brawl's commit history](https://github.com/Pixelpushin/pfp-brawl/commits/main) and cherry-pick just that one.

## Reporting bugs

Open an issue with what you did, what you expected, and what actually happened. A screenshot or short clip helps a lot for anything visual (animation timing, hitboxes, positioning).

## Credit

Not legally required (see License), but a mention in your own README/credits if you build on this is genuinely appreciated.
