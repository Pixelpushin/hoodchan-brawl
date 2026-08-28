const { redisCommand } = require("../_lib/redis");

function redirectTo(res, path) {
  res.writeHead(302, { Location: path });
  res.end();
}

// Exchanges the code X just redirected back with for an access token, looks
// up that account's @handle, and stores it against the wallet address that
// started the flow (see start.js). Unauthenticated write, same ambient trust
// model as the match-record API (api/match-result.js) - this is a display
// label for a wallet, not a security boundary.
module.exports = async (req, res) => {
  const { code, state, error: xError } = req.query;

  if (xError) {
    redirectTo(res, `/?xLinkError=${encodeURIComponent(String(xError))}`);
    return;
  }
  if (typeof code !== "string" || typeof state !== "string") {
    redirectTo(res, "/?xLinkError=missing_code_or_state");
    return;
  }

  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  const redirectUri = process.env.X_AUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    redirectTo(res, "/?xLinkError=not_configured");
    return;
  }

  let saved;
  try {
    const raw = await redisCommand("get", `xauth:state:${state}`);
    if (!raw) {
      redirectTo(res, "/?xLinkError=expired_or_invalid_state");
      return;
    }
    await redisCommand("del", `xauth:state:${state}`); // one-time use
    saved = JSON.parse(raw);
  } catch (err) {
    console.error("[x-auth/callback] state lookup", err);
    redirectTo(res, "/?xLinkError=state_lookup_failed");
    return;
  }

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: saved.codeVerifier,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("[x-auth/callback] token exchange failed", tokenData);
      redirectTo(res, "/?xLinkError=token_exchange_failed");
      return;
    }

    const userRes = await fetch("https://api.x.com/2/users/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();
    const username = userData?.data?.username;
    if (!userRes.ok || !username) {
      console.error("[x-auth/callback] user lookup failed", userData);
      redirectTo(res, "/?xLinkError=user_lookup_failed");
      return;
    }

    await redisCommand("set", `wallet:${saved.address}:xHandle`, username);
    // Add to the community set so the ransom-target API can pick random members
    await redisCommand("sadd", "chan:x-connected-handles", username).catch(() => {});

    redirectTo(res, `/?xLinked=${encodeURIComponent(username)}`);
  } catch (err) {
    console.error("[x-auth/callback]", err);
    redirectTo(res, "/?xLinkError=unexpected_error");
  }
};
