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
// specialLow/death's own extra scale multipliers land under that on their
// own smaller sheets). ARENA_MAX_X used to be 750, which let the right edge
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
// checkHodlerSpecialHit/updateProjectiles in game.js) so hitstop and
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
// Archetype-specific specials. Flipper (rat rush) and Collector (bolt) are
// ranged, spawned via spawnProjectile in game.js off the shared "special"
// cast pose. Builder and Hodler are melee with their own dedicated sheets/
// states (specialHigh/specialLow, see body.js) instead of sharing the cast
// pose - duration/activeStart/activeEnd here time their own active-hitbox
// window the same way UPPERCUT/KICK do, verified against which frames of
// each sheet actually show the kick connecting (green impact FX).
export const BUILDER_SPECIAL = { damage: 30, range: 85, duration: 45, activeStart: 21, activeEnd: 36 };
export const HODLER_SPECIAL = { damage: 26, range: 92, duration: 28, activeStart: 20, activeEnd: 27 };
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
const POWER_GAIN = { punch: 10, kick: 12, slide: 6, uppercut: 16, special: 0 };
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
    // Input buffer state - see INPUT_BUFFER_FRAMES above. At most one
    // pending action at a time (the latest press wins); consumeBuffered()
    // clears it the moment it actually fires.
    this.bufferedAction = null;
    this.bufferTtl = 0;
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

  update(input) {
    this.lastEvent = null;
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

    // slide and uppercut both hold their pose/travel on their own timers -
    // game.js's updateSlide/checkUppercutHit own the actual x movement and
    // hit detection for them, this just counts down back to idle. knockback
    // is never entered via input at all (see takeDamage), only ever reached
    // by getting hit by a slide.
    if (["punch", "kick", "special", "specialHigh", "specialLow", "hitstun", "slide", "knockback", "uppercut", "dash"].includes(this.state)) {
      const durations = {
        punch: PUNCH.duration,
        kick: KICK.duration,
        special: SPECIAL.duration,
        specialHigh: BUILDER_SPECIAL.duration,
        specialLow: HODLER_SPECIAL.duration,
        // Scaled per-hit by takeDamage (see this.hitstunFrames there) - a
        // jab locks the defender out for far less than an uppercut/special
        // does. HITSTUN_FRAMES is only ever the fallback for the
        // (unreachable in normal play) case nothing set it yet.
        hitstun: this.hitstunFrames ?? HITSTUN_FRAMES,
        slide: SLIDE.duration,
        knockback: KNOCKBACK_DURATION,
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
      if (this.stateT >= durations[this.state]) this.setState("idle");
      return;
    }

    if (this.state === "jump") {
      this.applyMove(input);
      if (this.stateT >= JUMP_DURATION) this.setState("idle");
      return;
    }

    if (this.state === "block" && !input.block) {
      this.setState("idle");
    }
    if (this.state === "crouch" && !input.crouch) {
      this.setState("idle");
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
      // Builder/Hodler get their own dedicated melee states (see body.js's
      // specialHigh/specialLow) instead of the shared ranged-cast pose -
      // see checkBuilderSpecialHit/checkHodlerSpecialHit in game.js for
      // where their actual hit window is checked.
      const type = this.data.archetypeKey;
      this.setState(type === "Builder" ? "specialHigh" : type === "Hodler" ? "specialLow" : "special");
      this.lastEvent = "special-start";
      return;
    }
    if (justPressed.jump || this.consumeBuffered("jump")) {
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
      this.setState("punch");
      return;
    }
    if ((justPressed.kick || this.hasBuffered("kick")) && this.power >= KICK.cost) {
      this.consumeBuffered("kick");
      this.spendPower(KICK.cost);
      this.setState("kick");
      return;
    }

    const vx = this.applyMove(input);
    this.state = vx !== 0 ? "walk" : "idle";
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

  // Covers real jump, uppercut's own (shorter) rise, and knockback's launch
  // arc - all the same parabola shape, different height/duration - so
  // body.js's draw code can stay untouched and just read one property
  // regardless of which move it is.
  get jumpOffset() {
    if (this.state === "jump") {
      const t = Math.min(1, this.stateT / JUMP_DURATION);
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
    return 0;
  }

  // Special has no melee hitbox of its own anymore - see spawnProjectile in
  // game.js, which handles its hit detection independently once the
  // projectile it fires is actually in flight.
  attackHitbox() {
    const spec = this.state === "punch" ? PUNCH : this.state === "kick" ? KICK : null;
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

  get hodlerSpecialDamage() {
    return HODLER_SPECIAL.damage * this.archetype.damageMult;
  }

  get slideDamage() {
    return SLIDE.damage * this.archetype.damageMult;
  }

  get uppercutDamage() {
    return UPPERCUT.damage * this.archetype.damageMult;
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

  takeDamage(amount, fromX, kind) {
    // Hodler's own special is a holding stance, not just a strike - it
    // blocks whatever the opponent throws at it the same as a real block,
    // matching every other archetype's special still costing the same power
    // and lockout window for the privilege.
    const isHolding = this.data.archetypeKey === "Hodler" && this.state === "specialLow";
    // Only a genuine "block" state counts for a perfect parry - not the
    // Hodler's specialLow holding stance, which is its own separate
    // block-alike with its own cost/lockout tradeoff already; layering a
    // free timing bonus on top of that too wasn't part of this mechanic's
    // design. stateT here is exactly "frames since block was raised" (see
    // the big comment on PARRY_WINDOW_FRAMES above for why that's reliable).
    const isPerfectParry = this.state === "block" && this.stateT <= PARRY_WINDOW_FRAMES;
    // Specials and slides both blow straight through a raised guard - full
    // damage even if the defender was holding block when it landed. A slide
    // is meant to be dodged by jumping over it, not blocked; block doing
    // nothing against it makes that the actual answer instead of a false one.
    if ((this.state === "block" || isHolding) && kind !== "special" && kind !== "slide") {
      if (isPerfectParry) {
        // Full negate, not just a discount - a perfect parry has to feel
        // categorically better than plain block or there's no reason to
        // ever attempt the tighter timing over just holding guard.
        this.power = Math.min(MAX_POWER, this.power + PARRY_POWER_GAIN);
        this.lastEvent = "perfect-parry";
      } else {
        this.health -= amount * 0.2 * this.archetype.blockMult;
        // A successful block is real defensive skill, not just standing
        // there - rewarding it with power gives blocking a reason to exist
        // beyond just "take less damage this once".
        this.power = Math.min(MAX_POWER, this.power + BLOCK_POWER_GAIN);
        this.lastEvent = "block-taken";
      }
    } else {
      // A continuation of the SAME combo only if this fighter was still
      // genuinely locked in the last hit's reaction when this one landed -
      // if state already got back to idle/walk/block/crouch/etc in between,
      // that's a gap, and this hit starts a fresh count at 1. See the
      // combo-scaling block up top for why the state check alone is enough
      // (no separate "combo ended" reset needed anywhere else).
      const wasChaining = this.state === "hitstun" || this.state === "knockback";
      this.comboCount = wasChaining ? this.comboCount + 1 : 1;
      const scaledAmount = amount * computeComboDamageScale(this.comboCount);
      this.health -= scaledAmount;
      // Scaled per this exact hit's ALREADY-combo-scaled damage (see
      // computeHitstunFrames above) - read by the "hitstun" branch of
      // update()'s durations map the instant setState below flips into it.
      // Using the scaled amount (not the raw one) means hitstun shrinks
      // alongside damage as a combo goes on, which is what keeps a long
      // string from staying trivially chainable forever - see the
      // COMBO_DAMAGE_DECAY comment above. Set even for a slide/knockback
      // hit (harmless - "knockback"'s own duration is fixed and never reads
      // this field) so it's always current for whichever hit lands next.
      this.hitstunFrames = computeHitstunFrames(scaledAmount);
      // A slide connecting gets its own reaction pose/knockback instead of
      // the generic hitstun - see updateSlide in game.js for the actual
      // push, this just picks which animation plays while it happens.
      this.setState(kind === "slide" ? "knockback" : "hitstun");
      this.lastEvent = "hit-taken";
    }
    this.health = Math.max(0, this.health);
    if (this.health <= 0) {
      this.setState("ko");
      this.lastEvent = "ko";
    }
  }
}
