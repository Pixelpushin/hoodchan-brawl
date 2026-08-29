// Soulbound mint celebration overlay — shown after every PVP match.
//
// Flow: PvP match ends → lobbyComplete fires → showMintCelebration() called
// immediately (optimistic — mint is guaranteed; cron processes within 1 min).
//
// Visual: KO card trophy + fuse-burns-across-bar animation + rank reveal.
// Audio: synthesized sizzle → crackle → boom (no audio file needed).

import { renderKOShareCard, shareKOImage } from "./share-card.js";

// ─── Synthesized fuse + boom sound ──────────────────────────────────────────

function playSizzleBoom(audioCtx) {
  if (!audioCtx) return;

  const now = audioCtx.currentTime;
  const fuseDuration = 2.2; // seconds the fuse burns
  const boomAt = now + fuseDuration;

  // ── Fuse sizzle: white noise through a rising bandpass ──
  const noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * (fuseDuration + 0.5), audioCtx.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;

  const noiseSource = audioCtx.createBufferSource();
  noiseSource.buffer = noiseBuffer;

  const bandpass = audioCtx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.setValueAtTime(800, now);
  bandpass.frequency.linearRampToValueAtTime(3200, boomAt);
  bandpass.Q.value = 8;

  const fuseGain = audioCtx.createGain();
  fuseGain.gain.setValueAtTime(0.18, now);
  fuseGain.gain.setValueAtTime(0.22, boomAt - 0.05);
  fuseGain.gain.setValueAtTime(0, boomAt);

  noiseSource.connect(bandpass).connect(fuseGain).connect(audioCtx.destination);
  noiseSource.start(now);
  noiseSource.stop(boomAt + 0.1);

  // ── Crackle pops along the fuse ──
  for (let i = 0; i < 12; i++) {
    const popAt = now + (fuseDuration * i) / 12 + Math.random() * 0.1;
    const pop = audioCtx.createOscillator();
    pop.type = "square";
    pop.frequency.setValueAtTime(300 + Math.random() * 800, popAt);
    pop.frequency.setValueAtTime(100, popAt + 0.04);
    const popGain = audioCtx.createGain();
    popGain.gain.setValueAtTime(0.08, popAt);
    popGain.gain.exponentialRampToValueAtTime(0.001, popAt + 0.06);
    pop.connect(popGain).connect(audioCtx.destination);
    pop.start(popAt);
    pop.stop(popAt + 0.08);
  }

  // ── Boom: noise burst + sub bass thump ──
  const boomNoiseSrc = audioCtx.createBufferSource();
  boomNoiseSrc.buffer = noiseBuffer;
  const boomFilter = audioCtx.createBiquadFilter();
  boomFilter.type = "lowpass";
  boomFilter.frequency.value = 400;
  const boomGain = audioCtx.createGain();
  boomGain.gain.setValueAtTime(0, boomAt);
  boomGain.gain.setValueAtTime(0.9, boomAt + 0.01);
  boomGain.gain.exponentialRampToValueAtTime(0.001, boomAt + 0.6);
  boomNoiseSrc.connect(boomFilter).connect(boomGain).connect(audioCtx.destination);
  boomNoiseSrc.start(boomAt);
  boomNoiseSrc.stop(boomAt + 0.7);

  // Sub thump
  const thump = audioCtx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(80, boomAt);
  thump.frequency.exponentialRampToValueAtTime(30, boomAt + 0.4);
  const thumpGain = audioCtx.createGain();
  thumpGain.gain.setValueAtTime(0.7, boomAt);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, boomAt + 0.5);
  thump.connect(thumpGain).connect(audioCtx.destination);
  thump.start(boomAt);
  thump.stop(boomAt + 0.6);

  // Shimmer after boom
  for (let i = 0; i < 8; i++) {
    const shimAt = boomAt + 0.05 + i * 0.08;
    const shim = audioCtx.createOscillator();
    shim.type = "sine";
    shim.frequency.value = 1800 + Math.random() * 2400;
    const shimGain = audioCtx.createGain();
    shimGain.gain.setValueAtTime(0.06 - i * 0.006, shimAt);
    shimGain.gain.exponentialRampToValueAtTime(0.001, shimAt + 0.15);
    shim.connect(shimGain).connect(audioCtx.destination);
    shim.start(shimAt);
    shim.stop(shimAt + 0.18);
  }
}

// ─── Bar fetch helpers ───────────────────────────────────────────────────────

async function fetchBarData() {
  try {
    const res = await fetch("/api/bar");
    if (!res.ok) return { total: 0, milestones: [] };
    return await res.json();
  } catch {
    return { total: 0, milestones: [] };
  }
}

async function fetchPlayerRank(walletAddress) {
  if (!walletAddress) return null;
  try {
    const res = await fetch("/api/leaderboard?limit=500");
    if (!res.ok) return null;
    const { fighters } = await res.json();
    const idx = fighters?.findIndex(f => f.wallet?.toLowerCase() === walletAddress.toLowerCase());
    return idx != null && idx >= 0 ? idx + 1 : null;
  } catch {
    return null;
  }
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = v;
    else if (k === "textContent") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Show the soulbound mint celebration overlay.
 *
 * @param {object} opts
 * @param {string}  opts.winnerName
 * @param {string}  opts.loserName
 * @param {object}  opts.wins          — { p1, p2 } round score
 * @param {HTMLCanvasElement} opts.matchCanvas
 * @param {AudioContext|null} opts.audioCtx
 * @param {string|null} opts.walletAddress — p1 connected wallet for rank lookup
 * @returns {Promise<void>} resolves when player dismisses
 */
export function showMintCelebration({ winnerName, loserName, wins, matchCanvas, audioCtx, walletAddress } = {}) {
  return new Promise((resolve) => {
    // ── Overlay shell ──
    const overlay = el("div", { className: "mint-celebration-overlay" });
    const panel = el("div", { className: "mint-celebration-panel" });
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    function dismiss() {
      overlay.classList.add("mint-celebration-exit");
      overlay.addEventListener("animationend", () => overlay.remove(), { once: true });
      resolve();
    }

    // Click-outside dismisses
    overlay.addEventListener("click", (e) => { if (e.target === overlay) dismiss(); });

    // ── Header ──
    const header = el("div", { className: "mint-cel-header" });
    const chain = el("div", { className: "mint-cel-chain", textContent: "⛓ SOULBOUND MINTED" });
    const subtitle = el("div", { className: "mint-cel-subtitle", textContent: "Your match record is being forged on-chain forever." });
    header.appendChild(chain);
    header.appendChild(subtitle);
    panel.appendChild(header);

    // ── KO card trophy ──
    const trophyWrap = el("div", { className: "mint-cel-trophy" });
    panel.appendChild(trophyWrap);

    // Render KO card async and drop it in
    renderKOShareCard({ winnerName, loserName, roundScore: wins, winnerCanvas: matchCanvas })
      .then((koCanvas) => {
        koCanvas.className = "mint-cel-ko-canvas";
        trophyWrap.appendChild(koCanvas);
        trophyWrap.classList.add("mint-cel-trophy-loaded");
      })
      .catch(() => {});

    // ── Community bar section ──
    const barSection = el("div", { className: "mint-cel-bar-section" });
    const barLabel = el("div", { className: "mint-cel-bar-label", textContent: "GLOBAL UNIQUE FIGHTS" });
    const barCountEl = el("div", { className: "mint-cel-bar-count", textContent: "…" });
    const barTrack = el("div", { className: "mint-cel-bar-track" });
    const barFill = el("div", { className: "mint-cel-bar-fill" });
    const fuseHead = el("div", { className: "mint-cel-fuse-head" });
    const sparksContainer = el("div", { className: "mint-cel-sparks" });
    barFill.appendChild(fuseHead);
    barTrack.appendChild(barFill);
    barTrack.appendChild(sparksContainer);
    barSection.appendChild(barLabel);
    barSection.appendChild(barCountEl);
    barSection.appendChild(barTrack);

    // Rank display
    const rankEl = el("div", { className: "mint-cel-rank hidden", textContent: "" });
    barSection.appendChild(rankEl);

    panel.appendChild(barSection);

    // ── Buttons ──
    const btns = el("div", { className: "mint-cel-btns" });
    const shareBtn = el("button", { className: "mint-cel-share-btn", textContent: "SHARE ON X" });
    const dismissBtn = el("button", { className: "mint-cel-dismiss-btn secondary-btn", textContent: "CONTINUE" });
    btns.appendChild(shareBtn);
    btns.appendChild(dismissBtn);
    panel.appendChild(btns);

    dismissBtn.addEventListener("click", dismiss);

    shareBtn.addEventListener("click", async () => {
      shareBtn.disabled = true;
      try {
        const ko = await renderKOShareCard({ winnerName, loserName, roundScore: wins, winnerCanvas: matchCanvas });
        const winner = winnerName || "My Hoodie";
        const loser = loserName || "their opponent";
        await shareKOImage(ko, {
          fileName: "hood-vs-hood-soulbound.png",
          title: `${winner} earned a Soulbound token in Hood Vs Hood`,
          text: `${winner} just KO'd ${loser} and minted a soulbound NFT! 🥊⛓`,
          tweetText: `${winner} just KO'd ${loser} and minted a Soulbound token 🥊⛓\n\nfight.hoodchan.org`,
        });
      } finally {
        shareBtn.disabled = false;
      }
    });

    // ── Animate bar after short delay (let overlay paint first) ──
    setTimeout(() => animateBar(), 300);

    async function animateBar() {
      const { total, milestones } = await fetchBarData();
      const newTotal = total + 1; // optimistic — mint pending
      const nextMilestone = milestones?.find(m => !m.reached);
      const target = nextMilestone?.threshold ?? Math.max(newTotal, 100);
      const pctBefore = Math.min(99, (total / target) * 100);
      const pctAfter = Math.min(100, (newTotal / target) * 100);

      barCountEl.textContent = total.toLocaleString();

      // Kick off sound
      if (audioCtx) playSizzleBoom(audioCtx);

      // Set bar to "before" width instantly, then animate to new width over fuse duration
      barFill.style.transition = "none";
      barFill.style.width = `${pctBefore}%`;

      // Spawn sparks periodically during fuse burn
      const FUSE_MS = 2200;
      let sparkInterval = setInterval(() => spawnSpark(sparksContainer, barFill), 120);

      // Force reflow then start the burn
      barFill.getBoundingClientRect();
      barFill.style.transition = `width ${FUSE_MS}ms cubic-bezier(0.4, 0, 0.8, 1)`;
      barFill.classList.add("mint-cel-burning");
      barFill.style.width = `${pctAfter}%`;

      // Boom at end of fuse
      setTimeout(() => {
        clearInterval(sparkInterval);
        barFill.classList.remove("mint-cel-burning");
        barFill.classList.add("mint-cel-boomed");
        barCountEl.textContent = newTotal.toLocaleString();
        barCountEl.classList.add("mint-cel-count-pop");

        // Milestone check
        if (nextMilestone && newTotal >= nextMilestone.threshold) {
          const milestoneEl = el("div", { className: "mint-cel-milestone-reached", textContent: `🏆 ${nextMilestone.label} UNLOCKED!` });
          barSection.appendChild(milestoneEl);
        }
      }, FUSE_MS + 50);

      // Rank reveal after boom
      setTimeout(async () => {
        const rank = await fetchPlayerRank(walletAddress);
        if (rank) {
          rankEl.textContent = `YOU RANK #${rank} IN TOTAL FIGHTS`;
          rankEl.classList.remove("hidden");
          rankEl.classList.add("mint-cel-rank-pop");
        }
      }, FUSE_MS + 400);
    }
  });
}

function spawnSpark(container, fillEl) {
  const spark = document.createElement("div");
  spark.className = "mint-cel-spark";
  // Position spark at the leading edge of the fill bar
  const fillRect = fillEl.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const x = fillRect.right - containerRect.left;
  const y = fillRect.top - containerRect.top + fillRect.height / 2;
  spark.style.left = `${x}px`;
  spark.style.top = `${y}px`;
  // Random direction
  const angle = (Math.random() * 160 - 80) * (Math.PI / 180);
  const speed = 30 + Math.random() * 50;
  spark.style.setProperty("--sx", `${Math.cos(angle) * speed}px`);
  spark.style.setProperty("--sy", `${Math.sin(angle) * speed - 20}px`);
  container.appendChild(spark);
  spark.addEventListener("animationend", () => spark.remove(), { once: true });
}
