import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cumulativeMiles } from "../public/geo.js";
import { geocode } from "./lib/geocode.mjs";
import { osrmPolyline } from "./lib/routing.mjs";
import { harvestAlongRoute } from "./lib/pois.mjs";
import { geoSearch, fetchExtract } from "./lib/wikipedia.mjs";
import { overpassPois } from "./lib/osm.mjs";
import { generateScript } from "./lib/scriptgen.mjs";
import { synth, durationSec, audioName, voiceAvailable } from "./lib/tts.mjs";

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const VOICE = "en-US-AndrewNeural", VOICE_FB = "en-US-GuyNeural", LEAD = 0.15;

export async function buildRouteContent({ from, to, deps }) {
  const d = deps;
  const a = await d.geocode(from), b = await d.geocode(to);
  const polyline = await d.osrmPolyline(a, b);
  const cum = cumulativeMiles(polyline);
  const total = cum[cum.length - 1];
  const pois = await d.harvestAlongRoute(polyline, cum, {});

  const voice = voiceAvailable(VOICE) ? VOICE : VOICE_FB;
  const clips = [];
  for (let i = 0; i < pois.length; i++) {
    const poi = pois[i];
    const script = await d.generateScript(poi, poi.side, {});
    const rel = d.audioName(voice, script);
    d.synth(script, voice, join(d.outDir, rel));
    const startAtMiles = i === 0 ? 0 : Math.max(0, poi.atMiles - LEAD);
    clips.push({
      id: poi.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40),
      title: poi.name, audio: rel, durationSec: round(d.durationSec(join(d.outDir, rel)), 1),
      atMiles: round(poi.atMiles), startAtMiles: round(startAtMiles), side: poi.side,
      category: poi.category, lat: poi.lat, lng: poi.lng, transcript: script,
    });
  }
  clips.sort((x, y) => x.startAtMiles - y.startAtMiles);
  const manifest = {
    schemaVersion: 1, voice,
    route: { name: `${a.displayName.split(",")[0]} -> ${b.displayName.split(",")[0]}`, totalMiles: round(total),
      expectedSpeedMph: 45, from: { name: from, ...a }, to: { name: to, ...b } },
    clips,
  };
  const route = { totalMiles: round(total), polyline };
  mkdirSync(join(d.outDir, "audio"), { recursive: true });
  writeFileSync(join(d.outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(d.outDir, "route.json"), JSON.stringify(route));
  return { manifest, route };
}

// ---- CLI ----
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
async function main() {
  const from = arg("--from"), to = arg("--to");
  if (!from || !to) { console.error('usage: node scripts/generate-route.mjs --from "A" --to "B"'); process.exit(1); }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const HERE = dirname(fileURLToPath(import.meta.url));
  const slug = `${from}-${to}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const outDir = join(HERE, "..", "public", "routes", slug);

  const deps = {
    geocode, osrmPolyline,
    harvestAlongRoute: (poly, cum) => harvestAlongRoute(poly, cum, {
      wikiSearch: geoSearch, wikiExtract: fetchExtract, osmSearch: overpassPois,
    }),
    generateScript: (poi, side) => generateScript(poi, side, { client }),
    synth, durationSec, audioName, outDir,
  };
  console.log(`Generating ${from} -> ${to} ...`);
  const { manifest } = await buildRouteContent({ from, to, deps });
  console.log(`OK: ${manifest.clips.length} auto-generated stops -> public/routes/${slug}/`);

  // register in routes.json so the player picker shows it
  const rj = join(HERE, "..", "public", "routes.json");
  const idx = existsSync(rj) ? JSON.parse(readFileSync(rj, "utf8")) : [];
  if (!idx.find((r) => r.id === slug)) {
    idx.push({ id: slug, label: manifest.route.name, name: manifest.route.name, dir: `routes/${slug}`, totalMiles: manifest.route.totalMiles, stops: manifest.clips.length });
    writeFileSync(rj, JSON.stringify(idx, null, 2));
  }
}
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
