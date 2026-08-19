// KO share-card generator - a self-contained frontend module with no
// integration into game.js/main.js of its own (see the caller-supplied
// winnerCanvas param below). A later agent wires renderKOShareCard/
// shareKOImage into the match-end flow; this file just needs to keep
// producing a correct canvas/Blob given the same inputs game.js already has
// at endRound (see game.js's titleEl.textContent assignment and main.js's
// updateRoundInfo `${wins.p1} - ${wins.p2}` for where winnerName/loserName/
// roundScore naturally come from).

// Standard OG/Twitter-card-ish aspect (~16:10, wider than tall) - big enough
// to hold the framed screenshot without it turning into a postage stamp,
// short enough that a phone's native share sheet preview doesn't crop it.
export const KO_SHARE_CARD_WIDTH = 1200;
export const KO_SHARE_CARD_HEIGHT = 820;

// Same 20:9 ratio as fighter.js's own CANVAS_WIDTH/CANVAS_HEIGHT (800x360) -
// matching it here means the arena screenshot below drops into its frame
// with no letterboxing or stretch distortion regardless of what resolution
// the source canvas actually renders at (backing store may be scaled up by
// main.js's RENDER_SCALE - drawImage reads a canvas source by its own pixel
// buffer regardless, so that scale is transparent to this file too).
const SNAPSHOT_ASPECT = 360 / 800;

const BRAND_GREEN = "#3ddc3d";
const BRAND_YELLOW = "#ffe066";
const BRAND_BG = "#0b0b0f";
const BRAND_BG_CENTER = "#1a1330";

// Mirrors #result-title in style.css: a thick black stroke UNDER a yellow
// fill (paint-order: stroke fill) is what keeps the title readable over a
// busy/bright arena screenshot - a glow alone (the old approach, per that
// CSS comment) nearly vanishes against a light background. Canvas has no
// paint-order property, so the same effect is just "stroke first, fill on
// top" in plain draw-call order, which is paint-order's default anyway.
function drawStrokedTitle(ctx, text, x, y, fontPx, fillColor) {
  ctx.font = `900 ${fontPx}px "Bungee", "Courier New", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Ratio matched to #result-title's own 9px stroke at its ~40px rendered
  // size (9/40 ≈ 0.22) - scaling with fontPx keeps the outline reading as
  // the same proportionally "bold cartoon outline" at this card's larger
  // title sizes instead of going hairline-thin or comically thick.
  ctx.lineWidth = fontPx * 0.22;
  ctx.strokeStyle = "#000";
  ctx.lineJoin = "round";
  ctx.shadowColor = `${fillColor}99`;
  ctx.shadowBlur = fontPx * 0.35;
  ctx.strokeText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.fillStyle = fillColor;
  ctx.fillText(text, x, y);
  ctx.shadowColor = "transparent";
}

// Plain glow text, no stroke - matches h1's own green wordmark style
// (text-shadow only, no -webkit-text-stroke) rather than #result-title's
// heavier treatment, since this is a secondary line, not the headline.
function drawGlowText(ctx, text, x, y, fontPx, color, align = "center") {
  ctx.font = `400 ${fontPx}px "Bungee", "Courier New", monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.shadowColor = `${color}99`;
  ctx.shadowBlur = fontPx * 0.4;
  ctx.fillText(text, x, y);
  ctx.shadowColor = "transparent";
}

// Bungee is only actually fetched once something on the page renders with
// it (index.html's own <link> just registers the @font-face, it doesn't
// force a download) - without waiting on this, a share card generated
// before any Bungee text has painted elsewhere on the page would silently
// fall back to Courier New for the whole export. Never rejects up to the
// caller - a slow/offline font fetch should degrade to the CSS fallback
// font, not break KO card generation entirely.
async function ensureFontsReady() {
  if (!document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load('900 72px "Bungee"'),
      document.fonts.load('400 36px "Bungee"'),
    ]);
  } catch {
    // Fallback chain in the font strings above already covers this.
  }
}

// Never throws/rejects - a missing or slow-to-load logo shouldn't block the
// whole card, it just draws without the brand mark.
function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Accepts the same {p1,p2} shape main.js's `wins` object already is (see
// updateRoundInfo), OR a plain pre-formatted string, so the integration
// agent can hand this either the raw wins tally or its own formatted label
// without this file dictating which.
function formatRoundScore(roundScore) {
  if (roundScore == null) return null;
  if (typeof roundScore === "string") return roundScore;
  if (typeof roundScore === "object" && "p1" in roundScore && "p2" in roundScore) {
    return `${roundScore.p1} - ${roundScore.p2}`;
  }
  return String(roundScore);
}

// winnerCanvas is the live match canvas (#canvas in index.html) at whatever
// moment the caller grabs it - typically right after the winner's "flex"
// state is set (see game.js's endRound), which already has both the winner
// posed and the loser's KO'd body in frame. That's deliberately used as-is
// instead of re-rendering a fighter in isolation: it's the actual moment
// that happened, blood decals/arena background/both fighters included, and
// it means this file never needs its own copy of body.js's draw logic (or
// to go stale against it - drawFighter's anchor/scale tuning changes often,
// see fighter.js's own comment history).
export async function renderKOShareCard({ winnerName, loserName, roundScore, winnerCanvas } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = KO_SHARE_CARD_WIDTH;
  canvas.height = KO_SHARE_CARD_HEIGHT;
  const ctx = canvas.getContext("2d");

  await ensureFontsReady();

  // Same radial dark-purple-to-near-black wash as body's own background-image
  // in style.css, just reproduced on canvas since there's no page background
  // to inherit from here.
  const bgGradient = ctx.createRadialGradient(
    KO_SHARE_CARD_WIDTH / 2, 0, 0,
    KO_SHARE_CARD_WIDTH / 2, 0, KO_SHARE_CARD_WIDTH * 0.8,
  );
  bgGradient.addColorStop(0, BRAND_BG_CENTER);
  bgGradient.addColorStop(1, BRAND_BG);
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, KO_SHARE_CARD_WIDTH, KO_SHARE_CARD_HEIGHT);

  // Headline first (drawn behind nothing yet, so no risk of the framed
  // screenshot's border/glow clipping under it).
  drawStrokedTitle(ctx, "K.O.", KO_SHARE_CARD_WIDTH / 2, 90, 88, BRAND_YELLOW);

  // Framed arena screenshot, sized off SNAPSHOT_ASPECT so it always exactly
  // fills its frame regardless of the source canvas's own resolution.
  const frameX = 60;
  const frameY = 150;
  const frameW = KO_SHARE_CARD_WIDTH - frameX * 2;
  const frameH = frameW * SNAPSHOT_ASPECT;

  ctx.save();
  ctx.shadowColor = `${BRAND_GREEN}88`;
  ctx.shadowBlur = 24;
  ctx.fillStyle = "#1b1330";
  ctx.fillRect(frameX, frameY, frameW, frameH);
  if (winnerCanvas && winnerCanvas.width > 0 && winnerCanvas.height > 0) {
    // drawImage on a <canvas> source always reads its full current pixel
    // buffer when no sx/sy/sw/sh is given - this is what makes it immune to
    // main.js's RENDER_SCALE upscaling the real backing store past the
    // logical 800x360 fighter.js coordinates are written in (see that
    // file's own CANVAS_WIDTH/CANVAS_HEIGHT comment).
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(winnerCanvas, frameX, frameY, frameW, frameH);
  } else {
    // No usable snapshot handed in - a blank framed panel still reads as
    // "this card is intentionally missing art", not a broken image icon.
    drawGlowText(ctx, "NO REPLAY AVAILABLE", frameX + frameW / 2, frameY + frameH / 2, 24, BRAND_GREEN);
  }
  ctx.shadowBlur = 0;
  ctx.strokeStyle = BRAND_GREEN;
  ctx.lineWidth = 4;
  ctx.strokeRect(frameX + 2, frameY + 2, frameW - 4, frameH - 4);
  ctx.restore();

  // Winner line + optional loser/score context, stacked directly under the
  // frame. Fixed pixel gaps (not proportional) deliberately hand-tuned
  // against KO_SHARE_CARD_HEIGHT=820 - each line's own font size plus glow
  // blur eats real vertical space (drawGlowText's shadowBlur is font-size
  // proportional), so this budget was verified against an actual rendered
  // screenshot rather than computed from font metrics alone, which
  // undercounts the glow and let the name/sub/brand lines visibly collide
  // at a shorter card height (750) that was tried first.
  const nameY = frameY + frameH + 50;
  const winnerLabel = winnerName ? `${String(winnerName).toUpperCase()} WINS!` : "VICTORY!";
  drawGlowText(ctx, winnerLabel, KO_SHARE_CARD_WIDTH / 2, nameY, 42, BRAND_GREEN);

  const scoreText = formatRoundScore(roundScore);
  const subParts = [];
  if (loserName) subParts.push(`defeated ${loserName}`);
  if (scoreText) subParts.push(scoreText);
  if (subParts.length > 0) {
    drawGlowText(ctx, subParts.join("  ·  "), KO_SHARE_CARD_WIDTH / 2, nameY + 42, 24, BRAND_YELLOW);
  }

  // Branding strip, bottom edge - same logo+wordmark pairing as index.html's
  // own h1 (#logo-mark next to "HOOD VS HOOD"), reproduced here since this
  // canvas has no access to that live DOM element to just screenshot.
  const brandY = KO_SHARE_CARD_HEIGHT - 40;
  const logo = await loadImage("assets/branding/logo.png");
  let wordmarkX = KO_SHARE_CARD_WIDTH / 2;
  if (logo) {
    const logoSize = 40;
    const totalW = logoSize + 12 + 220; // logo + gap + rough wordmark width, just for centering the pair
    const startX = KO_SHARE_CARD_WIDTH / 2 - totalW / 2;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(logo, startX, brandY - logoSize / 2, logoSize, logoSize);
    wordmarkX = startX + logoSize + 12;
    drawGlowText(ctx, "HOOD VS HOOD", wordmarkX + 100, brandY, 28, BRAND_GREEN, "center");
  } else {
    drawGlowText(ctx, "HOOD VS HOOD", KO_SHARE_CARD_WIDTH / 2, brandY, 28, BRAND_GREEN, "center");
  }

  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  // Must be in the DOM for Firefox to honor the click-triggered download -
  // Chrome/Safari don't need this, but it's a cheap, harmless no-op there.
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deferred, not immediate - revoking the object URL before the browser
  // has actually started the download (same tick as .click()) can cancel it
  // in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Web Share API (navigator.share with a `files` array) is what actually
// gets a mobile user straight to "share to Twitter/Discord/etc" - most
// desktop browsers (as of this writing) don't implement it at all, or
// implement `share` without file support, so canShare({files}) is checked
// explicitly rather than just feature-detecting `navigator.share` alone.
export async function shareKOImage(canvas, { fileName = "hood-vs-hood-ko.png", title = "Hood Vs Hood", text = "I just got a KO in Hood Vs Hood!" } = {}) {
  const blob = await canvasToBlob(canvas);
  if (!blob) return false;

  if (navigator.share && navigator.canShare) {
    const file = new File([blob], fileName, { type: "image/png" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title, text });
        return true;
      } catch (err) {
        // AbortError means the user closed the native share sheet on
        // purpose - silently downloading the file behind them right after
        // they dismissed it would be a surprising, unwanted side effect,
        // not a real fallback. Any OTHER failure (e.g. the OS share target
        // rejecting the file) still falls through to the download below.
        if (err && err.name === "AbortError") return false;
      }
    }
  }

  downloadBlob(blob, fileName);
  return true;
}
