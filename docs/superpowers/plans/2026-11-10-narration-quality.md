# Narration Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Smoother inserts, no repeated themes, trip tones, speed-aware stories on every road, exit amenity lines with
a brand slot, sight-free side wording, sourced local numbers, and topics/tones served from config.

**Architecture:** Server (MileMuseService, Node ESM Lambda) owns catalogues, prompts, cache keys, lookups and insert
writing; every tunable lives in `narration-config.mjs` (SSM-overridable, served at `GET /v1/config`). The phone
(MileMuseApp, Expo/RN) renders catalogues from that config, sends tone and past themes, and owns playback transitions
and the staleness drop. Server tasks S1–S7 ship and deploy first (old apps keep working); app tasks A1–A3 follow.

**Tech Stack:** Node 22 ESM, Fastify, DynamoDB lookups table (`lookups.mjs`), Bedrock (`d.complete`), Polly; Expo 58 /
RN 0.88 TypeScript; tests `node --test` (server: `npm test`, app: `npx tsc --noEmit && npm test`).

**Spec:** `docs/superpowers/specs/2026-11-10-narration-quality-design.md`

## Global Constraints

- Tones: `delightful` (default), `funny`, `serious`, `crazy`. Tone applies to stories and background segments only; inserts, lead-ins and bridges stay neutral.
- Story cache: at most 4 tone versions per key; a stored story with no tone is `delightful` (no cache wipe).
- Speed bands: `still` < 10 mph (4.5 m/s), `town` 10–45 mph, `freeway` ≥ 45 mph (20 m/s). Caps: still none, town 90 s, freeway 120 s. Effective length = min(level length, cap).
- Numbers only from the NUMBERS facts line, each with its year, rounded naturally, at most two per story; never invented.
- Banned phrases (config default): nestled, boasts, hidden gem, rich history, rich tapestry, picture this, imagine, interestingly, it's worth noting, a testament to, steeped in, vibrant.
- Theme vocabulary (config default): logging, film, railroads, rivers, farming, war, music, sports, industry, native history, disasters, architecture, food, nature, shipping, mining, aviation, religion, crime, science.
- Staleness drop: live segments only (never planned-route or downloaded stories); drop when the car is > `stale.m` (1500) from where the segment was requested.
- Exit inserts: one per exit, id `x:<exit ref>@<lat.toFixed(2)>,<lng.toFixed(2)>`, kinds only, no brand unless `ads.enabled && ads.spoken` and `d.sponsor` returns one.
- Lead-ins never ask the listener to look or glance; side words only.
- Unknown topic/tone ids are dropped (server and app), never a 400 or crash.
- No personal data in shared stories. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A config override that omits or malforms `topics`/`tones` (null, object, empty array) → defaults used, app still renders topics. Tests in S1 and A1.
2. Speed missing (null/NaN, no GPS speed) → `town` band, never a crash or a freeway lookahead. Test in S4.
3. Every library candidate's theme overlaps past themes → a new story is written (library never starves). Test in S3.
4. Stats lookup slow or failing (Wikidata/Census down, 429) → story written without NUMBERS within the normal budget (lookup capped at 1500 ms). Test in S6.
5. Insert due with the story's last sentence break far behind and none ahead → fade, insert, resume from that last break (never mid-sentence, never skipping the sentence). Test in A2.

---

## Server (MileMuseService)

### Task S1: Catalogues in the narration config

**Files:**
- Modify: `packages/core/src/narration-config.mjs` (DEFAULTS)
- Modify: `packages/core/src/narrate.mjs:42` (LENSES becomes the fallback; `lensText(id, cfg)` reads config)
- Modify: `packages/api/src/app.mjs` (narrate/settings schemas: `tone`; drop unknown topic/tone ids against the live config instead of an enum)
- Test: `packages/core/test/narration-config.test.mjs`, `packages/api/test/app.test.mjs`

**Interfaces:**
- Produces: `DEFAULTS.topics: { id, label, icon, lens, on, star, order }[]` (today's 21 topics; `lens` = today's LENSES text), `DEFAULTS.tones: { id, label, blurb, prompt }[]`, `DEFAULTS.themes: string[]`, `DEFAULTS.bannedPhrases: string[]`, `DEFAULTS.speed: { stillMps: 4.5, freewayMps: 20, capS: { still: null, town: 90, freeway: 120 } }`, `DEFAULTS.stale: { m: 1500 }`, `DEFAULTS.ads.spoken: false`.
- Produces: `catalogue(cfg, name)` in narration-config.mjs → the array if it is a non-empty array, else `DEFAULTS[name]`.
- Produces: `cleanIds(ids, list)` → ids present in `list.map(x => x.id)`, order kept.

- [ ] **Step 1: Write failing tests** — `catalogue({ topics: null }, "topics")` and `catalogue({ topics: {} }, "topics")` equal `DEFAULTS.topics`; `DEFAULTS.tones.map(t => t.id)` is `["delightful","funny","serious","crazy"]`; `DEFAULTS.topics.length === 21` and every id in the app's TOPICS list appears; POST `/v1/narrate` with `topics: ["history","zzz"], tone: "zzz"` → 200 and the handler receives `topics: ["history"]` and no tone.
- [ ] **Step 2: Run** `node --test packages/core/test/narration-config.test.mjs packages/api/test/app.test.mjs` — expect FAIL (no `catalogue`, no `tones`).
- [ ] **Step 3: Implement** DEFAULTS additions, `catalogue`, `cleanIds`; storySystem's angle text comes from `catalogue(cfg,"topics").find(t => t.id === lens)?.lens ?? LENSES[lens]`; app.mjs narrate route cleans `topics`/`lens`/`tone` with `cleanIds` against `await config()` (schema: strings ≤ 40, ≤ 40 items).
- [ ] **Step 4: Run** `npm test` — expect all pass (357 + new).
- [ ] **Step 5: Commit** `feat(config): topics, tones, themes, banned phrases and speed bands served from the narration config`.

### Task S2: Tone in the story prompt and the library key

**Files:**
- Modify: `packages/core/src/narrate.mjs` (`storySystem`, `writeStory` params)
- Modify: `packages/core/src/library.mjs:49` (`storyKey`)
- Test: `packages/core/test/narrate.test.mjs`, `packages/core/test/library.test.mjs`

**Interfaces:**
- Consumes: S1 `catalogue`, `DEFAULTS.tones`, `DEFAULTS.bannedPhrases`.
- Produces: `storySystem({ w, ask, imperial, lens, topics, party, tone = "delightful", cfg })`; `writeStory({ …, tone })`; `storyKey({ …, tone })` appends `t:<tone>` only when tone ≠ delightful (so existing keys keep hitting).

- [ ] **Step 1: Failing tests** — `storySystem({…, tone:"serious"})` contains the serious tone's `prompt` and the line `Never use these phrases: nestled, boasts,`; `tone:"funny"` system does not contain `Never use these phrases` but contains `Use these sparingly:`; `storyKey({…tone:"delightful"}) === storyKey({…})`; `storyKey({…tone:"crazy"})` ends with `#t:crazy`.
- [ ] **Step 2: Run** the two test files — FAIL.
- [ ] **Step 3: Implement**; tone text goes in the "THIS STORY'S SETTINGS" block; banned list from `catalogue`-style read of `cfg.bannedPhrases`.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(narrate): trip tones in the story system prompt and the library key`.

### Task S3: Themes — tagged, remembered, not repeated

**Files:**
- Modify: `packages/core/src/narrate.mjs` (SUMMARY_ASK adds THEMES; parse at :325; prompt line for used themes)
- Modify: `packages/core/src/library.mjs` (candidate filter), `packages/core/src/dynamo.mjs:68,81` (store/read `themes`)
- Modify: `packages/api/src/app.mjs` (`past.themes`: array ≤ 30 of strings ≤ 30)
- Test: `packages/core/test/narrate.test.mjs`, `packages/core/test/library.test.mjs`

**Interfaces:**
- Produces: `parseThemes(line, vocabulary) → string[]` (≤ 3, lowercase, only vocabulary words); story objects carry `themes: string[]`; reply includes `themes`.
- Produces: `overlaps(story, pastThemes) → boolean`.

- [ ] **Step 1: Failing tests** — model reply `"…\nSUMMARY: x\nTHEMES: Logging, film, unicorns"` → `themes: ["logging","film"]`, spoken text excludes both lines; library with candidates A(themes logging) and B(themes rivers) and `past.themes:["logging"]` serves B; with only A → writes a new story (write called once); writer prompt with `past.themes:["film"]` contains `Do not build this story around: film`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; stories without `themes` never overlap.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(narrate): stories tagged with themes; a theme heard in the last 30 min is not told again`.

### Task S4: Speed bands on every road

**Files:**
- Modify: `packages/core/src/narrate.mjs:196-260` (writeStory lookahead/radius/sides/length)
- Modify: `packages/core/src/library.mjs:50` (key: band letter replaces the `f` flag)
- Test: `packages/core/test/narrate.test.mjs`, `packages/core/test/library.test.mjs`

**Interfaces:**
- Produces: `bandOf(speedMps, cfg) → "still" | "town" | "freeway"` (non-finite speed → `"town"`); `capWords(words, band, cfg, w) → number`.

- [ ] **Step 1: Failing tests** — `bandOf(null)`/`bandOf(NaN)` → town; `bandOf(2)` still; `bandOf(15)` town; `bandOf(25)` freeway; a still request's prompt has no `COMING UP LATER` line, no place tagged with a side, and facts only within 800 m; a town request at 15 m/s with level deep (500 words) asks for ≤ 90 s of speech; freeway 120 s; still keeps 500; keys for speeds 2 / 15 / 25 at one spot are three distinct keys ending in `.s` / `.t` / `.f` segments.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `bandOf`, `capWords` (cap seconds × language wpm / 60), wire into writeStory and storyKey.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(narrate): speed bands for parked, town and freeway; length capped to stay in context`.

### Task S5: Sides without assuming sight

**Files:**
- Modify: `packages/core/src/languages.mjs:49-50` and every language's `left`/`right` lists (remove look/glance phrasings; keep position words)
- Modify: `packages/core/src/narrate.mjs:12` (NARRATOR side rule), `packages/core/src/inserts.mjs:123` (insert rule)
- Test: `packages/core/test/languages.test.mjs` (create if absent), `packages/core/test/narrate.test.mjs`

**Interfaces:** none new.

- [ ] **Step 1: Failing tests** — for every enabled language, no `left`/`right` lead-in matches `/glance|look|blick|regard|mira|olhe|guard/i` and each list keeps ≥ 2 entries; NARRATOR contains `never ask the listener to look`; insert system contains the same rule and no `left`/`right` words.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; visible exception text: on the road itself, a mountain or peak, or within 150 m.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `fix(narrate): say where a place is, never ask the listener to look`.

### Task S6: Local numbers (Wikidata + US Census)

**Files:**
- Create: `packages/core/src/stats.mjs`
- Modify: `packages/core/src/narrate.mjs` (gather `stats` in parallel; NUMBERS line; prompt rule)
- Modify: `packages/api/src/lambda.mjs` (lookups: `stats`)
- Test: `packages/core/test/stats.test.mjs`, `packages/core/test/narrate.test.mjs`

**Interfaces:**
- Produces: `placeStats({ town, county, state, country, lat, lng }, { fetch, timeoutMs = 1500 }) → { name, population?: { value, year }, areaKm2?, elevationM?, founded?, census?: { year, medianAge?, medianIncome?, medianHomeValue?, commuteMin?, wfhPct? } } | null` — cached via `shared("stats", <name|state|country>, 30 * DAY_S, …)`; Wikidata via Wikipedia pageprops → `wbgetentities` (P1082 with P585 year, P2046, P2044, P571); Census ACS 5-year (US only) by place FIPS from the Census geocoder.
- Produces: `numbersLine(stats, imperial) → string` (`NUMBERS (data, each with its year): …`) or `""`.

- [ ] **Step 1: Failing tests** (fake fetch fixtures) — Everett fixture → `population: { value: 111180, year: 2020 }`, `founded: 1893`; `numbersLine` contains `population 111,180 (2020)` and `founded 1893`; Census fixture → `medianAge` with `(ACS 2022)`; a fetch that never resolves → `placeStats` resolves `null` in ≤ 1600 ms and writeStory's prompt has no `NUMBERS` line; non-US → no Census call made.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; a failed source is not cached (lookups.mjs `shared` behaviour); prompt rule copy: `Use a number only from NUMBERS, say its year when it matters, round it the way people say it, at most two numbers, and only when it adds something.`
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(narrate): local numbers from Wikidata and the US Census, each with its year`.

### Task S7: Exit amenities and the sponsor slot

**Files:**
- Modify: `packages/core/src/inserts.mjs:79-90` (replace the single-stop candidate), `:123` (exit line prompt)
- Modify: `packages/api/src/wire.mjs` (inserts deps: `sponsor: async () => null`)
- Test: `packages/core/test/inserts.test.mjs`

**Interfaces:**
- Consumes: `mapPlaces(lat, lng)` (places.mjs) for the places around the exit; S1 `ads.spoken`.
- Produces: `exitKinds(places) → { fuel, ev, food, coffee, grocery, see, lodging }` counts; candidate `{ id: "x:<ref>@<lat2>,<lng2>", kind: "exit", exit, facts }` where facts reads e.g. `Exit 194: 2 gas stations, an EV charger, 5 places to eat, a grocery. Say what's there by kind, never by name.`; `d.sponsor({ exit, kinds }) → { brand } | null`.

- [ ] **Step 1: Failing tests** — freeway request with an exit and places (2 fuel, 1 EV, 5 food, 1 grocery) → one candidate with id prefix `x:194@`, facts containing `2 gas stations` and no place title; no places off the exit → no exit candidate; `ads.spoken:false` with a sponsor returning `{brand:"Acme"}` → facts have no `Acme`; `ads.enabled && ads.spoken` → facts end with `You may name Acme once.`
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(inserts): what's off the exit by kind, with a sponsor slot (off)`.

### Task S8: Ship the server

- [ ] **Step 1:** `ship_branch.sh` (rebase on origin/main, squash per task or one release commit, `npm test`, PR, fast-forward merge). Expected: `VERIFIED: origin/main = …`.
- [ ] **Step 2:** `cdk_diff_all.sh` — expected only Lambda code changes.
- [ ] **Step 3:** `deploy_checked.sh` — expected `deploy exit=0`.
- [ ] **Step 4:** Production check with a throwaway account: `/v1/config` has 21 topics and 4 tones; `/v1/narrate` at Everett (speed 2 m/s, tone serious) returns a story with `themes`, no banned phrase, and any number in it appears in the facts with a year; account deleted.

## App (MileMuseApp)

### Task A1: Catalogues and Tone in the app

**Files:**
- Modify: `src/config.ts` (NarrationConfig: `topics`, `tones`, `themes`, `speed`, `stale`), `src/model.ts:12-18,101-104` (TOPICS fallback, `Prefs.tone`), `src/api.ts:64` (send `tone`), `src/session.ts:188` (tasteOf includes tone)
- Modify: `src/screens/you.tsx` (Tone row), the trip-start sheet in `src/screens/explore.tsx` (one-tap tone chips), onboarding/you topic grids (render from config)
- Test: `src/config.test.ts`, `src/model.test.ts`, `src/session.test.ts`

**Interfaces:**
- Produces: `topicsOf(cfg) → { id, label, icon, on, star, order }[]` (config if non-empty array, else bundled); `tonesOf(cfg)`; `cleanPrefs(p, cfg) → Prefs` (drops topic/favourite/tone ids not in the catalogue; tone defaults to `delightful`).

- [ ] **Step 1: Failing tests** — config with `topics: null` → `topicsOf` returns the bundled 21; config adding `{id:"ghosts"}` → it appears, ordered by `order`; prefs with `topics:["history","gone"]`, `tone:"gone"` → `cleanPrefs` gives `["history"]` and `delightful`; narrate request body includes `tone` when not delightful.
- [ ] **Step 2: Run** `npx tsc --noEmit && npm test` — FAIL.
- [ ] **Step 3: Implement**; `Topic` type widens to `string`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(app): topics and tones from the server config; a Tone setting and trip chips`.

### Task A2: Inserts never cut a story

**Files:**
- Modify: `src/lanes.ts:19` (LanePlayer gains `fade?(to: number, ms: number): Promise<void>`), `:243-288` (evaluate/afterGap), the player implementation in `src/session.ts` (expo-audio volume ramp)
- Test: `src/lanes.test.ts`

**Interfaces:**
- Produces: `resumeFrom(breaksMs, posMs) → number` (the last break ≤ posMs, else 0) in lanes.ts.

- [ ] **Step 1: Failing tests** — no break before `latestS`: insert starts after `fade(0, 400)`, and the resume plays from `resumeFrom(breaks, pausePos)` (start of the interrupted sentence), after a bridge every time (two inserts → two bridges); segment with 6 s left after an insert and no next segment due → resumes (no longer dropped); next segment due → moves on.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; fade-in `fade(1, 300)` on resume; a player without `fade` behaves as today minus the mid-sentence cut.
- [ ] **Step 4: Run** `npx tsc --noEmit && npm test` — PASS.
- [ ] **Step 5: Commit** `fix(lanes): inserts never cut a sentence; fade, bridge and resume from the sentence start`.

### Task A3: Past themes and the staleness drop

**Files:**
- Modify: `src/session.ts` (past themes from story replies, sent as `past.themes`; staleness check before a live segment starts), `src/api.ts` (`Story.themes`)
- Test: `src/session.test.ts`

**Interfaces:**
- Consumes: S3 reply `themes`; A1 `cfg.stale.m`.
- Produces: `isStale(seg, pos, cfg) → boolean` (live segments only: `seg.requestedAt` set and haversine > `stale.m`).

- [ ] **Step 1: Failing tests** — after playing a story with `themes:["logging"]`, the next narrate body has `past.themes` containing `logging`; themes older than 30 min are gone; a prepared live segment requested 2 km back is dropped and a fresh request made; a planned-route or offline segment at the same distance still plays.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npx tsc --noEmit && npm test` — PASS.
- [ ] **Step 5: Commit** `feat(session): remember heard themes; drop a live segment the car has left behind`.

### Task A4: Ship the app

- [ ] **Step 1:** `ship_branch.sh` for MileMuseApp — `VERIFIED: origin/main = …`.
- [ ] **Step 2:** `release_and_check.sh` + signed-in audio check (TEMP-E2E in a worktree, throwaway account deleted after) — AudioTrack `state:started`, 0 crashes; insert transition heard without a mid-sentence cut on the emulator drive route (`drive_skip.sh`).
- [ ] **Step 3:** `upload_phone_apk.sh <phone-arm64.apk>` — `ABIs: lib/arm64-v8a/`, link HTTP 206.
- [ ] **Step 4:** iPhone: `ios_when_ready.sh` — `BUILD SUCCEEDED`, install, launch with no error lines.
