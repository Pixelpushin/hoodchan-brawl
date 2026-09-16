// Raw EIP-1193 calls against window.ethereum - no viem/WalletConnect
// dependency. This project has zero npm dependencies by design (no
// package.json, no build step - see vercel.json), and everything here is
// already standard on any injected wallet (MetaMask, Rabby, Coinbase
// Wallet, Brave Wallet, etc). Mobile/QR wallet support via WalletConnect
// would need a project ID from cloud.reown.com, which nobody has set up
// yet - out of scope until that exists.
//
// Chain-agnostic by design - which chain to switch to comes from whichever
// collection adapter is active (its config.chain, see
// src/adapters/index.js), not a constant baked in here. connectWallet
// takes that config as a parameter instead.

import { buildSessionMessage, computeDelegateFingerprint } from "./auth-message.js";

export function hasInjectedWallet() {
  return typeof window !== "undefined" && !!window.ethereum;
}

// Most injected wallets give a dapp no reliable way to force a full
// disconnect - eth_accounts (used by getConnectedAccount below) reflects
// permission state the WALLET itself remembers, which nothing this page
// does can clear on its own. wallet_revokePermissions actually revokes it
// on wallets that support it (MetaMask, Rabby, Coinbase Wallet as of
// 2024+) - see disconnectWallet - but this flag is the real fallback that
// makes "Disconnect" stick even on wallets that don't.
const DISCONNECTED_KEY = "pfp-brawl:wallet-disconnected";

async function ensureChain(provider, chainConfig) {
  const currentChainId = await provider.request({ method: "eth_chainId" });
  if (currentChainId === chainConfig.chainIdHex) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainConfig.chainIdHex }],
    });
  } catch (err) {
    // 4902 = chain not added to this wallet yet - add it, then switch.
    if (err?.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainConfig.chainIdHex,
            chainName: chainConfig.chainName,
            nativeCurrency: chainConfig.nativeCurrency,
            rpcUrls: chainConfig.rpcUrls,
            blockExplorerUrls: chainConfig.blockExplorerUrls,
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

// chainConfig comes from the active collection adapter (config.chain) - see
// src/adapters/index.js. Adapters with no on-chain component at all can
// omit config.chain entirely; main.js hides the "Connect Wallet" option in
// that case, so connectWallet is never called without one.
export async function connectWallet(chainConfig) {
  if (!hasInjectedWallet()) {
    throw new Error("No wallet found - install MetaMask, Rabby, or another browser wallet extension.");
  }
  const provider = window.ethereum;
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) throw new Error("No account returned by wallet.");
  await ensureChain(provider, chainConfig);
  // A visitor clicking Connect is explicitly opting back in - clear any
  // earlier Disconnect so getConnectedAccount's silent resume works again
  // on their next visit instead of staying stuck disconnected forever.
  localStorage.removeItem(DISCONNECTED_KEY);
  return accounts[0];
}

// The app-side half of Disconnect Wallet - see DISCONNECTED_KEY above for
// why wallet_revokePermissions alone isn't enough to rely on.
export async function disconnectWallet() {
  if (hasInjectedWallet()) {
    try {
      await window.ethereum.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      // Not every wallet supports this yet - the localStorage flag is what
      // actually makes this stick regardless.
    }
  }
  localStorage.setItem(DISCONNECTED_KEY, "1");
}

// Checks for an already-authorized connection without prompting -
// eth_accounts (unlike eth_requestAccounts) never shows a popup, it just
// returns whatever accounts this site already has permission for. Used to
// silently resume a previous session on reload/back-navigation instead of
// making a returning visitor click "Connect Wallet" again every time.
export async function getConnectedAccount() {
  if (!hasInjectedWallet()) return null;
  if (localStorage.getItem(DISCONNECTED_KEY) === "1") return null;
  try {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    return accounts?.[0] ?? null;
  } catch {
    return null;
  }
}

// Signs `message` (plain UTF-8 text, not pre-hashed) with EIP-191
// personal_sign from `address` - used for the match-result attestation
// api/lobby/complete.js verifies server-side (see src/lobby.js's
// buildResultMessage). params order is [message, address] per the
// personal_sign spec; MetaMask and other injected wallets show the message
// text itself in the signing prompt when it's passed as a string like this,
// so players can see exactly what they're attesting to.
export async function signMessage(address, message) {
  if (!hasInjectedWallet()) {
    throw new Error("No wallet found - install MetaMask, Rabby, or another browser wallet extension.");
  }
  return window.ethereum.request({
    method: "personal_sign",
    params: [message, address],
  });
}

export function onAccountsChanged(callback) {
  if (!hasInjectedWallet()) return () => {};
  window.ethereum.on("accountsChanged", callback);
  return () => window.ethereum.removeListener("accountsChanged", callback);
}

// ===== Backend session (POST /api/auth/session, see api/_lib/auth.js) =====
//
// getSession({tokenId, adapter}) gets the caller a bearer token for
// HOODCHAN Brawl's backend, binding a wallet signature to a live-owned
// token plus a per-session P-256 "delegate" keypair that can sign later
// requests (delegateSign) without re-prompting the wallet on every call.
//
// Sessions are cached in sessionStorage per (wallet, tokenId) so a page
// full of re-renders/reloads-within-tab doesn't re-prompt for a signature
// every time - but the delegate PRIVATE key never touches sessionStorage
// (or any other storage): it lives only in DELEGATE_KEYS, an in-memory map
// that's gone the moment this module is reloaded. A cache hit after that
// (e.g. after a hard page reload) still returns the cached token, but its
// delegateSign() will throw - the server already has that session's
// delegate fingerprint on file, but the matching private key is
// unrecoverably gone, by design (see generateDelegateKeyPair below).

const SESSION_ENDPOINT = "/api/auth/session";
const DELEGATE_CURVE = { name: "ECDSA", namedCurve: "P-256" };

// wallet:tokenId -> non-extractable CryptoKey (private). Never serialized.
const DELEGATE_KEYS = new Map();

function delegateMapKey(wallet, tokenId) {
  return `${wallet}:${tokenId}`;
}

function sessionStorageKey(wallet, tokenId) {
  return `brawl:session:${wallet}:${tokenId}`;
}

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Generates a fresh P-256 ECDSA keypair for this session's delegate.
// crypto.subtle.generateKey has no way to make ONLY the private half of a
// pair non-extractable (the `extractable` flag applies to the whole pair),
// so this generates an extractable pair just long enough to export both
// halves, then re-imports the private half as non-extractable and drops
// every other reference to it - the exported private JWK is a local
// variable that goes out of scope here and is never stored or transmitted
// anywhere. What callers actually get back is the public JWK (safe to send
// to the server) and a CryptoKey that itself is not extractable.
async function generateDelegateKeyPair() {
  const pair = await crypto.subtle.generateKey(DELEGATE_CURVE, true, ["sign"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, DELEGATE_CURVE, false, ["sign"]);
  return { publicJwk, privateKey };
}

function makeDelegateSign(wallet, tokenId) {
  return async function delegateSign(bytes) {
    const key = DELEGATE_KEYS.get(delegateMapKey(wallet, tokenId));
    if (!key) {
      throw new Error(
        "Delegate signing key is not available for this session (page was reloaded) - call getSession() again.",
      );
    }
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes);
    return bytesToBase64url(new Uint8Array(signature));
  };
}

function readCachedSession(storageKey) {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached?.token || typeof cached.expiresAt !== "number" || cached.expiresAt <= Date.now()) {
      sessionStorage.removeItem(storageKey);
      return null;
    }
    return cached;
  } catch {
    // sessionStorage unavailable (private mode, disabled site data, ...) -
    // callers just mint a fresh session every time instead of caching.
    return null;
  }
}

function writeCachedSession(storageKey, record) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(record));
  } catch {
    // Best-effort cache only - a session still works for this call either way.
  }
}

// Gets (from cache) or creates a backend session for `tokenId`, using
// whichever wallet is currently connected (see getConnectedAccount).
// `adapter` is passed straight through to POST /api/auth/session as the
// stats namespace for this deployment (see api/_lib/stats-keys.js).
//
// Returns { token, sid, wallet, tokenId, expiresAt, engineVersion,
// delegateSign(bytes) }. delegateSign signs arbitrary bytes with the
// session's in-memory delegate private key (ECDSA P-256 / SHA-256) and
// returns a base64url signature - see makeDelegateSign's cache-hit caveat
// above.
export async function getSession({ tokenId, adapter } = {}) {
  if (tokenId === undefined || tokenId === null || tokenId === "") {
    throw new Error("getSession requires a tokenId");
  }
  const address = await getConnectedAccount();
  if (!address) {
    throw new Error("No connected wallet - call connectWallet() first");
  }
  const walletLc = address.toLowerCase();
  const storageKey = sessionStorageKey(walletLc, tokenId);

  const cached = readCachedSession(storageKey);
  if (cached) {
    return { ...cached, delegateSign: makeDelegateSign(walletLc, tokenId) };
  }

  const nonce = randomNonce();
  const issuedAt = new Date().toISOString();
  const { publicJwk, privateKey } = await generateDelegateKeyPair();
  const delegate = await computeDelegateFingerprint(publicJwk);
  const message = buildSessionMessage({ tokenId, address, issuedAt, nonce, delegate });
  const signature = await signMessage(address, message);

  const res = await fetch(SESSION_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adapter, tokenId, address, issuedAt, nonce, signature, delegatePubKey: publicJwk }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || `Could not create session (status ${res.status})`);
    err.code = data?.code;
    throw err;
  }

  DELEGATE_KEYS.set(delegateMapKey(walletLc, tokenId), privateKey);

  const record = {
    token: data.token,
    sid: data.sid,
    wallet: data.wallet,
    tokenId: data.tokenId,
    expiresAt: data.expiresAt,
    engineVersion: data.engineVersion ?? null,
  };
  writeCachedSession(storageKey, record);

  return { ...record, delegateSign: makeDelegateSign(walletLc, tokenId) };
}

// Drops the cached session (and its in-memory delegate key) for a specific
// (wallet, tokenId), or every cached session when called with no argument -
// e.g. on "Disconnect Wallet" (see disconnectWallet above).
export function clearSession({ wallet, tokenId } = {}) {
  if (wallet !== undefined && tokenId !== undefined) {
    const walletLc = String(wallet).toLowerCase();
    DELEGATE_KEYS.delete(delegateMapKey(walletLc, tokenId));
    try {
      sessionStorage.removeItem(sessionStorageKey(walletLc, tokenId));
    } catch {
      // ignore
    }
    return;
  }

  DELEGATE_KEYS.clear();
  try {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith("brawl:session:")) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // ignore - nothing left to clear in memory either way
  }
}
