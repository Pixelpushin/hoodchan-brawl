export const MOVE_SPEED = 3;
export const MAX_HEALTH = 100;
export const MAX_POWER = 100;

// The logical coordinate space every draw call and position (ARENA_MIN_X/
// MAX_X below, fighter x/y, HUD layout math) is written in terms of - NOT
// necessarily the canvas element's own backing-store pixel dimensions. See
// main.js's setupCanvas: the actual canvas.width/height gets set higher
// (RENDER_SCALE×) so CSS's `image-rendering: pixelated` upscale (needed for
// the body sprites' own deliberately-blocky look) has less distance to
// stretch, which is what keeps adapter-supplied head art from getting
// crushed into blocky pixels alongside it - ctx.scale(RENDER_SCALE,
// RENDER_SCALE) then makes that transparent to every draw call, which can
// keep using these two numbers exactly as before.
export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 360;

// Canvas is 800 wide. `x` is a fighter's LEFT edge (see BODY_CENTER_OFFSET
// in game.js), and the widest a drawn sprite ever gets on screen is ~125px
// (86px raw frameSize * 1.4 CHARACTER_SCALE, the biggest of any sheet - even
// death's own extra scale multiplier lands under that on its own smaller
// sheet). ARENA_MAX_X used to be 750, which let the right edge
// of the sprite land at x+125=875 - 75px past the canvas's own 800px edge,
// clipping the fighter half off-screen. 50px margin on the left (unchanged)
// mirrored on the right: 800 - 50 - 125 = 625. Symmetric, and the sprite
// can never render outside the visible canvas on either side. Exported
// (previously a local, unexported pair of duplicated-by-value constants in
// both game.js AND here) so there's exactly one source of truth for it -
// applyMove/knockback below and game.js's own collision/slide/uppercut
// clamps all reference the same two numbers now instead of three separate
// hardcoded copies that could (and did) drift out of sync.
export const ARENA_MIN_X = 50;
export const ARENA_MAX_X = 625;

// Ranges need to clear MIN_FIGHTER_GAP (game.js) - the closest the solid-body
// collision will ever let two fighters stand - or the attack could never
// connect at point-blank range. Sprite bodies render ~60px wide at full
// scale, so the enforced gap is ~68px; these all clear it with margin.
// PUNCH's old range (74) only cleared that by 6px - fine at the absolute
// closest possible clinch, but two fighters throwing punches at each other
// rarely sit at exactly that minimum gap, so at any more normal engagement
// distance the animation's extended-arm reach visually looked like it
// connected while the actual hitbox (checkHit in game.js) missed and no
// damage registered. Bumped well past that bare-minimum margin instead.
const PUNCH = { duration: 22, activeStart: 6, activeEnd: 14, damage: 6, range: 90 };
const KICK = { duration: 34, activeStart: 10, activeEnd: 22, damage: 10, range: 84, cost: 20 };
// Ranged, not a melee hitbox - the cast animation plays out over `release`
// frames, then game.js reads "special-release" off lastEvent and spawns a
// projectile of its own that travels and hits independently. `duration`
// leaves a few recovery frames after release for the throw's follow-through
// before control returns. damage bumped well past kick's (10) - at the old
// value (25, only ~2.5x kick before archetype multipliers) it didn't feel
// meaningfully different from a kick landing, despite costing 50 power and
// a full cast animation to throw.
const SPECIAL = { duration: 42, release: 30, damage: 32, cost: 50 };
// Flat fallback only - real hitstun is scaled per-hit by computeHitstunFrames
// below (see takeDamage). Kept around as the "hitstun" state's default in
// the one case nothing set fighter.hitstunFrames yet.
const HITSTUN_FRAMES = 24;

// --- Hitstop + scaled hitstun -----------------------------------------
// Standard fighting-game "impact frame" technique (Street Fighter, Guilty
// Gear): the instant a hit lands, BOTH fighters (and the round timer) freeze
// for a handful of frames before knockback/hitstun actually starts playing
// out. Sells a hit as a real impact instead of a silent health-bar tick.
// Actual freeze/pause orchestration lives in game.js (it's the one thing
// that touches both fighters + the clock at once) - these two are just the
// pure damage->frames formulas, shared by every call site that lands a hit
// (checkHit/updateSlide/checkUppercutHit/checkBuilderSpecialHit/
// updateProjectiles in game.js) so hitstop and
// hitstun scale off the exact same "how big was this hit" reading and never
// drift apart from each other.
//
// Tunable constants for whoever builds combos on top of this: raise
// HITSTOP_PER_DAMAGE/HITSTUN_PER_DAMAGE to make big hits feel even heavier,
// or lower the *_MAX caps if a combo system needs shorter windows to chain
// moves. Damage in is always the already-archetype-scaled number (box.damage,
// attacker.slideDamage, etc), never the raw base constant.
const HITSTOP_BASE_FRAMES = 2;
const HITSTOP_PER_DAMAGE = 0.25;
// Caps how long the freeze can ever get (a special/builder-special at max
// archetype scaling would otherwise push past this) - keeps even the
// biggest hit's freeze readable as "impactful pause", not "the game hung".
const HITSTOP_MAX_FRAMES = 16;
export function computeHitstopFrames(damage) {
  return Math.min(HITSTOP_MAX_FRAMES, Math.round(HITSTOP_BASE_FRAMES + damage * HITSTOP_PER_DAMAGE));
}

// Same shape as hitstop, longer range - this is the actual "how long is the
// defender locked in the hurt state" window (see the "hitstun" branch of
// update()'s durations map below), not just a cosmetic freeze. Always
// finite and always counts down every real (non-hitstop) tick regardless of
// input - there's no path that can leave a fighter parked in "hitstun"
// forever, so this can't soft-lock a match no matter how it's tuned.
const HITSTUN_BASE_FRAMES = 14;
const HITSTUN_PER_DAMAGE = 0.6;
const HITSTUN_MAX_FRAMES = 42;
export function computeHitstunFrames(damage) {
  return Math.min(HITSTUN_MAX_FRAMES, Math.round(HITSTUN_BASE_FRAMES + damage * HITSTUN_PER_DAMAGE));
}
// --- Combo scaling --------------------------------------------------------
// Standard fighting-game damage scaling: a hit that lands while the defender
// is still locked in hitstun/knockback from the PREVIOUS hit (no gap - see
// takeDamage's wasChaining check) counts as a continuation of the same
// combo and does progressively less. Without this, hitstop+hitstun+input
// buffering above already make chaining moves together easy - so easy that
// an unscaled combo would turn "landed one jab" into "free full-combo kill"
// (this game already had exactly one free-win exploit fixed this session,
// in ai.js's crouch handling - this is the same category of mistake in a
// different mechanic). Feeding the SCALED amount back into
// computeHitstunFrames (not the raw one) is deliberate, not just damage
// bookkeeping: it makes hitstun shrink alongside damage on later combo
// hits, which self-limits how long a string can realistically stay chained
// (the defender's stun window gets tighter than the attacker's own
// recovery+startup can reliably beat) instead of needing a hard hit-count
// cap to prevent infinite strings.
const COMBO_DAMAGE_DECAY = 0.82;
// Never scales below this fraction of a hit's real damage, no matter how
// long the combo runs - a combo should still meaningfully punish, just not
// linearly stack into a one-touch kill.
const COMBO_DAMAGE_FLOOR = 0.25;
// hitIndex is 1-based (1 = the combo's opening hit, unscaled).
export function computeComboDamageScale(hitIndex) {
  return Math.max(COMBO_DAMAGE_FLOOR, Math.pow(COMBO_DAMAGE_DECAY, hitIndex - 1));
}

// --- Combo freeze-hold + enders -------------------------------------------
// Damage-based hitstop above already makes a single big hit feel heavy, but
// it's flat per-hit - it doesn't know or care that this is hit #4 of an
// unbroken string. Real fighting games hold the freeze noticeably longer the
// deeper a combo goes, on top of whatever the hit itself already earned, so
// landing hit #4 reads as heavier to land than hit #1 even at equal damage.
// This is a pure bonus ADDED to computeHitstopFrames' own result (see
// triggerHitstop in game.js) - never a replacement for it. comboCount === 1
// is just "a hit landed", not a combo yet (matches computeComboDamageScale's
// own 1-based "opening hit" framing above), so it earns no bonus at all.
const COMBO_FREEZE_PER_DEPTH = 1.5;
// Capped well under HITSTOP_MAX_FRAMES' own ceiling (16) so even an
// absurdly long string can't push the combined freeze into "the game hung"
// territory - see COMBO_HITSTOP_TOTAL_MAX_FRAMES in game.js for the combined
// backstop this and computeHitstopFrames' own cap add up to.
const COMBO_FREEZE_MAX_BONUS = 14;
export function computeComboFreezeBonus(comboCount) {
  if (comboCount < 2) return 0;
  return Math.min(COMBO_FREEZE_MAX_BONUS, Math.round((comboCount - 1) * COMBO_FREEZE_PER_DEPTH));
}

// What actually counts as a combo "ender" for the bigger freeze/shake/bark
// escalation in game.js (see each checkHit/updateSlide/checkUppercutHit/
// checkBuilderSpecialHit/updateProjectiles hit branch's
// own lastComboEnder-gated shake/flash/triggerHitstop calls, plus
// maybeBarkCombo). Definition, spelled out because there's no single obvious
// one for an
// engine without a scripted combo-route tree: a hit is an ender if it's
// EITHER (a) the killing blow, full stop, regardless of how it landed, OR
// (b) it lands at real combo depth (>= COMBO_ENDER_MIN_DEPTH - a two-hit
// string is just "a combo", not yet a finisher-worthy one) AND it's one of
// this engine's few "hard-knockdown" class hits - uppercut/slide (both
// already give the defender a real knockback flight instead of just
// hitstun, this engine's closest thing to a launcher) or special (the
// single biggest, most resource-committed hit in any kit). A pure jab/kick
// string never qualifies on its own, no matter how deep it runs - real
// fighting games reserve the big freeze/flourish for actually landing the
// hardest part of the sequence, not just for mashing long enough, which is
// also what keeps a dropped/incomplete combo reading as visibly smaller
// than one carried to a real ender (see the design note this was built
// from) without needing any separate "was this dropped" tracking - an
// incomplete string simply never reaches this gate.
const COMBO_ENDER_MIN_DEPTH = 3;
const ENDER_KINDS = new Set(["uppercut", "slide", "special"]);
export function isComboEnder(comboCount, kind, isKO) {
  if (isKO) return true;
  return comboCount >= COMBO_ENDER_MIN_DEPTH && ENDER_KINDS.has(kind);
}

// --- Punch/kick combo-string pose variety ----------------------------------
// Every punch used to play the exact same 8-frame "attack" animation no
// matter how many landed in a row - a real combo string reads as distinct
// beats, not one animation looping. These still poses (see body.js/the
// asset-registration report) exist specifically to be cycled through as a
// combo goes deeper. PUNCH_POSES/KICK_POSES are the full set of states that
// count as that kind of attack for hitbox/sound classification (see
// attackHitbox and handleSounds' fix in game.js) - PUNCH_CHAIN is the
// (smaller, ordered) subset actually cycled through by pickPunchState below;
// groundPunch is deliberately left out of the cycle - it's a dedicated
// anti-crouch answer instead (see pickPunchState), not a combo beat.
export const PUNCH_POSES = ["punch", "punchStill", "punch2", "elbow", "downPunch", "groundPunch"];
export const KICK_POSES = ["kick", "highKick"];
// Three-hit combo: punch → punch → elbow, growing impact FX each hit.
const PUNCH_CHAIN = ["punch", "punch2", "elbow"];
const KICK_CHAIN = KICK_POSES;
// Held-pose durations for the new stills, matching each one's own ANIMS
// entry in body.js exactly (see that file's own comment on where these
// numbers came from) - kept here too since fighter.js's own state-duration
// map (see the durations object in update() below) can't reach into body.js
// without a circular import.
const POSE_DURATIONS = {
  punch: PUNCH.duration,
  punchStill: 14,
  punch2: 14,
  elbow: 16,
  downPunch: 16,
  groundPunch: 18,
  kick: KICK.duration,
  highKick: 18,
};

// Tall/long enough that the arc actually clears over the other fighter's
// full standing height (~109px at CHARACTER_SCALE) instead of just a hop in
// place - see resolveCollision in game.js, which now lets fighters pass
// through each other horizontally while either is airborne, so this is what
// makes "jump over them" a real, usable option instead of just a dodge.
const JUMP_DURATION = 48;
const JUMP_HEIGHT = 140;
// Ground-closing move: moves forward on its own the whole time it's active
// (see updateSlide in game.js) rather than reading movement input. Exported
// (along with UPPERCUT below) since game.js's updateSlide/checkUppercutHit
// need the timing/range numbers directly - unlike damage, none of this
// varies by archetype, so plain constants rather than a getter.
// Deliberately short - this is a close-range "get under a jump" dodge/
// punish, not a full-screen gap closer. duration * SLIDE_SPEED (game.js)
// covers roughly one engage-range gap (~175px), not the ~700px arena the
// old version could cross - that was a mistake, it turned slide into a
// free win button from anywhere on screen instead of a real close-range
// mixup. Used to be free and hit for real damage (12) - that turned it into
// a spammable kill button since it also bypasses block (see takeDamage
// below) and paid back MORE power than it cost to use (nothing, since it
// was free). Now it costs a real chunk of power and does barely more than
// chip damage - the actual payoff is the dodge/reposition (get under a
// jump, close distance) and the brief stun on landing, not the damage.
export const SLIDE = { duration: 11, damage: 4, knockback: 90, cost: 30 };
// Pure repositioning burst - no hitbox, no damage, distinct from SLIDE
// (which IS an attack with its own cost/knockback/hit window). Direction is
// read once on activation (see the dash branch of update() below): held
// left/right at the moment of the press, defaulting to this.facing (a bare
// press with no direction burns forward, toward the opponent) so it works
// as both a quick approach and, held the opposite way, a retreat. Duration/
// distance sized to roughly match slide's own footprint (~175px over 11
// frames) so the two read as comparable-weight movement options rather than
// one trivially outclassing the other. Costs a small amount of power - free
// would make it a strictly-better replacement for ordinary walking (no
// downside, no reason not to spam it everywhere); a real cost keeps it a
// deliberate tool.
const DASH_DURATION = 10;
const DASH_DISTANCE = 100;
const DASH_COST = 12;
// How long the "hit by a slide" reaction pose holds before returning to
// idle - see takeDamage's kind==="slide" branch.
const KNOCKBACK_DURATION = 28;
// Arc height for the knockback flight - a real launch-and-land trajectory
// (see jumpOffset and setKnockbackMotion below) rather than the old instant
// teleport-then-freeze. Shorter than a real jump's arc (140) since this is a
// reaction, not a voluntary leap.
const KNOCKBACK_ARC_HEIGHT = 55;
// Anti-air counter: rises like a (shorter, faster) jump with an active
// hitbox partway through, specifically so it can catch an opponent mid-jump
// - see checkUppercutHit in game.js, which deliberately does NOT exclude a
// jumping defender the way every other melee hit does. range needs to clear
// MIN_FIGHTER_GAP (68, game.js) same as every melee range does - a range of
// 60 here missed every time (verified live: two grounded fighters can never
// stand closer than 68px apart in the first place, so a 60px range could
// never reach anyone even standing right next to you). Sheet swapped again
// to a clearer 3-frame version (from 4) - crouch, strike (a motion-blur
// streak on the swipe that actually reads as a hit), recovery - duration
// shortened to match (6 game-frames per sheet frame, same pacing the old
// 4-frame/24-duration sheet used), active window re-timed to the strike
// frame specifically (frame 1, verified against the art).
//
// cost/damage: this move was free (no `cost` at all) for a long time - a
// real balance bug, not a deliberate design choice, and the single most
// common complaint across every fork of this game. Free meant it strictly
// dominated kick (14 damage vs kick's 10, PLUS anti-air, PLUS knockback,
// for zero resource cost) - there was no reason to ever throw a kick
// instead. Now costs more than kick (a stronger commit, given the anti-air/
// knockback utility on top) and does the same damage as kick rather than
// more - the payoff for landing one is still real (knockback, catching a
// jump), it just isn't also free chip damage on top.
export const UPPERCUT = { duration: 18, activeStart: 6, activeEnd: 11, damage: 10, range: 80, height: 90, knockback: 100, cost: 25 };

// --- Airborne juggle (the real launcher) -----------------------------------
// The core system this whole workflow exists to add. Every other "big" hit
// in this engine (slide, the two melee specials) just plays a reaction pose
// and/or shoves the defender sideways along the ground - uppercut now does
// something categorically different when it connects: it launches the
// defender into THIS state, "juggled", a genuine airborne physics state (a
// real juggleY/juggleVY pair, integrated once a real tick in update()'s own
// "juggled" branch below - not a cosmetic parabola sampled off stateT the
// way jump/uppercut/knockback's own jumpOffset arcs are) rather than the
// flat, ground-locked "hitstun" every other hit still uses. See takeDamage
// far below: `kind === "uppercut"` is now the ONLY thing that routes into
// applyJuggleLaunch() instead of the plain setState("hitstun") branch - so
// there is no remaining case where a connecting uppercut still produces the
// old grounded reaction; every uppercut hit, fresh anti-air opener or a
// follow-up landed while the defender is already airborne (a "relaunch"),
// takes this path. checkUppercutHit in game.js deliberately never excludes
// a "juggled" defender the same way it already never excluded "jump" - that
// lack of an exclusion IS the relaunch mechanic, no separate flag needed.
//
// Horizontal position is a deliberate, fully-frozen non-choice, not
// "drifting slightly" - update()'s "juggled" branch never touches this.x at
// all. A juggled fighter staying exactly where they were launched from is
// what keeps checkUppercutHit's own fixed-range check (UPPERCUT.range, x-only,
// same as every other melee hitbox in this file) a reliable way to land a
// follow-up uppercut on someone already in the air, and keeps this phase's
// scope to "the physics state exists and is truly bounded" rather than also
// having to reason about a moving mid-air target - a real concern for
// whichever later pass wires airKick/flyingKick (registered in body.js,
// still unwired to any move here) as actual air-to-air follow-up attacks.
const JUGGLE_GRAVITY = 0.55;
// Peak height ≈ v²/(2·g) ≈ 15²/(2·0.55) ≈ 205px - taller than a real jump's
// arc (JUMP_HEIGHT 140) or uppercut's own old rise (UPPERCUT.height 90) on
// purpose: this needs to read as a real launch, not just a slightly bigger
// hop, and needs enough hang time for a follow-up (attacker's own jump, or a
// relaunch) to plausibly land before gravity brings them back down on its
// own. Time to return to the ground from a fresh launch (2v/g) is
// ≈ 2·15/0.55 ≈ 55 frames, well inside MAX_JUGGLE_FRAMES below.
const JUGGLE_LAUNCH_VELOCITY = 15;
// Every relaunch after the very first hit of a sequence decays off this
// SAME original velocity via Math.pow(DECAY, hits-1) in applyJuggleLaunch
// below - never off the previous hit's own already-decayed velocity.
// Compounding hit-over-hit decay (each relaunch scaled down from the last
// one, not from the original) only asymptotically approaches zero and never
// mathematically reaches it - exactly the "soft decay that happens to trend
// toward zero" the brief explicitly said was NOT an acceptable substitute
// for a hard cap. MAX_JUGGLE_HITS below is the actual hard stop; this just
// makes each hit leading up to it feel less generous than the one before,
// same shape as every real air-combo game's own proration.
const JUGGLE_RELAUNCH_DECAY = 0.6;
// Hard, unconditional cap #1 (hit-count axis): the 6th hit of any single
// juggle sequence (juggleHits > 5, i.e. hits 1-5 still launch, decayed, hit 6
// onward never do - see applyJuggleLaunch) grants ZERO further upward
// velocity, full stop, no matter what move lands it or how much power the
// attacker has. A capped hit still deals its (already combo-decayed)
// damage and can still land while the defender happens to still be
// airborne from momentum - it just can never add height again, so gravity
// alone (already running every real tick regardless of hits) guarantees
// they come down.
const MAX_JUGGLE_HITS = 5;
// Hard, unconditional cap #2 (time axis) - the actual backstop, independent
// of hit count entirely. Tracked via a dedicated juggleAirborneFrames
// counter (NOT this.stateT, which setState() zeroes on every relaunch's own
// setState("juggled") call and would therefore silently reset this exact
// guarantee right when it matters most) that only ever gets zeroed at the
// start of a genuinely FRESH sequence (defender wasn't already "juggled")
// and otherwise counts every real tick straight through every relaunch in
// between. Once it's hit, applyJuggleLaunch grants no more velocity
// regardless of juggleHits - even a sequence that somehow kept landing
// hits 1 frame apart forever (it structurally can't - see MAX_JUGGLE_HITS
// above) would still be capped here. 150 frames (2.5s at 60fps) comfortably
// covers even a full 5-hit relaunch chain (each relaunch both shortens its
// own hang time via the velocity decay above AND has to happen inside
// whatever hang time is left) with real margin, verified live under
// continuous attacker mashing - see the juggle-cap stress test in this
// workflow's own verification pass.
const MAX_JUGGLE_FRAMES = 150;

// --- Juggle spike (hard-knockdown ender) -----------------------------------
// The integration/polish pass this whole workflow was building toward: the
// launcher, the anti-infinite caps, the aerial follow-ups, and the homing
// extender all exist now, but landing on the DEFAULT juggle outcome
// (gravity quietly bringing the defender back down into the same brief
// "knockback" hold every ordinary landing gets, see update()'s "juggled"
// branch below) makes even a full, well-played launcher->air-combo sequence
// read as "one more hit that happened to be airborne", not the genuinely
// bigger moment it should be - exactly the "hard to get the final blow in
// that actually gets the big damage, otherwise it's small incomplete"
// design ask this phase exists to answer.
//
// A "spike" is a hit that qualifies as this juggle sequence's own closer -
// reusing isComboEnder's own shape (a hit only counts as a finisher-worthy
// moment past some minimum real depth, not on an early beat) rather than
// inventing a parallel concept, but measured on the axis that actually
// matters here: how many times THIS airborne sequence has already been
// extended (juggleHits, applyJuggleLaunch's own per-sequence counter), not
// the overall comboCount isComboEnder itself reads - comboCount also counts
// whatever grounded cancel-string opened the launcher in the first place
// (see CANCEL_ROUTES above), so gating a JUGGLE-specific finisher off it
// would let a long-enough ground opener spike the very FIRST airborne hit,
// which is exactly the "early juggle hit" the brief says this must not be.
// JUGGLE_SPIKE_MIN_HITS mirrors COMBO_ENDER_MIN_DEPTH's own "3" (a 2-hit
// string isn't finisher-worthy yet) on this juggle-local counter instead -
// the launch itself is juggleHits===1, so requiring the PRE-this-hit count
// to already be >= 3 means a spike is only reachable on the sequence's 4th
// airborne hit at the earliest (launch + two real extensions + the spike),
// leaving genuine room for the "jump-follow air attacks... extend a juggle"
// mechanic the earlier aerial-attack phase built to actually do its job
// before this phase's finisher can fire - a spike gate that fired on the
// very first follow-up would make that whole extension system pointless.
const JUGGLE_SPIKE_MIN_HITS = 3;
// Every kind that can EVER land on an already-"juggled" defender in the
// first place (checkHit/updateSlide/checkBuilderSpecialHit/the plain bolt's
// own dodge logic in game.js all already exclude an airborne target outright)
// is, by construction, one of
// this engine's few genuinely hard-hitting moves - there's no "weak jab"
// that can even reach a juggled opponent to begin with. This list is kept
// anyway, same reasoning ENDER_KINDS above documents its own short list
// for, so the design intent (a spike is specifically a CLOSER-class hit,
// not just "whatever happened to connect") stays explicit in code even
// though today it happens to cover every kind that could reach this check.
const JUGGLE_SPIKE_KINDS = new Set(["uppercut", "special", "airKick"]);
export function isJuggleSpike(wasAlreadyJuggled, juggleHitsBeforeThisHit, kind) {
  return wasAlreadyJuggled && juggleHitsBeforeThisHit >= JUGGLE_SPIKE_MIN_HITS && JUGGLE_SPIKE_KINDS.has(kind);
}
// A real, forceful SLAM - not the ordinary relaunch decay (JUGGLE_LAUNCH_
// VELOCITY * decay^n, applyJuggleLaunch below) trending toward zero, and not
// just letting gravity finish off whatever velocity was already left the way
// a MAX_JUGGLE_HITS-capped hit does either. Bigger in magnitude than the
// original upward launch (15) on purpose - the closer should feel more
// violent coming down than the opener felt going up, the actual "biggest
// treatment this game has" moment landing on the ground, not gravity
// trailing off. Sign is negative (this file's own juggleVY convention -
// positive lifts, see JUGGLE_GRAVITY above) - applied directly as
// this.juggleVY, not blended/decayed from whatever velocity was already
// there, so the slam reads the same forceful speed regardless of exactly
// when in the fall it lands.
const JUGGLE_SPIKE_VELOCITY = 24;
// The actual "real window of continued advantage" reward for completing a
// full sequence - a hard-knockdown recovery, not the same brief
// KNOCKBACK_DURATION (28) hold every ordinary juggle landing (or a plain
// slide hit) already gets. Meaningfully longer (>2x), same reasoning every
// other "earn this, don't just get it free" rebalance in this file gives:
// the payoff for actually landing the finisher has to be a real, usable
// window (walk up, keep pressuring, mix up the next opener) not just a
// bigger number on the health bar. Read by the "knockback" branch of
// update()'s shared durations map below via this.hardKnockdownFrames -
// see that field's own constructor comment for why it's a per-instance
// override rather than a second hardcoded state entry.
const HARD_KNOCKDOWN_DURATION = 65;

// --- Aerial attacks (airKick/flyingKick) ------------------------------------
// The move that actually USES the launcher/juggle system above - and, on its
// own, the classic fighting-game "jump-in": airKick/flyingKick (body.js's
// SHEETS/ANIMS - already registered as drawable poses, previously unwired to
// any input/hit-detection at all) are what let the attacker follow the
// opponent into the air rather than just watching gravity finish the job.
// One shared move spec (same pattern as PUNCH_POSES/KICK_POSES collapsing to
// one PUNCH/KICK spec in attackHitbox below) - airKick vs flyingKick is a
// COSMETIC choice (see pickAirAttackState below), not two different moves
// with their own separately-tuned numbers.
//
// duration (16) matches airKick/flyingKick's own ANIMS durationFrames in
// body.js exactly - this is the pose's full hold, same convention as every
// other move constant in this file already follows (see KICK's own comment
// on activeStart/activeEnd being read against this same duration).
// activeStart/activeEnd carve out the middle of that 16-frame hold as the
// live hitbox window, leaving real windup before it and recovery after -
// same shape as every other melee move here, just compressed to fit the
// shorter pose.
//
// range (88) clears MIN_FIGHTER_GAP (68, game.js) with real margin, same
// requirement every melee range in this file already has to clear - sized a
// touch past KICK's own 84 since a jump-in's reach reading as slightly more
// generous than a grounded kick is standard genre feel (the whole POINT of
// closing from the air is reaching a bit further than a grounded poke can).
//
// damage (11) sits just above KICK's 10 - enough that committing to a jump-
// in (real power cost, real whiff risk landing you exposed - see cost below)
// pays off a little better than the grounded equivalent, without being so
// far ahead of kick/punch that it obsoletes them as a neutral tool.
//
// cost (18) - real power, same reasoning UPPERCUT/KICK/SLIDE's own comments
// give for why these stopped being free: a committed aerial swing that can
// whiff and leave you landing with nothing to show for it needs to cost
// something, or it's strictly better than every grounded option (free reach,
// free height advantage, free juggle-extension) for zero downside. Slightly
// under KICK's 20 - the real risk here isn't the cost, it's landing recovery
// if it misses, so the resource price alone doesn't need to be the sole
// deterrent the way it is for a safer grounded poke.
export const AIR_ATTACK = { duration: 16, activeStart: 5, activeEnd: 13, damage: 11, range: 88, cost: 18 };
export const AIR_KICK_POSES = ["airKick", "flyingKick"];

// --- Aerial homing special --------------------------------------------------
// The actual "ranged attack from the air, auto-aimed" the brief asks for -
// see spawnHomingProjectile/updateProjectiles in game.js for the steering
// math and hit resolution, which reuses the existing projectiles array/
// updateProjectiles loop (same array the bolt/rat-rush already live in)
// rather than a second parallel projectile system. Only the move DATA (cost/
// damage, same convention every other move constant in this file follows)
// lives here.
//
// No cast animation of its own - there's no spare art for one (same
// constraint every earlier phase in this workflow worked within), and adding
// a new pose here would hit the exact problem airborneT was built to avoid:
// jumpOffset only samples a real height for "jump"/"airKick"/"flyingKick"
// (see that getter below), so transitioning into any OTHER state mid-flight
// would snap the sprite to ground level for the pose's duration, then jump
// back up once "jump" resumed - an obvious visual teleport. Instead this
// fires instantly off a buffered/justPressed special input while
// this.state === "jump" (see the combined jump/airKick/flyingKick branch of
// update() below) - this.state never changes, so jumpOffset keeps reading
// the same continuous flight arc it already was, and only lastEvent
// ("air-special-release") signals game.js to actually spawn the projectile
// that frame. Same "no windup, pure resource commitment" shape DASH already
// uses on the ground.
//
// Gated on this.state === "jump" specifically, not "airKick"/"flyingKick"
// too - those are already a committed 16-frame melee swing of their own (see
// AIR_ATTACK.duration), and letting a second, entirely different action fire
// out of the middle of one would need its own cancel-window reasoning this
// phase doesn't need to take on. A player gets one aerial special OR one
// aerial melee swing per airborne beat, same as a grounded fighter only ever
// commits to one grounded attack at a time.
//
// cost (30) sits between AIR_ATTACK's 18 and the grounded SPECIAL's 50 -
// real commitment (thrown from the air, where a whiff leaves no ground under
// you either, same risk framing AIR_ATTACK's own comment gives), but this
// move's actual power is the TRACKING (can't be juked by ordinary
// positioning the way a straight-line bolt can, and - unlike every other
// grounded ranged attack - can reach an already-juggled defender at all, see
// updateProjectiles' own dodge-exclusion comment) rather than a bigger
// number, so it doesn't need to cost as much as the multi-pulse grounded
// special to stay balanced.
//
// damage (14) is a SINGLE hit, deliberately not routed through the bolt/rat-
// rush's own SPECIAL_PULSE_COUNT multi-hit flurry (game.js) - a homing
// juggle-extender that also landed 3 pulses per cast would trivially blow
// through MAX_JUGGLE_HITS in one throw, exactly the kind of exploit the
// launcher phase's whole anti-infinite design worked to prevent. Sized
// between AIR_ATTACK's 11 and KICK's 10 rather than anywhere near the
// grounded SPECIAL's 32 - same reasoning, the payoff here is utility (tracks,
// reaches a juggled target, no positioning required), not raw damage.
export const AIR_SPECIAL = { damage: 14, cost: 30 };

// --- Cancel windows: move-specific "special cancel" routes -----------------
// Replaces the rule this whole workflow exists to fix - ANY attack
// connecting while the defender is still hitstun/knockback-locked counted as
// a combo continuation, with zero regard for which move the ATTACKER threw
// or in what order (see takeDamage's wasChaining check far below in this
// file - that's still exactly how a landed hit gets SCORED as a combo
// continuation once it lands; nothing here touches that). This section is
// entirely about whether the ATTACKER is even allowed to throw the next
// move early enough to land it in the first place. Classic Street Fighter/
// King of Fighters "special cancel": each grounded attack gets a short
// window LATE in its own recovery (after its active hitbox frames, near the
// very end of the move, not the instant recovery starts) during which a
// specific, limited follow-up input cuts the rest of that recovery short and
// starts the next move immediately - see update()'s attack-state branch
// below for where this actually gets checked, right before the plain
// `if (this.stateT >= durations[this.state]) this.setState("idle")`
// fallback that's still the only way out of a move for anything NOT in this
// graph (or anything whose input didn't land inside the window).
//
// The route graph (deliberately small, not "everything cancels into
// everything" - that would just be the old bug with extra steps):
//   punch    -> uppercut, kick   the "jab into launcher" opener; a punch is
//                                 the one move plain enough to lead into
//                                 either a bigger strike (uppercut) or a
//                                 height-varied follow-up (kick)
//   kick     -> uppercut         kick, the HIGH starter, sets up the same
//                                 anti-air-shaped launcher a punch can
//   slide    -> uppercut         slide, the LOW starter, converges on the
//                                 exact same launcher route kick does - see
//                                 takeDamage's high/low guard mixup below for
//                                 why these two are the deliberate high/low
//                                 pair the brief asked to unify
//   uppercut -> (nothing)        already this engine's biggest "ender" class
//                                 hit (see isComboEnder above) - it's the
//                                 string's natural stopping point for now,
//                                 not a step to cancel out of
// Notably absent: punch->punch and kick->kick. Repeating the exact same move
// never appears as its own target anywhere in this graph - mashing one
// button can still land two separate, real-gap-recovered pokes if the
// timing genuinely allows it (unchanged, self-limiting via hitstun/combo
// decay same as always - see COMBO_DAMAGE_DECAY above), but it can never
// CANCEL into itself to skip that recovery, which is exactly what would
// turn mashing into a free accelerating string.
//
// One interaction worth flagging rather than "fixing": a kick reached via a
// punch->kick cancel almost always resolves to a later PUNCH_CHAIN/
// KICK_CHAIN pose (see pickKickState below - opponent is already mid-hitstun
// by the time the cancel fires, so its own chain-depth logic picks
// "highKick", not the base "kick" pose) whose own (shorter) POSE_DURATIONS
// entry ends before KICK's own cancel window below is ever reached - so a
// punch->kick->uppercut three-deep cancel isn't reachable through this same
// mechanism. kick->uppercut and slide->uppercut both work exactly as
// documented when kick/slide is the STRING'S OWN OPENER (thrown fresh from
// neutral, so pickKickState's chain-depth read is 0 and the base "kick"
// pose - full duration, real window - is what actually plays).
const CANCEL_ROUTES = {
  punch: ["uppercut", "kick"],
  kick: ["uppercut"],
  slide: ["uppercut"],
  uppercut: [],
};

// Which family a given fighter state belongs to for cancel purposes. Reuses
// PUNCH_POSES/KICK_POSES wholesale (every pose variant in a family shares
// its family's window below) rather than a new parallel list - the same
// convention attackHitbox() below already uses to treat every punch pose as
// interchangeable for hit-detection purposes.
function moveFamily(state) {
  if (PUNCH_POSES.includes(state)) return "punch";
  if (KICK_POSES.includes(state)) return "kick";
  if (state === "slide") return "slide";
  if (state === "uppercut") return "uppercut";
  return null;
}

// Frame range (inclusive, read against this.stateT the same way
// activeStart/activeEnd are elsewhere in this file) each family's cancel
// window opens during - always AFTER that family's own real activeEnd
// (can't cancel a hit that's still live) and always the LATE portion of
// what's left, not the instant recovery starts, per "late in its own
// recovery" above. Derived directly off each move's own real duration
// (PUNCH/KICK/SLIDE/UPPERCUT constants above) rather than invented numbers.
// Every pose variant in PUNCH_POSES/KICK_POSES beyond the base "punch"/
// "kick" state shares this same family window (moveFamily above), but most
// of the shorter ones (POSE_DURATIONS: punchStill/punch2 = 14, highKick =
// 18) end and auto-return to idle before ever reaching it - unreachable
// from those quick beats is fine, they only ever occur as later beats of an
// already-connected string, not a spot a cancel actually needs throwing
// from (see the three-deep-cancel note on CANCEL_ROUTES above).
const CANCEL_WINDOWS = {
  // duration 22, activeEnd 14 -> 7 recovery frames (15-21). Window is the
  // last 4 of those.
  punch: { start: PUNCH.duration - 4, end: PUNCH.duration - 1 },
  // duration 34, activeEnd 22 -> 11 recovery frames (23-33). Window is the
  // last 5.
  kick: { start: KICK.duration - 5, end: KICK.duration - 1 },
  // duration 11, no separate activeEnd (its hit check runs off distance
  // every tick it's active in updateSlide, game.js - not a frame window) -
  // window is just the last 2 frames of its already-short total duration.
  slide: { start: SLIDE.duration - 2, end: SLIDE.duration - 1 },
  // duration 18, activeEnd 11 -> 6 recovery frames (12-17). Window is the
  // last 3. Defined for consistency (every grounded attack gets one, per
  // the brief) even though CANCEL_ROUTES.uppercut is empty today - nothing
  // currently reads this as a real gate, only future-proofing for whenever
  // uppercut itself gets an outgoing cancel route.
  uppercut: { start: UPPERCUT.duration - 3, end: UPPERCUT.duration - 1 },
};

// Archetype-specific specials. Flipper (rat rush), Collector (bolt), and
// Hodler are all ranged, spawned via spawnProjectile in game.js off the
// shared "special" cast pose. Builder alone is melee with its own dedicated
// sheet/state (specialHigh, see body.js) instead of sharing the cast pose -
// duration/activeStart/activeEnd here time its own active-hitbox window the
// same way UPPERCUT/KICK do, verified against which frames of the sheet
// actually show the kick connecting (green impact FX).
export const BUILDER_SPECIAL = { damage: 30, range: 85, duration: 45, activeStart: 21, activeEnd: 36 };
// Power now mostly comes from actually fighting - landing a hit or holding
// a block - rather than sitting still. Passive trickle is deliberately
// slow (was 0.15/frame, ~9/sec - fast enough that special was basically
// always available for free) so the special reads as something you earn,
// not something you wait out. special itself grants nothing back (already
// the most expensive thing you can do) - the resource wall is the point.
const PASSIVE_REGEN_PER_FRAME = 0.03; // ~1.8/sec at 60fps
// slide's gain used to be the highest of all of these (14) despite costing
// nothing to use - meaning landing one didn't just cost nothing, it was the
// fastest power battery in the game. Now that slide has a real cost (30),
// its gain is deliberately small so landing one still nets a real loss
// (30 - 6 = 24 power gone) rather than paying for itself - it should stay a
// deliberate, occasional tool, not something worth spamming even on a hit.
const POWER_GAIN = { punch: 10, kick: 12, slide: 6, uppercut: 16, special: 0, airKick: 12 };
const BLOCK_POWER_GAIN = 8;

// --- Perfect parry ---------------------------------------------------------
// "Just block"/parry pattern layered on top of ordinary block rather than
// replacing it: the block state already exists (see update()'s block branch
// and takeDamage below), and stateT already tracks "how many frames have I
// been continuously holding block" for free - setState only zeroes it on the
// actual TRANSITION into "block", not every frame it's held (see setState).
// A perfect parry therefore requires the guard to have gone up recently -
// tapping it right as the hit lands - not just holding it through the whole
// exchange, which is what keeps a turtling "hold block forever" player from
// ever seeing this trigger and makes it a real timing read instead of a
// strictly-better version of plain block.
//
// 8 frames (~133ms at 60fps): PUNCH's activeStart is 6 frames into its own
// wind-up and KICK's is 10 - both clear this window with margin if the
// defender raises block only once the swing is visibly already committed,
// so it can't be satisfied just by pre-emptively guarding the instant an
// attack animation starts. Tight enough to demand a real read of the
// incoming hit, loose enough (verified live, see the agent report) to
// actually land on purpose against a telegraphed swing.
const PARRY_WINDOW_FRAMES = 8;
// Meaningfully more than BLOCK_POWER_GAIN (8) - same reasoning as a landed
// hit's onLandedHit gain always outweighing a chip-damage block: the bigger
// resource swing is what makes eating a swing on purpose feel like a real
// turnaround instead of "block, but slightly better." No cap needed beyond
// MAX_POWER - spendPower/the passive regen clamp already handle that.
const PARRY_POWER_GAIN = 22;
// How long the attacker is left open after getting parried - long enough for
// the parrying player to land a real punish (a punch's own startup is only a
// few frames), short enough it isn't a free full combo on its own. NOT run
// through computeHitstunFrames - a parry's punish window is a fixed reward
// for the read, not something that should scale off how hard the parried
// attack would have hit.
const PARRY_STAGGER_FRAMES = 26;

// --- High/low guard mix-up --------------------------------------------
// Classic 3-way fighting-game height read, layered onto the single "block"
// state above now that a second guard stance actually exists to make it
// meaningful. Punches ("mid") are safely blockable from EITHER stance - the
// real mixup is only between kicks/uppercut ("high" - stops standing block
// only, whiffed clean by a crouching profile before this even runs, see
// checkHit's own crouch/blockLow check in game.js) and slide ("low" - stops
// the new crouching guard only). Slide used to blow straight through block
// unconditionally, full stop - "block doing nothing against it makes
// jumping it the actual answer" - but a crouching guard genuinely stopping
// it (for chip damage, same as every other block) is exactly the low half
// of this mixup the brief asks for; jumping it still works too, untouched.
// See update()'s crouch+block branch below for how "blockLow" is entered,
// and takeDamage's block gate for where this actually resolves.
const GUARD_FLASH_FRAMES = 18;

// The engine's 4 fixed archetype slots - every adapter (see
// src/adapters/index.js) must map its own collection's traits onto exactly
// these 4 names via archetypeKey. Originally named after OnChainHoodies'
// own "Builders, Collectors, Flippers and HODLers" framing, which the
// engine keeps using as the fixed slot names regardless of which
// collection is actually plugged in. Exported so the character-select
// tooltip (main.js) can read the real numbers instead of hardcoding a
// second copy that could drift out of sync.
export const ARCHETYPES = {
  Builder: { damageMult: 1.25, speedMult: 1, healthMult: 1, blockMult: 1 },
  Flipper: { damageMult: 1, speedMult: 1.3, healthMult: 1, blockMult: 1 },
  Hodler: { damageMult: 1, speedMult: 1, healthMult: 1.25, blockMult: 1 },
  Collector: { damageMult: 1, speedMult: 1, healthMult: 1, blockMult: 0.5 },
};
const DEFAULT_ARCHETYPE = { damageMult: 1, speedMult: 1, healthMult: 1, blockMult: 1 };
export const RARE_TRAIT_HEALTH_BONUS = 0.02;

// --- Input buffering -----------------------------------------------------
// A button pressed slightly before the current move's recovery/hitstun ends
// used to just be silently dropped (justPressed only fires on the exact
// frame the physical edge happens, and every locked state below returns
// before ever checking it). Now the most recent press of one of these gets
// remembered for INPUT_BUFFER_FRAMES real ticks and fires the instant the
// state machine is actually free to act, same idea as every modern
// fighting game's buffer window. ~5 frames at 60fps (~83ms) - generous
// enough to catch "pressed a hair early", nowhere near long enough to read
// as a queued-up combo string.
//
// uppercut is deliberately excluded, same reasoning as justPressed above:
// holding it is the real charge mechanic, not a discrete press to buffer.
const INPUT_BUFFER_FRAMES = 5;
// Priority order when two actions are pressed the same tick - most
// committal move wins and gets buffered (arbitrary but consistent; a real
// simultaneous double-press is rare and this just needs to be deterministic).
// dash sits right after jump - both are non-damaging repositioning tools,
// ahead of the attacks that actually matter to prioritize if two buttons
// land the same frame.
const BUFFERABLE_ACTIONS = ["special", "jump", "dash", "slide", "kick", "punch"];

export class Fighter {
  constructor(data, x, facing) {
    this.data = data;
    this.headImg = new Image();
    this.headImg.crossOrigin = "anonymous";
    this.headImg.src = data.imageUrl;

    this.archetype = ARCHETYPES[data.archetypeKey] ?? DEFAULT_ARCHETYPE;
    this.maxHealth = Math.round(
      MAX_HEALTH *
        this.archetype.healthMult *
        (1 + RARE_TRAIT_HEALTH_BONUS * (data.rareTraitCount ?? 0)),
    );

    this.x = x;
    this.facing = facing;
    this.state = "idle";
    this.stateT = 0;
    this.health = this.maxHealth;
    // Starting empty against an AI that can already fight back from frame
    // one felt unwinnable, not tense - starting full gives both sides an
    // opening special/kick to actually work with.
    this.power = MAX_POWER;
    this.hasHit = false;
    // Set by the caller (game.js) right after a hit/action lands, so it can
    // trigger the matching sound effect without fighter.js knowing about audio.
    this.lastEvent = null;
    // Rising-edge tracking for every discrete action - see _trackInput()'s
    // justPressed block. Holding a button down must not auto-repeat it the
    // instant the previous one ends; each activation needs its own fresh
    // press, same as a real arcade cabinet.
    this.prevInput = { punch: false, kick: false, slide: false, special: false, jump: false, dash: false };
    // See the combo-scaling block above - how many hits in a row have
    // landed on THIS fighter with no gap (still locked in hitstun/knockback
    // each time the next one connected). Reset to 1 the moment a hit lands
    // that ISN'T a continuation (see takeDamage) - never needs an explicit
    // "combo ended" reset elsewhere, since the only way a future hit reads
    // as chained is if this fighter is still genuinely stunned when it
    // lands, which state itself already guarantees.
    this.comboCount = 0;
    // Airborne juggle physics - see the "Airborne juggle" block above for
    // the full design. juggleY/juggleVY are only ever meaningful while
    // state === "juggled" (integrated once a real tick in update()'s own
    // branch for that state); juggleHits/juggleAirborneFrames persist across
    // an entire juggle SEQUENCE (including every relaunch, not just the
    // fresh opener) and are exactly what MAX_JUGGLE_HITS/MAX_JUGGLE_FRAMES
    // are checked against in applyJuggleLaunch - deliberately separate
    // fields from comboCount above, which is the older, broader "how many
    // hits in a row with no gap" counter this file already used for damage
    // scaling/FX tiers and keeps being fed by every kind of chained hit
    // (grounded or airborne), not just juggle ones.
    this.juggleY = 0;
    this.juggleVY = 0;
    this.juggleHits = 0;
    this.juggleAirborneFrames = 0;
    // Spike-ender bookkeeping - see the big "Juggle spike" comment block
    // above for the full design. `spiked` is a single-use flag (same
    // lifecycle as lastComboEnder/lastHitKind below): applyJuggleSpike sets
    // it true, and the ONLY place it's ever read is the instant this
    // fighter's own fall actually ends (update()'s "juggled" branch), which
    // consumes it back to false right there - so a later, ordinary
    // (non-spiked) knockback can never accidentally inherit a stale true
    // from an earlier sequence. `hardKnockdownFrames` is the actual duration
    // override this decides between (HARD_KNOCKDOWN_DURATION vs null, i.e.
    // "fall back to the plain KNOCKBACK_DURATION constant") - kept as its
    // own field rather than a second hardcoded state entry since "knockback"
    // is reused wholesale for both a spike's hard-knockdown landing and an
    // ordinary slide hit's much shorter one (see takeDamage's own explicit
    // reset of this field on the slide path, the only OTHER place
    // "knockback" ever gets entered from).
    this.spiked = false;
    this.hardKnockdownFrames = null;
    // Real "how long has THIS fighter been continuously off the ground"
    // counter for a voluntary jump - see the combined jump/airKick/flyingKick
    // branch of update() below for the full design. Deliberately separate
    // from stateT: stateT gets zeroed by setState() every time the state
    // machine moves from "jump" into "airKick"/"flyingKick" (throwing an air
    // attack) and potentially back into "jump" again afterward (still
    // airtime left) - if jumpOffset sampled stateT instead, the height arc
    // would snap back to its own t=0 (ground level) the instant an air
    // attack was thrown, then jump straight back up to a fresh full-height
    // arc once "jump" resumed, an obviously broken teleport rather than one
    // continuous flight with a strike in the middle of it. airborneT only
    // ever resets at the START of a fresh jump (see the jump-start branch
    // below) and counts every real tick straight through however many air
    // attacks get thrown along the way - same "persists across the whole
    // sequence, not just one sub-state" shape juggleAirborneFrames above
    // already uses for the same reason.
    this.airborneT = 0;
    // Input buffer state - see INPUT_BUFFER_FRAMES above. At most one
    // pending action at a time (the latest press wins); consumeBuffered()
    // clears it the moment it actually fires.
    this.bufferedAction = null;
    this.bufferTtl = 0;
    // Single-frame-lived flags, same lifecycle as lastEvent (reset to a
    // neutral value at the top of every update(), only ever set true inside
    // takeDamage for the exact frame a real hit lands on this fighter) - see
    // game.js's per-hit shake/flash/triggerHitstop calls and maybeBarkCombo,
    // which read these the same frame they're set and don't need them to
    // persist past it.
    this.lastComboEnder = false;
    this.lastHitKind = null;
    // Same single-frame-lived lifecycle as the two above - see
    // isJuggleSpike/applyJuggleSpike's own comments for what sets this true.
    this.lastHitWasSpike = false;
    // Cosmetic-only guard pose swap while standing-blocking - see
    // takeDamage's block-taken branch (which sets these) and body.js's
    // drawFighter (which reads them). Doesn't affect state/hit detection at
    // all; blockLow doesn't use this, it has its own dedicated sheet drawn
    // for the whole stance rather than just the instant of a hit.
    this.guardFlashSheet = null;
    this.guardFlashT = 0;
  }

  get name() {
    return this.data.name;
  }

  setState(state) {
    this.state = state;
    this.stateT = 0;
    this.hasHit = false;
  }

  spendPower(amount) {
    if (this.power < amount) return false;
    this.power -= amount;
    return true;
  }

  // Called by game.js right after takeDamage sets state to "knockback" -
  // records the launch point/direction/distance so update() can fly the
  // fighter there over KNOCKBACK_DURATION instead of snapping instantly.
  setKnockbackMotion(dir, total) {
    this.knockbackStartX = this.x;
    this.knockbackDir = dir;
    this.knockbackTotal = total;
  }

  // Rising-edge detection + input-buffer bookkeeping, factored out so it can
  // run every real tick regardless of whether the rest of update() actually
  // gets to execute that tick - called from update() itself below, AND from
  // tickInputOnly() during a hitstop freeze frame (game.js), so a press that
  // lands mid-freeze still gets captured into the buffer instead of the
  // fighter simply never seeing it (update() isn't called at all on frozen
  // frames - see game.js's loop()). Computed unconditionally, before any
  // state-gated early return in update() below - otherwise a button held
  // straight through an attack/hitstun/etc. would read as a "fresh press"
  // the instant that state happens to end, which is exactly the
  // hold-to-spam behavior this exists to prevent. uppercut is deliberately
  // excluded from both edge-tracking and buffering - holding it is the
  // actual charge mechanic, not something that needs edge-triggering or
  // queueing.
  _trackInput(input) {
    const justPressed = {
      punch: input.punch && !this.prevInput.punch,
      kick: input.kick && !this.prevInput.kick,
      slide: input.slide && !this.prevInput.slide,
      special: input.special && !this.prevInput.special,
      jump: input.jump && !this.prevInput.jump,
      dash: input.dash && !this.prevInput.dash,
    };
    this.prevInput = {
      punch: input.punch,
      kick: input.kick,
      slide: input.slide,
      special: input.special,
      jump: input.jump,
      dash: input.dash,
    };

    // Ages the buffer down every real tick this runs on - including
    // hitstop-frozen ticks - so the window is measured against real
    // elapsed frames, not just frames the state machine happened to be free
    // to act on. That's what keeps this from ever turning into an
    // indefinite queue.
    if (this.bufferTtl > 0) {
      this.bufferTtl--;
      if (this.bufferTtl <= 0) this.bufferedAction = null;
    }
    // A fresh press always overwrites whatever was previously buffered and
    // resets the window - latest press wins, checked in BUFFERABLE_ACTIONS
    // priority order so two buttons hit the same tick buffer the more
    // committal one.
    for (const action of BUFFERABLE_ACTIONS) {
      if (justPressed[action]) {
        this.bufferedAction = action;
        this.bufferTtl = INPUT_BUFFER_FRAMES;
        break;
      }
    }
    return justPressed;
  }

  // Non-consuming check - true if `action` is still live in the buffer.
  // Used ahead of a power-cost gate (see the special/dash/slide/kick
  // branches in update() below): those branches must NOT clear the buffer
  // via consumeBuffered() until they've confirmed the fighter can actually
  // afford the move, or a buffered press that arrives a frame before enough
  // power has regenerated would get silently eaten - the buffer cleared,
  // nothing happening, and the real press effectively lost - instead of
  // staying queued to retry on the next tick like an unbuffered fresh press
  // checked every frame would.
  hasBuffered(action) {
    return this.bufferedAction === action && this.bufferTtl > 0;
  }

  // Consumed from the free-to-act branch of update() below (ORed alongside
  // the real-time justPressed check) - treats a still-live buffered press
  // the same as a fresh edge, then clears it so it can't double-fire on a
  // later frame. Returns false (no side effect) if nothing buffered matches
  // `action`, so trying every action in turn is safe. Only call this once
  // the action is actually about to fire (see hasBuffered above for the
  // non-consuming pre-check power-gated branches need) - if the branch also
  // has a `&& this.power >= cost` guard, that guard must already be known
  // to pass before this runs, or a call here would consume the buffer even
  // when the move doesn't happen.
  consumeBuffered(action) {
    if (this.bufferedAction === action && this.bufferTtl > 0) {
      this.bufferedAction = null;
      this.bufferTtl = 0;
      return true;
    }
    return false;
  }

  // Called instead of update() for a hitstop-frozen frame (see game.js's
  // loop()) - keeps edge-detection/buffering alive so a press during the
  // freeze itself isn't silently lost, without touching state/stateT/
  // position/health at all, which is the entire point of the freeze.
  tickInputOnly(input) {
    this._trackInput(input);
  }

  // opponent (optional - callers with no opponent concept, if any ever show
  // up, still work fine) is ONLY used cosmetically, to pick which punch/kick
  // pose to display (see pickPunchState/pickKickState below) - it never
  // affects hit detection, damage, or state timing, all of which stay
  // exactly the caller's own responsibility via attackHitbox()/checkHit
  // (game.js) same as before.
  update(input, opponent) {
    this.lastEvent = null;
    this.lastComboEnder = false;
    this.lastHitKind = null;
    this.lastHitWasSpike = false;
    // Ages down every real tick regardless of state, same as the input
    // buffer above - a guard flash set the instant before a knockdown or
    // state change shouldn't outlive its own window just because nothing
    // else happened to reset it.
    if (this.guardFlashT > 0) this.guardFlashT--;
    const justPressed = this._trackInput(input);

    if (this.state === "ko") {
      this.stateT++;
      return;
    }

    this.stateT++;

    // Power slowly refills on its own except while kicking - jump is free
    // (it's the dodge tool, including for the ranged special, so it can't be
    // gated behind a resource you might not have when you need to dodge).
    if (this.state !== "kick") {
      this.power = Math.min(MAX_POWER, this.power + PASSIVE_REGEN_PER_FRAME);
    }

    // Held to charge, released to launch - freezes on the wind-up's very
    // first frame for as long as the key is down, so an anti-air can
    // actually be timed against an opponent's jump instead of committing
    // the instant the key is pressed. Resetting stateT back to 0 every
    // frame (rather than skipping the increment above) is what keeps
    // body.js's frame lookup pinned to frame 0 the whole time.
    if (this.state === "uppercut-charge") {
      if (input.uppercut) {
        this.stateT = 0;
        return;
      }
      this.setState("uppercut");
      this.lastEvent = "uppercut-start";
      return;
    }

    // Airborne juggle physics - see the big "Airborne juggle" comment block
    // above (near UPPERCUT) for the full design. Deliberately its own early-
    // return branch, same pattern as uppercut-charge just above, rather than
    // folded into the shared durations-map branch below: exit condition here
    // is "gravity actually brought them back to the ground" (a real physics
    // predicate), not "stateT reached some fixed duration" the way every
    // state in that shared branch works, so it can't reuse that machinery.
    // No input is read at all - same as hitstun/knockback, the defender is
    // locked out for the whole time they're airborne, only able to act again
    // once they land (see the "knockback" landing-recovery transition
    // below).
    if (this.state === "juggled") {
      // Counts every real tick of this entire juggle SEQUENCE, straight
      // through relaunches - unlike this.stateT (zeroed by every setState,
      // including the one applyJuggleLaunch itself calls on a relaunch),
      // this is exactly what MAX_JUGGLE_FRAMES needs to check against to be
      // a real, unconditional backstop. See its own comment above.
      this.juggleAirborneFrames++;
      this.juggleVY -= JUGGLE_GRAVITY;
      this.juggleY += this.juggleVY;
      if (this.juggleY <= 0) {
        this.juggleY = 0;
        this.juggleVY = 0;
        // Reuses the existing "knockback" pose/timer as the landing
        // recovery - a real hard-knockdown beat (this engine's own closest
        // thing to one already), not a straight-back-to-idle teleport, and
        // free (no new art/state-duration wiring needed): knockbackDir is
        // never set here, so the eased x-flight branch in the shared
        // durations block below (`if (this.state === "knockback" &&
        // this.knockbackDir)`) is simply never entered - this plays as a
        // pure landing-recovery hold in place, not a knockback slide.
        //
        // A SPIKED fall (see applyJuggleSpike/isJuggleSpike above) earns the
        // longer HARD_KNOCKDOWN_DURATION hold instead of this same branch's
        // usual plain fallback - `this.spiked` is consumed (reset false)
        // right here, the one and only read site, so it can never leak into
        // a later, unrelated ordinary landing. lastEvent fires exactly once,
        // the frame a spiked fall actually ends - see handleSounds in
        // game.js, which reacts to it with the real ground-impact shake/
        // thud/FX a slam this hard deserves, distinct from (and a beat
        // after) whatever hit did the spiking itself up in the air.
        this.hardKnockdownFrames = this.spiked ? HARD_KNOCKDOWN_DURATION : null;
        this.spiked = false;
        if (this.hardKnockdownFrames) this.lastEvent = "hard-knockdown-land";
        this.setState("knockback");
        return;
      }
      return;
    }

    // slide and uppercut both hold their pose/travel on their own timers -
    // game.js's updateSlide/checkUppercutHit own the actual x movement and
    // hit detection for them, this just counts down back to idle. knockback
    // is never entered via input at all (see takeDamage), only ever reached
    // by getting hit by a slide.
    // PUNCH_POSES/KICK_POSES beyond the base "punch"/"kick" (punchStill,
    // punch2, elbow, downPunch, groundPunch, highKick) are just alternate
    // held poses for the exact same two moves - they need their own entries
    // here (recovery timing) and in attackHitbox() below (hit detection),
    // but nowhere else; every other branch of update() that keys off
    // this.state (jump/block/crouch/etc) never produces these states in the
    // first place.
    if (["punch", "kick", "special", "specialHigh", "hitstun", "slide", "knockback", "uppercut", "dash", ...PUNCH_POSES.filter((s) => s !== "punch"), ...KICK_POSES.filter((s) => s !== "kick")].includes(this.state)) {
      const durations = {
        punch: PUNCH.duration,
        kick: KICK.duration,
        special: SPECIAL.duration,
        punchStill: POSE_DURATIONS.punchStill,
        punch2: POSE_DURATIONS.punch2,
        elbow: POSE_DURATIONS.elbow,
        downPunch: POSE_DURATIONS.downPunch,
        groundPunch: POSE_DURATIONS.groundPunch,
        highKick: POSE_DURATIONS.highKick,
        specialHigh: BUILDER_SPECIAL.duration,
        // Scaled per-hit by takeDamage (see this.hitstunFrames there) - a
        // jab locks the defender out for far less than an uppercut/special
        // does. HITSTUN_FRAMES is only ever the fallback for the
        // (unreachable in normal play) case nothing set it yet.
        hitstun: this.hitstunFrames ?? HITSTUN_FRAMES,
        slide: SLIDE.duration,
        // this.hardKnockdownFrames is only ever non-null for the frames right
        // after a spiked juggle lands (see the "juggled" branch's own landing
        // check above, and takeDamage's slide branch below for the only other
        // place this ever gets explicitly cleared back to null) - falls back
        // to the plain constant for every ordinary knockback (a ground slide
        // hit, or a juggle that fell out without ever being spiked).
        knockback: this.hardKnockdownFrames ?? KNOCKBACK_DURATION,
        uppercut: UPPERCUT.duration,
        dash: DASH_DURATION,
      };
      // Fires exactly once, the frame the cast animation completes - this is
      // what game.js listens for to actually spawn the projectile.
      if (this.state === "special" && this.stateT === SPECIAL.release) {
        this.lastEvent = "special-release";
      }
      // Real launch-and-land flight instead of the old instant teleport -
      // eased out (fast launch, decelerating into the landing) toward the
      // total distance set by setKnockbackMotion, driven off absolute t so
      // there's no drift/accumulation error frame to frame.
      if (this.state === "knockback" && this.knockbackDir) {
        const t = Math.min(1, this.stateT / KNOCKBACK_DURATION);
        const eased = 1 - (1 - t) * (1 - t);
        this.x = Math.max(
          ARENA_MIN_X,
          Math.min(ARENA_MAX_X, this.knockbackStartX + this.knockbackDir * this.knockbackTotal * eased),
        );
      }
      // Same eased-burst shape as knockback's flight above, just player-
      // initiated instead of a hit reaction - see the dash entry point below
      // for where dashStartX/dashDir get set.
      if (this.state === "dash" && this.dashDir) {
        const t = Math.min(1, this.stateT / DASH_DURATION);
        const eased = 1 - (1 - t) * (1 - t);
        this.x = Math.max(
          ARENA_MIN_X,
          Math.min(ARENA_MAX_X, this.dashStartX + this.dashDir * DASH_DISTANCE * eased),
        );
      }
      // Cancel check - see CANCEL_ROUTES/CANCEL_WINDOWS above for the full
      // route graph and window math. moveFamily returns null for every
      // state that flows through this same shared branch but isn't a
      // cancelable grounded attack (special/specialHigh/hitstun/knockback/
      // dash) - this whole block is a no-op for those, same as it always was
      // before cancels existed.
      const cancelFamily = moveFamily(this.state);
      if (cancelFamily) {
        const window = CANCEL_WINDOWS[cancelFamily];
        if (this.stateT >= window.start && this.stateT <= window.end) {
          // uppercut checked first when it's on this family's route list -
          // same priority the neutral (non-attack) input branch below
          // already gives it over kick, so a simultaneous press resolves
          // identically whether or not a cancel window happens to be open.
          // Not edge-triggered/buffered, same as every other uppercut check
          // in this file (see INPUT_BUFFER_FRAMES above) - holding it is
          // the real charge mechanic, so this cancels straight into
          // "uppercut-charge" exactly like the neutral entry point does,
          // not directly into "uppercut" itself.
          if (CANCEL_ROUTES[cancelFamily].includes("uppercut") && input.uppercut && this.power >= UPPERCUT.cost) {
            this.spendPower(UPPERCUT.cost);
            this.setState("uppercut-charge");
            return;
          }
          // kick is the only other cancel target this graph defines
          // (punch's own route list). A disallowed target (kick pressed
          // mid-kick, or any press at all outside the window above) just
          // falls through to the plain duration check below instead,
          // exactly like an unaffordable move does elsewhere in this file:
          // the input isn't queued or retried forever, it's simply not
          // honored this frame - the buffer (if anything's in it) just ages
          // out on its own normal INPUT_BUFFER_FRAMES timer.
          if (CANCEL_ROUTES[cancelFamily].includes("kick") && (justPressed.kick || this.hasBuffered("kick")) && this.power >= KICK.cost) {
            this.consumeBuffered("kick");
            this.spendPower(KICK.cost);
            this.setState(this.pickKickState(opponent));
            return;
          }
        }
      }
      if (this.stateT >= durations[this.state]) this.setState("idle");
      return;
    }

    // Jump + the two aerial-attack poses share one branch, same pattern as
    // "juggled" above getting its own early return instead of the shared
    // durations-map branch - all three need airborneT's own real-flight-time
    // logic (see its constructor comment), not a fixed-duration lookup keyed
    // off stateT the way every grounded attack pose is.
    if (this.state === "jump" || this.state === "airKick" || this.state === "flyingKick") {
      // One tick of real airtime, regardless of which of the three states
      // this is - a fighter thrusting into an air attack mid-jump hasn't
      // touched the ground, so their total flight budget (JUMP_DURATION)
      // keeps draining exactly like it would if they'd just kept falling.
      this.airborneT++;

      if (this.state === "jump") {
        this.applyMove(input);
        // The actual aerial-attack input: a real, move-specific hitbox (see
        // AIR_ATTACK above and checkAirAttackHit in game.js), not a cosmetic
        // reskin of the grounded kick - costs its own power, has its own
        // active-frame window, and is what lets the attacker follow a
        // launched opponent into the air to extend a juggle (see takeDamage's
        // launch-routing below) as well as functioning as a standalone
        // jump-in against a grounded opponent. Buffered/hasBuffered the same
        // way every other power-gated attack in this file already is (see
        // INPUT_BUFFER_FRAMES above) - a kick pressed a couple frames before
        // the jump animation itself starts, or before enough power has
        // regenerated, still fires the instant this branch can honor it
        // instead of being silently dropped.
        if ((justPressed.kick || this.hasBuffered("kick")) && this.power >= AIR_ATTACK.cost) {
          this.consumeBuffered("kick");
          this.spendPower(AIR_ATTACK.cost);
          this.setState(this.pickAirAttackState(opponent));
          this.lastEvent = "air-attack-start";
          return;
        }
        // The homing aerial special - see AIR_SPECIAL's own comment above for
        // why this fires instantly (no pose change, no `return`-into-a-new-
        // state) rather than following the kick branch's pattern just above.
        // Deliberately falls through to the shared stillAirborne/landing
        // logic right below instead of returning early - casting mid-flight
        // must not skip the "did this jump's airtime just run out" check the
        // same way throwing nothing at all wouldn't skip it either.
        if ((justPressed.special || this.hasBuffered("special")) && this.power >= AIR_SPECIAL.cost) {
          this.consumeBuffered("special");
          this.spendPower(AIR_SPECIAL.cost);
          this.lastEvent = "air-special-release";
        }
      }

      // Whether there's still real flight time left in this jump/juggle-
      // chase - used both to decide when a plain jump lands AND, below, to
      // decide whether an air attack's own pose should hand control back to
      // "jump" (still airborne, can keep drifting/attacking again) or
      // straight to "idle" (out of airtime, the fall is over) once its own
      // hold finishes.
      const stillAirborne = this.airborneT < JUMP_DURATION;
      if (this.state === "jump") {
        if (!stillAirborne) this.setState("idle");
        return;
      }

      // airKick/flyingKick: held for the move's own fixed pose duration
      // (AIR_ATTACK.duration) regardless of whether it actually connected -
      // hasHit only ever gates a SECOND hit from the same active window (see
      // attackHitbox's own equivalent gate for grounded punch/kick), never
      // the pose's own timing, so a whiffed air attack recovers on exactly
      // the same clock a landed one does and can never leave the attacker
      // stuck mid-animation waiting on something that isn't coming.
      if (this.stateT >= AIR_ATTACK.duration) {
        this.setState(stillAirborne ? "jump" : "idle");
      }
      return;
    }

    if (this.state === "block" && !input.block) {
      this.setState("idle");
    }
    if (this.state === "blockLow" && !(input.block && input.crouch)) {
      this.setState("idle");
    }
    if (this.state === "crouch" && !input.crouch) {
      this.setState("idle");
    }

    // Crouching guard - the other half of the high/low mixup (see
    // takeDamage's block gate below for what it actually stops). Holding
    // block AND crouch together reads as this dedicated stance rather than
    // just standing block ignoring the crouch input, so it's checked ahead
    // of the plain block branch below - same input-priority pattern that
    // branch already used against a simultaneous punch/etc (holding guard
    // suppresses everything else, nothing new here). Reuses body.js's
    // already-registered "blockLow" sheet/anim/head-anchor entries directly
    // by state name - no new asset wiring needed there.
    if (input.block && input.crouch) {
      if (this.state !== "blockLow") this.setState("blockLow");
      return;
    }
    if (input.block) {
      if (this.state !== "block") this.setState("block");
      return;
    }
    // Crouch locks you in place - no shuffling while ducked, and it doesn't
    // engage over any actual attack/jump input.
    if (
      input.crouch &&
      !input.punch &&
      !input.kick &&
      !input.special &&
      !input.jump &&
      !input.slide &&
      !input.uppercut &&
      !input.dash
    ) {
      if (this.state !== "crouch") this.setState("crouch");
      return;
    }
    // Every check below is ORed with a buffer check - a press that landed up
    // to INPUT_BUFFER_FRAMES ago, while the fighter was still locked in an
    // attack/hitstun/etc, fires the instant control actually returns here
    // instead of having been silently dropped. The four actions gated by a
    // power cost (special/dash/slide/kick) use the non-consuming
    // hasBuffered() for the OR and only call consumeBuffered() once the cost
    // check has already passed - if a buffered press consumed (cleared) the
    // buffer before the cost check, a press that arrives a frame or two
    // before enough power has regenerated would be eaten for nothing instead
    // of staying queued to retry next tick, same as an unbuffered fresh
    // press checked every frame would. jump/punch have no cost gate, so
    // consumeBuffered() (which is a no-op returning false if nothing of that
    // exact action is buffered) is safe to call directly in the OR.
    if ((justPressed.special || this.hasBuffered("special")) && this.power >= SPECIAL.cost) {
      this.consumeBuffered("special");
      this.spendPower(SPECIAL.cost);
      // Builder gets its own dedicated melee state (see body.js's
      // specialHigh) instead of the shared ranged-cast pose - see
      // checkBuilderSpecialHit in game.js for where its actual hit window is
      // checked. Every other archetype (Hodler included) fires the shared
      // ranged special.
      const type = this.data.archetypeKey;
      this.setState(type === "Builder" ? "specialHigh" : "special");
      this.lastEvent = "special-start";
      return;
    }
    if (justPressed.jump || this.consumeBuffered("jump")) {
      // Fresh flight - see airborneT's own constructor comment for why this
      // is the ONLY place it ever resets (every other touch of it, in the
      // combined jump/airKick/flyingKick branch above, only ever increments
      // it - an air attack thrown mid-flight must keep draining the SAME
      // flight budget, not reset it back to a fresh full jump's worth of
      // airtime for free).
      this.airborneT = 0;
      this.setState("jump");
      this.lastEvent = "jump-start";
      return;
    }
    if ((justPressed.dash || this.hasBuffered("dash")) && this.power >= DASH_COST) {
      this.consumeBuffered("dash");
      this.spendPower(DASH_COST);
      // Direction read once, right here, not re-read every frame of the
      // burst - holding left/right at the moment of the press picks
      // backward vs forward; releasing/changing direction mid-dash doesn't
      // redirect it, same as slide's own direction is locked in on entry.
      // No direction held defaults to this.facing (always toward the
      // opponent - see game.js), so a bare dash press is a forward burst.
      this.dashDir = input.left ? -1 : input.right ? 1 : this.facing;
      this.dashStartX = this.x;
      this.setState("dash");
      this.lastEvent = "dash-start";
      return;
    }
    if (input.uppercut && this.power >= UPPERCUT.cost) {
      // Not edge-triggered - holding this is the actual charge mechanic
      // (see the uppercut-charge branch above), not something to spam, and
      // deliberately not buffered either (see INPUT_BUFFER_FRAMES above).
      // Cost is spent on commit (entering the charge), same as kick/slide/
      // special all spend on their own activation - getting hit out of the
      // charge still cost the power, same as whiffing a kick would.
      this.spendPower(UPPERCUT.cost);
      this.setState("uppercut-charge");
      return;
    }
    if ((justPressed.slide || this.hasBuffered("slide")) && this.power >= SLIDE.cost) {
      this.consumeBuffered("slide");
      this.spendPower(SLIDE.cost);
      this.setState("slide");
      this.lastEvent = "slide-start";
      return;
    }
    if (justPressed.punch || this.consumeBuffered("punch")) {
      this.setState(this.pickPunchState(opponent));
      return;
    }
    if ((justPressed.kick || this.hasBuffered("kick")) && this.power >= KICK.cost) {
      this.consumeBuffered("kick");
      this.spendPower(KICK.cost);
      this.setState(this.pickKickState(opponent));
      return;
    }

    const vx = this.applyMove(input);
    this.state = vx !== 0 ? "walk" : "idle";
  }

  // Which punch pose to throw next - see the PUNCH_CHAIN comment above for
  // the full reasoning. Depth is read off the OPPONENT's own comboCount, not
  // a separately-tracked press counter on this fighter, and only while the
  // opponent is actually still chain-locked (hitstun/knockback - the exact
  // same "wasChaining" condition takeDamage itself uses below) - a punch
  // thrown after the opponent has already recovered back to neutral is a
  // fresh opener, not hit #3 of a string that already ended, even if this
  // fighter has thrown three punches in a row without any of the later ones
  // actually landing consecutively.
  pickPunchState(opponent) {
    // Every punch already connects through a crouch (see checkHit in
    // game.js - only kick is ducked) - groundPunch is purely a themed
    // "aimed low" answer to a turtling crouch, not a new way to beat it
    // mechanically. Checked first and unconditionally (not folded into the
    // chain-depth cycle below) since a crouching opponent can never
    // simultaneously be mid-hitstun-chain - the two states are mutually
    // exclusive - so there's no ordering ambiguity between this and the
    // depth check.
    // blockLow is still a crouching profile underneath the guard - same
    // themed "aimed low" answer applies there too, cosmetics only (the real
    // hit is still a plain "punch" per PUNCH_POSES/attackHitbox either way,
    // and whether it actually connects or gets chip-blocked is takeDamage's
    // call, not this one's).
    if (opponent && (opponent.state === "crouch" || opponent.state === "blockLow")) return "groundPunch";
    const chaining = opponent && (opponent.state === "hitstun" || opponent.state === "knockback");
    const depth = chaining ? opponent.comboCount : 0;
    return PUNCH_CHAIN[depth % PUNCH_CHAIN.length];
  }

  // Same idea as pickPunchState, just the smaller 2-pose kick set - no
  // anti-crouch case here, a kick already whiffs clean over a crouch
  // regardless of which pose it'd have used (see checkHit's crouch/kick
  // check), so there's nothing for a themed variant to answer.
  pickKickState(opponent) {
    const chaining = opponent && (opponent.state === "hitstun" || opponent.state === "knockback");
    const depth = chaining ? opponent.comboCount : 0;
    return KICK_CHAIN[depth % KICK_CHAIN.length];
  }

  // Which of the two identically-statted aerial poses to throw - purely
  // cosmetic (see AIR_ATTACK's own comment for why there's only one real
  // move spec behind both), but picked with real meaning rather than
  // randomly: flyingKick reads as the more committed "diving after them"
  // strike, so it's reserved for the situation that's actually novel here -
  // chasing an opponent who's ALREADY airborne from a launcher (opponent.state
  // === "juggled") to extend that juggle. Anything else - opponent grounded,
  // opponent mid-jump themselves, or no opponent reference at all - is the
  // plain jump-in read, airKick.
  pickAirAttackState(opponent) {
    return opponent && opponent.state === "juggled" ? "flyingKick" : "airKick";
  }

  // Collision (keeping the two fighters from ever overlapping) is resolved
  // symmetrically by the caller after both fighters have moved - see
  // resolveCollision in game.js. Doing it here per-fighter, keyed off each
  // one's own static facing, didn't account for the opponent's own movement
  // and could still let them slide past each other.
  applyMove(input) {
    const speed = MOVE_SPEED * this.archetype.speedMult;
    let vx = 0;
    if (input.left) vx -= speed;
    if (input.right) vx += speed;
    this.x += vx;
    this.x = Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, this.x));
    return vx;
  }

  // Covers real jump, uppercut's own (shorter) rise, knockback's launch arc,
  // and (new) the juggled state's own real physics - body.js's draw code
  // stays untouched either way and just reads one property regardless of
  // which move/state it is.
  get jumpOffset() {
    // jump/airKick/flyingKick all sample the SAME parabola off airborneT
    // (not stateT) - see airborneT's own constructor comment for why: an air
    // attack resets stateT (setState does that on every transition) but must
    // NOT restart the height arc, or the sprite would visibly snap back to
    // ground level the instant a jump-kick was thrown, then jump back up to
    // a fresh full-height arc once "jump" resumed after it. One continuous
    // flight, one continuous formula, sourced from the one counter that
    // actually persists across the whole thing.
    if (this.state === "jump" || this.state === "airKick" || this.state === "flyingKick") {
      const t = Math.min(1, this.airborneT / JUMP_DURATION);
      return JUMP_HEIGHT * 4 * t * (1 - t);
    }
    if (this.state === "uppercut") {
      const t = Math.min(1, this.stateT / UPPERCUT.duration);
      return UPPERCUT.height * 4 * t * (1 - t);
    }
    if (this.state === "knockback") {
      const t = Math.min(1, this.stateT / KNOCKBACK_DURATION);
      return KNOCKBACK_ARC_HEIGHT * 4 * t * (1 - t);
    }
    // Unlike every branch above (a fixed-shape parabola sampled purely off
    // stateT/a known total duration), juggleY is a REAL simulated value,
    // integrated tick by tick in update()'s own "juggled" branch off actual
    // velocity/gravity - it has no fixed total duration to sample against
    // (a relaunch can extend or shorten it), so this just reads whatever
    // that simulation's current height happens to be rather than computing
    // one itself.
    if (this.state === "juggled") {
      return this.juggleY;
    }
    return 0;
  }

  // Special has no melee hitbox of its own anymore - see spawnProjectile in
  // game.js, which handles its hit detection independently once the
  // projectile it fires is actually in flight.
  attackHitbox() {
    // Every pose in PUNCH_POSES/KICK_POSES (punchStill/punch2/elbow/
    // downPunch/groundPunch, highKick) shares its family's real move data
    // wholesale (same damage/range/timing as the original punch/kick) - this
    // is a visual/combo-string layer on top of the existing balance, not a
    // new set of moves with their own numbers to separately tune.
    const spec = PUNCH_POSES.includes(this.state) ? PUNCH : KICK_POSES.includes(this.state) ? KICK : null;
    if (!spec) return null;
    if (this.stateT < spec.activeStart || this.stateT > spec.activeEnd) return null;
    if (this.hasHit) return null;
    return {
      from: this.x,
      to: this.x + this.facing * spec.range,
      damage: spec.damage * this.archetype.damageMult,
      isPunch: spec === PUNCH,
      kind: spec === PUNCH ? "punch" : "kick",
    };
  }

  get specialDamage() {
    return SPECIAL.damage * this.archetype.damageMult;
  }

  get builderSpecialDamage() {
    return BUILDER_SPECIAL.damage * this.archetype.damageMult;
  }

  get slideDamage() {
    return SLIDE.damage * this.archetype.damageMult;
  }

  get uppercutDamage() {
    return UPPERCUT.damage * this.archetype.damageMult;
  }

  get airAttackDamage() {
    return AIR_ATTACK.damage * this.archetype.damageMult;
  }

  get airSpecialDamage() {
    return AIR_SPECIAL.damage * this.archetype.damageMult;
  }

  // kind is whatever attackHitbox()/updateSlide/checkUppercutHit call this
  // with ("punch"/"kick"/"slide"/"uppercut"/"special") - landing any real
  // hit builds power now, not just a punch, so kick/slide/uppercut (which
  // all cost power - see input handling above, or in slide/uppercut's case
  // spend the risk of missing) get some of it back on a successful hit.
  onLandedHit(kind) {
    const gain = POWER_GAIN[kind] ?? 0;
    if (gain > 0) this.power = Math.min(MAX_POWER, this.power + gain);
  }

  // Called from game.js's checkHit/checkUppercutHit ONLY when the defender's
  // own takeDamage just reported "perfect-parry" (see below) - reuses the
  // existing hitstun state/animation for the attacker's punish window
  // instead of a dedicated "parried" state, since there's no spare art for
  // a brand-new pose (see ANIMS in body.js) and getting visibly cut off
  // mid-swing into the same stagger a real hit causes already reads
  // correctly as "that opening got punished".
  applyParryStagger() {
    this.hitstunFrames = PARRY_STAGGER_FRAMES;
    // Without this, a real hit landed on the attacker while they're stuck in
    // this borrowed "hitstun" state would read as wasChaining=true in
    // takeDamage below and inherit whatever comboCount this fighter last had
    // from an earlier, unrelated combo - decaying the punish hit's damage
    // through computeComboDamageScale instead of letting it land clean. This
    // fighter isn't "still mid-combo", they're freshly staggered - zeroing
    // it here means the very next hit that lands on them reads as hit 1 of a
    // brand new combo (full damage), which is the whole point of rewarding
    // the read with an opening in the first place.
    this.comboCount = 0;
    this.setState("hitstun");
    this.lastEvent = "parried";
  }

  // Called from takeDamage below whenever kind === "uppercut" - see the big
  // "Airborne juggle" comment block up near the UPPERCUT/JUGGLE_* constants
  // for the full design this implements. Handles BOTH a fresh launch (this
  // fighter wasn't already airborne) and a relaunch (a second, third... Nth
  // uppercut catching them while state is already "juggled") through the
  // same path - the only thing that differs between the two is whether
  // juggleHits/juggleAirborneFrames carry over or reset, both handled right
  // here.
  applyJuggleLaunch() {
    const relaunch = this.state === "juggled";
    this.juggleHits = relaunch ? this.juggleHits + 1 : 1;
    // Only a genuinely fresh sequence resets the TIME axis cap's own
    // counter - a relaunch keeps counting from wherever the sequence already
    // was, which is the entire point of MAX_JUGGLE_FRAMES being a real
    // backstop across the whole sequence rather than something a relaunch
    // could quietly refresh back to zero.
    if (!relaunch) this.juggleAirborneFrames = 0;
    const capped = this.juggleHits > MAX_JUGGLE_HITS || this.juggleAirborneFrames >= MAX_JUGGLE_FRAMES;
    if (capped) {
      // Hard cap reached (either axis) - this hit still deals its own
      // (already combo-decayed, via computeComboDamageScale in takeDamage)
      // damage and, if they're mid-air from momentum already, doesn't yank
      // them out of it artificially either - but grants NO new upward
      // velocity, full stop. Clamped to never exceed 0 (never ADDS upward
      // velocity) rather than force-zeroed outright, so a capped hit landing
      // while they're already falling doesn't un-naturally freeze their
      // downward motion for a frame - gravity in update()'s "juggled" branch
      // just keeps doing its job either way.
      this.juggleVY = Math.min(this.juggleVY, 0);
    } else {
      // Decays off the ORIGINAL launch velocity via hits-so-far, not off
      // whatever this.juggleVY happens to already be - see
      // JUGGLE_RELAUNCH_DECAY's own comment above for why compounding decay
      // off the previous hit's already-decayed value would only trend
      // toward (never reach) zero on its own.
      this.juggleVY = JUGGLE_LAUNCH_VELOCITY * Math.pow(JUGGLE_RELAUNCH_DECAY, this.juggleHits - 1);
    }
    // A fresh launch starts from ground level; a relaunch keeps whatever
    // height they were already at (mid-air, by definition, since relaunch
    // requires state === "juggled" already) - only the velocity above
    // changes on a relaunch, not a position snap.
    if (!relaunch) this.juggleY = 0;
    this.setState("juggled");
  }

  // Called from takeDamage below whenever isJuggleSpike(...) says this hit
  // qualifies - see that function's own comment above for exactly which
  // hits count (already-airborne, real juggle-local depth, a closer-class
  // kind). Deliberately NOT applyJuggleLaunch with a bigger number - the
  // whole point is a categorically different reaction (forced hard down,
  // not a decayed relaunch up), so this is its own method rather than a
  // branch bolted onto that one. Still increments juggleHits (harmless
  // bookkeeping hygiene, matches applyJuggleLaunch's own relaunch path -
  // nothing reads juggleHits again after a spike, since the sequence is
  // about to end at landing regardless) rather than leaving it stale.
  applyJuggleSpike() {
    this.juggleHits += 1;
    this.juggleVY = -JUGGLE_SPIKE_VELOCITY;
    this.spiked = true;
    this.setState("juggled");
  }

  takeDamage(amount, fromX, kind) {
    // stateT here is exactly "frames since block was raised" (see the big
    // comment on PARRY_WINDOW_FRAMES above for why that's reliable).
    const isPerfectParry = this.state === "block" && this.stateT <= PARRY_WINDOW_FRAMES;
    // High/low guard mix-up (see the GUARD_FLASH_FRAMES comment above for
    // the full reasoning): standing block stops mid punches and high
    // kicks/uppercut, same as it always did, but is helpless against a
    // slide same as before slide even existed as a real kind here. blockLow
    // (crouch+block held together, see update()) is the crouching answer -
    // flipped the other way, it stops that same slide plus punches, but
    // does nothing against kick/uppercut. Kicks never actually reach this
    // far while crouching (checkHit's own crouch/blockLow whiff in game.js
    // already excludes them before takeDamage is even called), so the
    // `kind !== "kick"` exclusion below is belt-and-suspenders; uppercut
    // DOES reach here, and this is what actually makes it whiff a crouching
    // guard the way a real anti-air should - the one thing genuinely new to
    // verify (see the crouch-exploit re-check this was built against).
    // Specials always blow straight through either guard, full stop -
    // unchanged.
    const blockedByStanding = this.state === "block" && kind !== "special" && kind !== "slide";
    // "airKick" added alongside kick/uppercut - the whole point of a jump-in
    // is that it's a HIGH threat a crouching guard shouldn't save you from
    // (real fighting games: this is exactly what makes an overhead/jump-in
    // and a low sweep a genuine mix-up instead of one guard stance answering
    // everything - see checkAirAttackHit in game.js, which deliberately
    // doesn't whiff this move over a crouching profile the way a GROUNDED
    // kick does either, for the same reason). Only standing block (above)
    // actually stops it.
    const blockedByLowGuard = this.state === "blockLow" && kind !== "special" && kind !== "kick" && kind !== "uppercut" && kind !== "airKick";
    if (blockedByStanding || blockedByLowGuard) {
      if (isPerfectParry) {
        // Full negate, not just a discount - a perfect parry has to feel
        // categorically better than plain block or there's no reason to
        // ever attempt the tighter timing over just holding guard. Standing
        // block only (see isPerfectParry above) - blockLow doesn't get a
        // parry window, same reasoning Hodler's own holding stance doesn't:
        // it's a new, narrower guard option, not a strictly-better one.
        this.power = Math.min(MAX_POWER, this.power + PARRY_POWER_GAIN);
        this.lastEvent = "perfect-parry";
      } else {
        this.health -= amount * 0.2 * this.archetype.blockMult;
        // A successful block is real defensive skill, not just standing
        // there - rewarding it with power gives blocking a reason to exist
        // beyond just "take less damage this once".
        this.power = Math.min(MAX_POWER, this.power + BLOCK_POWER_GAIN);
        this.lastEvent = "block-taken";
        // Cosmetic guard-pose swap, standing block only - see body.js's
        // drawFighter, which reads this to pick block vs block2 while
        // state==="block". blockLow already has its own dedicated sheet
        // drawn for the whole stance, not just the instant of a hit, so it
        // doesn't need this at all. kind here is never "kick" (blockLow
        // can't reach this branch on a kick - see blockedByLowGuard above),
        // but uppercut reads as the same "high" family as a kick
        // cosmetically even though only standing block ever actually stops
        // it.
        if (this.state === "block") {
          this.guardFlashSheet = kind === "kick" || kind === "uppercut" || kind === "airKick" ? "block2" : "block";
          this.guardFlashT = GUARD_FLASH_FRAMES;
        }
      }
    } else {
      // A continuation of the SAME combo only if this fighter was still
      // genuinely locked in the last hit's reaction when this one landed -
      // if state already got back to idle/walk/block/crouch/etc in between,
      // that's a gap, and this hit starts a fresh count at 1. See the
      // combo-scaling block up top for why the state check alone is enough
      // (no separate "combo ended" reset needed anywhere else). "juggled" is
      // a chain-continuation state same as hitstun/knockback now - a
      // follow-up uppercut landing on an already-airborne defender is
      // exactly as much a real combo continuation as one landing on a
      // grounded hitstun defender, and needs to read that way for
      // comboCount/the FX tier escalation/isComboEnder below, all of which
      // are keyed off this same counter.
      const wasChaining = this.state === "hitstun" || this.state === "knockback" || this.state === "juggled";
      this.comboCount = wasChaining ? this.comboCount + 1 : 1;
      const scaledAmount = amount * computeComboDamageScale(this.comboCount);
      this.health -= scaledAmount;
      // Scaled per this exact hit's ALREADY-combo-scaled damage (see
      // computeHitstunFrames above) - read by the "hitstun" branch of
      // update()'s durations map the instant setState below flips into it.
      // Using the scaled amount (not the raw one) means hitstun shrinks
      // alongside damage as a combo goes on, which is what keeps a long
      // string from staying trivially chainable forever - see the
      // COMBO_DAMAGE_DECAY comment above. Set even for a slide/knockback/
      // juggle hit (harmless - neither "knockback"'s fixed duration nor the
      // physics-driven "juggled" state ever reads this field) so it's always
      // current for whichever hit lands next.
      this.hitstunFrames = computeHitstunFrames(scaledAmount);
      // uppercut is the real launcher now (see applyJuggleLaunch and the big
      // "Airborne juggle" comment block above) - kind === "uppercut" always
      // routes here, fresh launch or relaunch alike, so there's no path left
      // where a connecting uppercut still produces the old flat grounded
      // knockback/hitstun.
      //
      // `this.state === "juggled"` is the OTHER thing that routes here now -
      // this is the actual hook the aerial-attack phase needs: an airKick/
      // flyingKick (or, in principle, any move) landing on a defender who's
      // ALREADY airborne from an earlier launch must extend that same
      // juggle sequence through applyJuggleLaunch's own decay/hit-count/
      // frame-count caps, not snap them back down into grounded "hitstun"
      // mid-air the way every other hit already resolves - that snap would
      // both look like a teleport (jumpOffset returns 0 for "hitstun", not
      // whatever height juggleY was at) and silently break the anti-infinite
      // guarantee, since a hit routed through the plain branch below would
      // never touch juggleHits/juggleAirborneFrames at all. In practice this
      // can only ever fire for an uppercut relaunch or an airKick/flyingKick
      // follow-up - checkHit/updateSlide/checkBuilderSpecialHit/
      // updateProjectiles' own dodge logic all still
      // exclude a "juggled" defender outright (see each one's own comment in
      // game.js), so no grounded move can ever reach a defender in this
      // state to begin with. Deliberately reuses applyJuggleLaunch WHOLESALE
      // rather than a second, air-attack-specific version of it - a relaunch
      // via a follow-up jump-kick counts against the exact same
      // MAX_JUGGLE_HITS/MAX_JUGGLE_FRAMES caps an uppercut relaunch would,
      // which is the "same juggle-hit/damage-decay/juggle-cap machinery,
      // don't build a parallel path" requirement this phase was built
      // against, not a coincidence.
      // Captured before applyJuggleLaunch/applyJuggleSpike run (both call
      // setState("juggled"), which would make a same-state check here
      // meaningless) - true only when this fighter was ALREADY airborne the
      // instant this hit landed, i.e. this is a relaunch/follow-up, never
      // the launch itself. isJuggleSpike below needs exactly this (see its
      // own comment for why "already juggled" is what rules out the launch
      // reading as an "early juggle hit").
      const wasAlreadyJuggled = this.state === "juggled";
      // See isJuggleSpike's own big comment block above - a spike only ever
      // fires on a hit that both (a) lands on an already-airborne defender
      // and (b) has already extended THIS juggle sequence at least
      // JUGGLE_SPIKE_MIN_HITS times, on the juggle-local juggleHits counter,
      // not the polluted-by-ground-openers overall comboCount. Computed once
      // here (not re-derived inside the branch below) so the exact same
      // read also feeds lastComboEnder's own OR at the bottom of this
      // method - a spike must always read as an ender for the shake/flash
      // escalation even when its kind is "airKick", which ENDER_KINDS
      // itself deliberately doesn't include (see isComboEnder's own
      // comment for why a grounded jump-in alone isn't ender-class - a
      // SPIKED one, on an already-juggled target at real depth, is a
      // completely different situation).
      const spikedThisHit = isJuggleSpike(wasAlreadyJuggled, this.juggleHits, kind);
      if (kind === "uppercut" || wasAlreadyJuggled) {
        if (spikedThisHit) {
          this.applyJuggleSpike();
        } else {
          this.applyJuggleLaunch();
        }
      } else {
        // A spike's own much longer HARD_KNOCKDOWN_DURATION hold (see the
        // durations map above) must never leak into an unrelated LATER
        // slide hit that happens to reuse this same "knockback" state
        // string - explicitly cleared here, the only other place
        // "knockback" is ever entered from (the "juggled" branch's own
        // landing check is the other, and always assigns this field fresh
        // one way or the other on every landing - see its own comment).
        if (kind === "slide") this.hardKnockdownFrames = null;
        this.setState(kind === "slide" ? "knockback" : "hitstun");
      }
      this.lastEvent = "hit-taken";
      this.lastHitKind = kind;
      // Stashed on the instance (not just a local) so the isComboEnder OR
      // below can read it after health's own KO clamp runs - see that
      // block's own comment for why isKO has to be computed last, which
      // pushes this read to the very end of the method too.
      this.lastHitWasSpike = spikedThisHit;
    }
    this.health = Math.max(0, this.health);
    if (this.health <= 0) {
      this.setState("ko");
      this.lastEvent = "ko";
    }
    // Computed last, after health's own KO clamp above, so isComboEnder sees
    // the final post-hit health (isKO must reflect whether THIS hit was the
    // killing blow, not health from some earlier moment). Left false (the
    // constructor/update() default) for the block/perfect-parry branches
    // above - lastHitKind stays null there too - since neither is a real
    // landed hit, there's no combo depth or ender to escalate.
    if (this.lastEvent === "hit-taken" || this.lastEvent === "ko") {
      // `|| this.lastHitWasSpike` - a spike must always read as an ender for
      // the shake/flash escalation (see checkUppercutHit/checkAirAttackHit/
      // applyHomingHit in game.js, all of which key their SHAKE_ON_ENDER/
      // FLASH_ON_ENDER choice off this exact field) even on the "airKick"
      // kind, which isComboEnder's own ENDER_KINDS deliberately doesn't
      // include - see isJuggleSpike's own comment above for why a grounded
      // jump-in not being ender-class doesn't mean a SPIKED one isn't.
      this.lastComboEnder = isComboEnder(this.comboCount, kind, this.health <= 0) || this.lastHitWasSpike;
    }
  }
}
