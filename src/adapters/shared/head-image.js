// Shared head-image processing, reused by any adapter (see ../../../ADAPTERS.md's
// `headStyle` field). Two strategies, and which one a collection needs comes
// down to one question: can the art's background be cleanly removed?
//
// - "cropped" (cropToHeadShape): yes - isolated vector/flat-background art
//   (OnChainHoodies' SVGs, say) can be clipped to a tight head+shoulders
//   taper that sits seamlessly on the body sprite's neck. Requires the
//   caller to strip/isolate the background itself first (collection-specific -
//   see onchainhoodies/api.js's stripSvgBackground) since there's no generic
//   way to detect "the background layer" across arbitrary art.
// - "circle" (circleFrameImage): no - photographic art, busy collage art,
//   or anything else that can't be cleanly isolated. Skips background
//   removal entirely and just circle-crops+borders the whole image as a
//   badge, same idea as a normal avatar/PFP display. Works on literally any
//   image URL, which is why it's the safe default for a new collection you
//   haven't specifically written background-removal logic for.

export function loadImageAsync(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// The source art is assumed to already be background-free (a bust: head +
// shoulders, nothing else) by the time it reaches here - pasting it whole
// onto a fighter's neck would duplicate shoulder pixels against the body
// sprite's own shoulders otherwise. Clips to a home-plate shape: full width
// for the face, tapering to a point lower down so a bit of neck survives
// but the shoulder corners are cut away.
export async function cropToHeadShape(imageUrl) {
  const img = await loadImageAsync(imageUrl);
  const size = 200;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, size, size);

  const neckY = size * 0.62;
  const bottomY = size * 0.85;
  const centerX = size / 2;
  ctx.globalCompositeOperation = "destination-in";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(size, 0);
  ctx.lineTo(size, neckY);
  ctx.lineTo(centerX, bottomY);
  ctx.lineTo(0, neckY);
  ctx.closePath();
  ctx.fill();

  return canvas.toDataURL("image/png");
}

// Circle-crops the source image as-is (background included) with a border
// ring, same footprint (200x200, head mass in the upper-middle) as
// cropToHeadShape's output so it drops onto the body sprite's neck anchor
// without body.js needing to know or care which style produced it. Standard
// cover-fit (scale to fill the circle, crop overflow) - no attempt at
// subject detection, same as any ordinary avatar/PFP circle crop.
export async function circleFrameImage(imageUrl, { borderColor = "#0b0b0b", borderWidth = 6 } = {}) {
  const img = await loadImageAsync(imageUrl);
  const size = 200;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;

  const cx = size / 2;
  const cy = size * 0.46;
  const r = size * 0.42;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const scale = Math.max((r * 2) / img.width, (r * 2) / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = borderWidth;
  ctx.strokeStyle = borderColor;
  ctx.stroke();

  return canvas.toDataURL("image/png");
}

// Single entry point an adapter can call without caring which function
// backs which style - see any adapter's fetchFighterData for the one-line
// usage. `raw` should already be background-free for "cropped" (do any
// collection-specific stripping before calling this).
export async function prepareHeadImage(imageUrl, headStyle) {
  return headStyle === "circle" ? circleFrameImage(imageUrl) : cropToHeadShape(imageUrl);
}
