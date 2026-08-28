// GET /api/share?img=<url-encoded-blob-url>
// Returns an HTML page with full OG/Twitter/Farcaster meta tags so that
// X, Farcaster, Discord, etc. unfurl a proper image card rather than
// just a bare link. Also handles Farcaster frame POST actions (redirects
// to fight.hoodchan.org).
//
// The `img` query param is just a URL-encoded blob URL - no decoding tricks,
// no base64 (URL encoding is shorter and natively supported everywhere).
// We validate it is actually a Vercel Blob URL before trusting it, so a
// random attacker can't use this endpoint as an open-graph proxy for
// arbitrary external images.

const ALLOWED_BLOB_HOSTS = [
  ".public.blob.vercel-storage.com",
];

function isTrustedBlobUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    return ALLOWED_BLOB_HOSTS.some((suffix) => u.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

function escape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = async (req, res) => {
  // Farcaster frame POST action - redirect to the game
  if (req.method === "POST") {
    res.setHeader("Location", "https://fight.hoodchan.org");
    res.status(302).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).end("Use GET");
    return;
  }

  const rawImg = req.query.img || "";
  const imgUrl = decodeURIComponent(rawImg);

  // Fall back gracefully to a generic OG image if the param is missing/bad
  const fallbackImg = "https://fight.hoodchan.org/assets/branding/logo.png";
  const safeImg = imgUrl && isTrustedBlobUrl(imgUrl) ? imgUrl : fallbackImg;
  const escapedImg = escape(safeImg);

  const title = "K.O. in HOODCHAN Brawl!";
  const description = "PVP arcade battles with OnChain Hoodies NFTs — fight.hoodchan.org";
  const siteUrl = "https://fight.hoodchan.org";
  const shareUrl = `${siteUrl}/api/share?img=${encodeURIComponent(safeImg)}`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escape(title)}</title>

  <!-- Standard OG -->
  <meta property="og:title" content="${escape(title)}" />
  <meta property="og:description" content="${escape(description)}" />
  <meta property="og:image" content="${escapedImg}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="820" />
  <meta property="og:url" content="${escape(shareUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="HOODCHAN Brawl" />

  <!-- Twitter / X card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escape(title)}" />
  <meta name="twitter:description" content="${escape(description)}" />
  <meta name="twitter:image" content="${escapedImg}" />
  <meta name="twitter:site" content="@h00diechan" />

  <!-- Farcaster frame (vNext) -->
  <meta property="fc:frame" content="vNext" />
  <meta property="fc:frame:image" content="${escapedImg}" />
  <meta property="fc:frame:image:aspect_ratio" content="1.91:1" />
  <meta property="fc:frame:button:1" content="Play HOODCHAN Brawl" />
  <meta property="fc:frame:post_url" content="${escape(shareUrl)}" />

  <!-- Redirect to the game after 0s — crawlers/bots read the meta tags
       above before any redirect fires, so this doesn't break OG unfurling. -->
  <meta http-equiv="refresh" content="0;url=${escape(siteUrl)}" />

  <style>
    body {
      margin: 0;
      background: #0b0b0f;
      color: #3ddc3d;
      font-family: "Courier New", monospace;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      gap: 1rem;
      text-align: center;
    }
    a { color: #ffe066; }
    img { max-width: 90vw; border: 2px solid #3ddc3d; }
  </style>
</head>
<body>
  <img src="${escapedImg}" alt="HOODCHAN Brawl KO card" width="600" />
  <p>Redirecting to <a href="${escape(siteUrl)}">${escape(siteUrl)}</a>…</p>
</body>
</html>`;

  // Cache for 1 hour — the blob URL is immutable, content never changes
  res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).end(html);
};
