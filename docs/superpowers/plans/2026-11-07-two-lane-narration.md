# Two-lane narration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Just drive tells short roadside inserts on the fly (timed to land as the car passes) over a continuous lane of shared background segments written ahead of time, with every distance and length in a live-tunable config.

**Architecture:** The server gains a narration config (defaults + SSM override, `GET /v1/config`), a background mode for `/v1/narrate` that serves shared per-area *series* of short segments with sentence breaks, and `POST /v1/inserts` that finds places beside the road ahead and returns side-neutral, library-shared insert audio plus a pre-voiced side clip. The app gains a pure scheduler (`src/lanes.ts`) that wraps today's free drive as lane B and pauses it at a sentence break to play lane A inserts, then resumes.

**Tech Stack:** Node 24 ESM + Fastify on Lambda (MileMuseService, `node --test`), DynamoDB `Fast` table, S3/CloudFront, Polly via `speak()`; Expo 58 / React Native app (MileMuseApp, `node --experimental-test-module-mocks --test`, `npx tsc --noEmit -p .`); CDK (MileMuseInfra).

**Spec:** `docs/superpowers/specs/2026-11-07-two-lane-narration-design.md` (MileMuse repo)

## Global Constraints

- Config defaults (exact): `lanes.enabled: true`; `insert: { radiusM: 300, lookaheadS: 120, voiceAheadS: 60, leadS: 8, gapS: 2, latestS: 3, minSpacingS: 20, pollM: 400, words: [25, 50], writePerCall: 3 }`; `segment: { words: { light: 120, normal: 180, deep: 240 }, prefetch: 2, resumeMinS: 10, perArea: 6 }`; `tellRadiusM: 1600`.
- Config is one JSON document: defaults in code, overridden key-by-key (deep merge) by SSM parameter `/milemuse/narration-config`, cached 5 minutes in the Lambda; a missing or unparsable parameter means defaults.
- Side and bridge phrases (exact): en `{ left: "On your left,", right: "On your right,", resume: "Anyway," }`, es `{ left: "A tu izquierda,", right: "A tu derecha,", resume: "En fin," }`, ta `{ left: "உங்கள் இடது பக்கம்,", right: "உங்கள் வலது பக்கம்,", resume: "சரி," }`.
- Inserts are written side-neutral and shared per place + language + level; never say "left", "right", "coming up" or "passed".
- Insert and segment audio go under S3 `library/` (existing grant and 120-day lifecycle); DynamoDB items carry `ttl` 90 days.
- Never cut mid-sentence: lane B pauses only at a sentence break, except at `insert.latestS` before the place.
- `lanes.enabled: false` restores today's single-lane Just drive unchanged.
- Server schema stays `additionalProperties: false`: deploy the server before an app that sends new fields.

## Review Focus

- A place the car turns away from after its insert was voiced: never played late; logged as missed.
- Two places close together on opposite sides: only one insert per `minSpacingS`; the nearer wins, the other is skipped, not queued forever.
- No signal mid-drive: `/v1/inserts` fails → lane B carries on (offline segments) with no errors shown and no retry storm (poll again only after `pollM`).
- Parked car (speed < 3 m/s): no insert polling, no pause/resume churn.
- A listener asks a question (live answer) while an insert is due: the answer wins; the insert is dropped if its place passes meanwhile.

---

## File Structure

MileMuseService
- Create `packages/core/src/narration-config.mjs`: defaults, deep merge, SSM load + cache.
- Create `packages/core/src/inserts.mjs`: candidates beside the road ahead, side-neutral script writing, audio + side clips.
- Modify `packages/core/src/spatial.mjs`: return sentence breaks.
- Modify `packages/core/src/aws.mjs`: `speak()` passes breaks through.
- Modify `packages/core/src/narrate.mjs`: `mode: "background"`; `TELL_M` from config.
- Modify `packages/core/src/library.mjs`: background series (per area + lens + level + moment, indexed segments).
- Modify `packages/core/src/dynamo.mjs`: insert and clip items.
- Modify `packages/api/src/app.mjs`, `packages/api/src/lambda.mjs`: `GET /v1/config`, `POST /v1/inserts`, narrate `mode`.

MileMuseInfra
- Modify `lib/services-stack.ts`: SSM parameter (default JSON `{}`), read grant to the API Lambda, env `NARRATION_CONFIG_PARAM`.

MileMuseApp
- Create `src/config.ts`: fetch/cache the config, built-in defaults.
- Create `src/lanes.ts`: the scheduler (pure).
- Modify `src/native.ts`: `play(..., fromS)` and `positionS()`.
- Modify `src/api.ts`: `getConfig()`, `inserts()`, narrate `mode`/`segment` fields.
- Modify `src/session.ts`: Just drive uses lanes when enabled.
- Create `scripts/drive-summary.mjs`: summarises insert timing from a drive log.

---

### Task 1: Narration config (server + infra)

**Files:**
- Create: `MileMuseService/packages/core/src/narration-config.mjs`
- Modify: `MileMuseService/packages/api/src/app.mjs`, `MileMuseService/packages/api/src/lambda.mjs`
- Modify: `MileMuseInfra/lib/services-stack.ts`
- Test: `MileMuseService/packages/core/test/narration-config.test.mjs`, `MileMuseService/packages/api/test/app.test.mjs`, `MileMuseInfra/test/stacks.test.ts`

**Interfaces:**
- Produces: `export const DEFAULTS` (Global Constraints values); `export function mergeConfig(defaults, override): object` (deep merge, unknown keys kept, non-object override ignored); `export async function narrationConfig({ getParameter, now = Date.now, cache }): Promise<object>`; route `GET /v1/config` → the merged config (signed-in only); buildApp option `config: () => Promise<object>`.

- [ ] **Step 1: Write the failing tests**

```js
test("an override changes only what it names; the rest stays at the defaults", () => {
  const c = mergeConfig(DEFAULTS, { insert: { radiusM: 250 }, segment: { words: { deep: 300 } } });
  assert.equal(c.insert.radiusM, 250); assert.equal(c.insert.lookaheadS, 120);
  assert.deepEqual(c.segment.words, { light: 120, normal: 180, deep: 300 });
});
test("the SSM override is read once per 5 minutes; missing or bad JSON means defaults", async () => { /* getParameter fake counts calls; "{bad" -> DEFAULTS; throws ParameterNotFound -> DEFAULTS */ });
test("GET /v1/config returns the live config to a signed-in phone", async () => { /* inject -> 200, body.insert.radiusM === 300 */ });
```
Infra test: the API function's role may `ssm:GetParameter` on `parameter/milemuse/narration-config` and its env has `NARRATION_CONFIG_PARAM`.

- [ ] **Step 2: Run** `npm test` in MileMuseService and MileMuseInfra. Expected: the new tests FAIL (module/route missing).
- [ ] **Step 3: Implement** `narration-config.mjs`, the route, Lambda wiring (`getParameter` via `@aws-sdk/client-ssm` `GetParameterCommand`, already-installed SDK family; add the package to core), and the CDK `ssm.StringParameter` (`stringValue: "{}"`) with `grantRead(api)`.
- [ ] **Step 4: Run** both suites. Expected: all PASS.
- [ ] **Step 5: Commit** each repo: `feat: live narration config (defaults + SSM override)`.

### Task 2: Background segments with sentence breaks, shared as per-area series

**Files:**
- Modify: `packages/core/src/spatial.mjs`, `packages/core/src/aws.mjs`, `packages/core/src/narrate.mjs`, `packages/core/src/library.mjs`, `packages/api/src/app.mjs`, `packages/api/src/lambda.mjs`
- Test: `packages/core/test/spatial.test.mjs`, `packages/core/test/narrate.test.mjs`, `packages/core/test/library.test.mjs`, `packages/api/test/app.test.mjs`

**Interfaces:**
- Consumes: Task 1 `narrationConfig()` (for `tellRadiusM`, `segment.perArea`).
- Produces: `spatialSpeech()` and `speak()` return `{ audio, durationMs, breaksMs: number[] }` (end of each sentence, ms, ascending); library `voice()` returns `{ url, durationS, breaksMs }`; `writeStory({ ..., mode: "background" })` (no sided places, no "coming up", no inserts' places, `TELL_M` = config `tellRadiusM`); `storyKey` for background = `v5#<geohash5>.b#<locale>#<lens>#<party>#<words>#<moment>`; narrate body accepts `mode: { enum: ["drive", "background"] }`; response adds `breaksMs`, `series`, `segment`.

- [ ] **Step 1: Write the failing tests**

```js
test("speech comes back with the end of each sentence, in ms", async () => { /* fixture polly-neural.mp3, text of 2 sentences -> breaksMs.length === 2, last ≈ durationMs (±100) */ });
test("a background segment tells the area, never a side or 'coming up'", async () => { /* writeStory mode background, roadside fixtures -> prompt has no "[coming up", no "tagged coming up" line */ });
test("background segments are a shared series per area: a listener gets the first one they haven't heard, written to carry on from the ones before", async () => {
  // ann hears #0 then #1 (each written once, #1's write gets told = [#0 gist]); bob then gets #0 (shared, no new write)
});
test("an area's series stops at segment.perArea; after that, stories are written for the listener alone", async () => {});
test("narrate takes mode 'background' and returns breaksMs, series and segment", async () => {});
```

- [ ] **Step 2: Run** `npm test`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `spatial.mjs`: collect each span's `end` per sentence (the `spans()` already computed) as `breaksMs`. `library.mjs` background path: for `i` in `0..perArea-1`, key `${base}#${i}`; first `i` with no `heardIn(user, key)` is served — reuse the stored story, else write it with `told` = stored gists of `0..i-1`; `markHeard` on that key unless `prefetch`. Request `told` is ignored for background (the series carries its own).
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: background segments as shared per-area series, with sentence breaks`.

### Task 3: Insert candidates beside the road ahead

**Files:**
- Create: `packages/core/src/inserts.mjs`
- Test: `packages/core/test/inserts.test.mjs`

**Interfaces:**
- Consumes: `orderByAhead` (narrate.mjs), `exitsNear`/`exitFor` (exits.mjs), `landAround` (land.mjs), Task 1 config.
- Produces: `export async function insertCandidates({ lat, lng, heading, speed, curve = 0, exclude = [] }, d, cfg): Promise<Candidate[]>` where `Candidate = { id: string; title: string; kind: "landmark" | "land" | "stop"; lat: number; lng: number; side: "left" | "right"; aheadM: number; exit?: string; facts: string }`, sorted by `aheadM`. Ids: `w:<pageid>`, `land:<lat.toFixed(3)>,<lng.toFixed(3)>`, `p:<title>`.

- [ ] **Step 1: Write the failing tests**

```js
test("only places within radiusM of the road ahead, reached within lookaheadS at this speed", async () => {
  // speed 25 m/s, lookahead 120 s -> 3000 m; a landmark 150 m off at 800 m ahead -> in; 600 m off -> out; 3500 m ahead -> out; behind -> out
});
test("a change in the land beside the road becomes one insert (the crop map), with its side", async () => {
  // landAround -> { left: "hay fields", right: "blueberry fields", farms: true } -> kind "land", facts mention blueberry
});
test("on a freeway, one stop off an exit ahead is an insert with its exit", async () => {});
test("already heard (exclude) and worthless stubs are left out; at most 6, nearest first", async () => {});
```

- [ ] **Step 2: Run** `node --test packages/core/test/inserts.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** with `aheadM ≤ speed × cfg.insert.lookaheadS` and `|across| ≤ cfg.insert.radiusM` (reuse `orderByAhead(car, heading, list, aheadMax, 0)` then filter by its `ahead`); landmarks need `worthTelling` text ≥ 40 chars; the land insert uses the side whose `words` is farmland.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `feat: insert candidates beside the road ahead`.

### Task 4: Insert scripts, audio, side clips and `POST /v1/inserts`

**Files:**
- Modify: `packages/core/src/inserts.mjs`, `packages/core/src/dynamo.mjs`, `packages/api/src/app.mjs`, `packages/api/src/lambda.mjs`
- Test: `packages/core/test/inserts.test.mjs`, `packages/core/test/dynamo.test.mjs`, `packages/api/test/app.test.mjs`

**Interfaces:**
- Consumes: Task 3 `insertCandidates`; `speak()` (Task 2 shape); `putAudio`; voices `localeOf`/`idOf`.
- Produces: `export async function insertsAhead(req, user, d, cfg): Promise<{ inserts: InsertOut[] }>` with `InsertOut = { id, title, kind, lat, lng, side, aheadM, exit?, ready: boolean, audioUrl?, durationS?, sideClipUrl?, sideClipS? }`; store methods `getInsert(id, lang)`, `putInsert(id, lang, { title, script })`, `addInsertAudio(id, lang, voice, audio)`, `getClip(voice, phrase)`, `putClip(voice, phrase, audio)` (pk `I#<id>#<lang>` / `C#<voice>`, ttl 90 days); route `POST /v1/inserts` body `{ lat, lng, heading (required), speed, curve, voice, level, exclude: string[] ≤ 500 }`.

- [ ] **Step 1: Write the failing tests**

```js
test("an insert's script is written once per place, language and level, side-neutral, 25-50 words", async () => {
  // complete() fake records the prompt: contains "never say left, right, coming up or passed"; second request -> no new write
});
test("audio is made only for places within voiceAheadS; farther ones come back ready: false", async () => {});
test("the side clip is the voice's own 'On your left,' / 'On your right,', voiced once and reused", async () => {});
test("at most writePerCall new scripts per request; the rest wait for the next poll", async () => {});
test("POST /v1/inserts needs a heading; returns the inserts; bad input is refused", async () => {});
```

- [ ] **Step 2: Run** `npm test`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Script prompt: one or two sentences a friend says as the car passes, facts only, the exit if any ("it's off exit 173"), `cfg.insert.words` range, the listener's language; light model. Audio and clips via `speak()` + `putAudio("library/<uuid>.mp3")`. Wire the route with `library`-style deps in `lambda.mjs`. Log one JSON line per request: `{ msg: "inserts", candidates, written, voiced, ms }` (for tuning).
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Deploy and check live:** `cd MileMuseInfra && npx cdk deploy MileMuseServices --profile milemuse --require-approval never`; a scratch script posts `/v1/inserts` on Lowell-Larimer Road (47.9200, -122.1700, heading 120, speed 18) and plays the returned side clip + insert. Expected: at least one `ready: true` insert with both URLs, HTTP 200.
- [ ] **Step 6: Commit** `feat: roadside inserts (shared scripts, late voicing, side clips)`.

### Task 5: App config and player position

**Files:**
- Create: `MileMuseApp/src/config.ts`
- Modify: `MileMuseApp/src/api.ts`, `MileMuseApp/src/native.ts`
- Test: `MileMuseApp/src/config.test.ts`, `MileMuseApp/src/api.test.ts`, `MileMuseApp/src/native.test.ts`

**Interfaces:**
- Consumes: Task 1 `GET /v1/config`; Task 2 narrate fields; Task 4 `POST /v1/inserts`.
- Produces: `export type NarrationConfig` (Global Constraints shape); `export const DEFAULT_CONFIG: NarrationConfig`; `export async function loadConfig(get = getConfig): Promise<NarrationConfig>` (last good copy kept in memory; defaults on failure); `api.getConfig()`, `api.inserts(at, heading, speed, curve, voice, level, exclude): Promise<InsertItem[]>` with `export type InsertItem` = Task 4's `InsertOut` fields; narrate opts `{ mode?: "background" }` and `Segment` gains `breaksMs?: number[]`; `native.play(uri, title, mood?, fromS?)` seeks to `fromS` when > 0; `native.positionS(): number`.

- [ ] **Step 1: Write the failing tests** — `loadConfig` merges a partial server config over defaults and returns defaults when the call fails; `api.inserts` posts the exact body; `play(..., 42)` calls `seekTo(42)`; `positionS()` reports the player's current time.
- [ ] **Step 2: Run** `npm test`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the four pieces.
- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit -p .`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat: app reads the live narration config; player resume position`.

### Task 6: The lanes scheduler

**Files:**
- Create: `MileMuseApp/src/lanes.ts`
- Test: `MileMuseApp/src/lanes.test.ts`

**Interfaces:**
- Consumes: `createFreeDrive` (lane B, unchanged API), `NarrationConfig`, `InsertOut` (as `InsertItem`).
- Produces: `export type LanePlayer = { play(uri: string, title: string, mood?: Mood, fromS?: number): void; positionS(): number }`; `export type FetchInserts = (at: LatLng, heading: number, speedMps: number, curve: number, exclude: string[]) => Promise<InsertItem[]>`; `export function createLanes(player: LanePlayer, fetchSegment: FetchSegment, fetchInserts: FetchInserts, cfg: NarrationConfig, log?: (line: string) => void): DriveLike & { newStory(): void; heardInserts(): string[] }`.

- [ ] **Step 1: Write the failing tests** (fake player records `play` calls; fixes at 25 m/s)

```ts
test("an insert due mid-segment waits for the sentence break before its moment, then side clip, insert, bridge, resume", ...);
  // segment breaksMs [8000, 21000, 40000]; place reached in 30 s; leadS 8 + clip 1.5 s -> must start by 20.5 s
  // the last break at or before 20.5 s is 8.0 s: at position 8 s plays clip, insert, bridge; then the segment with fromS === 8
test("no break in time: it pauses at latestS before the place", ...);
test("an insert whose place would be passed before it can play is dropped and logged missed", ...);
test("one insert per minSpacingS: the nearer wins, the other is skipped", ...);
test("between segments, a due insert plays at once; the next segment follows it", ...);
test("the bridge is skipped when under resumeMinS of the segment is left: the next segment plays instead", ...);
test("inserts are polled every pollM of travel, never while parked, and a failed poll waits for the next pollM", ...);
test("a live answer takes priority; an insert whose place passes meanwhile is dropped", ...);
```

- [ ] **Step 2: Run** `node --experimental-test-module-mocks --test src/lanes.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `createLanes`: lane B is `createFreeDrive(innerPlay, fetchSegment)` whose `innerPlay` records the segment (uri, title, mood, `breaksMs`) and forwards to `player.play`; the scheduler intercepts `onFinished` while an insert sequence (clip → insert → gap → bridge) runs and forwards it to lane B only for segment ends. Insert start time per item: `wantS = aheadM / speed − leadS − sideClipS`; pause point = the last break in `(pos, pos + wantS]`, else `wantS − latestS`. Log lines: `insert played: <title> <s> s before`, `insert missed: <title>`, `segment paused at <s> s, resumed`.
- [ ] **Step 4: Run** the test file, then `npm test` and `npx tsc --noEmit -p .`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: lanes scheduler (inserts over background segments)`.

### Task 7: Wire Just drive to lanes, measure, ship

**Files:**
- Modify: `MileMuseApp/src/session.ts`
- Create: `MileMuseApp/scripts/drive-summary.mjs`
- Test: `MileMuseApp/src/session.test.ts`

**Interfaces:**
- Consumes: Tasks 5–6.
- Produces: Just drive uses `createLanes` when `config.lanes.enabled`, else today's `createFreeDrive`; segments are asked with `mode: "background"` and `words = cfg.segment.words[level]`; inserts with the listener's voice and level, excluding `heardInserts()`.

- [ ] **Step 1: Write the failing tests** — with lanes enabled, `startFree()` asks narrate with `mode: "background"` and `words === 180` (normal); with `lanes.enabled: false` it asks as today (no `mode`).
- [ ] **Step 2: Run** `npm test`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the switch in `startFree`; `drive-summary.mjs <drive-log.txt>` prints played/missed counts and the median "s before" per insert.
- [ ] **Step 4: Verify end to end:** `npm test`, `npx tsc --noEmit -p .`; Android `./gradlew assembleRelease`; iPhone via `~/Projects/install-iphone.command` (Mac GUI session). On the phone: a Just drive down Lowell-Larimer Road; pull `Documents/drive-log.txt` with `xcrun devicectl device copy from ... --domain-identifier com.milemuse.app`; run `node scripts/drive-summary.mjs drive-log.txt`. Expected: inserts played 5–12 s before their places, none played after.
- [ ] **Step 5: Commit** `feat: Just drive in two lanes (config switch)`.
