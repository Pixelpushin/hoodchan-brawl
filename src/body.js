// Nudged down from 300 - fighters were standing visibly above the arena
// backgrounds' own pavement/street line instead of on it. groundBlood
// (spawnBloodEffects, game.js) is positioned relative to this same constant,
// so this single change moves fighters and blood down together, keeping
// them aligned with each other.
const GROUND_Y = 320;
const HEAD_SIZE = 30;
const CHARACTER_Y_OFFSET = 5;
const CHARACTER_SCALE = 1.4;
// Corrects the crouch sheet's own art scale back in line with the other
// sheets - see the comment where this is applied in drawFighter for the
// measured numbers behind it.
const CROUCH_EXTRA_SCALE = 0.77;
// The death sheet fits a full lying-down body into a 62px frame, notably
// narrower than the 78-86px the standing sheets author their (taller,
// upright) art at - without this it reads as a shrunken doll instead of the
// same-sized character just knocked flat. ~78/62, matched to the standing
// sheets' own frame size.
const DEATH_EXTRA_SCALE = 1.3;
// The death sheet's own content also doesn't reach the bottom of its frame
// (~8.75px average gap across its 8 frames, measured against alpha) - the
// frame's bottom edge is what's anchored to GROUND_Y, so that empty padding
// otherwise floats the character's actual visible body above the ground
// line. 8.75 * CHARACTER_SCALE(1.4) * DEATH_EXTRA_SCALE(1.3) ≈ 16.
const DEATH_Y_OFFSET = 16;
// Hodler's low-special sheet authors at 68px vs the standing sheets' 78px -
// without this it reads as a hair smaller than every other pose instead of
// matching. ~78/68.
const SPECIAL_LOW_EXTRA_SCALE = 1.15;
const ARENA_BACKGROUNDS = [
  loadImg("assets/backgrounds/arena-2.png"),
  loadImg("assets/backgrounds/arena-3.png"),
];
let currentArenaIndex = 0;

// Called once per fight (see main.js) so the backdrop stays fixed for the
// whole match instead of changing mid-fight.
export function pickRandomArena() {
  currentArenaIndex = Math.floor(Math.random() * ARENA_BACKGROUNDS.length);
}

const BLOOD_SPOTS = [
  loadImg("assets/fx/blood-spot-1.png"),
  loadImg("assets/fx/blood-spot-2.png"),
  loadImg("assets/fx/blood-spot-3.png"),
  loadImg("assets/fx/blood-spot-4.png"),
  loadImg("assets/fx/blood-spot-5.png"),
  loadImg("assets/fx/blood-spot-6.png"),
];
const BLOOD_SPATTER_SHEET = loadImg("assets/fx/blood-spatter-sheet.png");
const BLOOD_SPATTER_FRAME = 34;
const BLOOD_SPATTER_FRAMES = 5;

// Static splat shapes layered behind the animated spatter burst for extra
// density - 3 variants (small/medium/large) in one 240x80 sheet, 80px each.
const BLOOD_SPLAT_EXTRA_SHEET = loadImg("assets/fx/blood-splat-extra.png");
const BLOOD_SPLAT_EXTRA_FRAME = 80;
const BLOOD_SPLAT_EXTRA_VARIANTS = 3;

// KO flourish - single static burst image (pulled from the aquaprime-sandbox
// project's fx set), animated here via scale/fade rather than a frame sheet.
const HEAD_POP_IMG = loadImg("assets/fx/head-pop.png");
export const HEAD_POP_DURATION = 30;

const SHEETS = {
  idle: { img: loadImg("assets/sprites/idle.png"), frameSize: 78 },
  walk: { img: loadImg("assets/sprites/walk.png"), frameSize: 86 },
  attack: { img: loadImg("assets/sprites/attack.png"), frameSize: 86 },
  kick: { img: loadImg("assets/sprites/kick.png"), frameSize: 86 },
  jump: { img: loadImg("assets/sprites/jump.png"), frameSize: 86 },
  hurt: { img: loadImg("assets/sprites/hurt.png"), frameSize: 78 },
  // Replaced with a real collapse-and-fall animation - the old file here was
  // a placeholder, never an actual death pose.
  death: { img: loadImg("assets/sprites/death.png"), frameSize: 62 },
  crouch: { img: loadImg("assets/sprites/crouch.png"), frameSize: 70 },
  block: { img: loadImg("assets/sprites/block.png"), frameSize: 78 },
  spellcast: { img: loadImg("assets/sprites/spellcast.png"), frameSize: 78 },
  // Single-frame still poses, held for their whole state duration rather
  // than cycling - same pattern crouch already uses.
  slide: { img: loadImg("assets/sprites/slide.png"), frameSize: 62 },
  knockback: { img: loadImg("assets/sprites/knockback.png"), frameSize: 76 },
  uppercut: { img: loadImg("assets/sprites/uppercut.png"), frameSize: 78 },
  // Post-match victory pose - only ever entered externally by game.js when
  // a round ends, never by player input.
  flex: { img: loadImg("assets/sprites/flex.png"), frameSize: 78 },
  // Builder/Hodler's dedicated melee specials (see fighter.js's
  // specialHigh/specialLow states) - a real high/low kick each, instead of
  // sharing the ranged-cast "spellcast" pose every other archetype uses.
  specialHigh: { img: loadImg("assets/sprites/special-high.png"), frameSize: 78 },
  specialLow: { img: loadImg("assets/sprites/special-low.png"), frameSize: 68 },
};

// Per-frame neck/collar anchor points, sampled directly from each sheet's
// pixel bounding box (topmost opaque row, x-center of its first ~6 rows).
// This is what makes the head actually follow the body's lean/recoil
// instead of sitting pinned at one fixed point regardless of animation.
// Shifted 10px up from the raw sampled points - at the raw anchor the
// collar covered most of the head. Then nudged +3px x / +2px y after that
// still sat too far back/high relative to the body art.
const HEAD_ANCHORS = {
  idle: [{"x":37.8,"y":-7},{"x":37.8,"y":-7},{"x":37.8,"y":-7},{"x":38.3,"y":-7},{"x":38.8,"y":-7},{"x":38.8,"y":-7},{"x":38.5,"y":-7},{"x":37.8,"y":-7}],
  walk: [{"x":40.9,"y":6},{"x":42.5,"y":5},{"x":41.4,"y":4},{"x":42.1,"y":3},{"x":40.5,"y":5},{"x":40.9,"y":6},{"x":42.2,"y":4},{"x":41.8,"y":3}],
  attack: [{"x":42.0,"y":2},{"x":41.3,"y":1},{"x":40.9,"y":2},{"x":37.0,"y":4},{"x":33.3,"y":1},{"x":47.8,"y":0},{"x":49.8,"y":3},{"x":47.3,"y":2}],
  kick: [{"x":42.0,"y":2},{"x":41.1,"y":3},{"x":39.8,"y":3},{"x":33.8,"y":3},{"x":43.5,"y":1},{"x":40.7,"y":-2},{"x":45.7,"y":5},{"x":42.3,"y":2}],
  jump: [{"x":42.0,"y":2},{"x":41.0,"y":2},{"x":41.6,"y":6},{"x":42.9,"y":11},{"x":45.3,"y":-3},{"x":41.5,"y":-5},{"x":40.9,"y":-2},{"x":41.3,"y":3}],
  hurt: [{"x":37.8,"y":-7},{"x":37.7,"y":-7},{"x":37.5,"y":-7},{"x":38.0,"y":-6},{"x":39.0,"y":-7},{"x":38.7,"y":-6},{"x":37.5,"y":-7},{"x":37.8,"y":-7}],
  // Single static pose - hunched crouch leaves very little headroom above
  // the hood, unlike the standing sheets, so this sits much closer to the
  // sampled raw point than the others needed to. Shifted forward (+9x) from
  // the raw sample - the hunch leans the head toward the front, not the
  // trailing/rear edge the raw collar point sat at.
  crouch: [{"x":40,"y":4}],
  block: [{"x":37.8,"y":-7},{"x":37.8,"y":-7},{"x":38.6,"y":-7},{"x":38.6,"y":-7},{"x":38.6,"y":-7},{"x":39.0,"y":-7},{"x":38.6,"y":-7},{"x":39.0,"y":-7}],
  // Sampled with the same method/offset as every other sheet above (raw
  // topmost-opaque-row + first-6-rows x-center, then the same +3x/-7y net
  // shift that lined up all six other sheets) - the character stands nearly
  // still through the whole cast, so these barely move frame to frame.
  spellcast: [{"x":35.9,"y":-7},{"x":35.9,"y":-7},{"x":35.9,"y":-7},{"x":36.3,"y":-7},{"x":36.4,"y":-7},{"x":36.1,"y":-7},{"x":35.9,"y":-7},{"x":36.3,"y":-7},{"x":36.4,"y":-7},{"x":36.1,"y":-7},{"x":35.9,"y":-7},{"x":36.0,"y":-7},{"x":36.0,"y":-7},{"x":35.9,"y":-7},{"x":35.9,"y":-7},{"x":35.9,"y":-7},{"x":36.9,"y":-7},{"x":38.2,"y":-7},{"x":37.8,"y":-7},{"x":38.3,"y":-7},{"x":36.7,"y":-7}],
  // Single low ground pose - sampled the same way as crouch.
  slide: [{"x":13.5,"y":2}],
  // Single mid-air knocked-back pose.
  knockback: [{"x":63.0,"y":4}],
  // 3-frame crouch-strike-recovery, replacing the old 4-frame sheet - a
  // clearer connecting swipe (motion-blur streak on the punching arm) that
  // reads better as an actual hit. Frame 1 (the strike) again had the
  // raised arm/streak hijacking the topmost-opaque-pixel sample instead of
  // the hood - re-sampled restricted to the body's central-left column,
  // same fix the old sheet needed.
  uppercut: [{"x":38.9,"y":9},{"x":48.2,"y":-5},{"x":42.4,"y":-7}],
  // 8-frame crouch-into-flex victory pose - same sampling method.
  flex: [{"x":37.8,"y":-7},{"x":38.4,"y":-4},{"x":38.0,"y":5},{"x":38.0,"y":7},{"x":37.9,"y":7},{"x":41.3,"y":5},{"x":42.8,"y":-1},{"x":40.0,"y":-2}],
  // 15-frame high-kick special (Builder) - windup/lean, kick, recovery.
  // Sampled the same way as every other multi-frame sheet; no fist/arm to
  // hijack it this time since it's a leg strike, values track the head/
  // hood cleanly throughout.
  specialHigh: [{"x":38.2,"y":-7},{"x":38.2,"y":-7},{"x":37.8,"y":-7},{"x":37.6,"y":-6},{"x":38.7,"y":-5},{"x":30.8,"y":-6},{"x":25.4,"y":-5},{"x":35.9,"y":-5},{"x":39.4,"y":-5},{"x":38.0,"y":-5},{"x":36.4,"y":-4},{"x":35.5,"y":-4},{"x":36.0,"y":-5},{"x":36.1,"y":-5},{"x":37.0,"y":-6}],
  // 7-frame low sweep special (Hodler) - crouched throughout, so y sits much
  // lower than the standing sheets (matches crouch's own anchor pattern).
  specialLow: [{"x":40.2,"y":20},{"x":38.7,"y":20},{"x":41.5,"y":20},{"x":35.9,"y":21},{"x":23.3,"y":21},{"x":25.8,"y":21},{"x":30.4,"y":21}],
  // 8-frame collapse. The earlier version of this data swung the anchor from
  // x~14 to x~43 across the sequence - that was wrong, a sampling error, not
  // real tumbling: frames 3-7 raise a leg up and over the torso, so a
  // topmost-pixel heuristic locks onto the kicked-up leg/foot instead of the
  // head once the leg becomes the tallest part of the silhouette. The head
  // itself stays on the left side the whole time, tucking face-down into the
  // collar as the body settles - resampled by tracking the small light-grey
  // collar-patch accent (a consistent, distinctly-colored landmark right at
  // the neck in every frame) instead of raw silhouette height.
  death: [{"x":11.6,"y":10.9},{"x":10.6,"y":12.9},{"x":7.3,"y":24.3},{"x":8.3,"y":33.4},{"x":8.4,"y":38.6},{"x":9.0,"y":40.0},{"x":8.8,"y":42.4},{"x":8.5,"y":43.0}],
};

// Head art is always drawn upright by default (fine for every standing/
// crouching pose) - but the death collapse actually tips the body over from
// standing to fully prone, so a never-rotating head reads as stuck bolt
// upright on a horizontal body by the final resting frames. Degrees per
// death frame, matching the body's own tumble (upright at the start,
// horizontal by the time it settles) - applied as a clockwise rotation
// around the head anchor, same signed value regardless of facing since it
// lives in the same (possibly already-mirrored) local space the anchor does.
const HEAD_ROTATIONS = {
  death: [0, 5, 25, 45, 65, 82, 90, 90],
};

const ANIMS = {
  idle: { sheet: "idle", frames: 8, cyclesPerSec: 1.1, loop: true },
  walk: { sheet: "walk", frames: 8, cyclesPerSec: 2, loop: true },
  block: { sheet: "block", frames: 8, cyclesPerSec: 1.3, loop: true },
  crouch: { sheet: "crouch", frames: 1, cyclesPerSec: 0, loop: true },
  // durationFrames (48) matches JUMP_DURATION in fighter.js - taller/longer
  // arc than before so a jump can actually clear over the other fighter
  // instead of just hopping in place.
  jump: { sheet: "jump", frames: 8, durationFrames: 48, loop: false },
  punch: { sheet: "attack", frames: 8, durationFrames: 22, loop: false },
  kick: { sheet: "kick", frames: 8, durationFrames: 34, loop: false },
  // durationFrames (30) matches SPECIAL.release in fighter.js exactly, so
  // the cast finishes on the sheet's last (fullest-charge) frame right as
  // the projectile fires - frameIndex clamps to that last frame for the
  // remaining recovery frames in SPECIAL.duration, holding the release pose.
  special: { sheet: "spellcast", frames: 21, durationFrames: 30, loop: false },
  hitstun: { sheet: "hurt", frames: 8, durationFrames: 24, loop: false },
  // Single still frame held for the whole slide (game.js moves the fighter's
  // x directly while this state is active - see updateSlide). durationFrames
  // matches SLIDE.duration in fighter.js.
  slide: { sheet: "slide", frames: 1, durationFrames: 11, loop: false },
  // Single still frame held while knocked back from a connecting slide.
  knockback: { sheet: "knockback", frames: 1, durationFrames: 28, loop: false },
  // durationFrames (18) over the sheet's 3 frames matches UPPERCUT.duration
  // in fighter.js - 6 game-frames per sheet frame, same per-frame pacing
  // the old 4-frame/24-duration sheet used, just one fewer frame.
  uppercut: { sheet: "uppercut", frames: 3, durationFrames: 18, loop: false },
  // Held while charging (see fighter.js's uppercut-charge state) - frozen
  // on the same sheet's frame 0, the wind-up's very first pose (a real
  // crouch on the current sheet), for however long the key stays down.
  "uppercut-charge": { sheet: "uppercut", frames: 1, durationFrames: 1, loop: false },
  // Slowed from 60 (a blink-and-you-miss-it 1s) to actually read as a
  // collapse instead of a flicker.
  ko: { sheet: "death", frames: 8, durationFrames: 100, loop: false },
  // Plays the crouch-into-flex sequence once, then frameIndex's own
  // non-loop clamping holds on the final (fullest-flex) frame for however
  // much longer the post-match display runs - not looped, so it doesn't
  // visibly crouch back down and repeat mid-celebration.
  flex: { sheet: "flex", frames: 8, durationFrames: 40, loop: false },
  // durationFrames (45)/(28) match BUILDER_SPECIAL.duration/HODLER_SPECIAL.duration
  // in fighter.js - active-hitbox window (game.js) is timed to whichever
  // frames the sheet's own impact FX actually shows the kick connecting.
  specialHigh: { sheet: "specialHigh", frames: 15, durationFrames: 45, loop: false },
  specialLow: { sheet: "specialLow", frames: 7, durationFrames: 28, loop: false },
};

const TINTS = {
  1: "hue-rotate(-88deg) saturate(1.6) brightness(1.05)",
  2: "hue-rotate(-58deg) saturate(1.3) brightness(0.85)",
};

function loadImg(src) {
  const img = new Image();
  img.src = src;
  return img;
}

function frameIndex(anim, stateT) {
  if (anim.loop) {
    if (anim.cyclesPerSec === 0) return 0;
    const framesPerSec = anim.cyclesPerSec * anim.frames;
    return Math.floor((stateT / 60) * framesPerSec) % anim.frames;
  }
  const perFrame = anim.durationFrames / anim.frames;
  return Math.min(anim.frames - 1, Math.floor(stateT / perFrame));
}

export function drawFighter(ctx, fighter, playerNum) {
  const { x, facing, state, stateT, headImg, jumpOffset } = fighter;
  const anim = ANIMS[state] || ANIMS.idle;
  const { img: sheet, frameSize } = SHEETS[anim.sheet];
  const frame = frameIndex(anim, stateT);

  const isSpecial = state === "special";

  ctx.save();
  // Every other draw function in this file sets this explicitly for its own
  // decal/FX - this one never did, so a character render's crispness just
  // depended on whatever imageSmoothingEnabled happened to be left at by
  // the last unrelated draw call. Usually invisible at CHARACTER_SCALE's
  // mild 1.4x, but stacked with a state-specific extra scale (DEATH_EXTRA_SCALE
  // etc.) the softening became obviously visible. Always crisp now,
  // regardless of ambient state or scale.
  ctx.imageSmoothingEnabled = false;
  // frameSize is per-sheet (crouch's is shorter than the standing sheets),
  // so anchoring off it here naturally grounds the crouch pose without any
  // extra transform - a hunched sprite is just a shorter frame.
  const deathYOffset = state === "ko" ? DEATH_Y_OFFSET : 0;
  ctx.translate(x, GROUND_Y - frameSize * CHARACTER_SCALE - jumpOffset + CHARACTER_Y_OFFSET + deathYOffset);
  ctx.scale(CHARACTER_SCALE, CHARACTER_SCALE);
  // Every other pose faces the way this fighter is actually facing (always
  // toward the opponent). Knockback is the one exception - it's the fighter
  // flying AWAY from whatever just hit them, i.e. travelling backward
  // relative to their own facing, so the source art (which leads in one
  // fixed direction) needs the opposite mirror rule or it reads as flying
  // toward the attacker instead of away from them.
  const shouldFlip = state === "knockback" ? facing === 1 : facing === -1;
  if (shouldFlip) {
    ctx.translate(frameSize, 0);
    ctx.scale(-1, 1);
  }

  const isCrouch = state === "crouch";
  // Crouch, specialLow, and ko all scale the body around the same bottom-
  // center pivot (crouch shrinks, the other two grow) - see the comments on
  // SPECIAL_LOW_EXTRA_SCALE/DEATH_EXTRA_SCALE above for why. null means "no
  // correction needed". Folded into one shared branch (rather than a
  // separate one for ko) so the head-anchor pivot correction below - which
  // keys off this same variable - automatically covers ko too now that the
  // head is drawn for it.
  const extraScale = isCrouch ? CROUCH_EXTRA_SCALE : state === "specialLow" ? SPECIAL_LOW_EXTRA_SCALE : state === "ko" ? DEATH_EXTRA_SCALE : null;

  // The crouch source art draws the character filling notably more of its
  // frame than every other sheet (measured ~69% of frame width vs ~47% for
  // idle/walk/etc), so at the same CHARACTER_SCALE it read as the character
  // visibly growing on the squat instead of just hunching down. Only the
  // body sprite is scaled here (in its own save/restore) - the head is
  // drawn afterward at its normal size, just repositioned to follow, so
  // this never also shrinks/grows the head.
  ctx.save();
  if (extraScale !== null) {
    ctx.translate(frameSize / 2, frameSize);
    ctx.scale(extraScale, extraScale);
    ctx.translate(-frameSize / 2, -frameSize);
  }

  if (isSpecial) {
    ctx.translate(frameSize / 2, frameSize / 2);
    ctx.scale(1.15, 1.15);
    ctx.translate(-frameSize / 2, -frameSize / 2);
  }

  ctx.filter = isSpecial ? `${TINTS[playerNum]} saturate(2) brightness(1.2)` : TINTS[playerNum];
  if (sheet && sheet.complete) {
    ctx.drawImage(
      sheet,
      frame * frameSize,
      0,
      frameSize,
      frameSize,
      0,
      0,
      frameSize,
      frameSize,
    );
  }
  ctx.filter = "none";
  ctx.restore();

  // Head is drawn on top of the body, in front of the collar, at its normal
  // (unshrunk) size - see isCrouch above. The head art itself is now
  // V-cropped at the bottom (see api.js cropToHeadShape) so its neck point
  // should land close to the body sprite's own collar V instead of
  // overlapping the shoulders. Kept visible through ko too now - it used to
  // vanish the instant a KO landed (paired with the head-pop FX burst), but
  // that left the loser looking headless for the entire post-match result
  // display, not just the brief pop moment.
  if (headImg && headImg.complete) {
    const anchors = HEAD_ANCHORS[anim.sheet];
    let anchor = anchors ? anchors[frame % anchors.length] : { x: frameSize / 2, y: 10 };
    // Anchors are sampled against each sheet's own (unscaled) pixels, so
    // they need the same pivot transform applied above to still land on the
    // now-resized body instead of where the head used to sit.
    if (extraScale !== null) {
      const pivotX = frameSize / 2;
      const pivotY = frameSize;
      anchor = {
        x: (anchor.x - pivotX) * extraScale + pivotX,
        y: (anchor.y - pivotY) * extraScale + pivotY,
      };
    }

    const rotationDeg = HEAD_ROTATIONS[anim.sheet]?.[frame % HEAD_ROTATIONS[anim.sheet].length] || 0;

    ctx.imageSmoothingEnabled = false;
    if (rotationDeg) {
      // Pivoting around anchor itself (the drawn square's center) swings the
      // neck end of the head away from the body as it rotates - a real head
      // tips from the neck, not its own middle. Anchor is calibrated as the
      // center of the unrotated square (see the plain drawImage below), so
      // its neck/bottom edge sits HEAD_SIZE/2 further down - pivot there
      // instead, so that point stays fixed against the collar while the
      // head tips.
      ctx.save();
      ctx.translate(anchor.x, anchor.y + HEAD_SIZE / 2);
      ctx.rotate((rotationDeg * Math.PI) / 180);
      // Mirrored horizontally on top of the rotation - without this the head
      // tips the wrong way relative to how the body actually falls (looked
      // backwards against the real art, confirmed against a live screenshot).
      ctx.scale(-1, 1);
      ctx.drawImage(headImg, -HEAD_SIZE / 2, -HEAD_SIZE, HEAD_SIZE, HEAD_SIZE);
      ctx.restore();
    } else {
      ctx.drawImage(
        headImg,
        anchor.x - HEAD_SIZE / 2,
        anchor.y - HEAD_SIZE / 2,
        HEAD_SIZE,
        HEAD_SIZE,
      );
    }
  }

  ctx.restore();
}

export function drawArena(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  const bg = ARENA_BACKGROUNDS[currentArenaIndex];
  if (bg.complete && bg.naturalWidth > 0) {
    ctx.drawImage(bg, 0, 0, w, h);
  } else {
    ctx.fillStyle = "#1b1330";
    ctx.fillRect(0, 0, w, h);
  }
}

export function drawFlash(ctx, w, h, alpha) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// Ground blood decals persist for the whole fight. `decal` is
// {imgIndex, x, y, size, rotation} - imgIndex picked/randomized by the
// caller so repeated hits don't all look identical. `size` is the desired
// on-screen width in px - the three source images are different native
// sizes (32/50/100px), so this normalizes them to a comparable footprint.
export function drawBloodSpot(ctx, decal) {
  const img = BLOOD_SPOTS[decal.imgIndex % BLOOD_SPOTS.length];
  if (!img.complete || img.naturalWidth === 0) return;
  ctx.save();
  ctx.translate(decal.x, decal.y);
  ctx.rotate(decal.rotation);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, -decal.size / 2, -decal.size / 2, decal.size, decal.size);
  ctx.restore();
}

export function pickBloodSpotVariant() {
  return Math.floor(Math.random() * BLOOD_SPOTS.length);
}

// Brief impact burst at the hit location - plays through its 5 frames once
// and is gone, unlike the ground spots which stay.
export const BLOOD_SPATTER_TOTAL_FRAMES = BLOOD_SPATTER_FRAMES;

// Drawn at ~1.8x native size - the source frames read as too small/subtle
// at 1:1 next to the 1.4x-scaled fighters.
const BLOOD_SPATTER_DRAW_SCALE = 1.8;

export function drawBloodSpatter(ctx, x, y, frame, rotation = 0) {
  if (!BLOOD_SPATTER_SHEET.complete || BLOOD_SPATTER_SHEET.naturalWidth === 0) return;
  const f = Math.min(BLOOD_SPATTER_FRAMES - 1, Math.max(0, frame));
  const size = BLOOD_SPATTER_FRAME * BLOOD_SPATTER_DRAW_SCALE;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.drawImage(
    BLOOD_SPATTER_SHEET,
    f * BLOOD_SPATTER_FRAME,
    0,
    BLOOD_SPATTER_FRAME,
    BLOOD_SPATTER_FRAME,
    -size / 2,
    -size / 2,
    size,
    size,
  );
  ctx.restore();
}

// Static splat layered behind the animated spatter burst for extra density -
// one of 3 fixed variants, randomized position/rotation/scale per spawn.
export function drawBloodSplatExtra(ctx, x, y, variant, rotation, scale) {
  if (!BLOOD_SPLAT_EXTRA_SHEET.complete || BLOOD_SPLAT_EXTRA_SHEET.naturalWidth === 0) return;
  const v = Math.min(BLOOD_SPLAT_EXTRA_VARIANTS - 1, Math.max(0, variant));
  const size = BLOOD_SPLAT_EXTRA_FRAME * scale;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.drawImage(
    BLOOD_SPLAT_EXTRA_SHEET,
    v * BLOOD_SPLAT_EXTRA_FRAME,
    0,
    BLOOD_SPLAT_EXTRA_FRAME,
    BLOOD_SPLAT_EXTRA_FRAME,
    -size / 2,
    -size / 2,
    size,
    size,
  );
  ctx.restore();
}

export function pickBloodSplatVariant() {
  return Math.floor(Math.random() * BLOOD_SPLAT_EXTRA_VARIANTS);
}

// Traveling projectile fired by the ranged special (game.js owns its
// position/lifetime, this just draws whatever frame it's on). The sheet's
// 16th frame is a leftover opaque placeholder tile from the source asset,
// not real content, so only the first 15 are ever indexed.
const SURGE_BLAST_SHEET = loadImg("assets/fx/surge-blast.png");
const SURGE_BLAST_FRAME = 180;
export const SURGE_BLAST_TOTAL_FRAMES = 15;
// Native frames are huge relative to the ~78px fighter frames - scaled down
// to read as a fireball roughly proportional to the character throwing it.
const SURGE_BLAST_DRAW_SCALE = 0.55;

export function drawSurgeBlast(ctx, x, y, frame, facing) {
  if (!SURGE_BLAST_SHEET.complete || SURGE_BLAST_SHEET.naturalWidth === 0) return;
  const f = ((frame % SURGE_BLAST_TOTAL_FRAMES) + SURGE_BLAST_TOTAL_FRAMES) % SURGE_BLAST_TOTAL_FRAMES;
  const size = SURGE_BLAST_FRAME * SURGE_BLAST_DRAW_SCALE;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(x, y);
  if (facing === -1) ctx.scale(-1, 1);
  ctx.drawImage(
    SURGE_BLAST_SHEET,
    f * SURGE_BLAST_FRAME,
    0,
    SURGE_BLAST_FRAME,
    SURGE_BLAST_FRAME,
    -size / 2,
    -size / 2,
    size,
    size,
  );
  ctx.restore();
}

// Flipper's special - a rat swarm rushing along the ground instead of a
// ranged bolt (game.js owns its position/lifetime, same as the surge blast
// above). 8 frames, rearing up then flattening into a low charge - cycled
// on a loop while it travels rather than played once, so it reads as a
// scuttling mass the whole time it's in flight. Swapped for a bigger,
// clearer pair of rats (was a small indistinct blob at this draw scale) -
// same 190px frame size and per-frame layout as the sheet it replaced, just
// 8 frames instead of 18.
const RAT_RUSH_SHEET = loadImg("assets/fx/rat-rush.png");
const RAT_RUSH_FRAME = 190;
export const RAT_RUSH_TOTAL_FRAMES = 8;
const RAT_RUSH_DRAW_SCALE = 0.55;
// The rat art only fills each 190px frame down to row ~151 - a ~39px
// transparent gap below the rats in every frame (measured via alpha
// bounding box, averaged across frames). Anchoring the frame's bottom edge
// to ground level left the rats floating in that gap - 39 *
// RAT_RUSH_DRAW_SCALE ≈ 21px offset pushes the actual rat art down to the
// real ground line instead.
const RAT_RUSH_Y_OFFSET = 21;

// Ground-anchored (bottom edge at y, not center) unlike the head-height
// surge blast - this is meant to be hugging the floor it's rushing across.
export function drawRatRush(ctx, x, y, frame, facing) {
  if (!RAT_RUSH_SHEET.complete || RAT_RUSH_SHEET.naturalWidth === 0) return;
  const f = ((frame % RAT_RUSH_TOTAL_FRAMES) + RAT_RUSH_TOTAL_FRAMES) % RAT_RUSH_TOTAL_FRAMES;
  const size = RAT_RUSH_FRAME * RAT_RUSH_DRAW_SCALE;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(x, y + RAT_RUSH_Y_OFFSET);
  if (facing === -1) ctx.scale(-1, 1);
  ctx.drawImage(
    RAT_RUSH_SHEET,
    f * RAT_RUSH_FRAME,
    0,
    RAT_RUSH_FRAME,
    RAT_RUSH_FRAME,
    -size / 2,
    -size,
    size,
    size,
  );
  ctx.restore();
}

// Impact burst where a projectile actually lands - plays through once, like
// the melee blood-spatter burst, and is gone.
const ENERGY_BURST_SHEET = loadImg("assets/fx/energy-burst.png");
const ENERGY_BURST_FRAME = 80;
export const ENERGY_BURST_TOTAL_FRAMES = 5;
const ENERGY_BURST_DRAW_SCALE = 1.6;

export function drawEnergyBurst(ctx, x, y, frame) {
  if (!ENERGY_BURST_SHEET.complete || ENERGY_BURST_SHEET.naturalWidth === 0) return;
  const f = Math.min(ENERGY_BURST_TOTAL_FRAMES - 1, Math.max(0, frame));
  const size = ENERGY_BURST_FRAME * ENERGY_BURST_DRAW_SCALE;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(x, y);
  ctx.drawImage(
    ENERGY_BURST_SHEET,
    f * ENERGY_BURST_FRAME,
    0,
    ENERGY_BURST_FRAME,
    ENERGY_BURST_FRAME,
    -size / 2,
    -size / 2,
    size,
    size,
  );
  ctx.restore();
}

// Generic melee impact flash - punch/kick/slide/uppercut all had NO hit
// feedback at all with blood turned off (spawnHitEffects in game.js used to
// bail out entirely before anything visual happened unless blood was
// unlocked), so a landed hit with blood off read as silently absorbed even
// though damage really did register. This plays unconditionally on every
// landed melee hit regardless of the blood setting - the energy burst above
// already covers ranged special impacts the same always-on way. Only 2
// frames (a sharp flash, not a lingering burst) - held a few ticks each in
// game.js rather than stepped every frame, or it'd read as a single blink.
const HIT_SPARK_SHEET = loadImg("assets/fx/hit-spark.png");
const HIT_SPARK_FRAME = 72;
export const HIT_SPARK_TOTAL_FRAMES = 2;
const HIT_SPARK_DRAW_SCALE = 0.75;

export function drawHitSpark(ctx, x, y, frame) {
  if (!HIT_SPARK_SHEET.complete || HIT_SPARK_SHEET.naturalWidth === 0) return;
  const f = Math.min(HIT_SPARK_TOTAL_FRAMES - 1, Math.max(0, frame));
  const size = HIT_SPARK_FRAME * HIT_SPARK_DRAW_SCALE;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(x, y);
  ctx.drawImage(
    HIT_SPARK_SHEET,
    f * HIT_SPARK_FRAME,
    0,
    HIT_SPARK_FRAME,
    HIT_SPARK_FRAME,
    -size / 2,
    -size / 2,
    size,
    size,
  );
  ctx.restore();
}

// Plays once over the KO's head position - scales up and fades out rather
// than stepping frames, since the source art is one still burst image.
export function drawHeadPop(ctx, x, y, t) {
  if (!HEAD_POP_IMG.complete || HEAD_POP_IMG.naturalWidth === 0) return;
  const progress = Math.min(1, t / HEAD_POP_DURATION);
  const scale = 0.6 + progress * 1.4;
  const alpha = 1 - progress;
  const size = HEAD_POP_IMG.naturalWidth * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(HEAD_POP_IMG, x - size / 2, y - size / 2, size, size);
  ctx.restore();
}

export { GROUND_Y };
