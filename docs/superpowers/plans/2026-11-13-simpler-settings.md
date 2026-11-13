# Simpler Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Story settings locked during a drive. Depth follows speed (no Level). One server-defined Style bar replaces
Tone and Topics. Other apps' audio pauses ours. Everything the listener triggers is charged.

**Architecture:**
- The server ships first and stays compatible with older apps: it keeps accepting `words`, `topics` and `level`.
- The app then stops sending level words and topics, locks its story settings during a trip, reports every charged
  play, and switches its audio session to `doNotMix`.
- iPhone gets a spoken-audio session mode from our native module.

**Tech Stack:** Node ESM (`node --test`) for MileMuseService; Expo React Native with TypeScript (`npm test`,
`npx tsc --noEmit`) for MileMuseApp; Swift for `modules/milemuse-platform`.

**Spec:** `docs/superpowers/specs/2026-11-13-simpler-settings-design.md`. Its "Owner's answers" section is binding.

## Global Constraints

- **Style ids stay** `delightful`, `funny`, `serious`, `crazy`. Labels: Easygoing, Funny, Just the facts, Deep dive.
- **Depth bands:**
  - Deep below 25 mph: 500 words, segment 240.
  - Normal from 25 to 45 mph: 300, segment 180.
  - Over 45 mph: normal, or light (150, segment 120) when fewer than 3 usable facts.
- **No speed:**
  - A live drive request is deep.
  - A `prefetch`, `offline` or `focus` request is normal.
- **Prices:** 2 credits per story, whatever its length. 1 credit per mic question.
- **Locked during a trip:** `tone`, `voice`, `lang`, `party`, `personal`, `trivia`, `jokes`, `units`, `commute`.
  - Lock copy: "Stop the drive to change this". Toast: "Stop the drive first to change this".
- **Still live during a trip:** `pace`, `music`, `musicVolume`. Night map and Appearance stay as they are.
- **Older apps' requests** (`words`, `topics`, `level`) behave as today.
- **No Polly or Bedrock bulk runs.** Style samples for the owner come before the server deploy.

## Review Focus

1. A request with `words` still gets the level path and the band caps (an old app). Owned by Task S2:
   `test("a request with words keeps today's capped length")`.
2. A preload, download or place story with no speed gets normal, never deep. Owned by Task S2:
   `test("no speed: deep for a live drive, normal for prefetch, offline and focus")`.
3. A story-setting change arrives through sign-in sync or a second phone during a trip. The lock is for the listener's
   own edits only. Owned by Task A1: `test("account sync during a trip still applies")`.
4. The OS pauses the story for other audio, and the watchdog doesn't restart it. Owned by Task A5:
   `test("a pause from the OS is not restarted by the watchdog")`.
5. The same story is downloaded, then played live. It is charged once (the ledger ref `heard:<id>` is unique). Owned
   by Task A4: `test("a downloaded story played later is reported with the same id")`.

---

### Task S1: Styles in the catalogue (service core)

**Files:**
- Modify: `packages/core/src/narration-config.mjs` (`TONES`, catalogue checks)
- Modify: `packages/core/src/narrate.mjs` (`storySystem`, segment jokes)
- Test: `packages/core/test/narration-config.test.mjs`, `packages/core/test/narrate.test.mjs`

**Interfaces:**
- Produces: each tone is `{ id, label, blurb, prompt, topics: string[] }`. `topics` holds ids from `TOPICS`.
- `toneOf(tone, cfg)` keeps its signature.

- [ ] **Step 1: Failing tests.**
  - `test("the four styles: ids kept, plain labels, each with a topic mix of known topics")`. Asserts the labels
    `["Easygoing","Funny","Just the facts","Deep dive"]` and that every `topics` entry is a `TOPICS` id.
  - `test("each style's prompt carries its fact budget")`:
    - Funny matches `/about 2 facts/` and `/joke/`.
    - Just the facts matches `/6 or more facts/` and `/no jokes/i`.
    - Deep dive matches `/one subject/` and `/about 5/`.
    - Easygoing matches `/about 3 facts/`.
  - `test("Just the facts: no segment joke, whatever the jokes setting")`.
- [ ] **Step 2: Run.** `node --test packages/core/test/narration-config.test.mjs`. It fails on the labels.
- [ ] **Step 3: Implement.**
  - Relabel the tones and rewrite each prompt with the spec's budget. Funny: comedy first, a joke or playful aside in
    most sentences, ends on a laugh, never about a tragedy.
  - Add `topics` to each tone.
  - The catalogue check keeps any tone whose `topics` is missing.
  - The segment joke is skipped when `toneOf(tone).id === "serious"`.
- [ ] **Step 4: Run** the core suite: `npm test -w packages/core`. Expect PASS.

### Task S2: Depth from speed (service core and API)

**Files:**
- Modify: `packages/core/src/narration-config.mjs`. Add to `DEFAULTS`:
  `depth: { deepBelowMph: 25, lightAboveMph: 45, words: { deep: 500, normal: 300, light: 150 }, segmentWords: { deep: 240, normal: 180, light: 120 }, thinFacts: 3 }`.
- Modify: `packages/core/src/narrate.mjs`. Add `depthWords(o: { speedMps?: number, segment?: boolean, noSpeedNormal?: boolean, facts?: number }, cfg) -> number`.
  In `writeStory`, an absent `words` takes `depthWords` and skips `capWords`.
- Modify: `packages/api/src/wire.mjs` and `packages/api/src/app.mjs`, so an absent `words` stays absent.
- Test: `packages/core/test/narrate.depth.test.mjs`.

**Interfaces:**
- Produces: `depthWords`, exported from `narrate.mjs`.

- [ ] **Step 1: Failing tests.**
  - `test("speed picks depth")`:
    - 5 m/s gives 500.
    - 15 m/s gives 300.
    - 25 m/s with 5 facts gives 300; with 2 facts it gives 150.
    - With `segment: true`: 240, 180, 180 and 120.
  - `test("no speed: deep for a live drive, normal for prefetch, offline and focus")`.
  - `test("a request with words keeps today's capped length")`.
- [ ] **Step 2: Run.** It fails because `depthWords` is not exported.
- [ ] **Step 3: Implement.**
  - mph to m/s is ×0.44704.
  - The thin check runs after facts are gathered (places plus area facts), only over 45 mph.
- [ ] **Step 4: Run** the core and API suites. Expect PASS.

### Task S3: Flat prices and question charges (service core and API)

**Files:**
- Modify: `packages/core/src/credits.mjs`.
  - `storyCost = () => 2`.
  - Add `creditsFor(ref: string) -> number`: 1 for `heard:ask:`, else 2.
  - `charge` uses `creditsFor(ref)`.
- Modify: `packages/api/src/app.mjs`. `/v1/stories-heard` item ids may start `ask:` (40 characters at most).
- Test: `packages/core/test/credits.test.mjs`, `packages/api/test/app.test.mjs`.

- [ ] **Step 1: Failing tests.**
  - `test("every story is 2 credits, whatever its words")`.
  - `test("a mic question is 1 credit")`: charges ref `heard:ask:abc` 1.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run.** PASS.

### Task S4: Planned trips follow the settings (core, API, pipeline)

**Files:**
- Modify: `packages/api/src/app.mjs` (`/v1/trips` accepts `tone`, `voice`, `party`; `level` stays for old apps).
- Modify: `packages/pipeline/src/handler.mjs` (the plan job carries them).
- Modify: `packages/core/src/trips.mjs` and `packages/core/src/scriptgen.mjs`.
  - `planTrip(tripId, { from, to, level, tone, voice, party }, d)` stores `style = "<tone>|<party>"`,
    `narrator = voice` and `lang =` the voice's language (`voices.mjs`).
  - `makeStory` writes with the tone's prompt, the party and the voice's language, and calls `d.speak(script, narrator)`.
- Test: `packages/core/test/trips.test.mjs`.

- [ ] **Step 1: Failing tests.**
  - `test("a planned trip's stories carry its style, party, voice and language")`. With funny, family and Amy, the
    insert has style `funny|family`, narrator `Amy` and lang `en`.
  - `test("makeStory writes in the trip's tone and voices with its narrator")`.
  - `test("an old app's trip (no tone) is storyteller, Matthew, English as before")`.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run** the full service suite (`npm test`). Expect PASS.
- [ ] **Step 5: Commit, PR, merge.** Message: `feat: one style bar, depth from speed, flat prices, planned trips follow settings`.

### Task A1: Story settings locked during a trip (app)

**Files:**
- Modify: `src/model.ts`. Add `STORY_PREFS: (keyof Prefs)[]` with the Global Constraints list.
- Modify: `src/session.ts`. `update(f)` returns `boolean`. While `s.trip`, a change to any `STORY_PREFS` key is
  refused: it returns `false` and sets the notice "Stop the drive first to change this". `mergeState` (account sync)
  is not blocked.
- Modify: `src/screens/you.tsx` and `src/screens/explore.tsx` (the route sheet before a trip stays editable). Story
  rows are disabled during a trip, with the caption "Stop the drive to change this".
- Test: `src/session.prefs.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `test("during a drive a story setting can't change: refused, unchanged, and the listener is told")`.
  - `test("during a drive voice pace and music still change")`.
  - `test("account sync during a trip still applies")`.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run.** PASS.

### Task A2: No Level (app)

**Files:**
- Modify: `src/session.ts`. `tasteOf` sends no `words`, and two-lane segments send no `words`. Offline downloads,
  the preload and place stories also send none: the server picks normal.
- Modify: `src/api.ts`. `createTrip(from, to, taste: { tone, voice, party })` sends no level. `narrate` registers
  plays with `words: 300` when none is given.
- Modify: `src/model.ts`. `tripCost(stories) = stories × 2`. `LEVELS` is used only by old trips' summaries.
- Remove:
  - the Level UI: the Stories subtitle, the "Level and topics" row, onboarding's level step, the route plan's Story
    level card and sheet
  - the trip summary's level question
  - `levelHint` and `levelOffer` in `lists.ts`, and the drive-start "Switch to" prompt in `trips.tsx`
  - the Wallet's level prices (now "Story · 2 credits" and "Live question · 1 credit")
  - the Calculator's level picker
- Test: `src/model.test.ts`, `src/api.test.ts`, `src/lists.test.ts`, and the session tests that asserted words.

- [ ] **Step 1: Failing tests.**
  - `test("a drive's story request carries no words: the server picks by speed")`.
  - `test("a trip is planned with the listener's style, voice and party")`.
  - `test("trip cost is 2 credits a story")`.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** Delete the level-feedback tests with their code.
- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit`. Expect PASS.

### Task A3: The Style bar, no Topics (app)

**Files:**
- Modify: `src/config.ts`. `ToneDef` gets `blurb` and `topics?: string[]`, and `BUILT_IN_TONES` gets the new labels.
- Modify: `src/model.ts`. `lensFor(tone: string | undefined, n: number) -> Topic | undefined` rotates through the
  style's `topics` from `tonesOf()`, else through every topic. `tasteOf` sends no `topics`.
- Remove:
  - the Topics picker and favourites (Stories screen, onboarding)
  - the car's Topics folder and its topic drives (`carlib.ts`)
- Add: the Style `SegmentedControl` with the chosen style's blurb under it, in You > Stories and on the route sheet.
- Test: `src/model.test.ts`, `src/carlib.test.ts`, `src/session.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `test("the angle rotates through the style's topics")`.
  - `test("a style with no topic list rotates through every topic")`.
  - `test("the car has no Topics folder")`.
  - `test("a story request sends the style, no topics")`.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` and tsc. Expect PASS.

### Task A4: Charge what the listener triggers (app)

**Files:**
- Modify: `src/api.ts`, `src/session.ts`, `src/drive.ts`, `src/screens/you.tsx` (Offline downloads) and
  `src/screens/explore.tsx` (Refresh).
  - The preloaded first story is registered for charging, and charged once it starts playing.
  - `preload(true)` makes a new story only when the phone moved more than 1 km or the taste changed.
  - A planned trip's story is reported (its story id) when it starts playing.
  - A mic answer is reported as `ask:<id>` once it plays.
  - A download reports every story it saved, in batches of 50. The price shows before the button:
    "About N stories, X MB, M credits".
- Test: `src/session.test.ts`, `src/session.offline.test.ts`, `src/api.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `test("the first story is charged when it plays")`.
  - `test("Refresh at the same spot keeps the first story")`.
  - `test("a planned story is charged when it starts")`.
  - `test("a question is charged once its answer plays")`.
  - `test("a download is charged per story, with the price shown first")`.
  - `test("a downloaded story played later is reported with the same id")`.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run.** PASS.

### Task A5: Other apps' audio first (app and iOS native)

**Files:**
- Modify: `src/native.ts`.
  - The audio mode is always `interruptionMode: "doNotMix"`.
  - Remove `setDucking`.
  - After each `setAudioModeAsync` on iOS, call `MileMusePlatform.setSpokenAudio()`.
  - The watchdog treats an OS pause as a pause.
- Modify: `modules/milemuse-platform/ios/MileMusePlatformModule.swift`. Add
  `Function("setSpokenAudio") { try? AVAudioSession.sharedInstance().setMode(.spokenAudio) }`.
- Remove: the "Lower other audio" row, the `duck` pref (tolerated when it comes back from the account) and `App.tsx`'s
  `setDucking` effect.
- Test: `src/native.test.ts`, `src/hold.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `test("the audio session never mixes with other apps")`.
  - `test("a pause from the OS is not restarted by the watchdog")`.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` and tsc. Expect PASS.
- [ ] **Step 5: Commit, PR, merge.** Message: `feat(settings): locked during a drive, no level or topics, style bar, other apps first, every play charged`.

### Release

1. Write 2 sample stories per style at two places and two speeds, locally with the new prompts. The owner listens and
   approves.
2. Deploy the service, after `cdk diff`. Both checkouts must equal origin/main and be clean.
3. Build Android (arm64-v8a) and iPhone, and check on a device:
   - Other music pauses the story.
   - A nav prompt pauses it, then it resumes.
   - Story rows are locked during a drive.
   - Credits move as priced.
