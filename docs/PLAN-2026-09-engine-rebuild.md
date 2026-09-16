# HOODCHAN BRAWL: from fork-and-patch to a professional fighting-game engine

**What this document is:** the full engineering plan for rebuilding this game's engine and backend - deterministic simulation, rollback netcode, server-verified match results, ranked scoring, and a one-repo layout shared across the three sibling sites (hoodchan, onchainhoodies, pixelheros). It came out of an audit of this repo and its sibling forks (findings and cited line numbers below) followed by design passes for the engine, the backend/security layer, and the repo restructuring, then narrowed to concrete phases and a timeline.

**Decisions taken (2026-09-15/16):** scope is the fighting-game engine plus real online play; the bar for "done" is ranked-grade rollback netcode with server-verified results; infrastructure is P2P WebRTC + TURN with verification on Vercel serverless functions; the end state is **one GitHub repo** with an engine package and one folder per site; scoring is a **per-HOODCHAN skill score** (chess-style Elo), with vs-AI tracked in a separate casual namespace; the **AI mint stays on** (players can still earn a soulbound match record fighting the AI) but gets ownership checks and caps; and the build order is **close the money holes first, then the engine and accounts side by side, then online play**.

**Phase 0 is being implemented directly in this repo** (hoodchan-brawl, as it exists today) before any monorepo move - it hardens the money-adjacent routes (`api/ai-match-complete.js`, `api/lobby/complete.js`) and ships truthful docs, without waiting on the Phase 1 repo restructuring. Everything from Phase 1 onward targets the eventual `packages/`+`sites/` layout described in Design C below and has not started yet.

---

## Context

- fight.hoodchan.org is a pfp-brawl fork with a lobby bolted on. "Remote PVP" only exchanged fighter IDs; each device ran its own local sim and `api/lobby/complete.js` took whichever result POSTed first. Two of yesterday's bugs (wrong NFT contract in `join.js`, combo chains lost to a manual "sync" then re-written by hand) were fork drift across three sibling repos.
- Deeper audit (3 explorations + 3 design passes, all cited in the sections below) found: the sim ticks at display refresh rate (144 Hz = 2.4× speed), P1 wins every same-frame trade by construction, no seeded randomness, sim and render are one function; `api/ai-match-complete.js` has **no auth** and enqueues real on-chain mints paid by `MINTER_PRIVATE_KEY`; PVP results are written to Redis keys nothing reads; README still says "nothing on-chain"; no tests in CI, no lint, no lockfile; four repos drifting with rsync "syncs".
- Operator decisions (2026-09-15/16): scope = fighting game engine + online play; bar = ranked-grade rollback netcode with server-verified results; infra = P2P WebRTC + TURN, verification on Vercel serverless; **one GitHub repo** with an engine folder and one folder per site; **per-HOODCHAN skill score** (chess-style), vs-AI tracked separately; **AI mint stays on** with ownership checks + caps; order = **close the money holes first, then engine + accounts side by side, then online play**.
- Outcome: one deterministic, tested engine; fair online matches whose results one client cannot fake; three sites that cannot drift; truthful docs.

## What "professional" means here (the bar every phase is measured against)

1. The match is a pure function of (seed, inputs): same result on every machine, replayable headlessly in Node.
2. Only inputs cross the wire; rollback hides latency; results count only when both players' input logs agree or a server replay settles it.
3. Nothing that spends money or writes a ranking is reachable without a wallet signature + live ownership check + rate limit.
4. One engine, one lockfile, one CI; shipped files are byte-identical to the repo; every real incident from the last month has a test that would have caught it.

## Execution plan

### Phase 0: close the money holes (1 day, ships first, in hoodchan-brawl as-is)
Files: `api/ai-match-complete.js`, `api/lobby/complete.js`, new `api/_lib/rate-limit.js`, `api/share-upload.js`, `api/ipfs.js`, `api/lobby/poll.js`, `api/_lib/stats-keys.js`, `src/wallet.js`, `src/lobby.js`, `src/main.js`, `src/mint-celebration.js`, `package.json`, `README.md`, `CONTRIBUTING.md`, `openapi.json`, `docs/`.
1. `ai-match-complete`: keep enabled (operator's call) but: `ownerOf(nft1)`/`ownerOf(nft2)` via `api/_lib/chain.js` must equal the claimed wallets (403; 502 on RPC failure, never fail open), `wallet1 !== wallet2`, idempotency `SET mintidem:<adapter>:<min>:<max> 1 NX EX 2592000` (409 on repeat), per-wallet cap `rl:aimint:<wallet>` 3/24 h, per-IP limit 5/10 min fail-closed; remove the pre-mint `fought:` writes (`:91-94`, the cron writes them on success). Residual risk (documented): a holder can still mint pairs among tokens they own.
2. `lobby/complete` → signed, both-must-agree. Body gains `{wallet, issuedAt, signature}`; server rebuilds `HOODCHAN Brawl result\nroom: <CODE>\nwinner: HOODCHAN #<id|none>\nloser: HOODCHAN #<id|none>\nscore: <a>-<b> in <n>\naddress: <wallet>\nissued: <ISO>`; `ethers.verifyMessage`; 10-min window +60 s skew; single-use `sigused:<sha256(canonical sig)>`; wallet must be `p1`/`p2`; CAS loop (pattern from `join.js`) storing `lobby.sub[side]`; second agreeing submission → stats via `stats-keys.js` helpers (fixes the orphan legacy keys) + mint enqueue; disagreement → `disputed`, nothing written. Client: `signMessage()` in `src/wallet.js`, `lobbyComplete` awaits and passes `recorded/disputed` to the celebration copy.
3. `rate-limit.js` (INCR+EXPIRE per IP, fail-closed on money routes): create 10, join 30, poll 600, complete 10, match-result 60, ai-match-complete 5, share-upload 5, ipfs 300, x-auth/start 5 per 10 min.
4. `share-upload`: PNG magic bytes, 3 MB, `addRandomSuffix`. `ipfs`: CID-shape regex. `poll`: truncate wallets before `ready`. `stats-keys.js`: `DEFAULT_ADAPTER_KEY = process.env.ADAPTER_KEY || legacy`; set `ADAPTER_KEY=hoodchan` in Vercel; store `adapter` on the room at create.
5. `package.json` `engines.node 22.x`, `.nvmrc`, `scripts.test`; README/CONTRIBUTING/openapi tell the truth (soulbound EIP-5192 record minted by an operator key to each fighter's TBA; players only sign EIP-191 messages); celebration copy for "recorded, not minted".
6. Commit the master plan into the repo as `docs/PLAN-2026-09-engine-rebuild.md` (this file, trimmed of session context) so the team doc exists from day one.
Verify: `node scripts/test-lobby-join.mjs` extended with complete/ai-match-complete cases; live probes (owner passes, non-owner 403, unsigned complete 401, forged winner 403, curl loop 429).

### Phase 1: one repo (Design C, ~3 weeks serial; engine/backend streams start at step 3)
Sync freeze from day 0 (no file copying between repos; hotfixes cherry-picked `-x` within 24 h). Steps 0–8 in Design C: preflight (gh access as Pixelpushin to hoodies-fight, fix pixelheros remote, env inventory, archive pfp-brawl) → rename hoodchan-brawl → `brawl`, skeleton green on old layout → `git mv` into `packages/{engine,adapter-kit,server,ui,contracts}` + `sites/{hoodchan,onchainhoodies,pixelheros}` → `site.config.js` + dispatcher + route manifest + conformance/config-lint/route-coverage tests → contracts import + hoodies keepers → hoodchan cutover (new Vercel project, domain reassign, 7-day soak) → onchainhoodies → pixelheros README stub → archive. Zero behavior change; the replay harness ships here with one golden of today's behavior.

### Phase 2 (parallel): deterministic engine (Design A steps a–f, ~11 days)
In `packages/engine`: (a) fixed 60 Hz accumulator; (b) declare every fighter field, `enterKnockback` (fixes stale `knockbackDir`), hoist closure state into `round`, projectile `owner` index, `Math.pow` → literal tables; (c) mulberry32 dual-stream RNG (outcome in `round.rng`, cosmetic in present); (d) symmetric resolution (observe → update both → collect → judge both vs pre-damage copies → apply; true trades; AI ticks in hitstop); (e) `simTick(state, masks, events)` + presentation layer draining events, countdown/roundOver in-sim; (f) snapshot ring + FNV checksum + input log + golden replays + `lint-sim` + poison-globals test + mirror/fuzz tests + Bun/JSC second-engine job in CI. Release notes list the deliberate behavior changes.

### Phase 3 (parallel): accounts, rooms, mint safety, ops (Design B Tier 1, 6–7 days)
In `packages/server`: EIP-191 session (`HOODCHAN Brawl session` message with nonce + delegate P-256 key, 24 h window, single-use, live `ownerOf`) → `v1.<sid>.<hmac>` token; `_lib/http.js` wrapper; room state machine via `redisCompareAndSet` (`waiting→connected→ready→signaling→in_match→submitted→verified→recorded`, `disputed/mint_failed/abandoned`), `POST/GET /api/rtc/signal`, `GET /api/rtc/turn` (per-match TURN creds), `match/start|heartbeat`, rejoin tokens, per-wallet room caps; mint cron lock + cursor scan + attempts/dead-letter + tx ledger + balance preflight; JSON logs + metrics + `GET /api/status`; `node --test` harness with DI fakes; CI test job gating deploy; cache headers; engine version pin (426 on mismatch).

### Phase 4: online play (Design A steps g–h, ~8 days; needs Phases 2+3)
`RollbackSession` + `TimeSync` + packet protocol over `LoopbackTransport` with `dev/loopback.html` (two sessions, checksum agreement) → WebRTC (`inputs` unreliable/unordered + `control` reliable), signaling through Redis, TURN creds, connect/disconnect/forfeit/rematch UI, log submission at match end; delete the two-local-sims path and the `?pvp=1` gate.

### Phase 5: verified ranked (Design B Tier 2, 7–9 days)
`POST /api/match/submit` with both input logs + checksums + delegate attestations; `verify.js decide()` (agree → verified; 15% sampled or disputed → headless replay of `packages/engine` in the function; liar gets a strike); forfeit rules; replays to Blob + `GET /api/replay/[matchId]`; per-token skill score (chess-style: start 1200, K 40 provisional/20/10, hidden until 5 matches, forfeit half-K, seasons with soft reset) applied by one Lua script with an append-only audit stream; `GET /api/rank?wallet=`; casual namespace for vs-AI (one report per match, delete per-round `game.js:1427-1428`); legacy-key migration script; admin ban/revoke routes; Redis matchmaking (queue by score, band widens 50/10 s, pairing Lua inside the poll call, room created `ready`); optional replay-verified vs-AI minting.

### Timeline
Phase 0 day 1. Phases 1–3 overlap: ~4 weeks. Phases 4–5: ~3 weeks. **≈ 7–8 weeks for one engineer + agent; ≈ 5 weeks with two people.** Playable and deployable at every step.

## Verification (end-to-end)
- Phase 0: extended hermetic tests + live curl probes listed above; `vercel` deploy, `version.json` shows the commit.
- Phase 1: `npm test && npm run lint && npm run typecheck` green; `tools/verify-deploy.mjs <preview>` proves shipped bytes == repo; Playwright smoke plays 10 s vs AI on the preview; domain reassigned with old project kept 7 days for rollback.
- Phase 2: golden replay checksums identical across two in-process runs, Node vs Bun, and Chromium/WebKit/Firefox; mirror test passes (no P1-first bias); fuzz invariants hold; 144 Hz and 30 Hz displays produce the same replay.
- Phase 3: contract tests for every write route (auth codes, CAS interference, room caps, 426 on version drift); `/api/status` green; cron lock/dead-letter tests; dashboard-free operation via `RUNBOOK.md`.
- Phase 4: `dev/loopback.html` at 120 ms / 5% loss stays in sync (checksums agree every 10 frames); two real devices on different networks complete a match, forfeit and rematch paths exercised; TURN path forced by blocking STUN.
- Phase 5: staged match with a tampered log → replay verdict + strike; sampled matches replay within 5 s; score changes appear in the audit stream; migration dry-run writes nothing.

---

## Findings (cited; the "why" behind each step)

### Engine (src/game.js, fighter.js, body.js, ai.js, main.js)
- Keep: integer-frame timings (`fighter.js:214-227`, `85-100`, `951-954`); 11-boolean input struct (`game.js:319-333`) fits u16; AI emits the same struct (`ai.js:29-43`); `drawFighter` duck-typed on 6 fields (`body.js:348`); sim tick 20–50 µs (8-frame re-sim ≈ 0.15 ms); no `Date.now`/DOM/Set-iteration in sim.
- Fix: tick bound to rAF, no dt (`game.js:1435-1648`); closure state (`game.js:350-397`, `ai.js:46-48`); `projectiles[].owner` Fighter ref (`game.js:965`); `headImg` HTMLImageElement on the fighter (`fighter.js:765`); six lazily-created fields; stale `knockbackDir` (`fighter.js:910` vs `1164`); `Math.random` in AI (`ai.js:62…205`) and blood FX gated by localStorage (`game.js:494-541`); `Math.pow` in damage (`fighter.js:124`) and relaunch (`1679`); P1-first order (`game.js:1529-1548`); sim/render/DOM/audio/network entangled (`game.js:569-651, 1297-1433`); gamepad sampled per rAF (`1523`); hitstop input asymmetry when P2 is AI (`1486-1489`).

### Backend (api/**)
- Exposures: `ai-match-complete.js:26-101` unauthenticated mint enqueue; `lobby/complete.js` room code picks the winner, no CAS, legacy keys nobody reads, `flaggedForReview` never consumed; `match-result.js` open + per-round reporting; no rate limits anywhere; `poll` discloses wallets; no SIWE/EIP-191 anywhere, `signature` stored unverified (`join.js:22-26,:162`), client-side `verified` gates the mint; X-auth binds any handle to any wallet; mint cron single SCAN page, no lock, no dead-letter, `txHash` discarded; adapter defaults differ (`stats-keys.js:11` vs `ai-match-complete.js:47`); celebration rank always null (`mint-celebration.js:114-117`); README/CONTRIBUTING/openapi false; CI runs no tests; Node unpinned; no cache headers.

### Repo family
- Two disjoint lineages; hoodchan-brawl is the de facto head with 23 unmerged commits; manual rsync syncs (08-27) deleted merged PR #1 (combo chains) → hand re-port `7d5f98d`; hoodies `join.js:28` still inlines the Hoodies contract; combat core collection-clean, leakage in `main.js`/`api/`/constants (`MAX_TOKEN_ID` ×4, `AUDIO_BASE` ×4, TBA constants, archetype names, `stamp-version.sh` slug, hardcoded Vercel IDs in hoodies CI pointing at the dead account); pixelheros is 100% Hoodies underneath and calls 6 routes it doesn't deploy; docs byte-copied ×3; `CONTRIBUTING.md` prescribes the upstream-merge flow that was abandoned in 48 h.

---

## Design A: deterministic engine + rollback netcode

### Module layout (packages/engine/src)
```
sim/       PURE: constants, state, input, rng, fighter, combat, physics, projectiles, ai, tick, checksum, snapshot
present/   browser-only: sprites (body.js), render, fx, audio, hud, camera, views (headImg lives here)
net/       transport (Loopback + WebRTC), protocol, rollback, timesync, signaling, session
input/     keyboard/gamepad → u16 mask; sources (Local/AI/Null/Remote); replay log
```
Rule: `sim/*` imports only `sim/*`; enforced by `tools/lint-sim.mjs` (bans `Math.random/pow/sin/…`, `Date`, DOM, timers, Set/Map iteration) and a Node test that imports the sim with those globals poisoned and ticks 3600 frames.

### Numeric policy
Doubles; `+ - * / % floor round min max abs` are bit-exact across engines; no transcendental fns in outcome code. `computeComboDamageScale` → `[1, .82, .6724, .551368, .45212176, .3707398432, .304006671424, .25]`; juggle relaunch → `[1, .6, .36, .216, .1296]`.

### MatchState (plain data)
`MatchState { version, seed, config (immutable; hashed into the log header), wins[2], roundIndex, drawStreak, phase, matchWinner, round }`; `RoundState { frame, clockFrames, timeLeft, hitstop, ended, winner, resultTimer, rng:u32, fighters[2], projectiles[8]+count, ai[2] }`; `FighterState` with every field declared (incl. `hitstunFrames=24, knockbackStartX/Dir/Total=0, dashDir/StartX=0, hardKnockdownFrames=0, prevMask`); projectiles carry `owner: 0|1`; tick-local `lastEvent*` become events; `headImg/data/archetype` leave the state (FighterConfig derived once). `enterKnockback(f, dir, total, holdFrames)` is the single entry for slide hits and juggle landings.

### Tick contract
```
simTick(state, [m0, m1], events): frame++ → countdown/roundOver phases in-sim (180 / 170 frames)
  trackInput both → if hitstop: hitstop--, return
  obs = observe both → updateFighter(f0, m0, obs[1]); updateFighter(f1, m1, obs[0])
  resolveCollision → collectAttack both → judge both vs pre-damage copies → applyOutcome both (true trades)
  projectiles → facing (tie → f0 right) → clock → checkWin (hitstop==0)
```
AI = `aiStep(state, side)` on `round.rng`, state in `round.ai`, think schedule on `round.frame`. Input log stores effective masks, so replays never need the AI.

### RNG, input, loop, snapshot
mulberry32; outcome stream `derive(seed,"round:i:drawStreak")`, cosmetic `derive(seed,"fx")`, arena `derive(seed,"arena")`; seed from `/api/lobby/create`, returned by `poll` at `ready`. Bits LEFT=1 RIGHT=2 BLOCK=4 CROUCH=8 JUMP=16 UPPERCUT=32 SLIDE=64 PUNCH=128 KICK=256 SPECIAL=512 DASH=1024; `trackInput` keeps edge detection + 5-frame buffer in-sim; keyboard `pressed` + per-tick `latched`; sampled once per sim tick. Loop: accumulator STEP=1000/60, MAX_STEPS=4, delta clamp 250 ms, render last simulated frame; presenter drains events; re-sim uses a discard array; `ko/round-end/match-end` held until confirmed. `SnapshotRing(16)` fixed-field copy every frame (~1–2 µs); FNV-1a checksum every frame, exchanged every 10 confirmed frames. Log `{v, engine, seed, config, frames, masks: base64(Uint16Array(2N))}`, `logHash = sha256(header+masks)`.

### Rollback session (GGPO-style)
`inputDelay=2` (auto from RTT, user 1–4), `maxRollback=8`, repeat-last prediction, stall when `head - remoteConfirmed > maxRollback + delay`, TimeSync skips a frame when >1 frame ahead (40-frame window, 60-frame cooldown). Packet ~34 B at 60 pps: `type, frame, startFrame, count≤8, masks[], ack, frameAdvantage, checksumFrame, checksum`. Desync → both stop, "match void", logs to `/api/match/desync`. Disconnect: 3 s overlay, 10 s forfeit. Rematch `REMATCH{seed}/ACK` on the reliable channel. `LoopbackTransport(latency, jitter, loss)` + `dev/loopback.html` is the regression harness.

### Transport
`RTCPeerConnection`; `inputs {ordered:false, maxRetransmits:0}` + `control {ordered:true}`; first control msg `{v, engine sha, seed}`; STUN (Cloudflare + Google) + per-match TURN creds from `api/rtc/turn` (Cloudflare Calls `credentials/generate`, ttl 3600; coturn HMAC or Twilio alternatives); signaling `POST/GET /api/rtc/signal` (RPUSH/Lua drain-once, 500 ms polling during setup only, trickle ICE); no `connected` in 20 s → clear error, back to lobby.

### Determinism tests
Golden replays (run twice in-process; Node vs Bun; optional Playwright Chromium/WebKit/Firefox); mirror property test (swap sides + mirror x/facing/masks ⇒ identical checksum); fuzz invariants; goldens: vs-AI match, mirror match, juggle/spike, projectile trade, timeout draw; `npm run golden:update` on intended balance changes.

### Migration steps (a–h) and effort
a fixed timestep 0.5 · b fields/knockback/hoist/owner/pow 1.5 · c rng 0.5 · d symmetric resolution 2 · e simTick + present split + extract engine + port sibling adapters 4 · f snapshot/checksum/log/goldens/lint/tests/CI 2 · g rollback over loopback 3.5 · h WebRTC + session UI + log submission 4.5 = 18.5 days. Risks: pow tables ≤1 ulp (regen goldens after b); contributor adding `Math.sin`/`toFixed` (lint+poison); sibling repos adopt hoodchan balance; iOS Safari 30 Hz rAF + backgrounding; TURN cost ~1 MB/match; serverless replay ≈ 0.6 s per match.

---

## Design B: backend authority, integrity, security

### Tier 1: identity, rooms, mint safety, ops (6–7 days; independent of engine work)
- Session message (twin builders `api/_lib/auth-message.js` + `src/auth-message.js`, byte-equality test): `HOODCHAN Brawl session\ntoken: HOODCHAN #<id>\naddress: <addr>\nissued: <ISO>\nnonce: <32 hex>\ndelegate: <sha256 of session P-256 pubkey | none>`; 24 h window, +60 s skew, single-use sig, live `ownerOf`. `POST /api/auth/session` → `v1.<sid>.<hmac>`; `sess:<sid>` JSON TTL 4 h; error codes mirror hoodchan.org (`INVALID_SIGNATURE | NOT_OWNER | REPLAYED | CHAIN_UNAVAILABLE | BANNED …`). Delegate key: per-session WebCrypto ECDSA P-256 signs later submissions without wallet prompts; verified with `node:crypto`. Agent wallets use the same POST. `Authorization: Bearer` on all writes via `api/_lib/http.js` (CORS allowlist for browsers). X-auth bound to the session wallet. Poll returns full wallets only to participants.
- Room state machine (`api/_lib/room.js transition(code, fromStates, mutate)` over `redisCompareAndSet`): record `{v, status, adapter, engineVersion, matchId, seed, p1/p2 {wallet, tokenId, sid}, submittedAt, result, mint}`; TTLs per state; create (p1 from session, `rooms:open:<wallet>` ≤ 2), join (live ownerOf, no self-play, 426 on engine mismatch), signal (RPUSH + drain-once Lua, 32 × 16 KB), turn (TURN REST HMAC, 10 min), `match/start`, `match/heartbeat` (10 s, `hb:` EX 25), rejoin tokens (EX 120), strikes → `ban:ranked`.
- Mint: only `verify.js` writes `mintqueue:` (grep test); `mint:lock` NX EX 50 + compare-and-DEL; cursor-complete SCAN oldest-first, ≤3 mints/run, `maxDuration 55`; `mint:attempts` ≥5 → `mint:dead`; `mint:ledger` hash (matchId → txHash, tbas) in one multi-exec with DEL + `bar:total`; `mint:cron:last/lastError`; balance preflight `MINTER_MIN_WEI`; `ALERT_WEBHOOK_URL`.
- Ops: `api/_lib/log.js` JSON lines (`reqId, matchId, roomCode, wallet`); `api/_lib/metrics.js` daily counters; `GET /api/status` (redis, rpc block + endpoint, minter balance via `MINTER_ADDRESS`, queue depth/age/dead, cron freshness, `alerts[]`).
- Tests/CI: `node --test`; `test/_helpers/{fake-redis, fake-chain, http}.js`; Lua in a `SCRIPTS` registry (`redisEval(name, keys, args)`); contract tests for every write route; `deploy` needs `test`; `vercel.json` headers; `version.js` + `?v=<sha>`.

### Tier 2: verified results, ranked, matchmaking (7–9 days; after the engine)
- Log: 11-bit masks RLE `[mask, run]` Uint16 base64 ≤64 KB/side, stored via `redisMultiExec([["SET", "mlog:<matchId>:<side>", …, "EX", 604800]])`.
- `POST /api/match/submit {roomCode, matchId, side, engineVersion, winner, winnerId, loserId, rounds, final, checksums, logs{p1,p2}, attest{own, opp}, claim, lastRemoteFrame}`; `msub:<matchId>:<side>` NX.
- `verify.js decide()`: structural checks → cross-attested logs must match (liar = side whose signed copy differs) → agree & not sampled (15%, reproducible from matchId) → `verified/agreement`; else headless replay (caps 11,400 frames / 5 s, `maxDuration 30`, `includeFiles`) → honest side wins, other gets a strike; both diverge → `disputed` + alert; engine drift → accept on agreement only. One multi-exec writes `match:<matchId>` (30 d), stats, rating Lua, `mintqueue:` (verified pvp only), metrics. Forfeit: no `hb:` + no submit within 90 s, `lastRemoteFrame ≥ 1800`, clean replay, one per pair per day, half-K. Replays to Blob `replays/<season>/<matchId>.json` + `GET /api/replay/[matchId]`.
- Rankings: `stats-keys.js` everywhere with `DEFAULT_ADAPTER_KEY`; casual namespace for vs-AI; `leaderboard:<adapter>:wins` fed only by verify; `scripts/migrate-legacy-keys.mjs --dry-run`. Per-token score: start 1200, K 40 (<10 matches) / 20 / 10 (>2200), hidden until 5, forfeit K/2, seasons via `SEASON` env with soft reset `1200 + (r-1200)/2`; `rating-apply.lua` writes `rating:<adapter>:<season>:<id>` hash, `rank:` zset, `audit:rating:<adapter>` stream + per-token lists; `rankw:` per-wallet best; `GET /api/rank?wallet=`. Admin ban/unban/revoke (inverse deltas, never edit history)/replay via EIP-191 admin message or `ADMIN_SECRET`.
- Matchmaking: `mm:active:<wallet>` NX, `mm:ticket:<id>`, `ZADD mm:<adapter>:<season>:q score`; `GET /api/mm/poll` widens band 100 + 50/10 s (cap 600), pairs via Lua (ZSCORE both → ZREM → `mm:result:*`), creates the room `ready`; cancel route.

### Threat model (asset → today → tiers → residual)
Minter gas (unauth → ownership/distinct/idempotency/caps P0; verified-only enqueue + lock + preflight T1; replay-verified AI T2; residual: colluders minting pairs they own). Mint integrity (room code picks winner → signed both-agree P0; sessions T1; replay T2; residual: staged matches → economic decay). Leaderboard (open POST → limits P0; casual/ranked split T1; score from verified matches + strikes/bans/audit T2; residual: sybil rings). Redis/Blob/RPC quotas (limits P0; per-wallet caps + sessions T1). Privacy (truncate P0; participants-only T1). Identity (sessions + delegate keys T1/T2; no ERC-1271). Impossible without an always-on server: authoritative live sim, live cheat detection, sub-second forfeits, push signaling/matchmaking, live spectating, hosted TURN.

---

## Design C: one repo, one engine, thin sites

### Layout (repo `Pixelpushin/brawl` = renamed hoodchan-brawl, history kept)
```
brawl/  package.json (workspaces) package-lock.json .nvmrc(22) tsconfig.json eslint.config.js .prettierrc .githooks/ .github/workflows/{ci,deploy-site,release,nightly}.yml
  CLAUDE.md (AGENTS.md → symlink) README ARCHITECTURE NETCODE SECURITY SITES CONTRIBUTING RUNBOOK CHANGELOG docs/{research,vision,rfcs}
  tools/ assemble-site.mjs verify-deploy.mjs dev.mjs affected-sites.mjs config-sync.mjs check-commit-msg.mjs check-identity.mjs assets/{build-manifest,check-licenses,png-size,sample-anchors}.mjs lint-sim.mjs purity-grep.mjs
  packages/engine/   src/{sim,present,net,input,game.js} assets/{sprites,fx,backgrounds,manifest.json,audio.manifest.json,LICENSES.json} test/
  packages/adapter-kit/ src/{head-image,chain-utils,site-config.schema.json,validate-config}.js template/ test/conformance.js ADAPTERS.md
  packages/server/   src/{routes.js, dispatch.js, lib/{redis,chain,stats-keys,mint,csp,http,log,metrics,room,auth,rate-limit,verify}.js, routes/**} openapi.json test/
  packages/ui/       src/{main,shell,setup,lobby,share-card,mint-celebration,wallet,api-client,gamepad-nav,blood-code,integrity,auth-message}.js style.css fonts/
  packages/contracts/ (Foundry, from hoodies-fight via filter-repo, no out/)
  sites/{hoodchan,onchainhoodies,pixelheros}/ index.html site.js site.config.js adapter/ brand/ api/index.js vercel.json README.md test/site.test.js
```
- Build = copy: `tools/assemble-site.mjs` copies files into `dist/` preserving repo paths; only `index.html` moves. Imports are relative paths that resolve identically in browser/Node/repo. `version.json = {repo, commit, site, engine.version, files:{path: sha256}, treeHash}`; client-side "verify" button; `tools/verify-deploy.mjs` diffs live vs raw.githubusercontent. `vercel.json` `must-revalidate` on `/packages/*` + `/sites/*` replaces `?v=N`.
- One serverless function per site (`/api/:path*` → `api/index?path=`), `createDispatcher(site)` 404s routes whose `feature` is off. `tools/dev.mjs` replaces `vercel dev`.
- `site.config.js` (JSON-shaped, env var NAMES only): `key, domain, collection{name, contract, tokenIds, supplyMax, imageHosts, apiHosts, chain{…, rpc{public, alchemy{keyEnv, urlTemplate}}}}, archetypes[4]{id, label, stats, special}, branding{…, og, theme, setupVideo}, features{pvp, mint, xauth, share, bar, ipfs, stats}, mint{soulboundAddressEnv, minterKeyEnv, tba{registry, implementation, salt}}, ipfs, redis{namespace, legacyUnprefixed, urlEnv, tokenEnv}, audio{base}, csp`. Engine receives `archetypes` (replaces hardcoded names; specials looked up by id); server pins contract/namespace from the site. Conformance test asserts schema, adapter exports, fixture shapes, `adapter.contract === site.collection.contract`, no 40-hex literals in `packages/server`, `vercel.json` == generated, og/title == config.
- Migration steps 0–8 (≈22 days serial, ≈14 calendar with two people), Vercel per-site settings (Root Directory `sites/<x>`, include files outside root ON, install `cd ../.. && npm ci --ignore-scripts`, build `node ../../tools/assemble-site.mjs`, output `dist`, Node 22, Git integration DISCONNECTED), file-move table (engine core → `packages/engine/src/{sim,present,input}`, UI files → `packages/ui/src`, adapters → `sites/<x>/adapter`, `api/**` → `packages/server/src/routes/**`, scripts/tests → package tests, assets → `packages/engine/assets` with anchors as `<sheet>.anchors.json`, contracts → `packages/contracts`), license: root AGPL-3.0, contracts MIT (confirm).
- Process: single lockfile; `node --test`; ESLint flat config (purity rules for `engine/src/sim`, import boundaries, only `packages/server` imports `ethers`); Prettier 110; `tsc --checkJs`; `.githooks` (prettier/eslint/purity/config-lint/**Pixelpushin identity**) + conventional commits; CODEOWNERS; PR template; engine tags + CHANGELOG; squash-merge, linear history.
- CI/CD: GitHub Actions deploys (Vercel Git integration off): `ci.yml` (identity + title checks, lint, format, typecheck, test, replay, build, affected-site previews via reusable `deploy-site.yml`: pull/build/attest/deploy `--prebuilt`, verify-deploy, Playwright smoke, PR comment); `release.yml` on main; `nightly.yml` (prod smoke ×3, live ownership, audio HEADs, replay fuzz, `forge test`, `npm audit`, verify-deploy). Secrets: `VERCEL_TOKEN` repo secret; `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` as Environment variables. Branch protection: required checks, linear, squash, no force-push, admins included.
- Tests: engine behavioral (`combo-chains.test.mjs`), golden replay + snapshot/restore invariant, adapter conformance, server contract with DI fakes + openapi parity, route-coverage, config-lint, asset-manifest (PNG IHDR vs frameSize/frames/anchors, orphans, license status), Playwright smoke, `forge test` nightly.
- Assets: `sprites/<state>.png` + `.anchors.json` (+ `.meta.json`), hand-edited `anims.json`, generated `manifest.json` consumed by `present/body.js` (sim-gating durations in `sim/rules.js`, test asserts agreement), SpriteCook notes + `sample-anchors.mjs`, `LICENSES.json` gate (regenerate or waive slide/knockback/uppercut/flex/rat-rush), per-site overlays, `audio.manifest.json` + per-site Blob store.
- Docs: ARCHITECTURE, NETCODE, SECURITY, ADAPTERS (updated), SITES, CONTRIBUTING (rewritten; drop the fork-sync section), RUNBOOK, per-site READMEs, rfcs/vision archives, regenerated openapi. Governance: per-site secrets inventory, one Upstash DB per site, dedicated minter wallet per site, quarterly rotation, nightly `secrets-audit.mjs`, identity rule enforced by hook + CI, archive-not-delete, `CLAUDE.md` invariants (no bundler; sim pure; no collection specifics outside `sites/`; runtime deps only in `packages/server`; generated files only via scripts; never copy between repos; never `vercel --prod` from a laptop; never print env values).
