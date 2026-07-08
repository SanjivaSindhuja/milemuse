// build-content.mjs - MileMuse content pipeline (multi-route + shared fillers).
// Reads content/routes/*.json and content/fillers.json, bakes each into
//   public/routes/<id>/{route.json, manifest.json, audio/<hash>.mp3}
//   public/fillers/{manifest.json, audio/<hash>.mp3}
// plus public/routes.json. Audio is content-hash-named, so rebuilds only
// re-synthesize NEW or CHANGED scripts (fast refresh). Also auto-bumps the
// service-worker cache version from a content hash.
// Run:  node scripts/build-content.mjs   (or: npm run build / npm run publish)

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bearingDeg, cumulativeMiles, snapToRoute, sideOfRoad } from "../public/geo.js";
import { osrmPolyline } from "./lib/routing.mjs";
import { audioName, synth, durationSec, voiceAvailable } from "./lib/tts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PUB = join(ROOT, "public");
const ROUTES_IN = join(ROOT, "content", "routes");
const FILLERS_IN = join(ROOT, "content", "fillers.json");

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const sha = (s) => createHash("sha256").update(s).digest("hex");
let synthCount = 0, cacheCount = 0;
const allText = []; // for the SW cache-version hash

function routeKey(r) { return `${r.from.lat},${r.from.lng}->${r.to.lat},${r.to.lng}`; }
async function getPolyline(id, route) {
  const cf = join(ROUTES_IN, ".cache", `${id}.polyline.json`);
  const key = routeKey(route);
  if (existsSync(cf)) {
    try {
      const c = JSON.parse(readFileSync(cf, "utf8"));
      if (c.key === key && c.polyline?.length) { console.log("  (cached route geometry)"); return c.polyline; }
    } catch {}
  }
  const poly = await osrmPolyline(route.from, route.to);
  mkdirSync(dirname(cf), { recursive: true });
  writeFileSync(cf, JSON.stringify({ key, polyline: poly }));
  return poly;
}

// Content-hash filename -> unchanged scripts keep the same file and are skipped.
function synthIfNeeded(text, voice, outPath) {
  if (existsSync(outPath)) { cacheCount++; return; }
  synth(text, voice, outPath); synthCount++;
}
function pruneAudio(dir, referenced) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (!referenced.has(f)) { try { rmSync(join(dir, f)); } catch {} }
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
  if (enriched.length) enriched[0].startAtMiles = 0; // opening clip plays at the very start

  const useVoice = voiceAvailable(voice) ? voice : voiceFallback;
  const referenced = new Set();
  const clips = enriched.map((lm) => {
    const rel = audioName(useVoice, lm.script);
    referenced.add(rel.split("/").pop());
    synthIfNeeded(lm.script, useVoice, join(outDir, rel));
    allText.push(lm.script);
    return {
      id: lm.id, title: lm.name, audio: rel, durationSec: round(durationSec(join(outDir, rel)), 1),
      atMiles: round(lm.atMiles), startAtMiles: round(lm.startAtMiles),
      side: lm.side, category: lm.category, lat: lm.lat, lng: lm.lng, transcript: lm.script,
    };
  });
  pruneAudio(audioDir, referenced);

  writeFileSync(join(outDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, voice: useVoice,
    route: { name: route.name, totalMiles: round(totalMiles), expectedSpeedMph: route.expectedSpeedMph, from: route.from, to: route.to },
    clips,
  }, null, 2));

  console.log(`  ${clips.length} stops (${clips.map((c) => c.atMiles).slice(0, 3).join(", ")}... mi)`);
  return { id, label: data.label || route.name, name: route.name, dir: `routes/${id}`, totalMiles: round(totalMiles), stops: clips.length };
}

function buildFillers() {
  if (!existsSync(FILLERS_IN)) return null;
  const data = JSON.parse(readFileSync(FILLERS_IN, "utf8"));
  const outDir = join(PUB, "fillers"), audioDir = join(outDir, "audio");
  mkdirSync(audioDir, { recursive: true });
  const useVoice = voiceAvailable(data.voice) ? data.voice : data.voiceFallback;
  const referenced = new Set();
  const clips = data.fillers.map((f) => {
    const rel = audioName(useVoice, f.script);
    referenced.add(rel.split("/").pop());
    synthIfNeeded(f.script, useVoice, join(outDir, rel));
    allText.push(f.script);
    return { id: f.id, title: f.title, audio: rel, durationSec: round(durationSec(join(outDir, rel)), 1), category: f.category, transcript: f.script };
  });
  pruneAudio(audioDir, referenced);
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ schemaVersion: 1, voice: useVoice, clips }, null, 2));
  console.log(`\n=== fillers ===\n  ${clips.length} anytime stories`);
  return { count: clips.length };
}

function bumpServiceWorker() {
  const v = "milemuse-" + sha(allText.join("\n")).slice(0, 8);
  const p = join(PUB, "sw.js");
  const s = readFileSync(p, "utf8").replace(/const CACHE = "[^"]*";/, `const CACHE = "${v}";`);
  writeFileSync(p, s);
  return v;
}

async function main() {
  const files = readdirSync(ROUTES_IN).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) throw new Error("no route files in content/routes/");
  const index = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(ROUTES_IN, f), "utf8"));
    index.push(await buildRoute(data, data.id || f.replace(/\.json$/, "")));
  }
  const fillers = buildFillers();
  index.sort((a, b) => (a.id < b.id ? 1 : -1)); // to-work before to-home
  writeFileSync(join(PUB, "routes.json"), JSON.stringify(index, null, 2));
  const swv = bumpServiceWorker();

  console.log(`\nOK: ${index.length} route(s) + ${fillers ? fillers.count : 0} fillers`);
  console.log(`  audio: ${synthCount} synthesized, ${cacheCount} reused from cache`);
  console.log(`  service worker cache -> ${swv}`);
}

main().catch((e) => { console.error("BUILD ERROR:", e.message); process.exit(1); });
