const crypto = require("crypto");
const { redisCommand } = require("../_lib/redis");

// Plenty of time for a visitor to actually get through X's consent screen,
// short enough that an abandoned attempt doesn't linger in Redis forever.
const STATE_TTL_SECONDS = 600;

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Authorization Code + PKCE, per X's OAuth 2.0 requirements (plain client-id
// auth alone isn't accepted). code_verifier is generated here and stashed in
// Redis against `state`, then re-supplied by the callback - X itself never
// sees the verifier, only the derived S256 challenge.
module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Use GET" });
    return;
  }

  const address = typeof req.query.address === "string" ? req.query.address.toLowerCase() : "";
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    res.status(400).json({ error: "address must be a valid 0x-prefixed wallet address" });
    return;
  }

  const clientId = process.env.X_CLIENT_ID;
  const redirectUri = process.env.X_AUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    res.status(500).json({ error: "X OAuth is not configured (X_CLIENT_ID/X_AUTH_REDIRECT_URI missing)" });
    return;
  }

  const state = base64url(crypto.randomBytes(24));
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());

  try {
    await redisCommand(
      "set",
      `xauth:state:${state}`,
      JSON.stringify({ address, codeVerifier }),
      "EX",
      String(STATE_TTL_SECONDS),
    );
  } catch (err) {
    console.error("[x-auth/start]", err);
    res.status(502).json({ error: "Could not start X sign-in right now" });
    return;
  }

  const authUrl = new URL("https://x.com/i/oauth2/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "users.read");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
};
