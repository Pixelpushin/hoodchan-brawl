# PRD: Fighter & Arena Cosmetic Packs

**Applies to:** hoodies-fight (OnChainHoodies, Robinhood Chain) and pixelheros-fight (PixelHeros, Base/Vibe Market). Canonical copy lives here; pixelheros-fight should treat this the same way it treats [2.0-VISION.md](../docs/2.0-VISION.md) — a carried-over design doc to re-pass, not a spec to build blindly against, per [RESKIN-NOTES.md](../../pixelheros-fight/docs/RESKIN-NOTES.md).

## 1. Introduction/Overview

Cosmetic gacha packs bound to NFTs via their own [ERC-6551](https://eips.ethereum.org/EIPS/eip-6551) token-bound accounts (TBA). Two pack types: **Fighter Packs** (cosmetics for a fighter NFT) and **Arena Packs** (cosmetics for an arena NFT — a new asset type introduced by this PRD). Packs are cosmetic-only — no stat or power effect — keeping combat skill-based, matching the rarity-vs-power decoupling already recommended in RESKIN-NOTES.md. Packs are sealed, tradeable, and travel with whichever NFT they're minted into: selling a fighter or arena includes everything inside its TBA.

This builds directly on [2.0-VISION.md](../docs/2.0-VISION.md)'s existing soulbound-achievement pattern (mint to the NFT's own TBA, not the human wallet) and its "arenas as ownable NFTs" section — this PRD is what turns that speculative section into an actual asset class.

## 2. Goals

- Give fighter and arena NFTs an ongoing cosmetic progression system that increases their value/history when resold
- Let players earn packs through play as well as purchase them directly
- Keep cosmetics purely visual — no combat power effect — preserving skill-based fairness
- Establish Arena as a real NFT asset class (backdrop, buildings, cosmetics) with its own TBA, mirroring the fighter pattern
- Use provably-fair on-chain randomness for pack contents
- Keep pack/cosmetic data in a shape a future marketplace (the hoodiearcade.com concept from 2.0-VISION.md) can read, without building that marketplace here

## 3. Done looks like

- A fighter NFT has its own ERC-6551 TBA; opening a Fighter Pack mints the resulting cosmetic item(s) directly into that TBA, never into the human player's EOA.
- An arena NFT (new asset type) also has its own ERC-6551 TBA; opening an Arena Pack mints cosmetic items into the arena's TBA.
- Fighter Packs and Arena Packs are distinct token types — a Fighter Pack cannot be opened against an arena, and vice versa.
- A sealed pack is itself a transferable token sitting in the owning NFT's TBA; it can be sold while still sealed and unopened.
- Selling a fighter or arena NFT transfers everything inside its TBA — sealed packs, unwrapped cosmetics, prior soulbound achievement records — to the new owner in the same transaction.
- Players acquire packs two ways: paying native token directly for a pack, or earning one as a reward for a defined in-play milestone — both mint to the same TBA-bound path.
- Opening a pack triggers an on-chain randomness request (Pyth Entropy or Chainlink VRF); the cosmetic reveal only finalizes once randomness is fulfilled, never synchronously in the purchase/open transaction.
- Every pack has a published rarity table (tier name, drop %, example items) visible before purchase, sourced from the same config the unwrap logic reads.
- Cosmetic items have zero effect on any combat stat, hit detection, AI weighting, or match outcome — the combat engine never reads pack/cosmetic state.
- Equipping a cosmetic is a separate, free, reversible action from unwrapping — unwrap grants ownership, equip changes what's rendered.
- If randomness fulfillment fails or times out, the pack remains sealed and unopened — no partial or lost state; the player can retry.
- A wallet that doesn't own the NFT a pack is bound to cannot open, equip, or transfer that pack's cosmetics.

## 4. Out of scope

- Cosmetics or packs granting any stat, power, or matchmaking advantage
- Cross-game cosmetics (a Hoodies cosmetic does not apply to PixelHeros or vice versa)
- Cosmetic combine/upgrade/crafting mechanics
- Off-chain or server-authoritative randomness
- Fractional pack ownership or trading pack contents before mint completes
- Retired-fighter passive fee-share (already flagged as its own speculative mechanic in 2.0-VISION.md)
- Building the actual hoodiearcade.com marketplace — this PRD only requires readable, stable pack/cosmetic data
- Arena gameplay mechanics beyond cosmetics — arena selection logic, fee-splitting between arena owner and featured fighters (2.0-VISION.md flags this as its own complex system)

## 5. User Stories

### US-001: Fighter TBA cosmetic minting
**Description:** As a fighter NFT owner, I want cosmetics from packs to mint into my fighter's own wallet so the fighter's look and history travel with it if I sell it.

**Acceptance Criteria:**
- [ ] Opening a Fighter Pack mints the resulting item(s) into the fighter NFT's ERC-6551 TBA
- [ ] Item cannot be minted to the caller's EOA, even when the caller triggers the open on behalf of the TBA
- [ ] Contract unit tests cover the mint-to-TBA path
- [ ] Typecheck/lint passes

### US-002: Arena NFT + TBA contract
**Description:** As a product owner, I want arenas to exist as their own NFTs with ERC-6551 accounts so arena cosmetics have somewhere to live and travel with a sale.

**Acceptance Criteria:**
- [ ] Arena NFT contract deployed (ERC-721), mintable per the game's existing pattern
- [ ] Each arena token has a deterministic ERC-6551 TBA
- [ ] Arena ownership transfer moves TBA contents with it (verified by test)
- [ ] Typecheck/lint passes

### US-003: Pack purchase flow
**Description:** As a player, I want to buy a Fighter Pack or Arena Pack with native token so I can try for rare cosmetics on demand.

**Acceptance Criteria:**
- [ ] Purchase function accepts payment and mints a sealed pack token to the target NFT's TBA
- [ ] Price is configurable per pack type/tier by contract owner
- [ ] Verify in browser using dev-browser skill

### US-004: Play-to-earn pack rewards
**Description:** As a player, I want to earn packs by playing, not just buying, so grinding matches has a payoff.

**Acceptance Criteria:**
- [ ] Defined trigger event(s) (e.g., match-win count threshold) grant a pack automatically
- [ ] Earned packs mint through the same TBA-bound path as purchased packs
- [ ] Reward triggers are rate-limited/anti-farm (reuse the `usedPairings`-style guard from soulbound achievements where applicable)
- [ ] Typecheck/lint passes

### US-005: On-chain randomness unwrap
**Description:** As a player, I want pack contents determined by verifiable on-chain randomness so results are provably fair.

**Acceptance Criteria:**
- [ ] Open action requests randomness from Pyth Entropy or Chainlink VRF
- [ ] Cosmetic reveal only finalizes in the fulfillment callback, not the request transaction
- [ ] Failed/timed-out fulfillment leaves the pack sealed and retryable, with no lost funds or state
- [ ] Rarity distribution matches the published table within contract-tested tolerance
- [ ] Typecheck/lint passes

### US-006: Rarity table transparency
**Description:** As a player, I want to see drop rates before I buy so I can decide if it's worth it.

**Acceptance Criteria:**
- [ ] Purchase UI displays tier names and percentages before purchase confirmation
- [ ] Rarity data is sourced from the same on-chain config the unwrap logic uses (no UI/contract drift)
- [ ] Verify in browser using dev-browser skill

### US-007: Equip cosmetics (fighter and arena)
**Description:** As an owner, I want to equip or unequip owned cosmetics on my fighter or arena independent of unwrapping them.

**Acceptance Criteria:**
- [ ] Equip action is callable only by the TBA/NFT owner
- [ ] Equip/unequip does not consume or transfer the cosmetic token
- [ ] Combat engine and arena renderer read equipped cosmetic state for display only, never for stats
- [ ] Verify in browser using dev-browser skill

### US-008: Sealed pack resale
**Description:** As a player, I want to sell a sealed pack, or the NFT holding it, so unopened packs have market value.

**Acceptance Criteria:**
- [ ] Sealed pack token is transferable while sealed
- [ ] Selling the parent NFT (fighter/arena) transfers all TBA contents including sealed packs
- [ ] Verify in browser using dev-browser skill (listing/transfer flow, even against a stub/test marketplace)

## 6. Implementation Steps

1. **Arena NFT contract + ERC-6551 TBA registration** — asset class exists and provably carries TBA contents on transfer, no cosmetics yet.
2. **Fighter Pack contract** — sealed pack token, mint-to-TBA purchase flow, rarity config storage, stub (non-random) reveal for early testing.
3. **Arena Pack contract** — same pattern as step 2, targeting arena TBAs instead of fighter TBAs.
4. **On-chain randomness integration** — wire Pyth Entropy or Chainlink VRF into both pack contracts' open/reveal flow, replacing the stub.
5. **Play-to-earn triggers** — define and wire the in-play milestone(s) that grant free packs, with anti-farm guard.
6. **Equip/unequip system** — contract state plus renderer hookup so combat engine and arena display read equipped cosmetic state.
7. **Purchase + rarity-table UI** — front-end for both games.
8. **Cross-game rollout** — adapt steps 2-7 for pixelheros-fight once hoodies-fight's version is proven.

## 7. Functional Requirements

- FR-1: The system must mint pack and cosmetic tokens to the target NFT's ERC-6551 TBA, never to the initiating EOA.
- FR-2: The system must support two distinct pack types (Fighter Pack, Arena Pack), each bound to its respective NFT type.
- FR-3: The system must provide an Arena NFT contract with a deterministic ERC-6551 TBA per token.
- FR-4: The system must accept native-token payment for pack purchase at a contract-owner-configurable price.
- FR-5: The system must grant packs automatically when defined in-play milestones are met, using the same TBA-bound mint path as purchases.
- FR-6: The system must request cosmetic randomness from an on-chain VRF/Entropy provider and finalize the reveal only on the fulfillment callback.
- FR-7: The system must leave a pack sealed and retryable if randomness fulfillment fails or times out.
- FR-8: The system must expose the rarity/drop-rate table on-chain (or via a config the UI reads directly) so displayed odds cannot drift from actual odds.
- FR-9: The system must let only the TBA/NFT owner equip or unequip a cosmetic they own.
- FR-10: The combat engine must not read any cosmetic/pack state when computing stats, hit detection, or AI behavior.
- FR-11: The system must allow sealed packs to be transferred independently before opening.
- FR-12: Transferring a fighter or arena NFT must carry its entire TBA contents (sealed packs, unwrapped cosmetics) to the new owner atomically.

## 8. Technical Considerations

- ERC-6551 registry/implementation choice should match whatever's already used or planned for the soulbound achievement TBAs in 2.0-VISION.md — don't introduce a second TBA standard.
- **Reuse HoodOS, don't stand up a fresh registry flow.** OnChainHoodies already has a working, deployed per-Hoodie wallet contract called HoodOS (`hoodies/lib/config.ts` — separate mainnet/testnet addresses; `hoodies/app/hoodwallet/page.tsx`, "Build 04 / ERC-6551") with a `walletOf(tokenId)` lookup and counterfactual → active status tracking. Verified live in a second local project on the same chain (`h00dchan/lib/tba.ts`) that Robinhood Chain has the canonical ERC-6551 *registry* deployed but **not** Tokenbound's standard implementation contract — that project disabled its own activate button because of it. HoodOS sidesteps that gap with its own deployed implementation. Fighter Packs (and Arena Packs, once the arena contract exists) should mint into HoodOS-style wallets rather than re-deriving TBA addresses against Tokenbound's implementation directly.
- Randomness provider choice should be decided per chain: hoodies-fight runs on Robinhood Chain (custom chain ID 4663) — confirm whether either provider has a deployed oracle there before committing. pixelheros-fight is on Base, where both are available.
- Play-to-earn anti-farm can reuse the canonical-hash/`usedPairings` guard already designed for soulbound achievements in 2.0-VISION.md.
- Cosmetic rendering needs a layering system in the sprite pipeline so cosmetics composite onto base fighter/arena sprites without regenerating a full sheet per combination. SpriteCook already handled the base sprite sets for both games.
- Marketplace integration is read-only for this PRD — pack/cosmetic metadata needs a stable, documented shape for a future indexer, but the indexer/marketplace itself is out of scope.
- PixelHeros' uncapped, forever-mintable collection model (per RESKIN-NOTES.md) may need different pack-supply/economy tuning than Hoodies' fixed-supply model — flagged in Open Questions, not resolved here.

## 9. Open Questions

- Does Robinhood Chain have a deployed Pyth Entropy or Chainlink VRF oracle? If neither, hoodies-fight may need a different chain for this feature or to wait on oracle support.
- Final naming: Alpha Pack / Drip Pack (Hoodies) vs Origin Pack (PixelHeros) — not decided.
- Exact play-to-earn trigger thresholds — needs game-economy tuning, not just engineering.
- Should Arena Packs ship before or after the arena ownership/fee-split system in 2.0-VISION.md, given arenas currently have no gameplay purpose beyond backdrop choice?
- Should sealed-pack contents be fixed at mint time (commit-reveal at mint) or only determined at open time — affects whether pack rarity can be inferred or sniped before opening.
- Actual pack pricing in native token, and whether price varies by tier/rarity-weighting.
