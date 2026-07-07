# MileMuse Build Contract (Everett -> Seattle demo)

This is the exact, binding spec for the two parallel build sessions. Follow it precisely.
Owner (orchestrator) provides `public/geo.js` and `content/landmarks.json` (READ-ONLY - do not edit).
The site in `public/` is deployed to **GitHub Pages under a subpath**, so **every web asset path MUST be
relative** (`./foo`), never absolute (`/foo`).

---

## Canonical data schemas

### `public/route.json` (written by Session A, read by Session B)
```json
{
  "totalMiles": 28.4,
  "polyline": [ { "lat": 47.979, "lng": -122.202 }, { "lat": 47.978, "lng": -122.203 } ]
}
```

### `public/manifest.json` (written by Session A, read by Session B)
```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-07T05:00:00Z",
  "voice": "en-US-AndrewNeural",
  "route": {
    "name": "Everett -> Seattle",
    "totalMiles": 28.4,
    "expectedSpeedMph": 45,
    "from": { "name": "Everett, WA", "lat": 47.979, "lng": -122.202 },
    "to": { "name": "Downtown Seattle, WA", "lat": 47.606, "lng": -122.332 }
  },
  "clips": [
    {
      "id": "everett-welcome",
      "title": "Welcome to Everett",
      "audio": "audio/01.mp3",
      "durationSec": 41.2,
      "atMiles": 0.0,
      "startAtMiles": 0.0,
      "side": "right",
      "category": "history",
      "lat": 47.979,
      "lng": -122.202,
      "transcript": "Alright - Everett...."
    }
  ]
}
```
- `clips` MUST be sorted ascending by `startAtMiles`.
- `audio` files are zero-padded in play order: `audio/01.mp3`, `audio/02.mp3`, ... matching clip order.
- `side` is `"left"` or `"right"` (from `geo.sideOfRoad`).

---

## `public/geo.js` API (owner-provided, used by BOTH sides)
```
haversineMiles(a, b) -> miles                 // a,b = {lat,lng}
bearingDeg(from, to) -> 0..360
cumulativeMiles(polyline) -> number[]          // polyline = [{lat,lng}], [0]=0
snapToRoute(polyline, cum, p) -> { atMiles, snapped:{lat,lng}, segIndex, offsetMiles }
sideOfRoad(headingDeg, from, poi) -> 'left'|'right'
```

---

## SESSION A - Content pipeline
**Owns / may create:** `scripts/build-content.mjs`, `scripts/*.test.mjs`, and OUTPUTS `public/manifest.json`,
`public/route.json`, `public/audio/*.mp3`. **Do NOT create/edit any `public/*.html/.css` or `public/app.js`,
`public/sw.js`, `public/app.webmanifest`.**

`node scripts/build-content.mjs` must, end to end:
1. Read `content/landmarks.json`. Import helpers from `../public/geo.js`.
2. **Route:** fetch the OSRM driving route between `route.from` and `route.to`:
   `https://router.project-osrm.org/route/v1/driving/{fromLng},{fromLat};{toLng},{toLat}?overview=full&geometries=geojson`
   (Node 24 has global `fetch`.) `routes[0].geometry.coordinates` is `[[lng,lat],...]` - convert to
   `[{lat,lng}]`. This is the polyline. Compute `cum = cumulativeMiles(polyline)`, `totalMiles = last(cum)`.
   Write `public/route.json`.
3. **Per landmark:** `snap = snapToRoute(polyline, cum, {lat,lng})` -> `atMiles`. Heading at the snapped
   segment = `bearingDeg(polyline[snap.segIndex], polyline[snap.segIndex+1])`. `side = sideOfRoad(heading,
   snap.snapped, {lat,lng})`. `startAtMiles = max(0, atMiles - (landmark.leadMiles ?? defaultLeadMiles))`.
4. **Sort** landmarks by `startAtMiles` ascending; that ordering fixes the `audio/NN.mp3` numbering.
5. **TTS (edge-tts, free, no key):** for each clip, write its `script` text to a temp UTF-8 file and run:
   `python -m edge_tts --file <tmp.txt> --voice <route voice> --write-media public/audio/NN.mp3`
   (edge-tts is installed, v7.2.8). If the primary voice errors, retry with `voiceFallback`. Verify the
   voice exists first via `python -m edge_tts --list-voices`.
6. **Duration:** `ffprobe -v quiet -print_format json -show_format public/audio/NN.mp3` -> `format.duration`
   (seconds, float). Put into `durationSec`.
7. **Assemble** `public/manifest.json` per schema above (include transcript = the script text).
8. **Self-verify:** re-read manifest; assert every clip has an existing audio file with `durationSec > 3`,
   clips sorted by `startAtMiles`, and `atMiles` within `[0, totalMiles]`. Print a summary table
   (id | atMiles | side | durationSec). Write a `scripts/build-content.test.mjs` that unit-tests at least
   the geo wiring (e.g. a known polyline + point -> expected side) using `node --test`.

Design for scale/extensibility: the pipeline reads ALL landmarks from JSON (no hardcoded Everett logic),
so a different `landmarks.json` / route "just works". Note that in `RESULT.md`.

---

## SESSION B - GPS web player (the app)
**Owns / may create:** `public/index.html`, `public/app.js`, `public/styles.css`, `public/sw.js`,
`public/app.webmanifest`, `public/icon.svg` (+ optional `public/apple-touch-icon.png`). **Do NOT touch
`public/geo.js`, `public/manifest.json`, `public/route.json`, `public/audio/*`, or anything in `scripts/`
or `content/`.** Those are produced by owner/Session A; assume they match the schema above (you can commit
a tiny stub `manifest.json`? NO - do not create it; code defensively if it's missing during your local
test, e.g. fall back to an empty clip list with a friendly message).

Build a mobile-first, driving-safe, **accessible** single-page app:

**Loading / gestures (iOS-critical):**
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`,
  `apple-mobile-web-app-capable`, a `theme-color`.
- A big primary **"Start drive"** button and a secondary **"Simulate drive (test)"** button.
- iOS blocks audio until a user gesture. Use ONE reused `<audio id="player">` element; on the Start tap,
  unlock it (call `.play()` then `.pause()` on a short silent clip, or just play clip 1), THEN start
  `navigator.geolocation.watchPosition(...)`. All later clips reuse the SAME element (set `.src`,`.play()`).
- Request a **screen wake lock** (`navigator.wakeLock.request('screen')`) inside the Start handler and
  re-acquire on `visibilitychange`. Show a one-line hint: "Keep this tab open, screen on, phone mounted."

**Engine (import from `./geo.js`):**
- Fetch `./manifest.json` and `./route.json` (RELATIVE paths).
- `const cum = cumulativeMiles(route.polyline)`.
- On each position `{lat,lng}` (from real GPS OR the simulator): `const s = snapToRoute(route.polyline, cum,
  {lat,lng}); currentMiles = s.atMiles; offRoute = s.offsetMiles > 0.25`.
- Play clips **in order, back-to-back, never double**: keep `nextIndex`. When the audio is idle and
  `clips[nextIndex].startAtMiles <= currentMiles`, play `clips[nextIndex]` (set src to `./` + clip.audio),
  mark played, `nextIndex++`. On `ended`, immediately play the next clip if it's already due (gap-free).
- Assume forward travel (miles increasing = southbound). It's fine if it degrades gracefully otherwise.
- Off route: show a small banner "Off the planned route"; keep the current clip, don't crash.

**Now-playing UI:** category chip, a clear **side indicator** (a left/right arrow that lights up per
`clip.side`), the clip **title**, the scrolling **transcript**, play/pause + skip buttons, a **progress
bar** (`currentMiles/totalMiles`, "clip X of N"), and an **upcoming** list (next 2-3 titles + their mile
marks). Large tap targets (>=44px), min 18px text, high contrast dark theme, `aria-label`s on all
controls, respect `prefers-reduced-motion`.

**Simulate mode (this is how it gets TESTED without driving):** an overlay that advances `currentMiles`
from 0 to `totalMiles` through the SAME engine. Provide: a **speed control** - a realistic **"~40 min
drive"** default (advance so the whole route takes ~40 min, i.e. mimic stop-and-go), plus a **"fast
preview"** (~2 min) and a **scrubber** to jump. Show the simulated position on a tiny inline route sketch
(SVG polyline + a moving dot) if easy; otherwise just the progress bar. Simulate must exercise real audio
playback so clips are actually heard.

**PWA / offline:** `app.webmanifest` (name "MileMuse", `start_url":"./"`, `display":"standalone"`, colors,
an `icon.svg` + optional 180x180 apple-touch-icon). `sw.js`: on install, fetch `./manifest.json`, then
cache-first ALL core assets (`./`, `./index.html`, `./app.js`, `./styles.css`, `./geo.js`,
`./manifest.json`, `./route.json`) **plus every `clip.audio`** so the drive works with no signal. Register
with `navigator.serviceWorker.register('./sw.js', { scope: './' })`.

Design for scale/extensibility: the app is 100% manifest-driven (no Everett-specific hardcoding); a new
route's manifest+audio makes it a different tour with zero code change. Note that in `RESULT.md`.

**Local self-test:** serve `public/` (`python -m http.server 8080` from `public/`) and load it; run Simulate
"fast preview" and confirm clips play in order with correct side. (Owner does the authoritative QA.)
