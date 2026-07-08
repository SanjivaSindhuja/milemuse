# MileMuse Phase 1 — Auto-Generated Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `node scripts/generate-route.mjs --from "Everett, WA" --to "410 Terry Ave N, Seattle"` produces a fully playable MileMuse route (route.json + manifest.json + audio) with **AI-generated, source-grounded** scripts — zero hand-authoring — that plays in the existing offline player.

**Architecture:** Extend the existing local Node pipeline. New library modules harvest points of interest from **live Wikipedia GeoSearch + OpenStreetMap Overpass** along the OSRM route, rank/dedupe/place them (reusing `public/geo.js`), generate witty **Claude**-written scripts grounded strictly on the harvested text, TTS them, and assemble the same manifest shape the player already consumes. Network clients are dependency-injected so everything is unit-testable offline.

**Tech Stack:** Node 24 (ESM, `node --test`), global `fetch`, `@anthropic-ai/sdk` (Claude Haiku), `python -m edge_tts` + `ffprobe` (dev TTS — Polly swap is Phase 2/4), OSRM + Nominatim + Wikipedia API + Overpass API.

## Global Constraints

- Node 24, ESM only (`"type":"module"` already set). Tests use built-in `node --test`.
- **No new heavy deps** beyond `@anthropic-ai/sdk`. Everything else via global `fetch` + existing python/ffprobe.
- **All network I/O is dependency-injected** (`{ fetch }`, `{ client }`) so unit tests run offline with mocks. Real network only in the CLI entrypoint and the final manual run.
- **Grounding is mandatory:** scripts are generated ONLY from harvested source text; the persona prompt forbids inventing facts. (Spec §10.)
- Manifest shape is **exactly** the player's: clips with `id,title,audio,durationSec,atMiles,startAtMiles,side,category,lat,lng,transcript`, sorted by `startAtMiles`, first clip `startAtMiles=0`. (Demo `build-content.mjs`.)
- Audio filenames are `audio/<sha256(voice+"\n"+script).slice(0,16)>.mp3` (matches existing dedup cache).
- LLM model: `claude-haiku-4-5-20251001` (configurable). TTS voice: `en-US-AndrewNeural` (fallback `en-US-GuyNeural`).
- Directional wording ("on your left/right") is computed via `geo.sideOfRoad` and passed to the LLM — never guessed by the model.

---

### Task 1: Factor shared helpers into `scripts/lib/`

**Files:**
- Create: `scripts/lib/routing.mjs`, `scripts/lib/tts.mjs`
- Modify: `scripts/build-content.mjs` (import the factored helpers instead of local copies)
- Test: `scripts/test/tts.test.mjs`

**Interfaces:**
- Produces:
  - `routing.osrmPolyline(from, to, {fetch?}) -> Promise<{lat,lng}[]>` (with 4× retry, as in build-content)
  - `tts.audioName(voice, text) -> "audio/<16hex>.mp3"`
  - `tts.synth(text, voice, outPath) -> void` (spawns `python -m edge_tts`)
  - `tts.durationSec(mp3Path) -> number` (spawns `ffprobe`)
  - `tts.voiceAvailable(voice) -> boolean`

- [ ] **Step 1: Write the failing test** — `scripts/test/tts.test.mjs`
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { audioName } from "../lib/tts.mjs";

test("audioName is deterministic and content-addressed", () => {
  const a = audioName("en-US-AndrewNeural", "hello world");
  const b = audioName("en-US-AndrewNeural", "hello world");
  const c = audioName("en-US-AndrewNeural", "different");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^audio\/[0-9a-f]{16}\.mp3$/);
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test scripts/test/tts.test.mjs`
Expected: FAIL — cannot find module `../lib/tts.mjs`.

- [ ] **Step 3: Create `scripts/lib/tts.mjs`** (move the existing functions verbatim from build-content.mjs)
```js
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

let _voices = null;
export function voiceAvailable(voice) {
  if (_voices === null) {
    try { _voices = execFileSync("python", ["-m", "edge_tts", "--list-voices"], { encoding: "utf8" }); }
    catch { _voices = ""; }
  }
  return _voices.includes(voice);
}
export function audioName(voice, text) {
  return "audio/" + createHash("sha256").update(voice + "\n" + text).digest("hex").slice(0, 16) + ".mp3";
}
export function synth(text, voice, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = join(dirname(outPath), ".clip.txt");
  writeFileSync(tmp, text, "utf8");
  execFileSync("python", ["-m", "edge_tts", "--file", tmp, "--voice", voice, "--write-media", outPath], { stdio: "pipe" });
}
export function durationSec(mp3) {
  const out = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", mp3], { encoding: "utf8" });
  return parseFloat(JSON.parse(out).format.duration);
}
```

- [ ] **Step 4: Create `scripts/lib/routing.mjs`** (move `osrmPolyline` verbatim from build-content.mjs, exported)
```js
export async function osrmPolyline(from, to, { fetch = globalThis.fetch } = {}) {
  const url = `https://router.project-osrm.org/route/v1/driving/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
      const data = await res.json();
      if (data.code !== "Ok" || !data.routes?.[0]) throw new Error(`OSRM: ${data.code}`);
      return data.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    } catch (e) { lastErr = e; if (attempt < 4) await new Promise((r) => setTimeout(r, 1500 * attempt)); }
  }
  throw lastErr;
}
```

- [ ] **Step 5: Update `build-content.mjs`** to import from lib (delete its local `osrmPolyline`, `voiceAvailable`, `synth`, `durationSec`, `audioName`; add `import { osrmPolyline } from "./lib/routing.mjs"; import { audioName, synth, durationSec, voiceAvailable } from "./lib/tts.mjs";`). Keep its `getPolyline` cache wrapper calling the imported `osrmPolyline`.

- [ ] **Step 6: Verify nothing broke**
Run: `node --test scripts/test/tts.test.mjs && node scripts/build-content.mjs`
Expected: test PASS; build prints `OK: 2 route(s) + 26 fillers` with `audio: 0 synthesized, 62 reused`.

- [ ] **Step 7: Commit**
```bash
git add scripts/lib/tts.mjs scripts/lib/routing.mjs scripts/build-content.mjs scripts/test/tts.test.mjs
git commit -m "refactor: factor tts+routing helpers into scripts/lib for reuse"
```

---

### Task 2: `geocode.mjs` — place name → coordinates

**Files:** Create `scripts/lib/geocode.mjs`; Test `scripts/test/geocode.test.mjs`

**Interfaces:** Produces `geocode(name, {fetch?}) -> Promise<{lat,lng,displayName}>`

- [ ] **Step 1: Failing test** — `scripts/test/geocode.test.mjs`
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { geocode } from "../lib/geocode.mjs";

const fakeFetch = async () => ({ ok: true, json: async () => ([{ lat: "47.979", lon: "-122.202", display_name: "Everett, WA" }]) });

test("geocode returns numeric lat/lng from Nominatim", async () => {
  const r = await geocode("Everett, WA", { fetch: fakeFetch });
  assert.equal(r.lat, 47.979);
  assert.equal(r.lng, -122.202);
  assert.equal(r.displayName, "Everett, WA");
});

test("geocode throws on empty result", async () => {
  await assert.rejects(() => geocode("zzzz", { fetch: async () => ({ ok: true, json: async () => [] }) }));
});
```

- [ ] **Step 2: Run — expect FAIL** (`node --test scripts/test/geocode.test.mjs`)

- [ ] **Step 3: Implement `scripts/lib/geocode.mjs`**
```js
export async function geocode(name, { fetch = globalThis.fetch } = {}) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { "User-Agent": "MileMuse/0.1 (dev; contact via github)" } });
  if (!res.ok) throw new Error(`geocode HTTP ${res.status}`);
  const arr = await res.json();
  if (!arr.length) throw new Error(`no geocode result for "${name}"`);
  return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), displayName: arr[0].display_name };
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `git add scripts/lib/geocode.mjs scripts/test/geocode.test.mjs && git commit -m "feat: Nominatim geocoding"`

---

### Task 3: `wikipedia.mjs` — GeoSearch + intro extract

**Files:** Create `scripts/lib/wikipedia.mjs`; Test `scripts/test/wikipedia.test.mjs`

**Interfaces:**
- `geoSearch(lat,lng,radiusM,{fetch?,limit?}) -> Promise<{pageid,title,lat,lng,distM}[]>`
- `fetchExtract(pageid,{fetch?,chars?}) -> Promise<string>`

- [ ] **Step 1: Failing test**
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { geoSearch, fetchExtract } from "../lib/wikipedia.mjs";

test("geoSearch maps results to {pageid,title,lat,lng,distM}", async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ query: { geosearch: [{ pageid: 5, title: "Gas Works Park", lat: 47.6, lon: -122.3, dist: 120 }] } }) });
  const r = await geoSearch(47.6, -122.3, 1000, { fetch });
  assert.deepEqual(r, [{ pageid: 5, title: "Gas Works Park", lat: 47.6, lng: -122.3, distM: 120 }]);
});

test("fetchExtract pulls the page extract", async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ query: { pages: { 5: { extract: "A public park." } } } }) });
  assert.equal(await fetchExtract(5, { fetch }), "A public park.");
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `scripts/lib/wikipedia.mjs`**
```js
export async function geoSearch(lat, lng, radiusM = 1000, { fetch = globalThis.fetch, limit = 20 } = {}) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=geosearch` +
    `&gscoord=${lat}%7C${lng}&gsradius=${radiusM}&gslimit=${limit}&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wiki geosearch HTTP ${res.status}`);
  const data = await res.json();
  return (data.query?.geosearch || []).map((g) => ({ pageid: g.pageid, title: g.title, lat: g.lat, lng: g.lon, distM: g.dist }));
}
export async function fetchExtract(pageid, { fetch = globalThis.fetch, chars = 900 } = {}) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1` +
    `&exchars=${chars}&pageids=${pageid}&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wiki extract HTTP ${res.status}`);
  const data = await res.json();
  return data.query?.pages?.[pageid]?.extract || "";
}
```
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat: Wikipedia geosearch + extract"`

---

### Task 4: `osm.mjs` — Overpass POIs near a point

**Files:** Create `scripts/lib/osm.mjs`; Test `scripts/test/osm.test.mjs`

**Interfaces:** `overpassPois(lat,lng,radiusM,{fetch?}) -> Promise<{name,lat,lng,category,tags}[]>` where category ∈ history|nature|quirky.

- [ ] **Step 1: Failing test**
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { overpassPois } from "../lib/osm.mjs";

test("overpassPois keeps only named nodes and maps category", async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ elements: [
    { lat: 1, lon: 2, tags: { name: "Old Fort", historic: "fort" } },
    { lat: 3, lon: 4, tags: { natural: "peak" } }, // no name -> dropped
    { lat: 5, lon: 6, tags: { name: "Big Tree", natural: "tree" } },
  ] }) });
  const r = await overpassPois(1, 2, 500, { fetch });
  assert.equal(r.length, 2);
  assert.equal(r[0].category, "history");
  assert.equal(r[1].category, "nature");
});
```
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `scripts/lib/osm.mjs`**
```js
export async function overpassPois(lat, lng, radiusM = 500, { fetch = globalThis.fetch } = {}) {
  const q = `[out:json][timeout:25];(` +
    `node(around:${radiusM},${lat},${lng})["historic"]["name"];` +
    `node(around:${radiusM},${lat},${lng})["tourism"]["name"];` +
    `node(around:${radiusM},${lat},${lng})["natural"]["name"];` +
    `);out body 30;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: q });
  if (!res.ok) throw new Error(`overpass HTTP ${res.status}`);
  const data = await res.json();
  return (data.elements || []).filter((e) => e.tags?.name).map((e) => ({
    name: e.tags.name, lat: e.lat, lng: e.lon,
    category: e.tags.historic ? "history" : e.tags.natural ? "nature" : "quirky",
    tags: e.tags,
  }));
}
```
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat: OSM Overpass POIs"`

---

### Task 5: `pois.mjs` — harvest, dedupe, rank, place along the route

**Files:** Create `scripts/lib/pois.mjs`; Test `scripts/test/pois.test.mjs`

**Interfaces:**
- Consumes: `geo.js` (`cumulativeMiles, snapToRoute, sideOfRoad, bearingDeg, haversineMiles`), and injected harvesters `{ wikiSearch, wikiExtract, osmSearch }`.
- Produces: `harvestAlongRoute(polyline, cum, opts) -> Promise<Poi[]>` where
  `Poi = { name, lat, lng, category, sourceText, sourceUrl, atMiles, side, offsetMiles }`, sorted by `atMiles`, deduped, one per ~`spacingMiles` slot.

- [ ] **Step 1: Failing test** (inject fake harvesters — no network)
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { cumulativeMiles } from "../../public/geo.js";
import { harvestAlongRoute } from "../lib/pois.mjs";

const line = [{ lat: 47.98, lng: -122.20 }, { lat: 47.90, lng: -122.22 }, { lat: 47.70, lng: -122.30 }];
const cum = cumulativeMiles(line);

test("harvest dedupes, grounds, and places POIs in mile order", async () => {
  const wikiSearch = async () => ([{ pageid: 1, title: "Boeing Factory", lat: 47.907, lng: -122.28, distM: 100 }]);
  const wikiExtract = async () => "The largest building in the world by volume.";
  const osmSearch = async () => ([{ name: "Boeing Factory", lat: 47.907, lng: -122.28, category: "history", tags: {} }]); // dup by name
  const pois = await harvestAlongRoute(line, cum, { wikiSearch, wikiExtract, osmSearch, spacingMiles: 2 });
  assert.ok(pois.length >= 1);
  assert.equal(pois[0].name, "Boeing Factory");
  assert.match(pois[0].sourceText, /largest building/);
  assert.ok(["left", "right"].includes(pois[0].side));
  for (let i = 1; i < pois.length; i++) assert.ok(pois[i].atMiles >= pois[i - 1].atMiles);
  // deduped: Boeing appears once
  assert.equal(pois.filter((p) => p.name === "Boeing Factory").length, 1);
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `scripts/lib/pois.mjs`**
```js
import { cumulativeMiles, snapToRoute, sideOfRoad, bearingDeg, haversineMiles } from "../../public/geo.js";

// Sample the route every ~spacingMiles, harvest POIs near each sample, dedupe,
// ground with Wikipedia extract, place along the route, and keep one per slot.
export async function harvestAlongRoute(polyline, cum, opts) {
  const { wikiSearch, wikiExtract, osmSearch, spacingMiles = 2, radiusM = 1600 } = opts;
  const total = cum[cum.length - 1];
  const seen = new Map(); // name(lowercased) -> poi (dedupe)

  for (let m = 0; m <= total; m += spacingMiles) {
    // find the vertex nearest mile m
    let vi = 1; while (vi < cum.length && cum[vi] < m) vi++;
    const p = polyline[Math.min(vi, polyline.length - 1)];
    const wiki = await wikiSearch(p.lat, p.lng, radiusM).catch(() => []);
    const osm = await osmSearch(p.lat, p.lng, Math.min(radiusM, 800)).catch(() => []);
    for (const w of wiki) {
      const key = w.title.toLowerCase();
      if (seen.has(key)) continue;
      const text = await wikiExtract(w.pageid).catch(() => "");
      if (text.length < 40) continue; // too thin to ground a story
      seen.set(key, { name: w.title, lat: w.lat, lng: w.lng, category: "history",
        sourceText: text, sourceUrl: `https://en.wikipedia.org/?curid=${w.pageid}`, _prom: text.length });
    }
    for (const o of osm) {
      const key = o.name.toLowerCase();
      if (seen.has(key)) continue; // Wikipedia wins on dupes
      seen.set(key, { name: o.name, lat: o.lat, lng: o.lng, category: o.category,
        sourceText: `${o.name} (${o.category}).`, sourceUrl: "https://www.openstreetmap.org/", _prom: 40 });
    }
  }

  // Place each POI on the route (atMiles + side), keep one per slot by prominence.
  const placed = [];
  for (const poi of seen.values()) {
    const snap = snapToRoute(polyline, cum, { lat: poi.lat, lng: poi.lng });
    if (snap.offsetMiles > 4) continue; // too far off the corridor
    const seg = Math.min(snap.segIndex, polyline.length - 2);
    const heading = bearingDeg(polyline[seg], polyline[seg + 1]);
    placed.push({ ...poi, atMiles: snap.atMiles, offsetMiles: snap.offsetMiles,
      side: sideOfRoad(heading, snap.snapped, { lat: poi.lat, lng: poi.lng }) });
  }
  placed.sort((a, b) => a.atMiles - b.atMiles);

  // Thin to one per slot: greedily keep the most prominent within each spacing window.
  const kept = [];
  for (const poi of placed) {
    const last = kept[kept.length - 1];
    if (last && poi.atMiles - last.atMiles < spacingMiles * 0.6) {
      if (poi._prom > last._prom) kept[kept.length - 1] = poi; // swap in the better one
      continue;
    }
    kept.push(poi);
  }
  return kept.map(({ _prom, ...p }) => p);
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat: POI harvest + placement along route"`

---

### Task 6: `scriptgen.mjs` — grounded Claude script generation

**Files:** Create `scripts/lib/scriptgen.mjs`; Test `scripts/test/scriptgen.test.mjs`

**Interfaces:**
- `buildPrompt(poi, side) -> string`
- `generateScript(poi, side, {client, model?}) -> Promise<string>` (client = an object with `messages.create(...)`, injectable)

- [ ] **Step 1: Failing test** (mock the Anthropic client)
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, generateScript } from "../lib/scriptgen.mjs";

const poi = { name: "Gas Works Park", side: "left", sourceText: "A public park on Lake Union built on a former gasification plant." };

test("buildPrompt grounds on source text, forbids invention, includes side", () => {
  const p = buildPrompt(poi, "left");
  assert.match(p, /Gas Works Park/);
  assert.match(p, /former gasification plant/);
  assert.match(p, /on your left/i);
  assert.match(p, /do not invent/i);
});

test("generateScript returns the model's text", async () => {
  const client = { messages: { create: async () => ({ content: [{ type: "text", text: "On your left, that's Gas Works Park..." }] }) } };
  const out = await generateScript(poi, "left", { client });
  assert.match(out, /Gas Works Park/);
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `scripts/lib/scriptgen.mjs`**
```js
export const PERSONA = "You are a witty, warm, well-read local friend riding shotgun on a road trip, narrating the places you pass. Casual, funny, and concise. Everything you write is spoken aloud to a driver: no markdown, no emojis, no stage directions, no lists. Around 70-100 words.";

export function buildPrompt(poi, side) {
  return [
    `Write a short spoken snippet (about 70-100 words) about this place for a driver passing by.`,
    `Ground it ONLY in the facts below. Do not invent names, dates, numbers, or details that are not present. If the facts are thin, keep it atmospheric rather than making things up.`,
    `Naturally mention that it's "on your ${side}". End on a clean sentence.`,
    ``,
    `PLACE: ${poi.name}`,
    `FACTS:`,
    poi.sourceText,
  ].join("\n");
}

export async function generateScript(poi, side, { client, model = "claude-haiku-4-5-20251001" }) {
  const msg = await client.messages.create({
    model, max_tokens: 400, system: PERSONA,
    messages: [{ role: "user", content: buildPrompt(poi, side) }],
  });
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  if (!text) throw new Error(`empty script for ${poi.name}`);
  return text;
}
```
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat: grounded Claude script generation"`

---

### Task 7: `generate-route.mjs` — CLI orchestrator + integration test

**Files:** Create `scripts/generate-route.mjs`; Test `scripts/test/generate-route.test.mjs`; Modify `package.json` (add `"generate": "node scripts/generate-route.mjs"`)

**Interfaces:**
- Consumes: all lib modules above + `tts` + `geo`.
- Produces (exported for testability): `buildRouteContent({ from, to, deps }) -> Promise<{ manifest, route }>` where `deps = { geocode, osrmPolyline, harvestAlongRoute, generateScript, synth, durationSec, audioName, outDir }`. The CLI wires real deps around it.

- [ ] **Step 1: Failing integration test** (all deps mocked — no network, no TTS)
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRouteContent } from "../generate-route.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("buildRouteContent assembles a valid manifest from mocked deps", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "mm-"));
  const line = [{ lat: 47.98, lng: -122.20 }, { lat: 47.70, lng: -122.33 }];
  const deps = {
    geocode: async (n) => ({ lat: n.includes("Everett") ? 47.98 : 47.70, lng: n.includes("Everett") ? -122.20 : -122.33, displayName: n }),
    osrmPolyline: async () => line,
    harvestAlongRoute: async () => ([
      { name: "Boeing Factory", lat: 47.907, lng: -122.28, category: "history", sourceText: "Big building.", sourceUrl: "u", atMiles: 5, side: "right", offsetMiles: 2 },
    ]),
    generateScript: async (poi, side) => `On your ${side}, ${poi.name}.`,
    synth: () => {}, durationSec: () => 42.0, audioName: () => "audio/deadbeefdeadbeef.mp3",
    outDir,
  };
  const { manifest } = await buildRouteContent({ from: "Everett, WA", to: "Seattle, WA", deps });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.clips[0].startAtMiles, 0);
  assert.match(manifest.clips[0].transcript, /Boeing Factory/);
  for (const c of manifest.clips) assert.ok("side" in c && "atMiles" in c && "audio" in c);
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `scripts/generate-route.mjs`**
```js
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
```

- [ ] **Step 4: Run — expect PASS** (`node --test scripts/test/generate-route.test.mjs`)
- [ ] **Step 5: Add dep + npm script**
```bash
npm install @anthropic-ai/sdk
```
Add to `package.json` scripts: `"generate": "node scripts/generate-route.mjs"`.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: generate-route CLI (auto-generated route end-to-end)"`

---

### Task 8: Real end-to-end run + play it (manual verification)

**Files:** none (verification task). Requires `ANTHROPIC_API_KEY` in env + internet.

- [ ] **Step 1: Run the full suite** — `node --test scripts/` → all green.
- [ ] **Step 2: Generate a real, never-hand-authored route**
```bash
export ANTHROPIC_API_KEY=sk-...
node scripts/generate-route.mjs --from "Everett, WA" --to "Leavenworth, WA"
```
Expected: `OK: N auto-generated stops -> public/routes/everett-wa-leavenworth-wa/`, plus a new entry in `routes.json`.
- [ ] **Step 3: Review content quality** — open `public/routes/<slug>/manifest.json`; read 3-4 transcripts. Confirm: witty tone, facts match the source (no obvious invention), directional cue present, ~70-100 words.
- [ ] **Step 4: Play it** — `python -m http.server 8080 --directory public`, open `http://localhost:8080/`, pick the new route in the picker, run **Simulate → fast preview**, confirm clips fire in order with correct sides and audio plays.
- [ ] **Step 5: Commit the generated route** (optional demo artifact) — `git add public/routes public/routes.json && git commit -m "content: first fully auto-generated route (Everett->Leavenworth)"`

**Phase 1 done when:** an arbitrary `--from/--to` produces a playable, source-grounded, witty route with zero hand-authoring — proving the generate-cache-serve model before we move it server-side (Phase 2).

---

## Self-Review

- **Spec coverage:** Phase 1 = spec §6.1 ("auto-route generation, prove it") — Tasks 2-8 cover geocode→route→harvest(Wikipedia+OSM, spec §2.1)→grounded generation(§10)→TTS→manifest(§3). POI cache/dedup (§2.2) is the `seen`-map + prominence swap in Task 5. Cloud/API/pools/freshness are explicitly **out of scope** (Phase 2-3). ✅
- **Placeholder scan:** every code step has complete, runnable code; every test has real assertions; no TBD/"handle errors" hand-waves. ✅
- **Type consistency:** `Poi` shape (`name,lat,lng,category,sourceText,sourceUrl,atMiles,side,offsetMiles`) is produced by Task 5 and consumed unchanged by Tasks 6-7; `audioName/synth/durationSec` signatures match Task 1; injected-deps names in Task 7's `buildRouteContent` match its test. ✅
