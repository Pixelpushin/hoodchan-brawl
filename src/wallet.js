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

export function onAccountsChanged(callback) {
  if (!hasInjectedWallet()) return () => {};
  window.ethereum.on("accountsChanged", callback);
  return () => window.ethereum.removeListener("accountsChanged", callback);
}
