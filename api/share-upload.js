// POST /api/share-upload
// Accepts raw PNG bytes (Content-Type: image/png), uploads to Vercel Blob,
// returns { url } with the public blob URL. The frontend then encodes this
// URL into a share page link at /api/share?img=<encoded-url>.
//
// No auth - this is a public game, KO cards are public by design. Rate
// limited (5/10min/IP, fail-open - see api/_lib/rate-limit.js) and magic-byte
// checked so this can't become a general-purpose anonymous file host.

const { put } = require("@vercel/blob");
const { enforceRateLimit } = require("./_lib/rate-limit");

// PNG signature (first 8 bytes of any valid PNG file, RFC 2083 sec 3.1).
// Content-Type is client-supplied and trivially spoofable, so this is the
// real gate on "is this actually a PNG" before it goes to Blob storage.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  if (!(await enforceRateLimit(req, res, "share-upload", 5, 600))) return;

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("image/png")) {
    res.status(400).json({ error: "Content-Type must be image/png" });
    return;
  }

  try {
    // Collect raw body bytes from the readable stream. Vercel serverless
    // functions expose req as a Node.js IncomingMessage, not a web Request,
    // so we read it manually. Cap at 3MB - a 1200x820 PNG is ~1-2MB at most.
    const MAX_BYTES = 3 * 1024 * 1024;
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) {
        res.status(413).json({ error: "Payload too large (3MB max)" });
        return;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    if (body.length === 0) {
      res.status(400).json({ error: "Empty body" });
      return;
    }

    if (body.length < 8 || !body.subarray(0, 8).equals(PNG_MAGIC)) {
      res.status(400).json({ error: "File is not a valid PNG" });
      return;
    }

    // Timestamped filename so blobs are sortable/identifiable in the Vercel
    // dashboard. Using Date.now() avoids any dependency on uuid/nanoid;
    // addRandomSuffix guards the (small but real) collision window when two
    // uploads land in the same millisecond.
    const filename = `hoodchan-ko-${Date.now()}.png`;

    const blob = await put(filename, body, {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: true,
    });

    res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error("[share-upload]", err);
    res.status(500).json({ error: "Upload failed" });
  }
};
