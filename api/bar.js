// GET /api/bar
// Returns the current community bar total (minted NFT count) and milestone
// status. The `bar:total` key is written by the mint pipeline; this endpoint
// is read-only. Falls back to 0 if the key doesn't exist yet.
//
// Milestone thresholds are read from env vars with defaults so they can be
// tuned per-deploy without a code change.

const { redisCommand } = require("./_lib/redis");

const DEFAULT_MILESTONES = [
  { label: "Hoodchan Brawlers", envKey: "MILESTONE_1", defaultThreshold: 100 },
  { label: "Girlfriends Enter",  envKey: "MILESTONE_2", defaultThreshold: 500 },
  { label: "Squirts Unleashed",  envKey: "MILESTONE_3", defaultThreshold: 2000 },
];

function getThreshold(envKey, defaultVal) {
  const raw = process.env[envKey];
  if (!raw) return defaultVal;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultVal;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Allow caching for 60s - this updates via mint pipeline, not in real time.
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
  if (req.method !== "GET") { res.status(405).json({ error: "Use GET" }); return; }

  try {
    const raw = await redisCommand("get", "bar:total");
    const total = raw !== null ? Math.max(0, Number(raw) || 0) : 0;

    const milestones = DEFAULT_MILESTONES.map(({ label, envKey, defaultThreshold }) => {
      const threshold = getThreshold(envKey, defaultThreshold);
      return { label, threshold, reached: total >= threshold };
    });

    res.status(200).json({ total, milestones });
  } catch (err) {
    console.error("[bar]", err);
    // Degrade gracefully: return 0 + unreached milestones so the UI renders
    // rather than breaking on a Redis hiccup.
    const milestones = DEFAULT_MILESTONES.map(({ label, envKey, defaultThreshold }) => ({
      label,
      threshold: getThreshold(envKey, defaultThreshold),
      reached: false,
    }));
    res.status(200).json({ total: 0, milestones });
  }
};
