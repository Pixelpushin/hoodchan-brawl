// Simple rule-based CPU opponent - no ML, just distance checks and timed
// decisions. Produces the exact same input shape readInput() does, so
// game.js can drive an AI fighter through the identical update() path a
// real player uses instead of needing a special case.

import { SLIDE, UPPERCUT, PUNCH_POSES, KICK_POSES } from "./fighter.js";

const ENGAGE_RANGE = 95; // close the gap if farther than this
const ATTACK_RANGE = 82; // attempt an attack once this close
const SLIDE_REACT_RANGE = 220; // slide closes distance fast, so react to it from further out than a normal swing
const UPPERCUT_REACT_RANGE = 110; // only worth anti-airing a jump that's actually closing in
// Both reaction speed and every reactive/opportunistic probability below
// scale off this - starts noticeably softer than the old fixed baseline (a
// new player should be able to land real hits before the fight gets hard)
// and ramps up as the AI actually takes damage, ending a bit sharper than
// the old baseline once it's genuinely hurt. Tied to the AI's own health
// ratio rather than elapsed time, so it's "get damage in to make it
// harder", not just "wait it out."
const DIFFICULTY_MIN = 0.35;
const DIFFICULTY_MAX = 1.15;
const THINK_INTERVAL_MIN = 10; // frames between re-decisions at difficulty 1.0
const THINK_INTERVAL_MAX = 20; // - divided by difficulty below, so it shrinks (faster reactions) as difficulty rises

function difficultyFor(self) {
  const damageRatio = 1 - self.health / self.maxHealth;
  return DIFFICULTY_MIN + (DIFFICULTY_MAX - DIFFICULTY_MIN) * Math.min(1, Math.max(0, damageRatio));
}

function emptyInput() {
  return {
    left: false,
    right: false,
    block: false,
    crouch: false,
    jump: false,
    uppercut: false,
    slide: false,
    punch: false,
    kick: false,
    special: false,
    dash: false,
  };
}

export function createAIController(self, opponent) {
  let input = emptyInput();
  let thinkAt = 0;
  let frame = 0;

  function decide(difficulty) {
    input = emptyInput();
    const dx = opponent.x - self.x;
    const dist = Math.abs(dx);
    const towardOpponent = dx > 0 ? "right" : "left";

    // Jumping a slide is still the clean, zero-damage answer and gets first
    // crack at it - high odds (close to the only sane response), wide
    // window (it closes distance instead of staying in place), scaled off a
    // high floor (0.5) instead of straight multiplying difficulty so even
    // at DIFFICULTY_MIN this is a ~68% dodge instead of ~25%.
    if (opponent.state === "slide" && dist < SLIDE_REACT_RANGE) {
      if (Math.random() < 0.5 + 0.5 * difficulty) {
        input.jump = true;
        return;
      }
      // Crouch+block (blockLow) is the OTHER thing that actually stops a
      // slide now - the low half of the standing/crouching guard mixup (see
      // fighter.js's takeDamage) - and doesn't need a jump's frame-perfect
      // timing, so a whiffed jump-read still has a real shot at only chip
      // damage instead of eating the slide clean. Deliberately a smaller,
      // separate roll rather than folded into the jump check above - this
      // is a fallback for missing the better answer, not a replacement for
      // it, and shouldn't make the slide trivially safe to throw into
      // either.
      if (Math.random() < 0.35 * difficulty) {
        input.block = true;
        input.crouch = true;
        return;
      }
    }
    // Opponent jumping in close is exactly what the uppercut exists to
    // punish - occasionally take the anti-air instead of just blocking/
    // waiting, so the AI actually uses the move rather than only ever
    // eating jump-ins.
    if (opponent.state === "jump" && dist < UPPERCUT_REACT_RANGE && Math.random() < 0.35 * difficulty) {
      input.uppercut = true;
      return;
    }

    // React to the opponent actively attacking - duck a kick, block a punch,
    // roughly half the time (scaled by difficulty) so it isn't a perfect
    // read every single swing. PUNCH_POSES/KICK_POSES (not literal "punch"/
    // "kick") - a combo's later beats cycle through punch2/elbow/downPunch/
    // groundPunch/highKick (see fighter.js), and this needs to keep reacting
    // to those exactly like the opening hit, or the AI would go completely
    // blind to (and stop ever ducking/blocking) anything past the first hit
    // of a real combo string.
    const isKickPose = KICK_POSES.includes(opponent.state);
    const opponentAttacking = (PUNCH_POSES.includes(opponent.state) || isKickPose || opponent.state === "special") && opponent.stateT < 10;
    if (opponentAttacking && dist < ATTACK_RANGE + 20 && Math.random() < 0.5 * difficulty) {
      if (isKickPose && Math.random() < 0.6) {
        input.crouch = true;
      } else if (opponent.state !== "special") {
        input.block = true;
      }
      return;
    }

    if (dist > ENGAGE_RANGE) {
      // Special is a thrown projectile now, not a melee move - it's just as
      // usable from across the arena as it is up close, so take the shot
      // instead of always closing distance first.
      if (self.power >= 50 && Math.random() < 0.25 * difficulty) {
        input.special = true;
        return;
      }
      // Slide covers ground fast - a real alternative to walking in from a
      // distance, not just a close-range finisher. Costs real power now, so
      // check for it first - otherwise the AI "chooses" slide and just does
      // nothing that frame once it can't afford it.
      if (self.power >= SLIDE.cost && Math.random() < 0.15 * difficulty) {
        input.slide = true;
        return;
      }
      input[towardOpponent] = true;
      // Rarely jump in from further out instead of always walking - jump is
      // free now, no power gate needed.
      if (dist > ENGAGE_RANGE * 2 && Math.random() < 0.15 * difficulty) {
        input.jump = true;
      }
      return;
    }

    if (dist <= ATTACK_RANGE) {
      const roll = Math.random();
      // Kick and special both whiff clean over a crouching opponent, guard
      // raised or not (see checkHit's crouch/blockLow kick check and
      // updateProjectiles' crouch/blockLow dodge) - throwing them anyway
      // just burns power for nothing. Was the actual mechanism behind "hold
      // crouch, spam punch, win every time" against the OLD ai.js (kick/
      // special wasted into a crouching opponent instead of the punch that
      // actually connects) - still true here regardless of which of the two
      // crouching states the opponent is actually in, which is the specific
      // thing to re-verify after adding blockLow: it must never regress
      // back into wasting power on a kick/special against either one.
      if (opponent.state === "crouch" || opponent.state === "blockLow") {
        // blockLow is a genuine guard, not just a duck - it now stops both
        // slide and punch (chip damage - see the high/low guard mixup in
        // fighter.js's takeDamage), so neither is the free punish plain
        // crouch still is. Uppercut is the one thing that actually beats it
        // clean (a crouching hurtbox still ducks kick/special regardless,
        // but doesn't stop an anti-air) - lean on that instead specifically
        // when a guard is actually up. Against plain crouch (no guard
        // raised), slide stays the real free punish, same as before this
        // mechanic existed.
        if (opponent.state === "blockLow" && self.power >= UPPERCUT.cost && roll < 0.4) {
          input.uppercut = true;
        } else if (opponent.state === "crouch" && self.power >= SLIDE.cost && roll < 0.35) {
          input.slide = true;
        } else if (roll < 0.9) {
          input.punch = true;
        } else {
          input.block = true;
        }
        return;
      }
      if (self.power >= 50 && roll < 0.2) {
        input.special = true;
      } else if (self.power >= 20 && roll < 0.45) {
        input.kick = true;
      } else if (self.power >= SLIDE.cost && roll < 0.6) {
        input.slide = true;
      } else if (roll < 0.9) {
        input.punch = true;
      } else {
        // Hold ground and block rather than always swinging - keeps it from
        // reading as a button-mashing bot.
        input.block = true;
      }
      return;
    }

    // In the gap between attack range and engage range - take a pot-shot
    // with the ranged special or a slide sometimes instead of always just
    // closing in on foot.
    const roll = Math.random();
    if (self.power >= 50 && roll < 0.2 * difficulty) {
      input.special = true;
      return;
    }
    if (self.power >= SLIDE.cost && roll < 0.35 * difficulty) {
      input.slide = true;
      return;
    }
    input[towardOpponent] = true;
  }

  return function getInput() {
    frame++;
    if (frame >= thinkAt) {
      const difficulty = difficultyFor(self);
      decide(difficulty);
      const min = THINK_INTERVAL_MIN / difficulty;
      const max = THINK_INTERVAL_MAX / difficulty;
      thinkAt = frame + min + Math.floor(Math.random() * (max - min));
    }
    return input;
  };
}
