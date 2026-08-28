// POST /api/share-upload
// Accepts raw PNG bytes (Content-Type: image/png), uploads to Vercel Blob,
// returns { url } with the public blob URL. The frontend then encodes this
// URL into a share page link at /api/share?img=<encoded-url>.
//
// No auth - this is a public game, KO cards are public by design. Blob storage
// costs are negligible for PNG-sized files; if spam ever becomes a problem,
// add a rate limit header check here (Vercel's own rate-limit middleware or
// a Redis counter via _lib/redis.js).

const { put } = require("@vercel/blob");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("image/png")) {
    res.status(400).json({ error: "Content-Type must be image/png" });
    return;
  }

  try {
    // Collect raw body bytes from the readable stream. Vercel serverless
    // functions expose req as a Node.js IncomingMessage, not a web Request,
    // so we read it manually. Cap at 5MB - a 1200x820 PNG is ~1-2MB at most.
    const MAX_BYTES = 5 * 1024 * 1024;
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) {
        res.status(413).json({ error: "Payload too large (5MB max)" });
        return;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    if (body.length === 0) {
      res.status(400).json({ error: "Empty body" });
      return;
    }

    // Timestamped filename so blobs are sortable/identifiable in the Vercel
    // dashboard. Using Date.now() avoids any dependency on uuid/nanoid.
    const filename = `hoodchan-ko-${Date.now()}.png`;

    const blob = await put(filename, body, {
      access: "public",
      contentType: "image/png",
    });

    res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error("[share-upload]", err);
    res.status(500).json({ error: "Upload failed" });
  }
};
