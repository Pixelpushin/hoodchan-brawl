#!/usr/bin/env node
// Hermetic tests for api/lobby/join.js: Redis and the chain read are stubbed
// (in-memory store, fixed ownerOf table), so this runs anywhere with no env.
//
//   node scripts/test-lobby-join.mjs
//
// Covers: ownership 403 vs pass, host/guest slot assignment, "connected" →
// "ready" transitions, explicit `side` cannot overwrite another wallet's slot
// (409), re-join is idempotent, full lobby is 409, and the compare-and-set
// retry survives a concurrent write.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- stubs, installed before join.js is required ----
const store = new Map();
let casInterference = null; // () => void, run once between GET and CAS to simulate a racing writer
const fakeRedis = {
  async redisCommand(cmd, ...args) {
    if (cmd === "GET") return store.get(args[0]) ?? null;
    if (cmd === "SET") { store.set(args[0], args[1]); return "OK"; }
    if (cmd === "EXPIRE") return 1;
    throw new Error(`fake redis: unhandled ${cmd}`);
  },
  async redisMultiExec() { return []; },
  async redisCompareAndSet(key, expected, next) {
    if (casInterference) { const f = casInterference; casInterference = null; f(); }
    const cur = store.get(key) ?? null;
    if ((cur === null && expected === "") || cur === expected) { store.set(key, next); return true; }
    return false;
  },
};
const OWNERS = { 14: "0xf69b1587d128c3651fbf6c5aa76e8f4b1d03f618", 165: "0xe0a73213560c3a34838de26f437c77d4f56eb409" };
const fakeChain = { async ownerOf(id) { if (id === 999) throw new Error("rpc down"); return OWNERS[id] ?? null; } };
for (const [rel, exp] of [["api/_lib/redis.js", fakeRedis], ["api/_lib/chain.js", fakeChain]]) {
  const p = require.resolve(path.join(root, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
}
const join = require(path.join(root, "api/lobby/join.js"));

function call(body) {
  return new Promise((resolve) => {
    const res = { setHeader() {}, status(c) { this.c = c; return this; }, json(o) { resolve({ status: this.c, body: o }); }, end() { resolve({ status: this.c }); } };
    join({ method: "POST", body }, res);
  });
}
let failed = 0;
function check(name, ok, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; }
const A = "0xf69b1587d128c3651fbf6c5aa76e8f4b1d03f618"; // owns 14
const B = "0xE0A73213560C3a34838De26f437C77D4f56eB409"; // owns 165 (checksummed on purpose)
const C = "0x3158abD4ADa2741CBD4798530885f36F0725ce05"; // owns nothing
const ROOM = "ABC123";
const key = `lobby:${ROOM}`;
const fresh = () => store.set(key, JSON.stringify({ status: "waiting", p1: { joinedAt: 1 }, p2: null, createdAt: 1 }));

// ownership
fresh();
let r = await call({ roomCode: ROOM, wallet: C, tokenId: 14, side: "p2" });
check("non-owner is 403", r.status === 403, JSON.stringify(r.body));
r = await call({ roomCode: ROOM, wallet: A, tokenId: 999, side: "p2" });
check("RPC failure is 502, not 403", r.status === 502, JSON.stringify(r.body));
r = await call({ roomCode: "NOPE", wallet: A, tokenId: 14, side: "p2" });
check("unknown room is 404", r.status === 404);

// host/guest handshake
fresh();
r = await call({ roomCode: ROOM }); // guest side-less auto-join
check("guest lands in p2, status connected", r.status === 200 && r.body.slot === "p2" && r.body.lobbyState.status === "connected", JSON.stringify(r.body));
r = await call({ roomCode: ROOM, wallet: B, tokenId: 165, side: "p2" }); // guest readies first
check("guest registers on p2, still connected", r.status === 200 && r.body.lobbyState.p2.wallet === B.toLowerCase() && r.body.lobbyState.status === "connected");
r = await call({ roomCode: ROOM, wallet: A, tokenId: 14, side: "p1" }); // host readies
check("host registers on p1 → ready", r.status === 200 && r.body.lobbyState.status === "ready" && r.body.lobbyState.p1.tokenId === 14);
r = await call({ roomCode: ROOM, wallet: A, tokenId: 14, side: "p1" });
check("re-join by the same wallet is idempotent (200)", r.status === 200 && r.body.slot === "p1");
r = await call({ roomCode: ROOM, wallet: B, tokenId: 165, side: "p1" });
check("explicit side cannot overwrite another wallet's slot (409)", r.status === 409, JSON.stringify(r.body));
r = await call({ roomCode: ROOM });
check("third stranger: lobby is full (409)", r.status === 409, JSON.stringify(r.body));
r = await call({ roomCode: ROOM, wallet: C, tokenId: 14 });
check("stranger with a token they don't own is 403 before touching the lobby", r.status === 403);

// compare-and-set retry: another writer lands between GET and CAS
fresh();
await call({ roomCode: ROOM }); // p2 occupied, connected
casInterference = () => {
  const l = JSON.parse(store.get(key));
  l.p2 = { ...l.p2, wallet: B.toLowerCase(), tokenId: 165 };
  store.set(key, JSON.stringify(l));
};
r = await call({ roomCode: ROOM, wallet: A, tokenId: 14, side: "p1" });
const final = JSON.parse(store.get(key));
check("concurrent READY clicks: both slots survive, status ready", r.status === 200 && final.p1.wallet === A && final.p2.wallet === B.toLowerCase() && final.status === "ready", JSON.stringify(final));

// completed room
store.set(key, JSON.stringify({ status: "complete", p1: { wallet: A, tokenId: 14 }, p2: { wallet: B.toLowerCase(), tokenId: 165 } }));
r = await call({ roomCode: ROOM, wallet: A, tokenId: 14, side: "p1" });
check("completed room is 409", r.status === 409);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
