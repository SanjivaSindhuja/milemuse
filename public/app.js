// MileMuse player. GPS (or simulated) position -> along-route miles -> play the
// right clip, in order, back-to-back, side-aware. 100% manifest-driven.
import { cumulativeMiles, snapToRoute } from "./geo.js";

const $ = (id) => document.getElementById(id);
const el = {
  start: $("start"), drive: $("drive"),
  routeName: $("route-name"), routeSub: $("route-sub"), routeMini: $("route-mini"),
  stopCount: $("stop-count"), routeMiles: $("route-miles"),
  btnStart: $("btn-start"), btnSim: $("btn-sim"), loadStatus: $("load-status"),
  milesNow: $("miles-now"), milesTotal: $("miles-total"), clipIdx: $("clip-idx"), clipTotal: $("clip-total"),
  progressFill: $("progress-fill"), offroute: $("offroute"),
  npCategory: $("np-category"), npSide: $("np-side"), npSideLabel: $("np-side-label"),
  npTitle: $("np-title"), npTranscript: $("np-transcript"),
  btnPlayPause: $("btn-playpause"), btnReplay: $("btn-replay"), btnSkip: $("btn-skip"), btnBack: $("btn-back"),
  upcoming: $("upcoming-list"),
  simPanel: $("sim-panel"), simRealistic: $("sim-realistic"), simFast: $("sim-fast"), simPause: $("sim-pause"), simScrub: $("sim-scrub"),
  map: $("map"), mapRoute: $("map-route"), mapDot: $("map-dot"),
  audio: $("player"),
};

// ---- state ----
let manifest, route, clips = [], polyline = [], cum = [], totalMiles = 0;
let current = -1, nextIndex = 0, isPlaying = false, paused = false;
let currentMiles = 0, currentLL = null, offRoute = false, mode = "idle";
let playbackRate = 1, wakeLock = null, watchId = null, simRaf = 0;
let bbox = null;

const setStatus = (t) => (el.loadStatus.textContent = t || "");
const pretty = (s) => (s || "").replace(/->/g, "→");

// ---------- load content ----------
async function load() {
  try {
    const [mf, rt] = await Promise.all([
      fetch("./manifest.json").then((r) => { if (!r.ok) throw new Error("manifest"); return r.json(); }),
      fetch("./route.json").then((r) => { if (!r.ok) throw new Error("route"); return r.json(); }),
    ]);
    manifest = mf; route = rt; clips = mf.clips || [];
    polyline = rt.polyline || []; cum = cumulativeMiles(polyline);
    totalMiles = rt.totalMiles || cum[cum.length - 1] || 0;

    el.routeName.textContent = pretty(mf.route?.name || "Your drive");
    el.routeMini.textContent = pretty(mf.route?.name || "Your drive");
    el.stopCount.textContent = clips.length;
    el.routeMiles.textContent = Math.round(totalMiles);
    el.milesTotal.textContent = totalMiles.toFixed(1);
    el.clipTotal.textContent = clips.length;
    buildMap();
    el.btnStart.disabled = false; el.btnSim.disabled = false;
    setStatus(`Ready · ${clips.length} stories downloaded · works with no signal.`);
    console.log(`[MileMuse] loaded ${clips.length} clips, ${totalMiles.toFixed(1)} mi`);
  } catch (e) {
    setStatus("Content is still baking - refresh in a moment.");
    console.warn("[MileMuse] load failed:", e.message);
  }
}

// ---------- geometry helpers ----------
function pointAtMiles(m) {
  if (!polyline.length) return { lat: 0, lng: 0 };
  if (m <= 0) return polyline[0];
  if (m >= totalMiles) return polyline[polyline.length - 1];
  let i = 1;
  while (i < cum.length && cum[i] < m) i++;
  const a = polyline[i - 1], b = polyline[i];
  const span = (cum[i] - cum[i - 1]) || 1;
  const t = (m - cum[i - 1]) / span;
  return { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
}

function buildMap() {
  if (!polyline.length) return;
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const p of polyline) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
  }
  bbox = { minLat, maxLat, minLng, maxLng };
  const step = Math.max(1, Math.floor(polyline.length / 140));
  let d = "";
  for (let i = 0; i < polyline.length; i += step) {
    const { x, y } = projectLL(polyline[i]);
    d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
  }
  el.mapRoute.setAttribute("d", d.trim());
  const s = projectLL(polyline[0]);
  el.mapDot.setAttribute("cx", s.x); el.mapDot.setAttribute("cy", s.y);
}
function projectLL(p) {
  const pad = 5;
  const w = 100 - 2 * pad, h = 46 - 2 * pad;
  const dLng = (bbox.maxLng - bbox.minLng) || 1e-6;
  const dLat = (bbox.maxLat - bbox.minLat) || 1e-6;
  return { x: pad + ((p.lng - bbox.minLng) / dLng) * w, y: pad + ((bbox.maxLat - p.lat) / dLat) * h };
}

// ---------- the engine ----------
function tick() {
  updateUI();
  // Off the planned route: hold narration (don't fire a story for a place you're not
  // near); it auto-resumes at the right spot once you rejoin the route.
  if (paused || isPlaying || offRoute) return;
  if (nextIndex < clips.length && clips[nextIndex].startAtMiles <= currentMiles + 1e-6) {
    playClip(nextIndex);
  }
}

function playClip(i) {
  current = i; nextIndex = i + 1; isPlaying = true;
  const c = clips[i];
  el.audio.src = "./" + c.audio;
  el.audio.playbackRate = playbackRate;
  const pr = el.audio.play();
  if (pr && pr.catch) pr.catch((err) => { console.warn("[MileMuse] play blocked:", err?.message); isPlaying = false; });
  renderNowPlaying(c);
  updateUI();
  console.log(`[MileMuse] >> #${String(i + 1).padStart(2, "0")} ${c.id} (${c.side}) @ ${currentMiles.toFixed(1)}mi`);
}

function renderNowPlaying(c) {
  el.npCategory.textContent = c.category;
  el.npCategory.dataset.cat = c.category;
  el.npSide.className = "side " + c.side;
  el.npSideLabel.textContent = c.side === "left" ? "on your LEFT" : "on your RIGHT";
  el.npTitle.textContent = c.title;
  el.npTranscript.textContent = c.transcript;
  el.npTranscript.scrollTop = 0;
  renderUpcoming();
}

function renderUpcoming() {
  const items = clips.slice(nextIndex, nextIndex + 3);
  el.upcoming.innerHTML = items.length
    ? items.map((c) => `<li><span>${c.title}</span><span class="mi">${c.atMiles.toFixed(1)} mi</span></li>`).join("")
    : `<li><span>That's the whole tour</span><span class="mi">enjoy</span></li>`;
}

function updateUI() {
  const frac = totalMiles ? Math.min(1, currentMiles / totalMiles) : 0;
  el.progressFill.style.width = (frac * 100).toFixed(1) + "%";
  el.milesNow.textContent = currentMiles.toFixed(1);
  el.clipIdx.textContent = current >= 0 ? current + 1 : 0;
  if (currentLL && bbox) {
    const { x, y } = projectLL(currentLL);
    el.mapDot.setAttribute("cx", x); el.mapDot.setAttribute("cy", y);
  }
  el.offroute.classList.toggle("hidden", !offRoute);
}

function setMiles(m, ll) { currentMiles = m; currentLL = ll || pointAtMiles(m); tick(); }

// ---------- modes ----------
function startDrive(m) {
  mode = m;
  el.start.classList.add("hidden");
  el.drive.classList.remove("hidden");
  requestWakeLock();
  current = -1; nextIndex = 0; isPlaying = false; paused = false; playbackRate = 1;
  currentMiles = 0; currentLL = polyline[0]; offRoute = false;
  setPlayIcon(true);
  tick(); // gesture-driven: plays clip #1 (unlocks audio on iOS)
  if (m === "gps") { el.simPanel.classList.add("hidden"); startGps(); }
  else { el.simPanel.classList.remove("hidden"); }
}

function startGps() {
  if (!navigator.geolocation) { setStatus("No GPS on this device - try Simulate."); return; }
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const s = snapToRoute(polyline, cum, p);
      offRoute = s.offsetMiles > 0.25;
      setMiles(s.atMiles, s.snapped);
    },
    (err) => console.warn("[MileMuse] GPS:", err.message),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
  );
}

function runSim(sweepSeconds, rate) {
  playbackRate = rate; paused = false; setPlayIcon(true);
  cancelSim();
  const startFrac = totalMiles ? currentMiles / totalMiles : 0;
  const t0 = performance.now();
  const frame = (now) => {
    const frac = Math.min(1, startFrac + (now - t0) / 1000 / sweepSeconds);
    setMiles(frac * totalMiles);
    if (frac < 1) simRaf = requestAnimationFrame(frame);
  };
  simRaf = requestAnimationFrame(frame);
}
function cancelSim() { if (simRaf) cancelAnimationFrame(simRaf); simRaf = 0; }

function endDrive() {
  cancelSim();
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  el.audio.pause(); isPlaying = false; releaseWakeLock();
  el.drive.classList.add("hidden"); el.start.classList.remove("hidden");
}

// ---------- controls ----------
function setPlayIcon(playing) { el.btnPlayPause.textContent = playing ? "⏸" : "▶"; el.btnPlayPause.setAttribute("aria-label", playing ? "Pause" : "Play"); }

el.btnStart.addEventListener("click", () => startDrive("gps"));
el.btnSim.addEventListener("click", () => startDrive("sim"));
el.btnBack.addEventListener("click", endDrive);
el.simRealistic.addEventListener("click", () => runSim(2400, 1));
el.simFast.addEventListener("click", () => runSim(20, 2));
el.simPause.addEventListener("click", () => { cancelSim(); el.audio.pause(); paused = true; setPlayIcon(false); });
el.simScrub.addEventListener("input", (e) => {
  cancelSim();
  const m = (parseFloat(e.target.value) / 100) * totalMiles;
  let idx = 0; while (idx < clips.length && clips[idx].startAtMiles <= m) idx++;
  nextIndex = Math.max(0, idx - 1); current = nextIndex - 1;
  el.audio.pause(); isPlaying = false; paused = false;
  setMiles(m);
});
el.btnPlayPause.addEventListener("click", () => {
  if (el.audio.paused) { el.audio.play().catch(() => {}); paused = false; setPlayIcon(true); tick(); }
  else { el.audio.pause(); paused = true; cancelSim(); setPlayIcon(false); }
});
el.btnReplay.addEventListener("click", () => { if (current >= 0) { el.audio.currentTime = 0; el.audio.play().catch(() => {}); } });
el.btnSkip.addEventListener("click", () => { if (nextIndex < clips.length) { el.audio.pause(); isPlaying = false; playClip(nextIndex); } });

el.audio.addEventListener("ended", () => { isPlaying = false; tick(); });
el.audio.addEventListener("play", () => setPlayIcon(true));
el.audio.addEventListener("pause", () => { if (el.audio.ended || el.audio.currentTime === 0) return; });

// ---------- wake lock ----------
async function requestWakeLock() { try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch {} }
function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !el.drive.classList.contains("hidden") && !wakeLock) requestWakeLock();
});

// ---------- service worker (offline) ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {}));
}

// debug hook for QA
window.__mm = {
  goto: (frac) => { el.simScrub.value = String(frac * 100); el.simScrub.dispatchEvent(new Event("input")); },
  state: () => ({ current, nextIndex, currentMiles, isPlaying, mode, clip: clips[current]?.id, side: clips[current]?.side }),
};

load();
