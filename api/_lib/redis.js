// Zero-dependency Upstash Redis client - plain fetch() against their REST
// API instead of the @upstash/redis npm package, matching the rest of this
// repo's zero-npm-dependency approach. KV_REST_API_URL/KV_REST_API_TOKEN are
// injected automatically by the Upstash-for-Redis Vercel integration.
// Prefixed with an underscore (like the whole _lib dir) so Vercel doesn't
// treat this as a route of its own - it's imported by the real handlers.
async function redisCommand(cmd, ...args) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("Redis is not configured (KV_REST_API_URL/KV_REST_API_TOKEN missing)");
  }
  // Path-style form (command + every arg as its own URL segment) rather than
  // command-in-path + args-in-body - the latter looked plausible but Upstash
  // rejected it ("wrong number of arguments") for anything past a single arg.
  const path = [cmd, ...args].map((s) => encodeURIComponent(s)).join("/");
  const res = await fetch(`${url}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

module.exports = { redisCommand };
