#!/usr/bin/env node
// Regression test for the PVP lobby ownership check.
//
// Bug it guards against: api/lobby/join.js verifying ownerOf() against a
// contract from the pfp-brawl fork (OnChainHoodies) instead of the collection
// this deployment actually serves, which made every remote-PVP join 403.
//
//   node scripts/test-lobby-ownership.mjs            # invariants + live RPC check
//   node scripts/test-lobby-ownership.mjs --offline  # invariants only
//
// Live check uses a wallet and token from the original bug report; if that
// wallet no longer holds HOODCHANs the live part is skipped, not failed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const ADDR40 = /0x[0-9a-fA-F]{40}/g;

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

// 1) The server and the client adapter must verify against the SAME contract.
const adapterSrc = read("src/adapters/hoodchan/chain.js");
const adapterContract = (adapterSrc.match(/export const CONTRACT = "(0x[0-9a-fA-F]{40})"/) || [])[1];
const chain = require(path.join(root, "api/_lib/chain.js"));
check(
  "api/_lib/chain.js NFT_CONTRACT equals src/adapters/hoodchan/chain.js CONTRACT",
  !!adapterContract && chain.NFT_CONTRACT.toLowerCase() === adapterContract.toLowerCase(),
  `${chain.NFT_CONTRACT} vs ${adapterContract}`,
);

// 2) No API file may hardcode its own NFT contract address again. The only
//    40-hex constants allowed anywhere under api/ are the ERC-6551 registry +
//    implementation in mint.js and NFT_CONTRACT itself in _lib/chain.js.
import { readdirSync, statSync } from "node:fs";
const ALLOWED = new Set([
  "0x000000006551c19487814612e58fe06813775758", // ERC-6551 registry
  "0x41c8f39463a868d3a88af00cd0fe7102f30e44ec", // ERC-6551 V3 implementation
  "0x0000000000000000000000000000000000000000",
]);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}
for (const abs of walk(path.join(root, "api"))) {
  const rel = path.relative(root, abs);
  const src = readFileSync(abs, "utf8");
  const found = (src.match(ADDR40) || []).map((a) => a.toLowerCase()).filter((a) => !ALLOWED.has(a));
  const ok = rel === "api/_lib/chain.js"
    ? found.length === 1 && found[0] === chain.NFT_CONTRACT.toLowerCase()
    : found.length === 0;
  check(`${rel} has no hardcoded NFT contract`, ok, found.join(", ") || "clean");
}
check(
  "api/lobby/join.js uses api/_lib/chain.js ownerOf",
  /require\(["']\.\.\/_lib\/chain["']\)/.test(read("api/lobby/join.js")),
);
check(
  "api/_lib/mint.js takes the contract from api/_lib/chain.js",
  /require\(["']\.\/chain["']\)/.test(read("api/_lib/mint.js")),
);

// 3) Live: a wallet that owns a token must pass ownerOf on the server's contract.
if (!process.argv.includes("--offline")) {
  const WALLET = "0xf69b1587d128c3651fbf6c5aa76e8f4b1d03f618"; // from the bug report
  try {
    const r = await fetch(`https://hoodchan.org/api/v1/wallet/${WALLET}`, { signal: AbortSignal.timeout(10000) });
    const { tokenIds = [] } = r.ok ? await r.json() : {};
    if (!tokenIds.length) {
      console.log("SKIP  live ownerOf check (wallet holds no HOODCHAN per hoodchan.org right now)");
    } else {
      const id = tokenIds[0];
      const owner = await chain.ownerOf(id);
      check(`live: ownerOf(${id}) on NFT_CONTRACT is the wallet hoodchan.org lists it under`, owner === WALLET, `${owner}`);
    }
    // Server and client agreeing is not enough (they could drift together):
    // the contract must also BE the 1,200-cap HOODCHAN collection.
    const rpc = await fetch(chain.RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0", origin: "https://vibechain.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: chain.NFT_CONTRACT, data: "0x18160ddd" }, "latest"] }),
      signal: AbortSignal.timeout(10000),
    }).then((x) => x.json());
    const supply = typeof rpc.result === "string" && rpc.result.length > 2 ? Number(BigInt(rpc.result)) : NaN;
    check("live: NFT_CONTRACT totalSupply is the ~1,200 HOODCHAN collection (not 6,000 Hoodies)", supply > 1000 && supply <= 1200, String(supply));
  } catch (e) {
    console.log(`SKIP  live ownerOf check (network: ${e.message})`);
  }
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
