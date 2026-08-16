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
  BLOOD_SPATTER_TOTAL_FRAMES,
  SURGE_BLAST_TOTAL_FRAMES,
  ENERGY_BURST_TOTAL_FRAMES,
  HIT_SPARK_TOTAL_FRAMES,
  HEAD_POP_DURATION,
  GROUND_Y,
} from "./body.js";
import { MAX_POWER, SLIDE, UPPERCUT, BUILDER_SPECIAL, HODLER_SPECIAL, ARENA_MIN_X, ARENA_MAX_X } from "./fighter.js";
import { playSound } from "./sound.js";
import { createAIController } from "./ai.js";
import { speakTaunt } from "./tts.js";
import { isBloodUnlocked } from "./blood-code.js";
import { reportMatchResult } from "./api.js";

const KEYMAP = {
  p1: {
    left: "a",
    right: "d",
    block: "c",
    crouch: "s",
    jump: " ",
    uppercut: "w",
    slide: "e",
    punch: "f",
    kick: "g",
    special: "r",
  },
  p2: {
    left: "arrowleft",
    right: "arrowright",
    block: "m",
    crouch: "arrowdown",
    jump: "arrowup",
    uppercut: "i",
    slide: "u",
    punch: "k",
    kick: "l",
    special: "j",
  },
};

const SHAKE_ON_HIT = 6;
const SHAKE_ON_SPECIAL = 12;
const FLASH_ON_HIT = 0.25;
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
// your slide - actually work.
function resolveCollision(a, b) {
  if (a.state === "jump" || b.state === "jump") return;
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

export function createGame({ ctx, canvas, p1, p2, onEnd, timeLimit = 60, p2AI = false, practiceMode = false }) {
  // A real training dummy, not just a very bad AI - never acts (no attacks,
  // no blocks, no movement), which is exactly emptyP2Input below. p2AI is
  // ignored entirely when this is on; readInput(KEYMAP.p2) is also skipped
  // since nobody's meant to be on the second keymap for solo practice.
  const emptyP2Input = {
    left: false, right: false, block: false, crouch: false, jump: false,
    uppercut: false, slide: false, punch: false, kick: false, special: false,
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
    };
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
  const powerFullFired = { p1: false, p2: false };
  const groundBlood = [];
  const spatters = [];
  const splatExtras = [];
  const headPops = [];
  const projectiles = [];
  const impacts = [];
  const hitSparks = [];

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
    const contactHeight =
      attacker.state === "kick" || attacker.state === "slide"
        ? GROUND_Y - 20
        : attacker.state === "special"
          ? PROJECTILE_Y
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
  // call, so this must only be called once per rendered frame.
  function drawBloodFX() {
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
      s.t++;
    }
    for (let i = spatters.length - 1; i >= 0; i--) {
      const s = spatters[i];
      const spriteFrame = Math.floor(s.t / SPATTER_TICKS_PER_FRAME);
      if (spriteFrame >= BLOOD_SPATTER_TOTAL_FRAMES) {
        spatters.splice(i, 1);
        continue;
      }
      drawBloodSpatter(ctx, s.x, s.y, spriteFrame, s.rotation);
      s.t++;
    }
    for (let i = impacts.length - 1; i >= 0; i--) {
      const im = impacts[i];
      const spriteFrame = Math.floor(im.t / IMPACT_TICKS_PER_FRAME);
      if (spriteFrame >= ENERGY_BURST_TOTAL_FRAMES) {
        impacts.splice(i, 1);
        continue;
      }
      drawEnergyBurst(ctx, im.x, im.y, spriteFrame);
      im.t++;
    }
    for (let i = hitSparks.length - 1; i >= 0; i--) {
      const hs = hitSparks[i];
      const spriteFrame = Math.floor(hs.t / HIT_SPARK_TICKS_PER_FRAME);
      if (spriteFrame >= HIT_SPARK_TOTAL_FRAMES) {
        hitSparks.splice(i, 1);
        continue;
      }
      drawHitSpark(ctx, hs.x, hs.y, spriteFrame);
      hs.t++;
    }
    for (let i = headPops.length - 1; i >= 0; i--) {
      const p = headPops[i];
      if (p.t >= HEAD_POP_DURATION) {
        headPops.splice(i, 1);
        continue;
      }
      drawHeadPop(ctx, p.x, p.y, p.t);
      p.t++;
    }
  }

  // Punch/kick only now - special has no melee hitbox of its own, see
  // spawnProjectile/updateProjectiles below for its (ranged) hit detection.
  function checkHit(attacker, defender) {
    const box = attacker.attackHitbox();
    if (!box) return;
    if (defender.state === "jump") return;
    // Ducking clears kicks clean over the top - punches still connect
    // through a crouch, only the low kick whiffs.
    if (defender.state === "crouch" && box.kind === "kick") return;
    const lo = Math.min(box.from, box.to);
    const hi = Math.max(box.from, box.to);
    if (defender.x >= lo && defender.x <= hi) {
      const wasBlocking = defender.state === "block";
      attacker.hasHit = true;
      defender.takeDamage(box.damage, attacker.x, box.kind);
      attacker.onLandedHit(box.kind);
      attacker.lastEvent = `${attacker.state}-hit`;
      shake = Math.max(shake, SHAKE_ON_HIT);
      flash = Math.max(flash, FLASH_ON_HIT);
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

    if (defender.state === "jump") return;
    const attackerCenterX = attacker.x + BODY_CENTER_OFFSET;
    const defenderCenterX = defender.x + BODY_CENTER_OFFSET;
    if (Math.abs(attackerCenterX - defenderCenterX) >= SLIDE_HIT_RADIUS) return;

    // A Hodler holding their own ground special isn't knocked back by a
    // slide, and doesn't take damage from it either - the slider just stops
    // dead on contact instead of connecting or passing through, because they
    // hold their ground.
    if (defender.data.hoodieType === "Hodler" && defender.state === "specialLow") {
      attacker.hasHit = true;
      attacker.lastEvent = "slide-stopped";
      shake = Math.max(shake, SHAKE_ON_HIT);
      return;
    }

    attacker.hasHit = true;
    defender.takeDamage(attacker.slideDamage, attacker.x, "slide");
    attacker.onLandedHit("slide");
    const pushDir = defenderCenterX >= attackerCenterX ? 1 : -1;
    // Flies out over the knockback state's own duration (see setKnockbackMotion/
    // jumpOffset in fighter.js) instead of teleporting straight to the final
    // spot - a real launch-and-land arc, not an instant snap-then-freeze.
    defender.setKnockbackMotion(pushDir, SLIDE.knockback);
    attacker.lastEvent = "slide-hit";
    shake = Math.max(shake, SHAKE_ON_HIT);
    flash = Math.max(flash, FLASH_ON_HIT);
    spawnHitEffects(defender, attacker);
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

    const caughtMidair = defender.state === "jump";
    attacker.hasHit = true;
    defender.takeDamage(attacker.uppercutDamage, attacker.x, "uppercut");
    attacker.onLandedHit("uppercut");
    if (caughtMidair) {
      const pushDir = defenderCenterX >= attackerCenterX ? 1 : -1;
      defender.x = Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, defender.x + pushDir * UPPERCUT.knockback));
    }
    attacker.lastEvent = "uppercut-hit";
    shake = Math.max(shake, SHAKE_ON_HIT);
    flash = Math.max(flash, FLASH_ON_HIT);
    spawnHitEffects(defender, attacker);
  }

  // Fires the instant the shared cast animation completes (fighter.js sets
  // this exactly once, at SPECIAL.release) - only ever reached by Flipper/
  // Collector now, since Builder/Hodler have their own dedicated melee
  // states (specialHigh/specialLow) with their own active-hitbox window
  // instead of this cast-then-release pose (see checkBuilderSpecialHit/
  // checkHodlerSpecialHit below).
  function spawnProjectile(fighter) {
    if (fighter.lastEvent !== "special-release") return;
    const isRatRush = fighter.data.hoodieType === "Flipper";
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

  // Runs after both fighters' own update() so a projectile spawned this same
  // frame (via spawnProjectile above) still gets its first move/hit-check
  // immediately rather than sitting a frame behind.
  function updateProjectiles() {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      const isRatRush = p.kind === "ratrush";
      p.x += (isRatRush ? RAT_RUSH_SPEED : PROJECTILE_SPEED) * p.facing;
      p.t++;

      const target = p.owner === p1 ? p2 : p1;
      // The bolt flies at head height, so a crouch dodges it same as a
      // jump. The rat rush is already on the ground - only a jump clears
      // it, same rule as a slide. Neither is stopped by a raised guard,
      // matching every other special's "blows straight through block".
      const dodged = isRatRush ? target.state === "jump" : target.state === "jump" || target.state === "crouch";
      if (!dodged) {
        const targetCenterX = target.x + BODY_CENTER_OFFSET;
        const hitRadius = isRatRush ? RAT_RUSH_HIT_RADIUS : PROJECTILE_HIT_RADIUS;
        if (Math.abs(targetCenterX - p.x) < hitRadius) {
          target.takeDamage(p.owner.specialDamage, p.x, "special");
          // The bolt gets its own dedicated magic-impact sound instead of
          // the generic special-hit thud everything else shares - it's
          // meant to read as a complete impact on its own, not layer under
          // the shared sound.
          if (isRatRush) {
            p.owner.lastEvent = "special-hit";
          } else {
            playSound("boltImpact", { volume: 0.7 });
          }
          shake = Math.max(shake, SHAKE_ON_SPECIAL);
          flash = Math.max(flash, FLASH_ON_HIT);
          // Anchored at the projectile's actual position (the real contact
          // point), not the caster's - the caster may be standing far away
          // by the time this lands, so their own x would be the wrong place
          // to burst blood. spawnHitEffects just needs something with an
          // .x/.state shape; this fakes a minimal "attacker" positioned
          // exactly where the hit happened - "slide" for the rat rush so the
          // blood lands at ground height instead of the bolt's head height.
          spawnHitEffects(target, { x: p.x - BODY_CENTER_OFFSET, state: isRatRush ? "slide" : "special" });
          impacts.push({ x: p.x, y: isRatRush ? GROUND_Y - 20 : p.y, t: 0 });
          projectiles.splice(i, 1);
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
    if (defender.state === "crouch" || defender.state === "jump") return;
    const attackerCenterX = attacker.x + BODY_CENTER_OFFSET;
    const defenderCenterX = defender.x + BODY_CENTER_OFFSET;
    if (Math.abs(attackerCenterX - defenderCenterX) >= BUILDER_SPECIAL.range) return;

    attacker.hasHit = true;
    defender.takeDamage(attacker.builderSpecialDamage, attacker.x, "special");
    attacker.onLandedHit("special");
    attacker.lastEvent = "special-hit";
    shake = Math.max(shake, SHAKE_ON_SPECIAL);
    flash = Math.max(flash, FLASH_ON_HIT);
    spawnHitEffects(defender, { x: attacker.x, state: "uppercut" });
  }

  // Hodler's special - a close ground sweep with its own dedicated
  // animation (specialLow), only dodged by a jump (same rule as the rat
  // rush - it's already at ground level, ducking doesn't get you out of its
  // way). See takeDamage's isHolding check for how this also blocks
  // whatever the opponent throws back during the same window, and
  // updateSlide above for how it stops a slide dead instead of trading.
  function checkHodlerSpecialHit(attacker, defender) {
    if (attacker.state !== "specialLow") return;
    if (attacker.stateT < HODLER_SPECIAL.activeStart || attacker.stateT > HODLER_SPECIAL.activeEnd) return;
    if (attacker.hasHit) return;
    if (defender.state === "jump") return;
    const attackerCenterX = attacker.x + BODY_CENTER_OFFSET;
    const defenderCenterX = defender.x + BODY_CENTER_OFFSET;
    if (Math.abs(attackerCenterX - defenderCenterX) >= HODLER_SPECIAL.range) return;

    attacker.hasHit = true;
    defender.takeDamage(attacker.hodlerSpecialDamage, attacker.x, "special");
    attacker.onLandedHit("special");
    attacker.lastEvent = "special-hit";
    shake = Math.max(shake, SHAKE_ON_SPECIAL);
    flash = Math.max(flash, FLASH_ON_HIT);
    spawnHitEffects(defender, { x: attacker.x, state: "kick" });
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
        playSound("kick", {
          rate: fighter.lastEvent === "special-hit" ? 0.75 : fighter.lastEvent === "uppercut-hit" ? 1.3 : 1,
        });
        break;
      case "block-taken":
      case "slide-stopped":
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
      case "special-start":
        playSound("powerfull", { rate: 1.15 });
        break;
      case "special-release":
        playSound("powerfull", { rate: 0.8 });
        break;
      case "ko":
        playSound("ko");
        headPops.push({ x: fighter.x, y: HEAD_Y, t: 0 });
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
      drawArena(ctx, canvas.width, canvas.height);
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

    frame++;

    p1.update(readInput(KEYMAP.p1));
    p2.update(practiceMode ? emptyP2Input : getAIInput ? getAIInput() : readInput(KEYMAP.p2));
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
    updateSlide(p1, p2);
    updateSlide(p2, p1);
    // Spawn (if this is the frame either fighter's cast just completed) and
    // resolve movement/hits for in-flight projectiles before the sound pass
    // below, so a hit landed this frame sets lastEvent in time for
    // handleSounds to actually see it rather than one frame late.
    spawnProjectile(p1);
    spawnProjectile(p2);
    checkBuilderSpecialHit(p1, p2);
    checkBuilderSpecialHit(p2, p1);
    checkHodlerSpecialHit(p1, p2);
    checkHodlerSpecialHit(p2, p1);
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
    drawArena(ctx, canvas.width, canvas.height);
    drawGroundBlood();
    drawFighter(ctx, p1, 1);
    drawFighter(ctx, p2, 2);
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
      drawFlash(ctx, canvas.width, canvas.height, flash);
      flash *= 0.75;
      if (flash < 0.02) flash = 0;
    }

    // Practice never ends on its own - see exit-match-btn (main.js) for
    // the only way out, since none of the normal win conditions apply to a
    // dummy that can neither be finished off nor time one out.
    if (!practiceMode) {
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
