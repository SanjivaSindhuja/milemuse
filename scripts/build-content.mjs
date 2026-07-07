// build-content.mjs - MileMuse content pipeline (multi-route).
// Reads every content/routes/*.json and bakes each into
//   public/routes/<id>/{route.json, manifest.json, audio/NN.mp3}
// plus a public/routes.json index. Uses OSRM + edge-tts + ffprobe.
// Run:  node scripts/build-content.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bearingDeg, cumulativeMiles, snapToRoute, sideOfRoad } from "../public/geo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PUB = join(ROOT, "public");
const ROUTES_IN = join(ROOT, "content", "routes");
const TMP = join(HERE, "tmp");

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
let _voices = null;

async function osrmPolyline(from, to) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
      const data = await res.json();
      if (data.code !== "Ok" || !data.routes?.[0]) throw new Error(`OSRM: ${data.code}`);
      return data.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    } catch (e) {
      lastErr = e;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

function voiceAvailable(voice) {
  if (_voices === null) {
    try {
      _voices = execFileSync("python", ["-m", "edge_tts", "--list-voices"], { encoding: "utf8" });
    } catch {
      _voices = "";
    }
  }
  return _voices.includes(voice);
}

function synth(text, voice, outPath) {
  mkdirSync(TMP, { recursive: true });
  const txt = join(TMP, "clip.txt");
  writeFileSync(txt, text, "utf8");
  execFileSync("python", ["-m", "edge_tts", "--file", txt, "--voice", voice, "--write-media", outPath], {
    stdio: "pipe",
  });
}

function durationSec(mp3) {
  const out = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", mp3], {
    encoding: "utf8",
  });
  return parseFloat(JSON.parse(out).format.duration);
}

function routeKey(r) {
  return `${r.from.lat},${r.from.lng}->${r.to.lat},${r.to.lng}`;
}

// Fetch route geometry once and cache it, so a flaky OSRM never blocks a rebuild
// (rebuilds mostly re-synth audio; the road line only changes if from/to change).
async function getPolyline(id, route) {
  const cf = join(ROUTES_IN, ".cache", `${id}.polyline.json`);
  const key = routeKey(route);
  if (existsSync(cf)) {
    try {
      const c = JSON.parse(readFileSync(cf, "utf8"));
      if (c.key === key && c.polyline?.length) {
        console.log("  (cached route geometry)");
        return c.polyline;
      }
    } catch {}
  }
  const poly = await osrmPolyline(route.from, route.to);
  mkdirSync(dirname(cf), { recursive: true });
  writeFileSync(cf, JSON.stringify({ key, polyline: poly }));
  return poly;
}

async function buildRoute(data, id) {
  const { route, voice, voiceFallback, defaultLeadMiles, landmarks } = data;
  const outDir = join(PUB, "routes", id);
  const audioDir = join(outDir, "audio");
  mkdirSync(audioDir, { recursive: true });

  console.log(`\n=== ${id}: ${route.name} ===`);
  const polyline = await getPolyline(id, route);
  const cum = cumulativeMiles(polyline);
  const totalMiles = cum[cum.length - 1];
  console.log(`  route: ${polyline.length} pts, ${totalMiles.toFixed(1)} mi`);
  writeFileSync(join(outDir, "route.json"), JSON.stringify({ totalMiles: round(totalMiles), polyline }));

  const enriched = landmarks.map((lm) => {
    const p = { lat: lm.lat, lng: lm.lng };
    const snap = snapToRoute(polyline, cum, p);
    const seg = Math.min(snap.segIndex, polyline.length - 2);
    const heading = bearingDeg(polyline[seg], polyline[seg + 1]);
    const side = sideOfRoad(heading, snap.snapped, p);
    const lead = lm.leadMiles ?? defaultLeadMiles;
    return { ...lm, atMiles: snap.atMiles, side, startAtMiles: Math.max(0, snap.atMiles - lead) };
  });
  enriched.sort((a, b) => a.startAtMiles - b.startAtMiles);
  if (enriched.length) enriched[0].startAtMiles = 0; // opening clip plays at the very start (also unlocks iOS audio on the Start tap)

  const useVoice = voiceAvailable(voice) ? voice : voiceFallback;
  const clips = [];
  for (let i = 0; i < enriched.length; i++) {
    const lm = enriched[i];
    const num = String(i + 1).padStart(2, "0");
    const rel = `audio/${num}.mp3`;
    synth(lm.script, useVoice, join(outDir, rel));
    const dur = durationSec(join(outDir, rel));
    clips.push({
      id: lm.id, title: lm.name, audio: rel, durationSec: round(dur, 1),
      atMiles: round(lm.atMiles), startAtMiles: round(lm.startAtMiles),
      side: lm.side, category: lm.category, lat: lm.lat, lng: lm.lng, transcript: lm.script,
    });
    console.log(`  ${num} ${lm.id.padEnd(20)} ${lm.atMiles.toFixed(1).padStart(5)}mi ${lm.side.padEnd(5)} ${dur.toFixed(0)}s`);
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    voice: useVoice,
    route: { name: route.name, totalMiles: round(totalMiles), expectedSpeedMph: route.expectedSpeedMph, from: route.from, to: route.to },
    clips,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const errs = [];
  for (const c of clips) {
    if (!existsSync(join(outDir, c.audio))) errs.push(`missing ${c.audio}`);
    if (c.durationSec <= 3) errs.push(`too short: ${c.id}`);
  }
  for (let i = 1; i < clips.length; i++) if (clips[i].startAtMiles < clips[i - 1].startAtMiles) errs.push("not sorted");
  if (errs.length) throw new Error(`${id}: ${errs.join("; ")}`);

  return { id, label: data.label || route.name, name: route.name, dir: `routes/${id}`, totalMiles: round(totalMiles), stops: clips.length };
}

async function main() {
  const files = readdirSync(ROUTES_IN).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) throw new Error("no route files in content/routes/");
  const index = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(ROUTES_IN, f), "utf8"));
    index.push(await buildRoute(data, data.id || f.replace(/\.json$/, "")));
  }
  index.sort((a, b) => (a.id < b.id ? 1 : -1)); // to-work before to-home
  writeFileSync(join(PUB, "routes.json"), JSON.stringify(index, null, 2));
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\nOK: built ${index.length} route(s) -> public/routes.json`);
  for (const r of index) console.log(`  ${r.id.padEnd(10)} ${r.stops} stops, ${r.totalMiles} mi  (${r.name})`);
}

main().catch((e) => { console.error("BUILD ERROR:", e.message); process.exit(1); });
