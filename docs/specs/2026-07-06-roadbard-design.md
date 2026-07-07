# Roadbard — Offline AI Travel Narration

**Design spec** · Date: 2026-07-06 · Status: Approved (brainstorm) → ready for implementation plan
**Working name:** Roadbard (placeholder, renameable)

---

## 1. Summary

Roadbard is a road-trip companion that talks to you the whole drive — telling you about the
places you pass, in the voice of a witty, well-read friend in the passenger seat. It is built as
**two pieces**:

- **The Baker** — runs on your laptop at home (on WiFi). You give it a route (any start, end, and
  waypoints). It harvests points of interest along the whole corridor, writes narration scripts,
  turns them into speech, and assembles a single **offline package**.
- **The Player** — an app on your phone that plays that package by GPS while you drive. It never
  touches the internet, so it cannot fail when you lose signal.

The defining property: **it is never silent, and it never streams.** Everything is pre-generated at
home, so the entire trip plays flawlessly through the dead zones where cell service disappears —
exactly where every existing app breaks.

```
┌─ AT HOME (WiFi, best AI) ───────────────────┐      ┌─ IN THE CAR (no internet, ever) ─┐
│  Baker (Node/TypeScript CLI)                │      │  Player (Expo app)               │
│                                             │      │                                  │
│  route → sample corridor → harvest POIs     │  ⇒   │  GPS ─▶ snap to route ─▶ play     │
│    → curate & sequence → witty AI scripts   │ 📦   │        next clip, back-to-back   │
│    → text-to-speech → offline package       │      │        (heading ⇒ left/right)    │
└─────────────────────────────────────────────┘      └──────────────────────────────────┘
```

---

## 2. Problem & market gap

Research (competitive survey, Jul 2026, verified) found the space is real but nobody ships the
combination this product targets. Four properties, and **no existing app has all four**:

| Property | Autio (market leader) | GuideAlong / Shaka / Action | AI newcomers (Roadguide, Summer AI, Votura, Roadtrip Buddy) |
|---|---|---|---|
| **1. Talks the whole drive** | ✅ only one | ❌ only *inside* the park | ⚠️ some |
| **2. Never silent** | ❌ real gaps; even tells you to play your own podcast | ❌ silent between destinations | ⚠️ |
| **3. Bulletproof offline** | ⚠️ story-by-story; #1 complaint is it *won't play* off-grid | ✅ solid | ❌ **cloud-only — dies in dead zones** |
| **4. Directional ("on your left")** | ❌ | ❌ | ❌ |
| Content | human pre-recorded, subscription | human pre-recorded, per-tour | AI-generated, online |

**The empty intersection is the wedge:** never-silent **+** directional **+** guaranteed-offline **+**
fresh AI content. The offline champs lack 1/2/4; the AI apps lack the one that matters most for
rural road trips (3). Verification specifically corrected the claim that Autio is "continuous" — it
is POI-triggered with documented silent stretches, and its top user complaint is failure to play
without a connection.

**Why offline is the crux:** on a representative route (e.g. Seattle→Glacier via US-2), coverage
dies at Stevens Pass, across the Idaho Panhandle, and through most of Glacier itself; the NPS
explicitly advises downloading everything *before* arriving. A design that has **no network code on
the road** turns the hardest problem in the category into a non-problem.

---

## 3. Goals & non-goals

**Goals (MVP)**
- Generate a complete, never-silent narration package for **any driving route** (arbitrary start,
  end, and multiple waypoints), anywhere content data exists (US-wide via Wikipedia/OSM).
- Play it back on iPhone **or** Android, **fully offline**, triggered by GPS.
- Narration hands off topic every **1–5 minutes**, back-to-back, never silent.
- **Directional awareness** — "coming up on your left…" — from travel heading + POI side of road.
- Voice = **witty local friend**; content priority **history → nature → quirky → practical**.

**Non-goals (explicitly deferred — YAGNI)**
- Live/on-the-fly generation while driving (Phase "later"; the Hybrid mode).
- On-device LLM (not good enough on phones in 2026).
- Accounts, multi-user, marketplace, sharing packages (grow-later).
- Turn-by-turn navigation (we are a *narrator*, not a nav app; we ride alongside one).
- Full offline *map* rendering / tiles (Player shows a minimal position dot, not a nav map).
- International content quality guarantees (US-first).
- Monetization.

---

## 4. Users & scope

**Primary user (now):** the builder, on personal road trips. **Design intent (later):** the content
pipeline and package format are built route-agnostic and reusable so this can grow into a product
for other travelers without a rewrite.

"Start personal, grow later": we ship the magic for real trips first, but no route-specific or
single-user assumptions leak into the architecture.

---

## 5. Key product decisions (the dials)

| Dial | Decision |
|---|---|
| Cadence | Always-on; topic hands off every **1–5 min**, clips run ~**30–90 s** each, back-to-back. |
| Spacing model | **Along-route distance**, not radius geofences (see §7). |
| Directional | Yes — heading + side-of-road computed in the Baker, baked into the script text. |
| Content types | History, Nature, Quirky/roadside, Practical — **in that priority order**. |
| Voice persona | **Witty local friend** (casual, funny, well-read passenger). |
| Offline | **Absolute** — the Player has zero network code. |
| Route input | **Any** origin/destination + **N waypoints**, entered by place name. |
| Platforms | iPhone + Android via **Expo (React Native)**; Player runs foreground, screen kept awake. |

---

## 6. System architecture

Two independently-buildable components communicating through one well-defined artifact — the
**offline package**. Neither component knows the other's internals; the package schema is the
contract.

- **Baker** (online, laptop): pure "route in → package out." No mobile concerns.
- **Package** (§11): a self-contained folder — manifest + audio + route geometry.
- **Player** (offline, phone): pure "package + GPS → audio out." No content-generation concerns.

Shared: a single TypeScript type definition of the package schema, imported by both, so the
contract is enforced at compile time on both sides.

---

## 7. The Baker — pipeline

A Node/TypeScript CLI. Each stage consumes the previous stage's output; stages are independently
testable.

1. **Route input & geocoding.** Accept a list of stops by place name (`--from`, `--to`,
   `--via` repeatable): e.g. *Seattle → Leavenworth → Glacier* or *Seattle → Spokane → Glacier*.
   Geocode names → coordinates (Nominatim or Mapbox Geocoding). **Output:** ordered coordinate list.

2. **Routing.** Fetch the road polyline through all waypoints in order (OSRM public server or Mapbox
   Directions — both accept waypoints natively). **Output:** dense ordered `[lat,lng]` polyline +
   total distance + per-vertex cumulative mileage.

3. **Corridor sampling.** Walk the polyline and drop a content **slot** roughly every ~1 mile
   (tunable to hit the 1–5 min cadence at expected highway speed). At each slot compute the local
   **heading** (bearing between adjacent vertices). **Output:** ordered slots, each with
   `{ atMiles, lat, lng, headingDeg }`.

4. **POI harvest.** For each stretch, query:
   - **Wikipedia GeoSearch** (`API:Geosearch`) — articles near a coordinate within a radius, plus
     the article extract as grounding text.
   - **OpenStreetMap Overpass** — features tagged `historic=*`, `natural=*`, `tourism=*`,
     `amenity=*`, etc.
   For each POI capture `{ name, lat, lng, category, sourceText, sourceUrl }`. Compute **side of
   road** (left/right, via the sign of the cross product of the heading vector and the
   vector-to-POI) and approximate distance/offset from the route. **Output:** candidate POIs keyed
   to route mileage, annotated with side + distance.

5. **Curate & sequence.** Dedupe (same place from multiple sources); rank by **content priority**
   (history → nature → quirky → practical), prominence (e.g. Wikipedia article length/links), and
   proximity; assign POIs to slots spaced for the 1–5 min cadence with **no overlap**. **Continuity
   guarantee:** where a stretch is POI-sparse (rural), fall back to **bigger-picture stories** — the
   mountain range, the county's history, the highway/railroad itself, the ecoregion. This
   *hierarchical* fallback (landmark → corridor → region) is what keeps any route from going silent
   and is a **core feature, not a nice-to-have**. **Output:** an ordered, gap-free playlist of
   `{ atMiles, side, category, poi | regionTopic }` entries.

6. **Script generation.** For each playlist entry, Claude writes a **~30–90 s** script (~80–220
   words) as the **witty local friend**, **grounded strictly on the harvested `sourceText`** (RAG
   style — the model is instructed to use only provided facts and, if unsure, stay vague or skip
   rather than invent). The directional cue ("in about a mile, on your left…") is composed from the
   side + distance computed in step 4. **Output:** script text per entry.

7. **Text-to-speech.** Feed each script to a characterful cloud TTS (**default ElevenLabs**;
   pluggable) → one audio clip per entry. One-time, at home, so quality > cost. **Output:** audio
   files + measured durations.

8. **Assemble package.** Write `manifest.json` (triggers + metadata), `/audio/*.mp3`, and
   `route.json` (polyline). This folder is the deliverable (§11).

---

## 8. The trigger model (the clever bit)

**Do not** use naive radius geofences — adjacent circles overlap (two clips fire at once) and leave
gaps (silence between circles). Instead:

- Each clip carries **`startAtMiles`** — the along-route distance at which playback should *begin*,
  computed so the clip *finishes* right as you pass the place (using an expected speed for lead
  time).
- The Player continuously **snaps raw GPS onto the route polyline** → a single scalar: **current
  along-route distance**. It plays clips **in order, back-to-back**, starting each when its
  `startAtMiles` is reached.

This makes the experience robust to real driving:

| Situation | Behaviour |
|---|---|
| Slower than expected | Clips simply wait; queue follows your true position. |
| Faster than expected | Clips queue and play back-to-back; never silent. |
| Stopped (gas, food) | Position frozen → current clip finishes, then holds until you move. |
| Brief GPS loss (tunnel) | Along-route distance holds/extrapolates; resumes on re-lock (GPS, not network). |
| Off-route | Large deviation from polyline detected → v1: pause + gentle "we've left the planned route," resume on rejoin. |

Directional accuracy comes for free: the "left/right" is already in the clip text, and the clip is
timed to land as you reach the place.

---

## 9. Content & continuity strategy

- **Priority ordering** (history → nature → quirky → practical) governs both *selection* (when
  several POIs compete for a slot) and *tone* emphasis.
- **Never-silent guarantee** via the hierarchical fallback in §7.5: landmark stories where POIs are
  dense; corridor/region stories where they are sparse. The Baker verifies the final playlist has
  **no gap longer than a threshold** at expected speed and fills any that remain with region topics.
- **Anti-repetition:** a place used once is not reused later on the same route.

---

## 10. Grounding / anti-hallucination

The research's central finding: vague or wrong narration comes from vague source docs, not model
limits. Therefore:

- Scripts are generated **only** from harvested `sourceText` (Wikipedia extract / OSM tags / curated
  region facts), passed to the model as explicit context.
- The system prompt forbids inventing facts, dates, or names not present in the source; when unsure,
  the model keeps it atmospheric or defers to the next place.
- Each clip retains its `sourceUrl`(s) in the manifest for spot-checking during the Baker review
  step.

---

## 11. Offline package format

A self-contained folder (zippable), sideloaded to the phone over WiFi/USB for v1:

```
<route-name>/
  manifest.json
  route.json            # { polyline: [[lat,lng], ...], totalMiles }
  audio/
    0001.mp3
    0002.mp3
    ...
```

`manifest.json` (schema sketch):

```jsonc
{
  "schemaVersion": 1,
  "route": { "name": "Seattle → Leavenworth → Glacier", "totalMiles": 512.3,
             "waypoints": ["Seattle, WA", "Leavenworth, WA", "Glacier NP, MT"] },
  "expectedSpeedMph": 65,           // used to time startAtMiles lead-in
  "clips": [
    {
      "id": "0001",
      "audio": "audio/0001.mp3",
      "durationSec": 62.4,
      "startAtMiles": 3.10,          // begin playback here (along route)
      "poi": { "name": "Gas Works Park", "lat": 47.6456, "lng": -122.3344 },
      "side": "left",                // left | right | ahead
      "category": "history",         // history | nature | quirky | practical | region
      "transcript": "…",
      "sources": ["https://en.wikipedia.org/wiki/Gas_Works_Park"]
    }
    // … ordered by startAtMiles, gap-free
  ]
}
```

The shared TypeScript type mirroring this schema is the compile-time contract between Baker and
Player.

---

## 12. The Player (Expo, 100% offline)

- **Stack:** Expo (React Native + TypeScript). `expo-location` (GPS), `expo-audio` (playback),
  `expo-keep-awake` (mounted + charging), `expo-file-system` (load package from storage). Built for
  iOS + Android via EAS cloud builds (works from a Windows dev machine).
- **Runtime model:** runs **foreground with screen awake** (phone is car-mounted) — deliberately
  sidesteps iOS's strict background-GPS/audio limits for v1.
- **Playback engine:** snap GPS → along-route distance; maintain an ordered clip queue; start each
  clip at its `startAtMiles`; play back-to-back; handle stop/hold, off-route pause, skip.
- **UI (driving-safe, audio-first):** one large "now playing" card — title, category icon, and a
  **minimal dot** on the route line showing where you are and what's coming — plus play/pause/skip.
  No fiddly interaction, no full map.
- **Offline guarantee:** the app contains **no network calls**. Nothing *can* try to stream.

---

## 13. Tech stack & external services

| Concern | Choice | Notes |
|---|---|---|
| Baker runtime | Node.js + TypeScript CLI | runs on the Windows laptop |
| Geocoding | Nominatim (free) or Mapbox | name → coords |
| Routing | OSRM (free public) or Mapbox Directions | waypoints native |
| POI + grounding | **Wikipedia GeoSearch** + **OSM Overpass** (both free) | avoid Google Places — its $200/mo free credit ended Feb 2025; ~$275/mo at scale |
| Script LLM | **Claude** (latest) | witty persona + strict grounding |
| TTS | **ElevenLabs** (default, pluggable) | one-time at home; quality over cost |
| Player | **Expo (React Native)** + EAS builds | iOS + Android from Windows |
| Shared | TS package-schema types | compile-time contract |

Cost is a **home-time, one-time-per-route** expense (LLM tokens + TTS characters + free map APIs),
not a per-user runtime cost — a direct benefit of the bake-at-home architecture.

---

## 14. Data sources & licensing

- **Wikipedia / Wikivoyage** — free API; content is CC BY-SA (attribution retained via `sources`).
- **OpenStreetMap / Overpass** — free (rate-limited); ODbL (attribution retained).
- **Deliberately avoided:** Google Places (cost), Atlas Obscura & HMdb.org (no official API →
  scraping/ToS risk). Revisit as licensed sources later if content depth demands it.

---

## 15. Edge cases & error handling

| Case | Handling |
|---|---|
| POI-sparse rural stretch | Hierarchical region/corridor fallback (§9) — never silent. |
| Off-route detour | Player pauses + gentle notice; resumes on rejoin (v1). |
| Slower/faster/stopped | Distance-based queue self-corrects (§8). |
| Brief GPS loss | Hold/extrapolate along-route distance; GPS ≠ network, so no failure. |
| Duplicate POIs | Deduped + min-spacing in Baker curation. |
| Hallucination risk | Strict grounding + "skip if unsure" (§10). |
| Odd place-name pronunciation | Optional pronunciation hints in TTS input for flagged names (minor, v1-optional). |
| Empty/failed harvest for a leg | Baker warns; fills with region content or flags the gap in review. |

---

## 16. Testing strategy

- **The "desk driving" harness (key):** a **GPS-trace simulator** feeds a synthetic drive of the
  route (a timed sequence of GPS points, with speed variation, a stop, a brief dropout, and an
  off-route excursion) into the Player's playback engine — asserting correct clip order, **never
  silent**, correct **left/right**, and correct hold/resume — all **without leaving the desk**.
- **Baker geometry unit tests:** bearing, side-of-road (cross-product sign), snap-to-polyline,
  along-route distance, slot spacing (no gap/overlap; within cadence at target speed).
- **Package schema validation:** every Baker output validates against the shared type; golden-file
  test on a short known route.
- **Content pipeline (non-deterministic) — test the plumbing, mock the APIs:** given fixed POIs, the
  correct prompt is built, TTS is invoked, files are written, manifest is valid.
- **End-to-end dry run:** bake a short local route, sideload, take a brief real drive to tune
  spacing/voice/timing.

---

## 17. Build phases (personal-first, grow later)

- **Phase 1 — Baker MVP:** route+waypoints → POIs (Wikipedia + OSM) → Claude scripts → TTS →
  package. Validate content quality on the laptop. First test route: Seattle→(Leavenworth|Spokane)→
  Glacier.
- **Phase 2 — Player MVP + GPS-trace simulator:** prove the road experience at the desk.
- **Phase 3 — Real drive:** sideload, short local test drive, tune.
- **Phase 4 — Polish:** sparse-stretch fallback tuning, off-route handling, nicer minimal UI,
  smoother package-load UX.
- **Later (grow):** Hybrid online mode (live-generate with cell, pre-baked fallback), spontaneous
  routes, shareable packages, multi-user, richer content sources.

---

## 18. Open questions / risks

- **Timing calibration** — the `expectedSpeedMph` lead-in that lands a clip "as you pass" needs
  real-drive tuning; the simulator gets us close, a test drive finalizes it.
- **Content quality in the wild** — rural fallback richness depends on region-topic sourcing; may
  need a small curated region-facts layer.
- **Package size** — hours of audio per long route; measure and, if needed, tune bitrate / clip
  length. (Storage, not bandwidth — it's all local.)
- **iOS foreground assumption** — relies on the mounted-and-awake model; true background playback is
  a later hardening item.

---

## 19. Appendix — glossary

- **Slot** — a ~1-mile point along the route that wants something to say.
- **Clip** — one generated audio narration (~30–90 s) assigned to a position via `startAtMiles`.
- **Along-route distance** — GPS snapped onto the polyline, reduced to a single "miles from origin"
  scalar; the master clock for playback.
- **Side of road** — left/right/ahead, from heading × vector-to-POI.
- **Hierarchical fallback** — landmark → corridor → region content, ensuring never-silent playback.
