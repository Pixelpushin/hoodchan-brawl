import {
  drawFighter,
  drawArena,
  drawFlash,
  drawBloodSpot,
  drawBloodSpatter,
  drawBloodSplatExtra,
  pickBloodSpotVariant,
  pickBloodSplatVariant,
  drawHeadPop,
  drawSurgeBlast,
  drawRatRush,
  drawEnergyBurst,
  drawHitSpark,
  drawComboSwish,
  drawComboPow,
  BLOOD_SPATTER_TOTAL_FRAMES,
  SURGE_BLAST_TOTAL_FRAMES,
  ENERGY_BURST_TOTAL_FRAMES,
  HIT_SPARK_TOTAL_FRAMES,
  HEAD_POP_DURATION,
  COMBO_POW_DURATION,
  GROUND_Y,
} from "./body.js";
import {
  MAX_POWER,
  SLIDE,
  UPPERCUT,
  AIR_ATTACK,
  AIR_SPECIAL,
  AIR_KICK_POSES,
  BUILDER_SPECIAL,
  ARENA_MIN_X,
  ARENA_MAX_X,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  computeHitstopFrames,
  computeComboFreezeBonus,
  KICK_POSES,
} from "./fighter.js";
import { playSound } from "./sound.js";
import { createAIController } from "./ai.js";
import { speakTaunt } from "./tts.js";
import { isBloodUnlocked } from "./blood-code.js";
import { reportMatchResult } from "./api.js";
import { findGamepad, buildGamepadInput } from "./gamepad.js";

const KEYMAP = {
  p1: {
    // WASD movement + JKIL attack scheme (mirrors a controller face layout)
    // J=punch(X)  K=kick(A)  I=powerKick(Y)  L=special(B)
    // F=block   Shift=dash   Space=jump   S=crouch   A/D=move
    left: "a",
    right: "d",
    block: "f",
    crouch: "s",
    jump: " ",
    uppercut: "i",
    slide: "e",
    punch: "j",
    kick: "k",
    special: "l",
    dash: "shift",
  },
  p2: {
    left: "arrowleft",
    right: "arrowright",
    block: "m",
    crouch: "arrowdown",
    jump: "arrowup",
    uppercut: "8",
    slide: "7",
    punch: "4",
    kick: "5",
    special: "6",
    dash: "9",
  },
};

const SHAKE_ON_HIT = 6;
const SHAKE_ON_SPECIAL = 12;
// Combo-ender escalation - clearly bigger than either baseline above, but not
// by an order of magnitude, since shake is drawn as a per-frame random
// translate (see loop()'s `if (shake > 0)` branches) and an excessive value
// there reads as broken jitter rather than "big hit". Reserved for hits where
// defender.lastComboEnder is true (see isComboEnder in fighter.js) - checked
// at each checkHit/updateSlide/checkUppercutHit/checkBuilderSpecialHit/
// updateProjectiles hit branch below.
const SHAKE_ON_ENDER = 22;
const FLASH_ON_HIT = 0.25;
const FLASH_ON_ENDER = 0.5;

// Combo "charge-up" FX escalation - a pure function of the defender's own
// comboCount (see takeDamage in fighter.js), not a variable this module
// tracks itself, so a combo dropping back to 1 mid-match just falls straight
// back to NONE next hit with nothing to reset - there's no persisted
// "current tier" to get stuck holding an elevated value. Design brief: hit 1
// bare, hit 2 a plain swish, hit 3 a bigger colored swish, hit 4 that swish
// plus a pow burst, hit 5+ the biggest swish plus the biggest burst.
const COMBO_FX_TIER = { NONE: "none", SWISH: "swish", SWISH_COLORED: "swish-colored", POW: "pow", BIG_POW: "big-pow" };
function getComboFxTier(comboCount) {
  if (comboCount >= 5) return COMBO_FX_TIER.BIG_POW;
  if (comboCount === 4) return COMBO_FX_TIER.POW;
  if (comboCount === 3) return COMBO_FX_TIER.SWISH_COLORED;
  if (comboCount === 2) return COMBO_FX_TIER.SWISH;
  return COMBO_FX_TIER.NONE;
}
// Tier 4/5 are already the big moments on their own - this just nudges a
// long-running string (6, 7, 8+ hits) a little further past whichever of
// those it's landed on rather than flatlining at the same size forever,
// capped so it never runs away.
function comboPowScale(comboCount) {
  return Math.min(1.8, 1.3 + Math.max(0, comboCount - 4) * 0.1);
}
const COMBO_SWISH_LIFETIME_FRAMES = 16;
const COMBO_SWISH_FADE_FRAMES = 6;
// How long the winner's flex (and the loser's own finishing animation)
// keeps playing after a round ends before actually moving on - long enough
// for a short spoken victory line to finish, not just an instant flash.
const RESULT_DISPLAY_FRAMES = 170;
const SPATTER_TICKS_PER_FRAME = 3;
const IMPACT_TICKS_PER_FRAME = 3;
// Only 2 source frames (a sharp flash, not a lingering burst) - held longer
// per tick than the 5-frame energy burst above so it still reads as a
// visible flash instead of blinking past in 2 frames flat.
const HIT_SPARK_TICKS_PER_FRAME = 5;
const MAX_GROUND_BLOOD = 90;
// Mid-air splats (splatExtras) vanish almost immediately rather than
// sticking around - unlike groundBlood, which is meant to pool and stay.
// Roughly matches how long the animated spatter burst itself lives
// (BLOOD_SPATTER_TOTAL_FRAMES * SPATTER_TICKS_PER_FRAME = 15 frames), so it
// doesn't outlast the effect it's layered behind.
const SPLAT_EXTRA_LIFETIME_FRAMES = 14;
const SPLAT_EXTRA_FADE_FRAMES = 5;
// How fast the special's projectile crosses the arena - covers the full
// ~700px play area in a bit over a second at 60fps, fast enough to read as
// a real threat but slow enough a jump can still dodge it.
const PROJECTILE_SPEED = 9;
// Half-width of its hit window, centered on the target's visual body
// center - roughly matches the fighter sprite's own on-screen body width.
const PROJECTILE_HIT_RADIUS = 34;
const PROJECTILE_SPRITE_TICKS_PER_FRAME = 2;
// Flipper's rat rush - a ground-level swarm instead of a head-height bolt.
// Slower than the bolt (a crawling mass, not a lobbed shot) but only
// dodgeable by a jump - crouching doesn't help against something already at
// ground level, matching the same rule as a slide.
const RAT_RUSH_SPEED = 10;
const RAT_RUSH_HIT_RADIUS = 45;
const RAT_RUSH_SPRITE_TICKS_PER_FRAME = 3;

// --- Homing aerial special (fighter.js's AIR_SPECIAL) -----------------------
// Same projectiles array/updateProjectiles loop/drawSurgeBlast art the bolt
// above already uses (see spawnHomingProjectile/the "homing" branch inside
// updateProjectiles below) - only the STEERING is new. A simple proportional
// (P-)controller, not real aim-assist: every real tick, the projectile's own
// velocity is nudged a fraction (HOMING_TURN_RATE) of the way toward "dead
// straight at the target's x THIS INSTANT", recomputed fresh every tick
// rather than aimed once at cast time. Since the target's own x is itself
// still moving (walking, or drifting through a juggle), the bolt is always
// chasing a moving point it hasn't yet caught up to - that's what makes the
// flight path visibly curve rather than snap-lock onto a straight line or
// teleport onto the target, and it's the whole "how do you combo... ranged
// attacks from the air auto aimed at opponent" ask made real.
const HOMING_SPEED = 8;
// Fraction of the current velocity-vs-target-heading gap corrected per real
// tick. 0.16 chosen empirically (verified live - see this phase's own
// verification pass): high enough that a launch aimed roughly at the
// opponent visibly bends onto them within a few frames instead of missing
// wide, low enough that the curve is actually visible frame to frame rather
// than reading as an instant snap the moment it's cast.
const HOMING_TURN_RATE = 0.16;
// Matches PROJECTILE_HIT_RADIUS (the straight bolt's own hit window) - same
// target body width, no reason for the homing variant's contact tolerance to
// differ.
const HOMING_HIT_RADIUS = 34;
// Backstop, not a real gameplay lever - a projectile that's still tracking
// (never closed the gap, e.g. the target stayed pinned at the exact opposite
// wall for its whole flight) fizzles out here rather than homing forever.
// 90 frames (1.5s) is generous relative to how fast HOMING_SPEED actually
// closes real arena distances - this essentially never fires in practice,
// it's a guarantee, not a tuning knob.
const HOMING_MAX_LIFETIME_FRAMES = 90;

// --- Bolt/rat-rush multi-hit flurry ---------------------------------------
// Both of these are ranged - once one connects, the defender is genuinely
// locked in real hitstun (Fighter.update() early-returns on "hitstun", no
// input read at all), so this reads as a short scripted flurry riding that
// lockout rather than a fresh hit-radius check every tick: the ONLY real
// "escape" window is before the first pulse ever lands (dodged, below, same
// as it always was) - exactly how a real fighting-game multi-hit super
// works, and why there's no soft-lock risk either (pulsesLeft only ever
// counts down, never resets, so the sequence always terminates in exactly
// SPECIAL_PULSE_COUNT beats regardless of what either fighter does).
const SPECIAL_PULSE_COUNT = 3;
// Real ticks between each follow-up pulse once the flurry has started (NOT
// counting whatever extra frames that pulse's own triggerHitstop freezes on
// top - updateProjectiles doesn't run at all during a hitstop freeze, so the
// freeze can't eat into this). Comfortably shorter than computeHitstunFrames'
// own floor (14, fighter.js) even at the smallest pulse damage this move can
// ever deal, so the defender is never actually free to act between pulses -
// verified live (see the multi-hit special report) rather than just assumed.
const SPECIAL_PULSE_INTERVAL_FRAMES = 10;
// Each pulse's push, applied a few times rather than once - "a few paces
// total across the sequence", not a single big shove on pulse one. p.facing
// (the direction the projectile launched in, locked at spawn) drives the
// direction rather than a live attacker-vs-defender position compare, since
// the caster may already be several frames into their own recovery/hitstun
// by the time a later pulse in this same sequence fires - "away from
// wherever this was thrown from" is what should track, not a stale read of
// wherever the caster happens to be standing right now.
const SPECIAL_PULSE_KNOCKBACK = 20;
// How fast the slide closes distance - a short, committal burst (11 frames
// at SLIDE.duration in fighter.js, ~175px max) meant to close one engage-
// range gap and get under a jump, not cross the arena. It used to be tuned
// to clear the full ~700px width, which turned it into a free full-screen
// approach with no real risk - now whiffing one from far away just leaves
// you exposed mid-floor instead of guaranteeing a "land behind them" payoff
// from anywhere.
const SLIDE_SPEED = 16;
// Wider than PROJECTILE_HIT_RADIUS and set to just clear MIN_FIGHTER_GAP -
// the slide should connect right as the two fighters would otherwise
// collide, not noticeably before or after.
const SLIDE_HIT_RADIUS = 70;
// Solid-body distance the two fighters can never close past - matches the
// actual rendered sprite width (~60px at full scale) so their bodies visibly
// meet without overlapping, not just an arbitrary small number. Attack
// ranges (fighter.js) are all sized to clear this with margin.
const MIN_FIGHTER_GAP = 68;

// A fighter counts as "airborne" for every one of the grounded-attack
// exclusion checks below (checkHit/updateSlide/checkBuilderSpecialHit/
// updateProjectiles' own dodge logic/resolveCollision)
// the moment they're off the ground for ANY reason - a voluntary jump, an
// uppercut-launched juggle, or (new) mid-way through throwing airKick/
// flyingKick, fighter.js's aerial-attack poses: airborneT (fighter.js) keeps
// counting through that whole flight without resetting specifically so a
// fighter mid-air-attack still reads as genuinely airborne everywhere else
// in the engine, same as plain "jump" already did, rather than becoming
// briefly "grounded" (and hittable by a sweep, dodging nothing, solid-body
// blocked) for the couple frames their own swing is out. Factored out once
// here instead of repeating the same four-state OR chain at every call site
// below - same reasoning KICK_POSES/PUNCH_POSES already collapse several
// pose variants into one classification for.
function isAirborne(state) {
  return state === "jump" || state === "juggled" || state === "airKick" || state === "flyingKick";
}

// Pushes both fighters apart symmetrically whenever they'd overlap, instead
// of each fighter unilaterally checking only its own (static) facing - that
// old approach didn't account for the opponent's own movement and let them
// slide past each other. Clamping each side to the arena bounds
// independently after a naive symmetric push isn't enough on its own: if one
// side is pinned against a wall, its half of the push gets silently
// swallowed by the clamp and the other side never receives it, letting the
// pair stay overlapped (or, at the extreme, the wall-pinned one gets read as
// "off" its own clamped position because the other overshoots). Instead each
// side's shortfall against the wall is measured and handed to the other side
// so the full gap is still enforced.
//
// Skipped entirely while either fighter is airborne - jumping used to be
// purely cosmetic (jumpOffset just lifts the sprite; horizontally they were
// still solid-blocked at MIN_FIGHTER_GAP the whole time), so there was
// never actually a way to end up on the other side of the opponent. This is
// what makes jumping over someone - or sliding past one who jumped over
// your slide - actually work. "juggled" (fighter.js's new airborne-launcher
// state) is included in the same skip for the same reason - a juggled
// fighter is every bit as airborne as a jumping one, and this is also what
// lets the ATTACKER actually jump in close to (or past) a still-airborne
// juggled opponent to follow up, instead of the solid-body push shoving
// them back out to MIN_FIGHTER_GAP the instant they try. "airKick"/
// "flyingKick" fold into the same isAirborne() check now for the same
// reason - the attacker throwing an air attack while closing in on a
// juggled opponent is exactly the case this exists to not shove apart.
function resolveCollision(a, b) {
  if (isAirborne(a.state) || isAirborne(b.state)) return;
  const dx = b.x - a.x;
  if (Math.abs(dx) >= MIN_FIGHTER_GAP) return;
  const dir = dx >= 0 ? 1 : -1;
  const overlap = MIN_FIGHTER_GAP - Math.abs(dx);
  const halfPush = (dir * overlap) / 2;

  const aTarget = a.x - halfPush;
  const bTarget = b.x + halfPush;
  const aClamped = Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, aTarget));
  const bClamped = Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, bTarget));
  // Whatever either side couldn't take because it hit a wall gets handed to
  // the other side, so the full gap is still enforced even when one fighter
  // is pinned - a one-directional version of this let the pinned side's
  // shortfall just vanish, silently leaving the pair overlapped.
  const aShortfall = aTarget - aClamped;
  const bShortfall = bTarget - bClamped;
  a.x = Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, aClamped - bShortfall));
  b.x = Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, bClamped - aShortfall));
}

const SCROLL_KEYS = new Set([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

export function createGame({ ctx, p1, p2, onEnd, timeLimit = 60, p2AI = false, practiceMode = false }) {
  // A real training dummy, not just a very bad AI - never acts (no attacks,
  // no blocks, no movement), which is exactly emptyP2Input below. p2AI is
  // ignored entirely when this is on; readInput(KEYMAP.p2) is also skipped
  // since nobody's meant to be on the second keymap for solo practice.
  const emptyP2Input = {
    left: false, right: false, block: false, crouch: false, jump: false,
    uppercut: false, slide: false, punch: false, kick: false, special: false,
    dash: false,
  };
  const getAIInput = practiceMode ? null : p2AI ? createAIController(p2, p1) : null;
  const pressed = new Set();
  const keydown = (e) => {
    const key = e.key.toLowerCase();
    if (SCROLL_KEYS.has(key)) e.preventDefault();
    pressed.add(key);
  };
  const keyup = (e) => pressed.delete(e.key.toLowerCase());
  window.addEventListener("keydown", keydown);
  window.addEventListener("keyup", keyup);

  function readInput(map) {
    return {
      left: pressed.has(map.left),
      right: pressed.has(map.right),
      block: pressed.has(map.block),
      crouch: pressed.has(map.crouch),
      jump: pressed.has(map.jump),
      uppercut: pressed.has(map.uppercut),
      slide: pressed.has(map.slide),
      punch: pressed.has(map.punch),
      kick: pressed.has(map.kick),
      special: pressed.has(map.special),
      dash: pressed.has(map.dash),
    };
  }

  // OR's keyboard and gamepad together rather than one replacing the other,
  // so a controller plugged in mid-match just works alongside the keyboard
  // with nothing to switch into. gp is a real Gamepad object (or null) from
  // findGamepad() - resolved fresh per-frame in the main loop below rather
  // than assumed to live at a fixed browser index (verified live: a single
  // connected pad can land at index 1, not 0, leaving a hardcoded "p1 =
  // index 0" lookup seeing nothing even though the pad works fine).
  function withGamepad(keyboardInput, gp) {
    if (!gp) return keyboardInput;
    const gpInput = buildGamepadInput(gp);
    const merged = {};
    for (const key in keyboardInput) merged[key] = keyboardInput[key] || gpInput[key];
    return merged;
  }

  let timeLeft = timeLimit;
  let frame = 0;
  let ended = false;
  // Fully halts the render loop (set by the cleanup function this returns).
  // Distinct from `ended`, which only stops combat logic - the result/flex
  // display keeps animating and rendering for a while after `ended` flips.
  let stopped = false;
  let resultTimer = 0;
  let roundWinner;
  let shake = 0;
  let flash = 0;
  // Hitstop - counts down in real frames. While > 0, loop() below takes the
  // early-return branch that freezes both fighters, projectiles, blood FX,
  // and the round timer entirely (only input polling for buffer capture and
  // drawing the current frame still run) - see computeHitstopFrames in
  // fighter.js for the damage->frames formula and the "if (hitstopFrames >
  // 0)" branch of loop() for the actual freeze. Set (never just assigned)
  // via triggerHitstop so multiple hits landing the same frame always keep
  // the larger of their two freezes rather than one clobbering the other.
  let hitstopFrames = 0;
  // COMBO_HITSTOP_TOTAL_MAX_FRAMES: computeHitstopFrames alone already caps
  // at 16 (fighter.js's HITSTOP_MAX_FRAMES) and computeComboFreezeBonus caps
  // its own contribution at 14, so 30 is already the natural ceiling of the
  // sum below - this is a documented backstop, not something that actually
  // binds today, but keeps that guarantee explicit here rather than only
  // true by coincidence of two separately-tuned constants in another file.
  const COMBO_HITSTOP_TOTAL_MAX_FRAMES = 30;
  // comboCount defaults to 1 (computeComboFreezeBonus's own "not a combo
  // yet" floor) - every call site below only passes a real comboCount when
  // the hit actually landed clean (see each one's own comment), so a block/
  // parry never contributes a freeze bonus on top of its own flat hitstop.
  function triggerHitstop(damage, comboCount = 1) {
    const total = computeHitstopFrames(damage) + computeComboFreezeBonus(comboCount);
    hitstopFrames = Math.max(hitstopFrames, Math.min(COMBO_HITSTOP_TOTAL_MAX_FRAMES, total));
  }
  const powerFullFired = { p1: false, p2: false };
  const groundBlood = [];
  const spatters = [];
  const splatExtras = [];
  const headPops = [];
  const projectiles = [];
  const impacts = [];
  const hitSparks = [];
  // Combo escalation FX - separate from impacts/hitSparks above (those are
  // the plain per-hit feedback every landed hit already gets) so this layer
  // can come and go with comboCount without touching that baseline.
  const comboSwishes = [];
  const comboPops = [];

  // Rough head height rather than a per-frame anchor lookup - matches the
  // same level-of-precision the blood-spatter positioning already uses.
  const HEAD_Y = GROUND_Y - 95;
  // Flies at head height, not chest height - high enough that a crouching
  // target's shorter silhouette clears under it (see the crouch dodge check
  // in updateProjectiles below), the way a real fireball you duck under
  // should work.
  const PROJECTILE_Y = HEAD_Y;

  // fighter.x is the LEFT EDGE of the sprite's full bounding box, not its
  // visual center - drawFighter always translates to x then draws the frame
  // running rightward from there, for both facings (mirroring flips content
  // within that box, not the box's position). Every position calculated off
  // a fighter for blood/FX purposes needs this offset or it lands entirely
  // inside that fighter's own silhouette instead of at their actual body.
  const BODY_CENTER_OFFSET = 53;

  function spawnHitEffects(defender, attacker) {
    const defenderCenterX = defender.x + BODY_CENTER_OFFSET;
    const attackerCenterX = attacker.x + BODY_CENTER_OFFSET;

    // Anchored between the two fighters' actual visual centers, offset
    // toward wherever the attacker actually is - NOT the defender's own
    // (static, never-changing) facing, which pointed the wrong way whenever
    // the real attacker was standing behind that fixed direction, and NOT
    // raw defender.x either, which is that fighter's left edge rather than
    // their body - anchoring there and then offsetting further toward the
    // attacker landed the burst inside the ATTACKER's own silhouette.
    // Scales with the actual gap between them (~68-94px depending on the
    // move) instead of a small fixed nudge. Biased 40% of the way rather
    // than a true 50/50 midpoint - the attacker's own lunge animation pushes
    // them visually closer than their logical x, so a true midpoint reads as
    // skewed toward the attacker. Height varies by attack type so a kick
    // lands lower than a punch, and a special (thrown from updateProjectiles
    // with a synthetic attacker.state of "special") lands at the same head
    // height PROJECTILE_Y actually flies at, not the old chest-level punch
    // height - otherwise the blood would land somewhere the fireball never
    // was.
    const gapX = Math.abs(attackerCenterX - defenderCenterX);
    const towardAttacker = attackerCenterX >= defenderCenterX ? 1 : -1;
    // KICK_POSES (not a literal "kick" check) - a landed highKick is still a
    // kick-height hit, same as the original kick sheet, even though its own
    // state string is "highKick" now that punch/kick attacks cycle through
    // several pose states (see PUNCH_POSES/KICK_POSES in fighter.js).
    // AIR_KICK_POSES checked ahead of the uppercut case below - a landed
    // airKick/flyingKick connects well above even uppercut's own already-
    // elevated contact point, since the attacker is genuinely up in the air
    // throwing it (the whole point of the move), not just mid-swing at
    // standing height the way a grounded anti-air is.
    const contactHeight =
      KICK_POSES.includes(attacker.state) || attacker.state === "slide"
        ? GROUND_Y - 20
        : attacker.state === "special"
          ? PROJECTILE_Y
          : AIR_KICK_POSES.includes(attacker.state)
            ? GROUND_Y - 110
            : attacker.state === "uppercut"
              ? GROUND_Y - 90
              : GROUND_Y - 50;
    const contactX = defenderCenterX + towardAttacker * (gapX * 0.4);

    // Always-on melee impact flash, independent of the blood setting below -
    // punch/kick/slide/uppercut had NO hit feedback at all with blood off
    // before this (this whole function used to bail out first thing unless
    // blood was unlocked), so a landed hit read as silently absorbed even
    // though damage really did register. See drawHitSpark in body.js.
    hitSparks.push({ x: contactX, y: contactHeight, t: 0 });

    // Combo charge-up escalation - always-on like the hit spark above (not
    // gated on the blood setting below), since it's readability/feel for the
    // combo itself, not a gore option. defender is always the real p1/p2
    // Fighter this comboCount lives on, but attacker sometimes isn't (the
    // specials call sites above pass a synthetic {x, state} object instead
    // of the real owner) - "whichever player defender ISN'T" is always
    // correct here regardless, since this is strictly a 1v1 game.
    const comboTier = getComboFxTier(defender.comboCount);
    if (comboTier !== COMBO_FX_TIER.NONE) {
      // Swish leans the direction the hit actually traveled (toward the
      // defender, away from the attacker) rather than a fixed orientation,
      // with a little jitter so repeated hits in one string don't all look
      // like the exact same stamp.
      const swishRotation = (towardAttacker === -1 ? Math.PI : 0) + (Math.random() - 0.5) * 0.4;
      // level 0/1/2 - see body.js's SWISH_LEVELS. SWISH_COLORED and POW share
      // level 1 (POW just additionally layers a pow burst on top of it);
      // BIG_POW steps up to level 2, the biggest swish art.
      const swishLevel = comboTier === COMBO_FX_TIER.SWISH ? 0 : comboTier === COMBO_FX_TIER.BIG_POW ? 2 : 1;
      const swishScale = comboTier === COMBO_FX_TIER.SWISH ? 1 : comboTier === COMBO_FX_TIER.BIG_POW ? 1.9 : 1.6;
      comboSwishes.push({ x: contactX, y: contactHeight, rotation: swishRotation, scale: swishScale, level: swishLevel, t: 0 });
      if (comboTier === COMBO_FX_TIER.POW || comboTier === COMBO_FX_TIER.BIG_POW) {
        comboPops.push({ x: contactX, y: contactHeight, scale: comboPowScale(defender.comboCount), big: comboTier === COMBO_FX_TIER.BIG_POW, t: 0 });
      }
    }

    // Everything below is blood - hidden by default, Mortal Kombat-style -
    // see blood-code.js for the secret sequence that unlocks it.
    if (!isBloodUnlocked()) return;

    // Ground spots spray wide around the contact point instead of a tight
    // cluster right under their feet - several per hit, reads as a real
    // messy scatter. Nudged down from GROUND_Y - now that there's no
    // platform texture (removed - the backgrounds have their own painted
    // ground), spots centered right at GROUND_Y read as too high, landing
    // behind/on the character instead of clearly on the ground in front of
    // and below them.
    const spotCount = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < spotCount; i++) {
      groundBlood.push({
        imgIndex: pickBloodSpotVariant(),
        x: defenderCenterX + (Math.random() - 0.5) * 160,
        y: GROUND_Y + 8 + Math.random() * 28,
        size: 14 + Math.random() * 20,
        rotation: Math.random() * Math.PI * 2,
      });
    }
    while (groundBlood.length > MAX_GROUND_BLOOD) groundBlood.shift();

    // A static splat layered behind the animated burst first, for extra
    // density - fully randomized position/rotation/scale each time so
    // stacking several hits' worth never looks like the same stamp reused.
    // Spawned in mid-air at the contact point rather than on the ground, so
    // unlike groundBlood it doesn't stick around forever - it ages out (see
    // SPLAT_EXTRA_LIFETIME_FRAMES below) instead of hanging there.
    const splatCount = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < splatCount; i++) {
      splatExtras.push({
        x: contactX + (Math.random() - 0.5) * 24,
        y: contactHeight + (Math.random() - 0.5) * 20,
        variant: pickBloodSplatVariant(),
        rotation: Math.random() * Math.PI * 2,
        scale: 0.7 + Math.random() * 0.6,
        t: 0,
      });
    }
    while (splatExtras.length > MAX_GROUND_BLOOD) splatExtras.shift();

    const burstCount = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < burstCount; i++) {
      spatters.push({
        x: contactX + (Math.random() - 0.5) * 14,
        y: contactHeight + (Math.random() - 0.5) * 16,
        rotation: Math.random() * Math.PI * 2,
        t: -Math.floor(Math.random() * 3),
      });
    }
  }

  // Ground blood is floor-level, so it draws before (behind) both fighters
  // - a character standing on/near a pool should have their own legs
  // occlude it, not float on top of it like a decal pasted over their
  // sprite. Split out from the FX below (and called separately, before
  // drawFighter) rather than combined into one function, since these two
  // groups sit on opposite sides of the fighters in the draw order. Also
  // called from the post-round "ended" display so blood doesn't vanish the
  // instant a round ends - it used to only ever render from inside the
  // active-combat branch of loop().
  function drawGroundBlood() {
    for (const decal of groundBlood) drawBloodSpot(ctx, decal);
  }

  // Impact/hit-point FX - static splats, the animated spatter burst, energy
  // bursts, hit sparks, and the KO head-pop, all layered in front of both
  // fighters (an impact flash should read clearly at the moment of the hit,
  // unlike groundBlood's floor-level pooling). Ages/fades each on every
  // call, so this must only be called once per rendered frame - UNLESS
  // `paused` (true during a hitstop freeze frame, see loop() below), in
  // which case everything still draws at its current frame but none of the
  // .t counters advance and nothing expires. Keeps a hit spark from
  // finishing (and vanishing) partway through the freeze it was itself
  // triggered by - the whole frozen moment holds on the same frame the hit
  // actually landed on, same as shake/flash not decaying during hitstop.
  function drawBloodFX(paused = false) {
    for (let i = splatExtras.length - 1; i >= 0; i--) {
      const s = splatExtras[i];
      if (s.t >= SPLAT_EXTRA_LIFETIME_FRAMES) {
        splatExtras.splice(i, 1);
        continue;
      }
      const fadeIn = SPLAT_EXTRA_LIFETIME_FRAMES - SPLAT_EXTRA_FADE_FRAMES;
      const alpha = s.t < fadeIn ? 1 : 1 - (s.t - fadeIn) / SPLAT_EXTRA_FADE_FRAMES;
      ctx.save();
      ctx.globalAlpha = alpha;
      drawBloodSplatExtra(ctx, s.x, s.y, s.variant, s.rotation, s.scale);
      ctx.restore();
      if (!paused) s.t++;
    }
    for (let i = spatters.length - 1; i >= 0; i--) {
      const s = spatters[i];
      const spriteFrame = Math.floor(s.t / SPATTER_TICKS_PER_FRAME);
      if (spriteFrame >= BLOOD_SPATTER_TOTAL_FRAMES) {
        spatters.splice(i, 1);
        continue;
      }
      drawBloodSpatter(ctx, s.x, s.y, spriteFrame, s.rotation);
      if (!paused) s.t++;
    }
    for (let i = impacts.length - 1; i >= 0; i--) {
      const im = impacts[i];
      const spriteFrame = Math.floor(im.t / IMPACT_TICKS_PER_FRAME);
      if (spriteFrame >= ENERGY_BURST_TOTAL_FRAMES) {
        impacts.splice(i, 1);
        continue;
      }
      drawEnergyBurst(ctx, im.x, im.y, spriteFrame);
      if (!paused) im.t++;
    }
    for (let i = hitSparks.length - 1; i >= 0; i--) {
      const hs = hitSparks[i];
      const spriteFrame = Math.floor(hs.t / HIT_SPARK_TICKS_PER_FRAME);
      if (spriteFrame >= HIT_SPARK_TOTAL_FRAMES) {
        hitSparks.splice(i, 1);
        continue;
      }
      drawHitSpark(ctx, hs.x, hs.y, spriteFrame);
      if (!paused) hs.t++;
    }
    // Combo swish/pop - same fade-then-expire pattern as splatExtras/impacts
    // above, kept as their own loops rather than folded into those so the
    // combo escalation reads as a distinct visual layer (drawn on top of the
    // baseline hit spark, same draw-order-is-front-to-back rule this whole
    // function follows).
    for (let i = comboSwishes.length - 1; i >= 0; i--) {
      const s = comboSwishes[i];
      if (s.t >= COMBO_SWISH_LIFETIME_FRAMES) {
        comboSwishes.splice(i, 1);
        continue;
      }
      const fadeIn = COMBO_SWISH_LIFETIME_FRAMES - COMBO_SWISH_FADE_FRAMES;
      const alpha = s.t < fadeIn ? 1 : 1 - (s.t - fadeIn) / COMBO_SWISH_FADE_FRAMES;
      ctx.save();
      ctx.globalAlpha = alpha;
      drawComboSwish(ctx, s.x, s.y, s.level, s.rotation, s.scale);
      ctx.restore();
      if (!paused) s.t++;
    }
    for (let i = comboPops.length - 1; i >= 0; i--) {
      const p = comboPops[i];
      if (p.t >= COMBO_POW_DURATION) {
        comboPops.splice(i, 1);
        continue;
      }
      drawComboPow(ctx, p.x, p.y, p.t, p.big, p.scale);
      if (!paused) p.t++;
    }
    for (let i = headPops.length - 1; i >= 0; i--) {
      const p = headPops[i];
      if (p.t >= HEAD_POP_DURATION) {
        headPops.splice(i, 1);
        continue;
      }
      drawHeadPop(ctx, p.x, p.y, p.t);
      if (!paused) p.t++;
    }
  }

  // Combo readout - drawn directly with the 2D context rather than routed
  // through body.js, since it's plain text over a fighter, not a sprite/FX
  // asset. Gated on state (hitstun/knockback) rather than just comboCount,
  // so it disappears the instant the defender actually recovers instead of
  // lingering with a stale number until their next hit overwrites it - see
  // takeDamage's wasChaining check for why state alone is a reliable "still
  // mid-combo" signal. >= 2 only (a single hit isn't a combo, it's just a
  // hit) matches how every fighting game's own combo counter works.
  function drawComboCounter(fighter) {
    if (fighter.comboCount < 2) return;
    // "juggled" added alongside hitstun/knockback - a launched defender is
    // exactly as much "still mid-combo" as a grounded one (see
    // takeDamage's own wasChaining check in fighter.js, which now agrees),
    // so the readout should stay up the whole time they're airborne instead
    // of blanking out the moment uppercut launches them.
    if (fighter.state !== "hitstun" && fighter.state !== "knockback" && fighter.state !== "juggled") return;
    const centerX = fighter.x + BODY_CENTER_OFFSET;
    ctx.save();
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#ffd23f";
    const label = `${fighter.comboCount} HIT COMBO`;
    ctx.strokeText(label, centerX, HEAD_Y - 30);
    ctx.fillText(label, centerX, HEAD_Y - 30);
    ctx.restore();
  }

  // Punch/kick only now - special has no melee hitbox of its own, see
  // spawnProjectile/updateProjectiles below for its (ranged) hit detection.
  function checkHit(attacker, defender) {
    const box = attacker.attackHitbox();
    if (!box) return;
    // isAirborne() - a grounded punch/kick swing can't reach someone who's
    // genuinely off the ground, whether that's a plain jump, a juggle, or
    // mid-way through their own airKick/flyingKick swing. checkUppercutHit
    // deliberately does NOT carry this same exclusion - catching a juggled
    // (or air-attacking) defender with another uppercut is the entire point
    // of that move being a real anti-air/launcher. checkAirAttackHit below
    // ALSO deliberately doesn't carry it - that's the one attack in this
    // engine meant to reach an airborne target.
    if (isAirborne(defender.state)) return;
    // Ducking clears a STANDING kick clean over the top - punches still
    // connect through a crouch, only the standing kick whiffs. blockLow
    // (crouch+block held together - see fighter.js's update()) is still
    // physically crouching underneath the guard, so a standing kick ducks
    // clean under it the exact same way - the high/low guard mixup in
    // takeDamage is about whether a raised guard STOPS a hit that would
    // otherwise land, not about what a crouching hurtbox already dodges
    // regardless of guard. "attacker.state !== 'crouchKick'" excludes the
    // one deliberate exception: a LOW kick is thrown from the exact same
    // crouched profile it's meant to threaten, so unlike every standing
    // kick pose it should still connect against a crouching/blockLow
    // defender - that's the entire point of it existing as its own move
    // instead of just another standing-chain hit.
    if ((defender.state === "crouch" || defender.state === "blockLow") && box.kind === "kick" && attacker.state !== "crouchKick") return;
    const lo = Math.min(box.from, box.to);
    const hi = Math.max(box.from, box.to);
    if (defender.x >= lo && defender.x <= hi) {
      // blockLow only actually blocks punches here (kicks already returned
      // above) - see takeDamage's blockedByLowGuard - so this is accurate
      // without needing to know box.kind itself.
      const wasBlocking = defender.state === "block" || defender.state === "blockLow";
      attacker.hasHit = true;
      defender.takeDamage(box.damage, attacker.x, box.kind);
      // Checked BEFORE onLandedHit/lastEvent below, not after - a parried
      // swing didn't actually land clean, so the attacker shouldn't get the
      // usual power-on-hit payout or their normal "punch-hit"/"kick-hit"
      // sound cue. applyParryStagger below is what actually cuts their
      // animation off into the punish window instead.
      if (defender.lastEvent === "perfect-parry") {
        attacker.applyParryStagger();
        playSound("block", { rate: 1.4 });
      } else {
        attacker.onLandedHit(box.kind);
        // box.kind, not attacker.state - punch/kick attacks now cycle
        // through several pose states (punch2/elbow/downPunch/groundPunch/
        // highKick, see PUNCH_POSES/KICK_POSES in fighter.js), so
        // `${attacker.state}-hit` would silently stop matching
        // handleSounds' switch below the instant a combo reached its second
        // beat. box.kind is always the plain "punch"/"kick" family name
        // regardless of which pose actually threw it.
        attacker.lastEvent = `${box.kind}-hit`;
      }
      // defender.lastComboEnder/comboCount are single-frame-lived, set by
      // takeDamage just above - both stay at their neutral defaults (false /
      // whatever comboCount already was) on the block/perfect-parry
      // branches, so this naturally falls back to the plain SHAKE_ON_HIT/
      // no-freeze-bonus behavior for anything that isn't a genuine landed
      // hit, with no extra gating needed here.
      shake = Math.max(shake, defender.lastComboEnder ? SHAKE_ON_ENDER : SHAKE_ON_HIT);
      flash = Math.max(flash, defender.lastComboEnder ? FLASH_ON_ENDER : FLASH_ON_HIT);
      triggerHitstop(box.damage, defender.lastEvent === "hit-taken" || defender.lastEvent === "ko" ? defender.comboCount : 1);
      if (!wasBlocking) spawnHitEffects(defender, attacker);
    }
  }

  // Slide moves the attacker forward on its own (not player-input movement)
  // for as long as it's active. If it connects, the attacker stops dead
  // (hasHit gates the movement itself, not just the hit-check) and the
  // defender gets knocked back - that's the "you don't get behind them"
  // outcome. If the defender jumped over it instead, no hit registers and
  // the attacker just keeps sliding forward - since resolveCollision skips
  // enforcement while either fighter is airborne, that forward movement can
  // now actually carry the attacker past the defender's x, landing them on
  // the other side once the defender comes back down.
  function updateSlide(attacker, defender) {
    if (attacker.state !== "slide") return;
    if (attacker.hasHit) return;
    attacker.x = Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, attacker.x + SLIDE_SPEED * attacker.facing));

    // isAirborne() - same as checkHit above - a ground-level sweep can't
    // connect with someone who's genuinely up in the air, whether that's a
    // jump, a launcher juggle, or their own air attack in progress.
    if (isAirborne(defender.state)) return;
    const attackerCenterX = attacker.x + BODY_CENTER_OFFSET;
    const defenderCenterX = defender.x + BODY_CENTER_OFFSET;
    if (Math.abs(attackerCenterX - defenderCenterX) >= SLIDE_HIT_RADIUS) return;

    // Captured BEFORE takeDamage - a blocked slide never changes
    // defender.state away from "blockLow" (takeDamage's blocked branch only
    // ever sets lastEvent/health/power, see fighter.js), so this reads the
    // same either way, but matching checkHit's own wasBlocking-before-the-
    // call pattern rather than relying on that just in case that ever
    // changes underneath this.
    const wasBlocking = defender.state === "blockLow";
    attacker.hasHit = true;
    defender.takeDamage(attacker.slideDamage, attacker.x, "slide");
    // Same as checkHit - onLandedHit fires whether the hit actually landed
    // clean or only got through as chip, mirroring how every other attack
    // already rewards committing to a swing that at least connects through
    // guard.
    attacker.onLandedHit("slide");
    if (!wasBlocking) {
      // Slide no longer unconditionally launches the defender - a
      // crouching guard (blockLow) now genuinely stops it (see the high/low
      // guard mixup in fighter.js's takeDamage), so a blocked slide just
      // stops the attacker dead the same as any other blocked attack,
      // instead of still knocking the guarding defender backward for free.
      const pushDir = defenderCenterX >= attackerCenterX ? 1 : -1;
      // Flies out over the knockback state's own duration (see
      // setKnockbackMotion/jumpOffset in fighter.js) instead of teleporting
      // straight to the final spot - a real launch-and-land arc, not an
      // instant snap-then-freeze.
      defender.setKnockbackMotion(pushDir, SLIDE.knockback);
    }
    attacker.lastEvent = "slide-hit";
    // defender.lastComboEnder/comboCount are only ever touched by
    // takeDamage's real-hit branch (see fighter.js) - they stay at their
    // pre-hit values (comboEnder false) on the new blocked-by-blockLow path
    // the same way they already do for checkHit's block-taken case, so this
    // naturally falls back to plain SHAKE_ON_HIT/no freeze bonus with no
    // extra gating needed here, same as checkHit.
    shake = Math.max(shake, defender.lastComboEnder ? SHAKE_ON_ENDER : SHAKE_ON_HIT);
    flash = Math.max(flash, defender.lastComboEnder ? FLASH_ON_ENDER : FLASH_ON_HIT);
    triggerHitstop(attacker.slideDamage, defender.comboCount);
    // Full claret/impact FX only on a real, unblocked landing - matches
    // checkHit's own `if (!wasBlocking) spawnHitEffects(...)` gate exactly;
    // a blocked slide still gets its block sound (defender's own lastEvent
    // is "block-taken", handled by handleSounds) and the shake/flash above,
    // same layered feedback an ordinary blocked punch/kick already gets.
    if (!wasBlocking) spawnHitEffects(defender, attacker);
  }

  // Anti-air counter - deliberately does NOT exclude a jumping defender
  // (every other melee check does) since catching one mid-jump is the whole
  // point. The knockback push, though, is ONLY for that anti-air case -
  // stopping someone jumping over you from landing past you. A grounded
  // defender caught by an uppercut gets normal damage and the normal
  // hitstun reaction (takeDamage already only sets "knockback" pose for a
  // slide, never for this), but used to ALSO get instantly shoved 100px
  // sideways regardless, since this push happened unconditionally - which
  // read as a real knockback hit even standing right in front of them.
  // "Was jumping" has to be captured before takeDamage runs, since that
  // call itself changes defender.state out of "jump".
  function checkUppercutHit(attacker, defender) {
    if (attacker.state !== "uppercut") return;
    if (attacker.stateT < UPPERCUT.activeStart || attacker.stateT > UPPERCUT.activeEnd) return;
    if (attacker.hasHit) return;
    const attackerCenterX = attacker.x + BODY_CENTER_OFFSET;
    const defenderCenterX = defender.x + BODY_CENTER_OFFSET;
    if (Math.abs(attackerCenterX - defenderCenterX) >= UPPERCUT.range) return;

    // Deliberately checked BEFORE takeDamage runs (which changes
    // defender.state to "juggled" on every uppercut hit now - see
    // applyJuggleLaunch in fighter.js) and deliberately narrow to "jump"
    // only, not "juggled" too: this UPPERCUT.knockback sideways shove is
    // specifically the old "catch someone jumping over you and stop them
    // landing past you" anti-air answer, not a launcher mechanic. A relaunch
    // (this same function connecting again while defender.state is already
    // "juggled") goes through takeDamage's own applyJuggleLaunch path
    // instead, which is real vertical physics, not a horizontal shove - the
    // two are deliberately different reactions to two different situations,
    // caughtMidair only ever fires for the former.
    const caughtMidair = defender.state === "jump";
    attacker.hasHit = true;
    defender.takeDamage(attacker.uppercutDamage, attacker.x, "uppercut");
    // caughtMidair and a perfect parry can never both be true - block (and
    // so a parry) is only reachable from a grounded state, see update()'s
    // early jump-state return - but this is still checked the same way
    // checkHit above does it, so a grounded block turning into a parry gets
    // the same treatment either way.
    if (defender.lastEvent === "perfect-parry") {
      attacker.applyParryStagger();
      playSound("block", { rate: 1.4 });
    } else {
      attacker.onLandedHit("uppercut");
      if (caughtMidair) {
        const pushDir = defenderCenterX >= attackerCenterX ? 1 : -1;
        defender.x = Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, defender.x + pushDir * UPPERCUT.knockback));
      }
      attacker.lastEvent = "uppercut-hit";
    }
    // Same gating as checkHit above - a parried uppercut never touched
    // defender.comboCount (takeDamage's block branch owns that path
    // instead), so lastComboEnder/comboCount stay at their pre-hit values
    // and this correctly falls back to plain SHAKE_ON_HIT/no freeze bonus.
    shake = Math.max(shake, defender.lastComboEnder ? SHAKE_ON_ENDER : SHAKE_ON_HIT);
    flash = Math.max(flash, defender.lastComboEnder ? FLASH_ON_ENDER : FLASH_ON_HIT);
    triggerHitstop(attacker.uppercutDamage, defender.lastEvent === "hit-taken" || defender.lastEvent === "ko" ? defender.comboCount : 1);
    spawnHitEffects(defender, attacker);
  }

  // The aerial attack (airKick/flyingKick, fighter.js) - the move that
  // actually DOES something with the launcher/juggle system above, and, on
  // its own, this engine's jump-in. Two distinct jobs, one function, because
  // both are literally the same hitbox/kind/damage landing on two different
  // kinds of defender - see fighter.js's takeDamage for where that fork
  // actually happens (routes into applyJuggleLaunch if defender is already
  // "juggled", plain "hitstun" otherwise), not here.
  //
  // Deliberately does NOT carry any of the defender-state whiff exclusions
  // every OTHER melee check in this file has:
  //   - no isAirborne(defender.state) exclusion, unlike checkHit/updateSlide/
  //     checkBuilderSpecialHit above - reaching an
  //     airborne (specifically "juggled") defender is the entire reason this
  //     move exists; excluding it here would make it structurally
  //     impossible to ever extend a juggle with anything but another
  //     uppercut relaunch, exactly the gap this whole phase was built to
  //     close.
  //   - no crouch/blockLow whiff, unlike checkHit's own kind==="kick"
  //     exclusion - a GROUNDED kick ducks clean under a crouching profile
  //     because it swings at roughly knee/waist height; this is a strike
  //     coming down from genuinely above the defender's head (see
  //     spawnHitEffects' own AIR_KICK_POSES contact-height branch), which is
  //     exactly the classic "jump-in beats a low crouch, only a raised
  //     STANDING guard actually answers it" fighting-game read the brief
  //     asked for - see takeDamage's blockedByLowGuard in fighter.js, which
  //     now explicitly excludes "airKick" from what a crouching guard stops
  //     for the same reason. blockedByStanding (unchanged - "airKick" was
  //     never excluded from it) is what actually has to react to this.
  function checkAirAttackHit(attacker, defender) {
    if (attacker.state !== "airKick" && attacker.state !== "flyingKick") return;
    if (attacker.stateT < AIR_ATTACK.activeStart || attacker.stateT > AIR_ATTACK.activeEnd) return;
    if (attacker.hasHit) return;
    const attackerCenterX = attacker.x + BODY_CENTER_OFFSET;
    const defenderCenterX = defender.x + BODY_CENTER_OFFSET;
    if (Math.abs(attackerCenterX - defenderCenterX) >= AIR_ATTACK.range) return;

    // Same wasBlocking-before-the-call pattern checkHit/updateSlide already
    // use - only a standing guard actually stops this (see the block-gate
    // comment above), so that's the only state worth capturing here.
    const wasBlocking = defender.state === "block";
    attacker.hasHit = true;
    // Landing a real air hit refreshes the ATTACKER's own airborneT budget
    // the same way applyJuggleLaunch (fighter.js) refreshes the DEFENDER's
    // juggle suspension on every hit they take while airborne - without
    // this, the attacker's flight was capped at one fixed JUMP_DURATION
    // (48 frames) regardless of what they did with it, while a juggled
    // defender can stay up for up to MAX_JUGGLE_FRAMES (150). That mismatch
    // meant the attacker always ran out of air well before a juggled
    // opponent came back down, forcing a full land-and-rejump between every
    // single air hit instead of one continuous chase. Resetting to 0 here
    // hands them a fresh jump's worth of airtime exactly when they've
    // earned it - by actually connecting - so both fighters stay suspended
    // together for the rest of the exchange instead of just the defender.
    attacker.airborneT = 0;
    // "airKick" always - see AIR_KICK_POSES' own comment in fighter.js for
    // why airKick/flyingKick collapse to one reported kind, same as every
    // PUNCH_POSES/KICK_POSES variant already collapses to "punch"/"kick" in
    // attackHitbox.
    defender.takeDamage(attacker.airAttackDamage, attacker.x, "airKick");
    // Same parry-before-normal-hit-payout ordering checkHit/checkUppercutHit
    // both already use.
    if (defender.lastEvent === "perfect-parry") {
      attacker.applyParryStagger();
      playSound("block", { rate: 1.4 });
    } else {
      attacker.onLandedHit("airKick");
      attacker.lastEvent = "air-attack-hit";
    }
    shake = Math.max(shake, defender.lastComboEnder ? SHAKE_ON_ENDER : SHAKE_ON_HIT);
    flash = Math.max(flash, defender.lastComboEnder ? FLASH_ON_ENDER : FLASH_ON_HIT);
    triggerHitstop(attacker.airAttackDamage, defender.lastEvent === "hit-taken" || defender.lastEvent === "ko" ? defender.comboCount : 1);
    if (!wasBlocking) spawnHitEffects(defender, attacker);
  }

  // Fires the instant the shared cast animation completes (fighter.js sets
  // this exactly once, at SPECIAL.release) - reached by every archetype
  // except Builder, which has its own dedicated melee state (specialHigh)
  // with its own active-hitbox window instead of this cast-then-release
  // pose (see checkBuilderSpecialHit below).
  function spawnProjectile(fighter) {
    if (fighter.lastEvent !== "special-release") return;
    const isRatRush = fighter.data.archetypeKey === "Flipper";
    if (!isRatRush) playSound("boltWhoosh", { volume: 0.6 });
    projectiles.push({
      kind: isRatRush ? "ratrush" : "bolt",
      x: fighter.x + BODY_CENTER_OFFSET + fighter.facing * 34,
      y: isRatRush ? GROUND_Y : PROJECTILE_Y,
      facing: fighter.facing,
      owner: fighter,
      t: 0,
    });
  }

  // Fires the instant fighter.js's jump/airKick/flyingKick branch sets
  // lastEvent to this - see AIR_SPECIAL's own comment in fighter.js for why
  // there's no cast animation/state change to key off instead, unlike
  // spawnProjectile above (which waits for SPECIAL.release at the end of a
  // whole cast pose). Pushed into the SAME `projectiles` array the bolt/rat-
  // rush already live in (see updateProjectiles' own "homing" branch below
  // for its movement/hit resolution) - one array, one update loop, one draw
  // loop, not a second parallel system.
  function spawnHomingProjectile(fighter) {
    if (fighter.lastEvent !== "air-special-release") return;
    playSound("boltWhoosh", { volume: 0.6, rate: 1.25 });
    projectiles.push({
      kind: "homing",
      x: fighter.x + BODY_CENTER_OFFSET + fighter.facing * 34,
      // Launched from the caster's OWN current airborne height (not a fixed
      // head-height the way the grounded bolt's spawn point is) - fighter.js's
      // jumpOffset already tracks exactly how high this fighter currently is
      // mid-flight, so subtracting it here starts the bolt visibly coming
      // from wherever the caster actually is, not snapping to ground-level
      // PROJECTILE_Y and floating unnaturally beneath them.
      y: PROJECTILE_Y - fighter.jumpOffset,
      facing: fighter.facing,
      // Starting velocity is a straight shot in the cast direction - the
      // curve only becomes visible once updateProjectiles' own steering
      // starts correcting it toward the target's actual position tick over
      // tick (see HOMING_TURN_RATE's own comment above).
      vx: fighter.facing * HOMING_SPEED,
      owner: fighter,
      t: 0,
    });
  }

  // Single-hit resolution for the homing special landing - deliberately NOT
  // routed through applySpecialPulse's multi-pulse flurry machinery above,
  // even though it shares almost everything else with it (kind "special" for
  // takeDamage, the same triggerHitstop/shake/flash/spawnHitEffects call
  // shape) - see AIR_SPECIAL's own damage comment in fighter.js for why a
  // homing juggle-extender landing 3 pulses per cast would trivially blow
  // through MAX_JUGGLE_HITS in a single throw. kind "special" (not
  // "uppercut") means this can never open a fresh juggle on a grounded
  // target on its own - fighter.js's takeDamage only routes into
  // applyJuggleLaunch when kind==="uppercut" OR the defender is ALREADY
  // "juggled" - so this hit either lands as an ordinary combo-scaled grounded
  // hit, or, precisely when it's needed most, extends an existing juggle
  // sequence through that SAME decay/hit-cap machinery, never bypassing it.
  function applyHomingHit(p, target) {
    target.takeDamage(p.owner.airSpecialDamage, p.x, "special");
    p.owner.onLandedHit("special");
    playSound("boltImpact", { volume: 0.65, rate: 1.1 });
    shake = Math.max(shake, target.lastComboEnder ? SHAKE_ON_ENDER : SHAKE_ON_HIT);
    flash = Math.max(flash, target.lastComboEnder ? FLASH_ON_ENDER : FLASH_ON_HIT);
    triggerHitstop(p.owner.airSpecialDamage, target.comboCount);
    spawnHitEffects(target, { x: p.x - BODY_CENTER_OFFSET, state: "special" });
    // Juggled fighters never move horizontally on purpose - see the big
    // "Airborne juggle" comment in fighter.js: update()'s own "juggled"
    // branch only ever touches juggleY/juggleVY, this.x is a deliberate
    // frozen non-choice. Pushing them here would fight that invariant and
    // desync x from where checkUppercutHit/checkAirAttackHit's own fixed-
    // range follow-up checks expect them to still be sitting. A grounded
    // target (this hit's other valid case) gets the same small nudge every
    // other special already gives on a landed hit.
    if (target.state !== "juggled") {
      target.x = Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, target.x + p.facing * SPECIAL_PULSE_KNOCKBACK));
    }
    impacts.push({ x: p.x, y: p.y, t: 0 });
  }

  // One beat of the bolt/rat-rush flurry - shared by the instant-of-contact
  // opening pulse AND every scheduled follow-up in updateProjectiles' own
  // pulsesLeft branch below, so there's exactly one place that actually
  // applies damage/push/FX for this move instead of two copies that could
  // drift apart. pulseDamage is a fraction of the OLD single-hit total
  // (p.owner.specialDamage, still the same getter/number every other special
  // call site uses) - and every pulse after the opening one lands on a
  // defender who's still genuinely mid-hitstun from the pulse before it, so
  // takeDamage's own wasChaining check reads it as a real combo continuation
  // and computeComboDamageScale (fighter.js) is already quietly shrinking
  // each later pulse's actual damage on its own. At SPECIAL_PULSE_COUNT = 3
  // that combo decay alone drops the sequence's real total to roughly 83% of
  // the old one-shot hit (verified live, see the multi-hit special report) -
  // deliberate, same restraint this codebase already applied rebalancing
  // slide/uppercut: the payoff for a flurry is the flurry itself (more
  // hitstop beats, more pushback, a longer stun) rather than a bigger number
  // than the old single hit.
  function applySpecialPulse(p, target, isRatRush, isFinalPulse) {
    const pulseDamage = p.owner.specialDamage / SPECIAL_PULSE_COUNT;
    target.takeDamage(pulseDamage, p.x, "special");
    p.owner.onLandedHit("special");
    // Same dedicated-impact-sound-vs-shared-thud split the old single-hit
    // version used - just now on every pulse, quieter on the opening/middle
    // beats and back to full volume on the one that actually ends the
    // flurry, so the finisher still reads as the loudest moment.
    if (isRatRush) {
      p.owner.lastEvent = "special-hit";
    } else {
      playSound("boltImpact", { volume: isFinalPulse ? 0.7 : 0.45 });
    }
    // SHAKE_ON_SPECIAL/FLASH's own bigger jolt is reserved for the pulse
    // that ends the sequence - every earlier beat uses the plain per-hit
    // magnitude instead, so an individual pulse reads as one part of a
    // flurry rather than three full "special connected" hits back to back.
    // lastComboEnder (set by takeDamage just above) can still override
    // either with SHAKE_ON_ENDER/FLASH_ON_ENDER on its own terms - unchanged
    // from every other hit branch in this file.
    const baseShake = isFinalPulse ? SHAKE_ON_SPECIAL : SHAKE_ON_HIT;
    shake = Math.max(shake, target.lastComboEnder ? SHAKE_ON_ENDER : baseShake);
    flash = Math.max(flash, target.lastComboEnder ? FLASH_ON_ENDER : FLASH_ON_HIT);
    // Same reasoning as checkBuilderSpecialHit - a
    // projectile connecting always registers as a real hit (specials bypass
    // block/parry), so target.comboCount/lastComboEnder are always
    // meaningful right here, no gate needed.
    triggerHitstop(pulseDamage, target.comboCount);
    // Anchored at the projectile's actual position (the real contact
    // point), not the caster's - see p.x's own tracking of the target below,
    // which is what keeps this correct pulse over pulse as the cumulative
    // push actually moves the target. spawnHitEffects just needs something
    // with an .x/.state shape; this fakes a minimal "attacker" positioned
    // exactly where the hit happened - "slide" for the rat rush so the blood
    // lands at ground height instead of the bolt's head height.
    spawnHitEffects(target, { x: p.x - BODY_CENTER_OFFSET, state: isRatRush ? "slide" : "special" });
    // Cumulative push, a bit at a time - see SPECIAL_PULSE_KNOCKBACK's own
    // comment above for why p.facing (not a live position compare) drives
    // the direction.
    target.x = Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, target.x + p.facing * SPECIAL_PULSE_KNOCKBACK));
    // Big finisher burst only on the pulse that actually ends the sequence -
    // every pulse already gets its own small hit-spark via spawnHitEffects
    // above (that's the per-pulse "hit-flash" reaction), so stacking the
    // bigger energy-burst on every single beat just read as clutter in
    // testing rather than a flurry building to a finish.
    if (isFinalPulse) {
      impacts.push({ x: p.x, y: isRatRush ? GROUND_Y - 20 : p.y, t: 0 });
    }
  }

  // Runs after both fighters' own update() so a projectile spawned this same
  // frame (via spawnProjectile above) still gets its first move/hit-check
  // immediately rather than sitting a frame behind.
  function updateProjectiles() {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];

      // Homing special - entirely its own branch, not a variant of the
      // bolt/rat-rush's own pulsesLeft/dodge machinery below (that logic
      // assumes a fixed straight-line trajectory and a defender who can
      // dodge by leaving the ground - the exact opposite of what this move
      // needs to do). Still the SAME `projectiles` array/loop/draw call
      // (drawSurgeBlast, game.js's own render pass - "homing" isn't
      // "ratrush" so it falls into that existing branch with no new draw
      // code needed) as every other projectile in this file.
      if (p.kind === "homing") {
        const homingTarget = p.owner === p1 ? p2 : p1;
        p.t++;
        if (homingTarget.state === "ko") {
          projectiles.splice(i, 1);
          continue;
        }
        // Movement/steering happens every tick regardless of dodge state,
        // same as the plain bolt/rat-rush below (their own p.x +=
        // .../p.t++ runs unconditionally too, before their dodge check) -
        // only the HIT is gated on dodged, not the flight itself, or a
        // ducking target would freeze this in mid-air instead of it visibly
        // continuing to track/fly past them.
        const targetCenterX = homingTarget.x + BODY_CENTER_OFFSET;
        // Proportional steering - see HOMING_TURN_RATE's own comment above
        // for why this is recomputed fresh every tick (a moving target,
        // never a fixed aim point) rather than locked in once at spawn.
        const desiredVx = (targetCenterX >= p.x ? 1 : -1) * HOMING_SPEED;
        p.vx += (desiredVx - p.vx) * HOMING_TURN_RATE;
        p.x += p.vx;
        // Flips the drawn sprite to face whichever way it's actually
        // currently flying, not the direction it was cast in - a curve that
        // bends back the way it came should visibly flip, same as every
        // other directional FX in this file already keys off facing.
        p.facing = p.vx >= 0 ? 1 : -1;
        // Vertical tracking too - chases a juggled target UP, not just
        // across, so the sprite reads as genuinely homing onto them rather
        // than flying flat through their feet while they're launched
        // overhead. The actual hit check right below stays x-only, same as
        // the plain bolt/rat-rush's own hit check already is (see
        // PROJECTILE_HIT_RADIUS's own comment for why that's always been
        // true in this engine) - this is purely a visual-fidelity read, not
        // a second axis of hit detection.
        const targetY = PROJECTILE_Y - homingTarget.jumpOffset;
        p.y += (targetY - p.y) * HOMING_TURN_RATE;

        // Crouch/blockLow still duck under this the same way they duck a
        // straight bolt (see the plain-bolt dodge comment below) - a real,
        // physical hurtbox height change, not a positioning read this move's
        // homing is meant to defeat. Genuinely airborne (jump/juggled/
        // airKick/flyingKick) is deliberately NOT excluded here, unlike the
        // straight bolt/rat-rush - reaching a target who's off the ground for
        // ANY reason (a plain evasive jump, or - the actual point of this
        // move - already mid-juggle) is exactly what "auto-aimed... doubles
        // as a real juggle-extender/closer" requires, and matches the
        // precedent checkAirAttackHit (game.js) already set for the OTHER
        // aerial move: no isAirborne exclusion there either, since being able
        // to reach an airborne target at all is the entire reason these
        // moves exist.
        const dodged = homingTarget.state === "crouch" || homingTarget.state === "blockLow";
        if (!dodged && Math.abs(targetCenterX - p.x) < HOMING_HIT_RADIUS) {
          applyHomingHit(p, homingTarget);
          projectiles.splice(i, 1);
          continue;
        }

        if (p.t > HOMING_MAX_LIFETIME_FRAMES || p.x < ARENA_MIN_X - 60 || p.x > ARENA_MAX_X + 60) {
          projectiles.splice(i, 1);
        }
        continue;
      }

      const isRatRush = p.kind === "ratrush";
      const target = p.owner === p1 ? p2 : p1;

      // Already latched onto the target from an earlier tick this same
      // flight - pulsesLeft only ever counts down (see SPECIAL_PULSE_COUNT's
      // own comment above for why a renewed hit-radius/dodge check here
      // would be wrong: the defender is genuinely stunned, not still
      // dodgeable, same as any other multi-hit fighting-game super). Runs on
      // a fixed timer instead.
      if (p.pulsesLeft > 0) {
        p.t++;
        // Tracks the target's own (cumulatively pushed-back) position every
        // tick rather than the projectile's own old flight trajectory, so
        // the lingering sprite/FX always sits where the defender actually
        // is by the time the next pulse fires.
        p.x = target.x + BODY_CENTER_OFFSET;
        // An opening pulse that was itself the killing blow (or, rare but
        // possible against a low-health-mult archetype, a later one) ends
        // the flurry immediately rather than continuing to push/flash a
        // fighter who's already down.
        if (target.state === "ko") {
          projectiles.splice(i, 1);
          continue;
        }
        if (--p.pulseCooldown > 0) continue;
        p.pulsesLeft--;
        applySpecialPulse(p, target, isRatRush, p.pulsesLeft === 0);
        if (p.pulsesLeft <= 0) {
          projectiles.splice(i, 1);
        } else {
          p.pulseCooldown = SPECIAL_PULSE_INTERVAL_FRAMES;
        }
        continue;
      }

      p.x += (isRatRush ? RAT_RUSH_SPEED : PROJECTILE_SPEED) * p.facing;
      p.t++;

      // The bolt flies at head height, so a crouch dodges it same as a
      // jump - blockLow ducks under it too, still physically crouching
      // underneath the guard (same reasoning as checkHit/checkBuilderSpecialHit
      // above). The rat rush is already on the ground - only a jump clears
      // it, same rule as a slide. Neither is stopped by a raised guard,
      // matching every other special's "blows straight through block" - this
      // stays true pulse over pulse too (see applySpecialPulse), since
      // takeDamage's own kind !== "special" guard on block never changes.
      // isAirborne() dodges both, same as plain "jump" always did (including
      // now "juggled" and mid-air-attack) - this move doesn't yet know how
      // to track/home in on an airborne target's actual height (that's
      // explicitly future air-to-air/homing-special work, not this phase),
      // so for now anyone off the ground for any reason just clears a
      // projectile clean the same way a voluntary jump already does, rather
      // than the projectile silently hitting a target it was never aimed at
      // vertically.
      const dodged = isRatRush
        ? isAirborne(target.state)
        : isAirborne(target.state) || target.state === "crouch" || target.state === "blockLow";
      if (!dodged) {
        const targetCenterX = target.x + BODY_CENTER_OFFSET;
        const hitRadius = isRatRush ? RAT_RUSH_HIT_RADIUS : PROJECTILE_HIT_RADIUS;
        if (Math.abs(targetCenterX - p.x) < hitRadius) {
          // First contact starts the flurry - pulsesLeft counts the beats
          // still owed AFTER this one, so a count of 1 here (a degenerate
          // SPECIAL_PULSE_COUNT of 1) correctly reads as the final pulse
          // immediately and never enters the branch above at all.
          p.x = targetCenterX;
          p.pulsesLeft = SPECIAL_PULSE_COUNT - 1;
          p.pulseCooldown = SPECIAL_PULSE_INTERVAL_FRAMES;
          applySpecialPulse(p, target, isRatRush, p.pulsesLeft === 0);
          if (p.pulsesLeft <= 0) projectiles.splice(i, 1);
          continue;
        }
      }

      // Missed and flew off the edge of the arena - fizzles out quietly
      // rather than bursting against a wall that isn't really there.
      if (p.x < ARENA_MIN_X - 60 || p.x > ARENA_MAX_X + 60) {
        projectiles.splice(i, 1);
      }
    }
  }

  // Builder's special - a big high kick with its own dedicated animation
  // (specialHigh), active window timed to when the sheet's own impact FX
  // actually shows the kick connecting. Dodged the same way the bolt is
  // (crouch or jump both clear it) since unlike the free universal
  // uppercut, this isn't meant to be an anti-air counter.
  function checkBuilderSpecialHit(attacker, defender) {
    if (attacker.state !== "specialHigh") return;
    if (attacker.stateT < BUILDER_SPECIAL.activeStart || attacker.stateT > BUILDER_SPECIAL.activeEnd) return;
    if (attacker.hasHit) return;
    // blockLow is still physically crouching underneath the guard (same
    // reasoning as checkHit's own crouch/blockLow kick-whiff above) - a
    // crouching hurtbox ducks this the same way plain crouch always did,
    // regardless of whether a guard happens to be raised too.
    // isAirborne() - same reasoning as checkHit/updateSlide above, a
    // grounded special can't reach someone genuinely off the ground for any
    // reason (jump, juggle, or their own air attack).
    if (defender.state === "crouch" || defender.state === "blockLow" || isAirborne(defender.state)) return;
    const attackerCenterX = attacker.x + BODY_CENTER_OFFSET;
    const defenderCenterX = defender.x + BODY_CENTER_OFFSET;
    if (Math.abs(attackerCenterX - defenderCenterX) >= BUILDER_SPECIAL.range) return;

    attacker.hasHit = true;
    defender.takeDamage(attacker.builderSpecialDamage, attacker.x, "special");
    attacker.onLandedHit("special");
    attacker.lastEvent = "special-hit";
    // Specials blow straight through block/parry (takeDamage's kind !==
    // "special" guard), so this always lands as a real hit - comboCount/
    // lastComboEnder are always meaningful here, no gate needed.
    shake = Math.max(shake, defender.lastComboEnder ? SHAKE_ON_ENDER : SHAKE_ON_SPECIAL);
    flash = Math.max(flash, defender.lastComboEnder ? FLASH_ON_ENDER : FLASH_ON_HIT);
    triggerHitstop(attacker.builderSpecialDamage, defender.comboCount);
    spawnHitEffects(defender, { x: attacker.x, state: "uppercut" });
  }

  function handleSounds(fighter) {
    switch (fighter.lastEvent) {
      case "punch-hit":
        playSound("punch");
        break;
      case "kick-hit":
      case "special-hit":
      case "slide-hit":
      case "uppercut-hit":
      case "air-attack-hit":
        playSound("kick", {
          rate: fighter.lastEvent === "special-hit" ? 0.75 : fighter.lastEvent === "uppercut-hit" ? 1.3 : fighter.lastEvent === "air-attack-hit" ? 1.15 : 1,
        });
        break;
      case "block-taken":
        playSound("block");
        break;
      case "hit-taken":
        playSound("hit");
        break;
      case "jump-start":
        playSound("jump");
        break;
      case "slide-start":
        playSound("jump", { rate: 0.8 });
        break;
      case "uppercut-start":
        playSound("jump", { rate: 1.3 });
        break;
      case "air-attack-start":
        playSound("jump", { rate: 1.15 });
        break;
      case "special-start":
        playSound("powerfull", { rate: 1.15 });
        break;
      case "special-release":
        playSound("powerfull", { rate: 0.8 });
        break;
      case "air-special-release":
        playSound("powerfull", { rate: 1.2 });
        break;
      case "ko":
        playSound("ko");
        headPops.push({ x: fighter.x, y: HEAD_Y, t: 0 });
        break;
      // The actual ground-impact beat of a spike ender - see fighter.js's
      // applyJuggleSpike/the "juggled" branch's own landing check for how
      // this fires exactly once, the frame gravity brings a SPIKED (not an
      // ordinary juggle-fallout) defender back down to earth. Every other
      // case in this switch reacts to a HIT landing; this is the one
      // exception - the whole point of a spike is that the LANDING itself is
      // a second, real impact beat a frame or several after whatever move
      // actually did the spiking, not just a bigger version of that same
      // hit's own feedback. Low-pitched "hit" (no dedicated thud clip - see
      // sound.js's own CLIPS list) reads heavier than the sharp default
      // rate, closer to a body slamming down than a strike connecting.
      // Reuses drawEnergyBurst (impacts array, same as every other special/
      // uppercut impact in this file) at ground level rather than adding a
      // new draw call - a real visible burst right where they landed, on
      // top of the shake, is what makes this actually read as a slam.
      case "hard-knockdown-land":
        playSound("hit", { rate: 0.6, volume: 0.9 });
        shake = Math.max(shake, SHAKE_ON_HIT);
        impacts.push({ x: fighter.x + BODY_CENTER_OFFSET, y: GROUND_Y - 10, t: 0 });
        break;
    }
  }

  function updateHud() {
    document.getElementById("p1-health").style.width = `${(p1.health / p1.maxHealth) * 100}%`;
    document.getElementById("p2-health").style.width = `${(p2.health / p2.maxHealth) * 100}%`;

    const p1PowerPct = (p1.power / MAX_POWER) * 100;
    const p2PowerPct = (p2.power / MAX_POWER) * 100;
    const p1PowerEl = document.getElementById("p1-power");
    const p2PowerEl = document.getElementById("p2-power");
    p1PowerEl.style.width = `${p1PowerPct}%`;
    p2PowerEl.style.width = `${p2PowerPct}%`;
    p1PowerEl.classList.toggle("power-ready", p1PowerPct >= 100);
    p2PowerEl.classList.toggle("power-ready", p2PowerPct >= 100);

    if (p1PowerPct >= 100 && !powerFullFired.p1) {
      powerFullFired.p1 = true;
      playSound("powerfull");
    } else if (p1PowerPct < 100) powerFullFired.p1 = false;

    if (p2PowerPct >= 100 && !powerFullFired.p2) {
      powerFullFired.p2 = true;
      playSound("powerfull");
    } else if (p2PowerPct < 100) powerFullFired.p2 = false;
  }

  // Prefers a quote the fighter hasn't already said pre-fight (their
  // taunt), so the win screen doesn't just repeat the intro line. Falls
  // back to the taunt itself if that's all they've got recorded.
  function pickVictoryQuote(fighter) {
    const history = fighter.data.talkHistory ?? [];
    const fresh = history.filter((q) => q !== fighter.data.taunt);
    const pool = fresh.length > 0 ? fresh : history;
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];
    return fighter.data.taunt ?? null;
  }

  // Doesn't call onEnd right away - combat logic stops immediately (ended),
  // but the actual round transition waits out RESULT_DISPLAY_FRAMES so the
  // winner's flex and spoken victory line (and the loser's own finishing
  // animation) get to play out instead of freezing the instant the round
  // is decided.
  function endRound(winner) {
    if (ended) return;
    ended = true;
    roundWinner = winner;
    resultTimer = RESULT_DISPLAY_FRAMES;
    const titleEl = document.getElementById("result-title");
    if (winner) {
      winner.setState("flex");
      const quote = pickVictoryQuote(winner);
      const label = winner === p1 ? "PLAYER ONE" : "PLAYER TWO";
      titleEl.textContent = `${label} WINS!`;
      // Reuses the same pre-fight taunt bubble (already positioned above
      // this fighter's own head, already hidden again by the time a round
      // ends) instead of a floating line of glow text - a real opaque
      // speech bubble stays readable over any arena background.
      if (quote) {
        const bubbleEl = document.getElementById(winner === p1 ? "taunt-p1" : "taunt-p2");
        bubbleEl.textContent = `"${quote}"`;
        bubbleEl.classList.remove("hidden");
      }
      speakTaunt(quote);
      const loser = winner === p1 ? p2 : p1;
      reportMatchResult(winner.data.tokenId, loser.data.tokenId, "win");
      reportMatchResult(loser.data.tokenId, winner.data.tokenId, "loss");
    } else {
      titleEl.textContent = "DRAW";
    }
    document.getElementById("result").classList.remove("hidden");
  }

  function loop() {
    if (stopped) return;

    if (ended) {
      // Combat logic (input, hits, movement) is done - just keep the last
      // pose animating (winner's flex, loser's own hitstun/KO) and the
      // frame rendering instead of freezing on whatever frame the round
      // happened to end on.
      p1.stateT++;
      p2.stateT++;
      ctx.save();
      drawArena(ctx, CANVAS_WIDTH, CANVAS_HEIGHT);
      drawGroundBlood();
      drawFighter(ctx, p1, 1);
      drawFighter(ctx, p2, 2);
      drawBloodFX();
      ctx.restore();
      resultTimer--;
      if (resultTimer <= 0) {
        if (onEnd) onEnd(roundWinner);
        return;
      }
      requestAnimationFrame(loop);
      return;
    }

    // Hitstop freeze - the instant a hit landed (see triggerHitstop, called
    // from every checkHit/updateSlide/checkUppercutHit/checkBuilderSpecialHit/
    // updateProjectiles hit branch above), both
    // fighters, projectiles, blood FX, and the round clock all hold dead
    // still for a few frames before knockback/hitstun actually starts
    // playing - `frame` itself doesn't advance and neither does the
    // once-per-60-frames timer tick below, so hitstop truly doesn't cost the
    // clock any time. shake/flash are drawn at whatever their current value
    // is but deliberately NOT decayed here, so the screen holds at the
    // impact's peak for the whole freeze instead of fading out mid-stop.
    //
    // Input is still polled and fed to Fighter.tickInputOnly (edge-detection
    // + the input buffer only - no state/position change) for whichever
    // side(s) are human, so a button pressed during the freeze itself still
    // gets buffered instead of silently vanishing (see INPUT_BUFFER_FRAMES
    // in fighter.js). The AI side is deliberately skipped entirely here -
    // getAIInput() advances its own internal think-timer every call, and
    // calling it on frozen frames would speed up the AI's decision cadence
    // relative to a human's, which is exactly the kind of timing drift that
    // could reopen the crouch-exploit fix in ai.js (that fix depends on the
    // AI's read of `opponent.state` lining up with real elapsed frames).
    if (hitstopFrames > 0) {
      hitstopFrames--;
      const p1Gamepad = findGamepad();
      const p2Gamepad = findGamepad(p1Gamepad ? p1Gamepad.index : -1);
      p1.tickInputOnly(withGamepad(readInput(KEYMAP.p1), p1Gamepad));
      if (!getAIInput) {
        p2.tickInputOnly(practiceMode ? emptyP2Input : withGamepad(readInput(KEYMAP.p2), p2Gamepad));
      }

      ctx.save();
      if (shake > 0) {
        ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      }
      drawArena(ctx, CANVAS_WIDTH, CANVAS_HEIGHT);
      drawGroundBlood();
      drawFighter(ctx, p1, 1);
      drawFighter(ctx, p2, 2);
      drawComboCounter(p1);
      drawComboCounter(p2);
      for (const p of projectiles) {
        if (p.kind === "ratrush") {
          drawRatRush(ctx, p.x, p.y, Math.floor(p.t / RAT_RUSH_SPRITE_TICKS_PER_FRAME), p.facing);
        } else {
          drawSurgeBlast(ctx, p.x, p.y, Math.floor(p.t / PROJECTILE_SPRITE_TICKS_PER_FRAME), p.facing);
        }
      }
      drawBloodFX(true);
      ctx.restore();
      if (flash > 0) drawFlash(ctx, CANVAS_WIDTH, CANVAS_HEIGHT, flash);

      if (!stopped) requestAnimationFrame(loop);
      return;
    }

    frame++;

    // Resolved fresh every frame (not cached) so a controller plugged in or
    // unplugged mid-match takes effect immediately, and p1's gamepad is
    // whichever one the browser actually reports first - not assumed to be
    // index 0 (see withGamepad's comment above for why that assumption
    // broke in practice).
    const p1Gamepad = findGamepad();
    const p2Gamepad = findGamepad(p1Gamepad ? p1Gamepad.index : -1);
    // opponent passed through purely for the standing punch chain's
    // anti-crouch groundPunch check and pickAirAttackState's own cosmetic
    // pose choice (see fighter.js) - never read for hit detection, which
    // stays entirely in checkHit/etc below, run after both updates.
    p1.update(withGamepad(readInput(KEYMAP.p1), p1Gamepad), p2);
    p2.update(practiceMode ? emptyP2Input : getAIInput ? getAIInput() : withGamepad(readInput(KEYMAP.p2), p2Gamepad), p1);
    // The dummy tops back up to full once it's recovered from the last
    // combo (back to idle) rather than sitting there half-dead or at 0 -
    // real hit feedback lands every time (health bar actually drops during
    // a combo), but there's always a fresh dummy for the next attempt
    // instead of a match-ending KO interrupting practice.
    if (practiceMode && p2.state === "idle" && p2.health < p2.maxHealth) {
      p2.health = p2.maxHealth;
    }
    resolveCollision(p1, p2);

    checkHit(p1, p2);
    checkHit(p2, p1);
    checkUppercutHit(p1, p2);
    checkUppercutHit(p2, p1);
    checkAirAttackHit(p1, p2);
    checkAirAttackHit(p2, p1);
    updateSlide(p1, p2);
    updateSlide(p2, p1);
    // Spawn (if this is the frame either fighter's cast just completed) and
    // resolve movement/hits for in-flight projectiles before the sound pass
    // below, so a hit landed this frame sets lastEvent in time for
    // handleSounds to actually see it rather than one frame late.
    spawnProjectile(p1);
    spawnProjectile(p2);
    spawnHomingProjectile(p1);
    spawnHomingProjectile(p2);
    checkBuilderSpecialHit(p1, p2);
    checkBuilderSpecialHit(p2, p1);
    updateProjectiles();
    // Keep both fighters facing each other regardless of which physical
    // side they're actually standing on - computed last, after every move
    // this frame (walk, slide, jump-crossup) has already landed, so a jump
    // or slide that puts someone on the "wrong" side flips both of them to
    // match instead of leaving them facing their original start direction.
    if (p1.x <= p2.x) {
      p1.facing = 1;
      p2.facing = -1;
    } else {
      p1.facing = -1;
      p2.facing = 1;
    }
    handleSounds(p1);
    handleSounds(p2);
    updateHud();

    // No countdown in practice - there's no round to time out, and letting
    // it run would otherwise end "practice" via the timeout ratio-compare
    // below the instant the dummy takes any damage at all (p1 undamaged
    // always reads as the higher ratio).
    if (!practiceMode && frame % 60 === 0 && timeLeft > 0) {
      timeLeft--;
      document.getElementById("timer").textContent = timeLeft;
    }

    ctx.save();
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake *= 0.8;
      if (shake < 0.5) shake = 0;
    }
    drawArena(ctx, CANVAS_WIDTH, CANVAS_HEIGHT);
    drawGroundBlood();
    drawFighter(ctx, p1, 1);
    drawFighter(ctx, p2, 2);
    drawComboCounter(p1);
    drawComboCounter(p2);
    for (const p of projectiles) {
      if (p.kind === "ratrush") {
        drawRatRush(ctx, p.x, p.y, Math.floor(p.t / RAT_RUSH_SPRITE_TICKS_PER_FRAME), p.facing);
      } else {
        drawSurgeBlast(ctx, p.x, p.y, Math.floor(p.t / PROJECTILE_SPRITE_TICKS_PER_FRAME), p.facing);
      }
    }
    drawBloodFX();
    ctx.restore();

    if (flash > 0) {
      drawFlash(ctx, CANVAS_WIDTH, CANVAS_HEIGHT, flash);
      flash *= 0.75;
      if (flash < 0.02) flash = 0;
    }

    // Practice never ends on its own - see exit-match-btn (main.js) for
    // the only way out, since none of the normal win conditions apply to a
    // dummy that can neither be finished off nor time one out.
    //
    // Gated on hitstopFrames === 0: a killing blow triggers hitstop the
    // same frame it drops health to 0 (checkHit/etc above run before this),
    // so without this guard endRound would fire - and `ended` would flip
    // true - before the freeze this exact hit just queued ever got a chance
    // to play (loop()'s `if (ended)` branch is checked ahead of the
    // hitstop branch, so an already-ended round would skip the freeze
    // entirely next tick). Deferring the win check until hitstop has fully
    // drained means the KO hit's own freeze plays out first, then the round
    // ends on the frame right after - so the biggest hits of the match
    // (the ones that end it) are the ones guaranteed to actually get their
    // impact pause instead of being cut short.
    if (!practiceMode && hitstopFrames === 0) {
      if (p1.health <= 0 && p2.health <= 0) endRound(null);
      else if (p1.health <= 0) endRound(p2);
      else if (p2.health <= 0) endRound(p1);
      else if (timeLeft <= 0) {
        const p1Ratio = p1.health / p1.maxHealth;
        const p2Ratio = p2.health / p2.maxHealth;
        if (p1Ratio === p2Ratio) endRound(null);
        else endRound(p1Ratio > p2Ratio ? p1 : p2);
      }
    }

    // Always continues (unlike the old `if (!ended)` gate) - the very next
    // tick is what lets the `if (ended)` branch above actually run and
    // start the flex/result display instead of the round-ending frame just
    // being the last one ever rendered.
    if (!stopped) requestAnimationFrame(loop);
  }

  document.getElementById("timer").textContent = practiceMode ? "∞" : timeLeft;
  requestAnimationFrame(loop);

  return () => {
    stopped = true;
    window.removeEventListener("keydown", keydown);
    window.removeEventListener("keyup", keyup);
  };
}
