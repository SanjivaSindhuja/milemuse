// build-content.mjs - MileMuse content pipeline.
// landmarks.json -> OSRM route -> snap/side/startAtMiles -> edge-tts audio ->
// public/route.json + public/manifest.json + public/audio/NN.mp3
//
// Deps: none (Node 24 global fetch + child_process to python edge-tts + ffprobe).
// Run:  node scripts/build-content.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  bearingDeg,
  cumulativeMiles,
  snapToRoute,
  sideOfRoad,
} from "../public/geo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PUB = join(ROOT, "public");
const AUDIO = join(PUB, "audio");
const TMP = join(HERE, "tmp");

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

async function osrmPolyline(from, to) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes?.[0]) throw new Error(`OSRM: ${data.code}`);
  // GeoJSON coordinates are [lng, lat]
  return data.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
}

function voiceAvailable(voice) {
  try {
    const out = execFileSync("python", ["-m", "edge_tts", "--list-voices"], {
      encoding: "utf8",
    });
    return out.includes(voice);
  } catch {
    return false;
  }
}

function synth(text, voice, outPath) {
  mkdirSync(TMP, { recursive: true });
  const txt = join(TMP, "clip.txt");
  writeFileSync(txt, text, "utf8");
  execFileSync(
    "python",
    ["-m", "edge_tts", "--file", txt, "--voice", voice, "--write-media", outPath],
    { stdio: "pipe" }
  );
}

function durationSec(mp3) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_format", mp3],
    { encoding: "utf8" }
  );
  return parseFloat(JSON.parse(out).format.duration);
}

async function main() {
  const data = JSON.parse(readFileSync(join(ROOT, "content", "landmarks.json"), "utf8"));
  const { route, voice, voiceFallback, defaultLeadMiles, landmarks } = data;

  console.log(`Routing ${route.from.name} -> ${route.to.name} via OSRM...`);
  const polyline = await osrmPolyline(route.from, route.to);
  const cum = cumulativeMiles(polyline);
  const totalMiles = cum[cum.length - 1];
  console.log(`  polyline: ${polyline.length} pts, ${totalMiles.toFixed(1)} mi`);

  mkdirSync(PUB, { recursive: true });
  writeFileSync(
    join(PUB, "route.json"),
    JSON.stringify({ totalMiles: round(totalMiles), polyline })
  );

  // Enrich each landmark: snap to route, compute travel side + start point.
  const enriched = landmarks.map((lm) => {
    const p = { lat: lm.lat, lng: lm.lng };
    const snap = snapToRoute(polyline, cum, p);
    const seg = Math.min(snap.segIndex, polyline.length - 2);
    const heading = bearingDeg(polyline[seg], polyline[seg + 1]);
    const side = sideOfRoad(heading, snap.snapped, p);
    const lead = lm.leadMiles ?? defaultLeadMiles;
    return {
      ...lm,
      atMiles: snap.atMiles,
      offsetMiles: snap.offsetMiles,
      side,
      startAtMiles: Math.max(0, snap.atMiles - lead),
    };
  });
  enriched.sort((a, b) => a.startAtMiles - b.startAtMiles);

  const useVoice = voiceAvailable(voice) ? voice : voiceFallback;
  console.log(`Voice: ${useVoice}`);
  mkdirSync(AUDIO, { recursive: true });

  const clips = [];
  console.log(`\n  ##  id                  at(mi)  side   dur(s)`);
  for (let i = 0; i < enriched.length; i++) {
    const lm = enriched[i];
    const num = String(i + 1).padStart(2, "0");
    const rel = `audio/${num}.mp3`;
    const out = join(PUB, rel);
    synth(lm.script, useVoice, out);
    const dur = durationSec(out);
    clips.push({
      id: lm.id,
      title: lm.name,
      audio: rel,
      durationSec: round(dur, 1),
      atMiles: round(lm.atMiles),
      startAtMiles: round(lm.startAtMiles),
      side: lm.side,
      category: lm.category,
      lat: lm.lat,
      lng: lm.lng,
      transcript: lm.script,
    });
    console.log(
      `  ${num}  ${lm.id.padEnd(18)}  ${lm.atMiles.toFixed(1).padStart(5)}  ${lm.side.padEnd(5)}  ${dur.toFixed(1).padStart(5)}`
    );
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    voice: useVoice,
    route: {
      name: route.name,
      totalMiles: round(totalMiles),
      expectedSpeedMph: route.expectedSpeedMph,
      from: route.from,
      to: route.to,
    },
    clips,
  };
  writeFileSync(join(PUB, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Self-verify (CONTRACT step 8)
  const errs = [];
  for (const c of clips) {
    if (!existsSync(join(PUB, c.audio))) errs.push(`missing ${c.audio}`);
    if (c.durationSec <= 3) errs.push(`too short: ${c.id} (${c.durationSec}s)`);
    if (c.atMiles < 0 || c.atMiles > totalMiles + 0.5) errs.push(`atMiles OOR: ${c.id}`);
  }
  for (let i = 1; i < clips.length; i++) {
    if (clips[i].startAtMiles < clips[i - 1].startAtMiles) errs.push("clips not sorted");
  }
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}

  if (errs.length) {
    console.error(`\nFAILED:\n - ${errs.join("\n - ")}`);
    process.exit(1);
  }
  console.log(
    `\nOK: ${clips.length} clips, ${totalMiles.toFixed(1)} mi, voice ${useVoice}. ` +
      `Wrote public/manifest.json + public/route.json + public/audio/*.mp3`
  );
}

main().catch((e) => {
  console.error("BUILD ERROR:", e.message);
  process.exit(1);
});
