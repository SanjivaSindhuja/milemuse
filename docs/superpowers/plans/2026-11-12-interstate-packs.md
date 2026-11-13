# Interstate Packs Implementation Plan (pilot)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interstate highway segments as downloadable story packs for the pilot corridors, with stories written by agents.
Users find them through their routes and one Packs library, not Explore shelves.

**Architecture:** A highway segment is a pack in the existing park pack machinery. Only the roads step differs: the
interstate's OpenStreetMap route clipped to a state replaces a park boundary, and Wikipedia landmarks near the road
replace NPS places. Everything downstream is unchanged:

- `NP#` items, `parks/<code>/` on the CDN, ParkPrime.
- park-drafts export/load, manifest v2.
- Phone sync (`parkpacks.ts`) and playback (`parkplay.ts`).

New on the phone: one Packs library screen, and a route card on the trip plan.

**Tech Stack:** Node ESM pipeline/API (`node --test`), Overpass API, Expo React Native (`node --test`), AWS Step
Functions (existing ParkPrime), Polly.

**Spec:** `docs/superpowers/specs/2026-11-12-interstate-packs-design.md`, approved with the defaults.

## Global Constraints

- Segment codes match `^i\d{1,3}-[a-z]{2}(-[a-z])?$`: `i5-wa`, `i90-mt-w`. Park codes stay `^[a-z]{4}$`.
- Highway stretches are 3,000 m. Parks stay 1,000 m. Stops are landmarks within 300 m of the road (STOP_M).
- Pilot segments, with splits at these thresholds:

  | Highway | Segments |
  |---|---|
  | I-5 | `i5-wa`, `i5-or`, `i5-ca-n` (lat ≥ 38.55, Sacramento) |
  | I-405 | `i405-wa` |
  | I-90 | `i90-wa`, `i90-id`, `i90-mt-w` / `i90-mt-e` (lng −112.53, Butte) |
  | I-80 | `i80-nv-w` / `i80-nv-e` (lng −117.74, Winnemucca), `i80-wy-w` / `i80-wy-e` (lng −107.24, Rawlins) |
  | I-15 | `i15-ut-n` / `i15-ut-s` (lat 40.23, Provo), `i15-nv` |

- Pricing: Essentials free. Full only with Plus (a highway can't be the free first Full park).
- Writing: drafts by spawned Claude Code agents (session writer, no Bedrock). Voicing: Polly through ParkPrime's write
  step.
- Pack rules for highways: "an interstate highway" wording. No business, hours, closures, "currently". Direction-neutral.
- No new infra: the ParkPrime state machine, the CDN behaviours and the signed cookies are all code-generic.
- Explore gets one "Offline packs" row and no highway shelves.

## Review Focus

1. A segment whose OSM route has gaps or both carriageways: a single ordered centre line, never a zig-zag between
   carriageways. Test in Task 1.
2. A clip boundary through the middle of a stretch: the stretch belongs to one segment only, never to both halves.
   Test in Task 1.
3. A sparse stretch (Nevada desert, fewer than MIN_FACTS facts): no story there, and the segment overview covers it.
   Test in Task 2.
4. A planned route that runs beside an interstate without using it (a frontage road): no route card for it. It needs
   at least 10 km within 150 m of the line. Test in Task 4.
5. Old app versions see the new codes in `/v1/parks`. They must not show highways on the parks shelf, so highways get
   their own list (`/v1/highways`). Test in Task 3.

---

### Task 1: Interstate roads and corridor places (service core)

**Files:**
- Create: `packages/core/src/parks/highways.mjs`
- Test: `packages/core/test/parks.highways.test.mjs`

**Interfaces:**
- `HIGHWAYS`: the pilot registry, entries of
  `{ code, ref: "5", state: "WA", name: "I-5 · Washington", clip?: { latMin?, latMax?, lngMin?, lngMax? } }`.
- `highwayOf(code) => entry | null`.
- `interstateRoads(hw, { fetch }) => { name, states: [state], bbox: [w, s, e, n], roads: [{ id: "i5", name: "I-5", km, line: [[lat, lng], ...] }] }`.
  - One Overpass query: the route relations `route=road, network=US:I, ref=<ref>` inside the state's area, with
    `out geom`.
  - One direction's members (the relation or role that is northbound/eastbound, else the longest), chained in member
    order.
  - Then clipped by `clip`, and simplified with the existing `simplify`.
- `corridorPlaces(line, { wikiSearch, wikiExtracts }, { everyM = 2000, radiusM = 400 }) => [{ title, text, lat, lng }]`:
  Wikipedia pages within 300 m of the line, de-duplicated by title. These are the stops.

- [ ] **Step 1: failing tests**, with an Overpass fixture (a small JSON with two relations, northbound and southbound,
  and three ways each):
  - `test("an interstate is one ordered line from one direction's relation, never both carriageways")`: about 30 m
    apart, 6 ways. Expect one road whose km matches the northbound length within 2%.
  - `test("a clip keeps only the part of the road inside it, and stretches never straddle the cut")`
  - `test("corridor places: Wikipedia pages within 300 m of the line, each once")`
  - `test("the pilot registry: 15 segments, codes match the pattern, splits at the documented thresholds")`
- [ ] **Step 2:** `node --test packages/core/test/parks.highways.test.mjs` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(highways): interstate roads and corridor landmarks from OpenStreetMap and Wikipedia`.

### Task 2: The roads step takes highway segments (pipeline)

**Files:**
- Modify: `packages/pipeline/src/parks.mjs` (the `roads` step; the stretch length)
- Modify: `packages/core/src/parks/write.mjs` (pack rules per kind)
- Modify: `packages/core/src/parks/facts.mjs` (de-duplicate places against Wikipedia pages)
- Test: `packages/pipeline/test/parks.test.mjs`

**Interfaces:**
- `roads({ code })`:
  - For a highway code it uses `highwayOf` + `interstateRoads` + `corridorPlaces`, writing the places to `placesKey`
    as NPS places are.
  - The META gets `kind: "highway"`, `ref`, `stretchM: 3000`, `essentialRoads: ["i<ref>"]`, `review: false`.
  - Parks are unchanged.
- `stretchesOf(road, meta.stretchM ?? 1000)` everywhere a stretch list is built (roads, facts).
- `packRules(kind)`: the park text, or for highways "THIS IS A PRE-RECORDED PACK for an interstate highway…" with the
  same never-list plus "never name a business, a gas station or what's off an exit". `packPrompt` takes `kind` from
  the item's meta.
- `stretchFacts` skips a Wikipedia page whose title is already a place fact.

- [ ] **Step 1: failing tests:**
  - `test("a highway segment's roads step: one road, 3 km stretches, corridor places as stops, kind highway")`
  - `test("a sparse highway stretch with fewer than MIN_FACTS facts gets no story; the segment overview covers its topic")`
  - `test("highway briefs say interstate highway and forbid businesses and exits")`
  - `test("a park's roads step is unchanged")`
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(highways): the park priming job builds highway segments`.

### Task 3: API: highways listed apart; access without a free claim

**Files:**
- Modify: `packages/api/src/app.mjs` (`/v1/highways`; code patterns; access)
- Modify: `packages/core/src/parks/access.mjs` (`fullAccess` ignores the free claim for highway codes)
- Test: `packages/api/test/app.test.mjs`

**Interfaces:**
- `GET /v1/highways` returns `[{ code, name, ref, states, essentialsBytes, fullBytes, version, access, line }]`.
  - `line` is an encoded polyline of the road, simplified to about 200 m.
  - It lists only published segments from `highways.codes` in the config (default: the pilot 15).
- `GET /v1/parks/:code` and `POST /v1/parks/:code/access` accept both code patterns, so the park page and the cookie
  serve segments.
- `GET /v1/parks` lists only park codes, never highways (old apps).
- Highway access: `full` only with Plus.

- [ ] **Step 1: failing tests:**
  - `test("highways are their own list, with their line; the parks list never shows one")`
  - `test("a highway segment page and its Full cookie: Plus only, never the free first park")`
  - `test("bad codes are 400")`
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(highways): highway packs API`.

### Task 4: App: the Packs library and the route card

**Files:**
- Create: `src/packs.ts` (pure: `packsOnRoute`, grouping, search)
- Create: `src/screens/packs.tsx` (the library)
- Modify: `src/api.ts` (`highways()`)
- Modify: `src/session.ts` (highway list loading, plus the download and remove helpers, reusing the park ones by code)
- Modify: `src/screens/explore.tsx` (one "Offline packs" row)
- Modify: the trip plan card (route card)
- Test: `src/packs.test.ts`, `src/session.parks.test.ts` (highway install via the same sync)

**Interfaces:**
- `packsOnRoute(route: LatLng[], list: HighwaySummary[]) => HighwaySummary[]`: a segment counts when the route has at
  least 10 km within 150 m of its line. Ordered along the route.
- `groupByHighway(list)` and `searchHighways(list, q)`: "I-90", "90" and "Montana" all match.
- The library: tabs Parks | Highways, a search box, highways grouped by ref, and a segment row (size, tier, state). A
  segment opens the existing park page by code.
- Route card: "Offline stories for this route: I-90 WA, I-90 MT · 140 MB · Download". It downloads Essentials, or Full
  with Plus, on Wi-Fi.
- Commute card in the library: segments on a detected commute.

- [ ] **Step 1: failing tests:**
  - `test("a route that uses an interstate for 10+ km gets its segments, in route order")`
  - `test("a route beside an interstate (a frontage road) gets none")`
  - `test("search finds I-90 by 'I-90', '90' or 'Montana'")`
  - `test("a highway segment installs and plays through the park pack sync")`
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, plus typecheck.
- [ ] **Step 5:** Commit `feat(highways): the Packs library and the route card`.

### Task 5: Build the pilot content (agents)

1. Deploy service and app work. Add `highways.codes` (the pilot 15) and a write budget to the narration config
   override.
2. Start ParkPrime per segment. Roads and facts run; write finds no drafts; publish waits.
3. `node packages/pipeline/scripts/park-drafts.mjs export <code> <dir>` for each segment.
4. Spawn writer agents in parallel, about 8 at a time. Each gets a set of batch files, the brief rules and the lint
   rules, and returns drafts.
5. `park-drafts.mjs load`, then rerun ParkPrime. Write voices, publish puts out manifests, samples are picked.
6. Check: every segment has a published manifest, and Essentials is 40 MB or less.

### Task 6: End to end and install

1. Emulator: open Packs → Highways and download `i405-wa`. Turn data off and drive I-405 (`geo fix` with speed). Pack
   stories play offline and become notes.
2. A planned Seattle → Spokane trip shows the route card with I-90 WA.
3. iPhone build and install.

## Status (2026-11-13): four segments live, no more Polly

- **Owner's call:** stop the pilot at what was ready, with no more Polly ("polly is billing a lot"). November so far
  is $461. $432 of that was the 62-park build on Nov 11: 14.4M characters on the Generative engine, at $30 per million.
- **Live on the app** (`GET /v1/highways` lists only published segments):

  | Segment | Version | Essentials / Full | Voice |
  |---|---|---|---|
  | `i405-wa` | v0645bfda4314 | 3.8 / 12.1 MB, 80 stories | Polly Matthew, Generative ($1.48) |
  | `i15-nv` | v4efd28d25904 | 6.6 / 18.2 MB, 111 stories | Kokoro `am_michael`, local, $0 |
  | `i15-ut-n` | v1c9b8f9e2e61 | 8.0 / 19.3 MB, 144 stories | Kokoro `am_michael`, local, $0 |
  | `i15-ut-s` | v7397aff244ec | 5.4 / 11.0 MB, 74 stories | Kokoro `am_michael`, local, $0 |

- **Writing:** one Sonnet writer agent per segment. Every draft passed `park-drafts.mjs check`. One draft was fixed by
  hand because it named a business.
- **Local voicing:** Kokoro-82M ONNX (Apache-2.0) on the owner's PC.
  - Its phonemizer misreads digits, so years, decades, grouped numbers, decimals and 3-digit interstates are spelled
    out for the voice only. The stored text keeps its digits.
  - Each item is stored as park.write would store it: mono 22.05 kHz 32 kbps at -20 LUFS, S3
    `parks/<code>/<tier>/<sha256>.mp3`, and the item row. Then the pipeline Lambda runs `park.publish` and
    `park.collect`.
  - The first priming run had voiced the 12 lead-ins of each I-15 segment with Polly. They were re-voiced locally, so
    each pack has one voice.
  - Never load drafts into `next.text` and then start ParkPrime: its write step voices them with Polly.
- **Not built:** the other 11 pilot segments. Their priming failed on Wikipedia 429s when 14 ran at once. Rerun them
  one segment at a time.
- **Not done:** emulator e2e (Task 6) and the iPhone build.
