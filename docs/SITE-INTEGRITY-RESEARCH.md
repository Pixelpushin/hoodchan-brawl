# Site Integrity Research — Closing the "Trust the Host" Gap

Reference material, not a build plan. The game already ships a basic trust
mechanism (see README's "Verifying the live site"): every page shows the
running commit in the footer, links straight to it on GitHub, and because
it's a zero-build static site you can `curl` + `diff` any file against that
commit yourself. That's real, but it's "trust but verify," not tamper-proof
— nothing stops Vercel itself from serving different bytes than the commit
it claims to be running. This doc is a survey of what actually exists (as
of 2025/2026) to close that specific gap, and what we did with each option.

## Doing now

Build provenance attestation is being wired up separately from this doc —
this is just the pointer, not the design doc for it.

- **`actions/attest-build-provenance`** in GitHub Actions — free, keyless
  via Sigstore/Rekor, been GA since 2024. GitHub cryptographically attests
  "this artifact was built from this exact commit by this exact workflow."
- Paired with **`vercel deploy --prebuilt`** instead of letting Vercel
  build server-side. That pairing matters: an attestation only means
  something if the thing being served is the thing that was attested. If
  Vercel rebuilds on its own infra, the attestation covers a build nobody
  actually deployed.
- **The gap this pipeline only covers what's committed to git** — real
  concern initially, since audio (licensed Splice/Suno content, see
  README's License section) is gitignored and used to require manual
  `vercel --prod` deploys from local disk that bypassed the attestation
  entirely. **Resolved**: audio now lives in a Vercel Blob store,
  referenced by absolute URL from `src/sound.js` (`AUDIO_BASE`), fully
  decoupled from the git-driven deploy pipeline. The committed code — the
  part that actually talks to a wallet — is 100% reproducible from the
  repo now; audio is just an external asset the page happens to load, same
  as the OnChainHoodies head art already was.

## Watch for later

Real projects, real cryptography, just not mature enough to build on yet.

- **WEBCAT** (Web-based Code Assurance and Transparency) — built by
  Freedom of the Press Foundation for SecureDrop. Site owners sign a
  manifest of every JS/CSS file; a browser extension refuses to load the
  page if served code doesn't match the manifest; transparency log via
  Sigsum + Sigstore + CometBFT. The Ethereum Foundation funded it
  Aug 5, 2026 specifically to protect wallet/dapp frontends from
  frontend-swap attacks — that's about as close a match to our exact
  problem as exists anywhere. Still alpha though. Revisit once it's past
  alpha and has a real adoption path (i.e. an extension people actually
  have installed before they land on the page).
- **web3:// (ERC-4804/6860, EthStorage)** — on-chain frontends addressed
  by contract, explicitly pitched as a post-Bybit-hack defense against
  frontend compromise. Two live gaps: L1 storage is expensive (mitigated
  via L2), and browsers don't speak the protocol natively — needs an
  extension. A verifier extension shipped July 2026. Worth another look
  once browser support matures past "needs an extension."
- **IPFS + ENS contenthash** — real, in production today (Uniswap, Aave):
  publish a CID per release, point an ENS contenthash at it, serve via
  eth.limo as gateway. Only covers static files, though — our API is
  Redis-backed and can never live there, so at best this becomes a
  fallback mirror of the frontend shell, not a full solution. Note: Fleek
  Hosting, the easy on-ramp for this, shut down Jan 31, 2026 — 4EVERLAND
  or Filebase are the current alternatives if we ever pick this up.

## Explored and ruled out

- **Signed Exchanges (SXG)** — dead. Cloudflare pulled support Oct 2025,
  and it was Chromium-only anyway.
- **C2PA/Content Credentials** — wrong tool. Built for media/deepfake
  provenance, not code — the C2PA ecosystem itself routes software
  provenance questions elsewhere, to SLSA/Sigstore (which is what we're
  already using above).
- **zkTLS/TLSNotary** — still unaudited alpha (v0.1.0-alpha), and even
  once mature it proves what a *user* received, not what *we built* — it
  doesn't bind to the repo. Reclaim Protocol is the more usable zkTLS
  option out there but has the same binding gap.
- **Radicle** — alive but niche (~8k repos), and its web frontend is
  read-only. A possible mirror, not a GitHub replacement for a project
  that needs real CI/PR workflows.
- **Internet Computer (ICP)** — the only option here that puts *both*
  frontend and dynamic backend fully on-chain with certified responses.
  Genuinely interesting, but it means rewriting the entire app in
  Rust/Motoko. That's a different project, not a feature to bolt on.

## Why this matters

The canonical example of this attack class is the Bybit hack: the smart
contracts were never touched. The frontend serving the signing UI was
compromised, and users signed exactly what the compromised UI told them
to sign. Nothing on-chain caught it because nothing on-chain was wrong —
the lie was entirely in what got served to the browser. That's the exact
class of attack this whole research thread is about defending against,
and why "the commit footer looks right" isn't the same thing as "the host
can't lie."
