# Two-lane narration: roadside inserts on the fly, background stories ahead of time

Date: 2026-11-07. Status: draft for approval.

## Why

A Normal story runs ~2 minutes and a Deep one ~4. At 65 mph the car covers 3.5–7 km while one plays, so anything
it says about "here" or "on your left" is stale by the end, and widening the search to fill the time drags in
places that aren't part of the drive (the Everett Mall on Lowell-Larimer Road). The listener wants what is beside
the road told *as it passes*, and the deeper history and character of the area told around it, with every distance
and length tunable so we can find the sweet spot by driving.

## Goals

1. **Roadside inserts (lane A), on the fly.** Short (10–25 s) snippets about what is right beside the road: a
   landmark, the farm fields, a place to stop off an exit. Each plays so its "on your left" lands just before the car
   passes, in the current story's next sentence break.
2. **Background stories (lane B), ahead of time.** Area-level segments (town and county history, nature, farming,
   culture, by the listener's categories and the moment) in short segments (45–90 s), written and voiced before
   they're needed for the area the car is heading into, and shared through the story library.
3. **One conversation.** Both lanes carry the drive's context (the last 5 summaries) so a segment resumes naturally
   after an insert and never repeats it.
4. **Tunable without an app release.** Every distance, length and rule lives in one narration config, served by the
   server and adjustable live.
5. **Measurable.** Each insert logs where it actually played relative to its place, each segment whether it was cut,
   so tuning is by data, not feel.

## Non-goals

- Turn-by-turn navigation or predicting turns in Just drive (inserts use the heading and bend as today).
- Changing planned trips' place stories (they become lane A cues as they are; today's gap filling becomes lane B).
- New content sources (Wikipedia, Amazon Location places, USDA crop map, OSM exits, Open-Meteo stay).

## Anti-goals

- An insert that names a place already passed, or one more than ~1.5 km off the road.
- Choppy audio: never cut mid-sentence, never two inserts back to back without a breath of background.
- A config change that needs an app update.

## Design

### Lane A: roadside inserts

- **What qualifies:** a place within `insert.radiusM` (default 300 m) of the road ahead (heading + bend, as today),
  reached within `insert.lookaheadS` (default 120 s): Wikipedia landmarks worth telling, a change in the land beside
  the road (crop map: "blueberry fields start on your right"), and on freeways one stop off an exit ahead.
- **Shared scripts:** each insert's script is written side-neutral ("The old Lowell mill was built in 1890…") and
  kept in the story library per place, language and level, so every driver in either direction reuses it. The side
  comes from a tiny pre-voiced clip per voice ("On your left,", "On your right,", "Coming up on your left,"),
  played first. Exit numbers are in the script (they don't depend on direction).
- **Voiced late:** scripts are written when a place enters the lookahead; audio is made only when it is within
  `insert.voiceAheadS` (default 60 s), so places lost to a turn cost a little text, not audio.
- **API:** `POST /v1/inserts { lat, lng, heading, speed, curve, voice, exclude }` returns the places ahead with their
  side, distance, script status and, once voiced, `audioUrl`, `durationS`, `sideClipUrl`. The app calls it about
  every `insert.pollM` (default 400 m) of travel.

### Lane B: background stories

- Area-level segments: the town and county articles, the land and farm country, the moment, the listener's category
  for this segment, nearby places only as context (never with a side, never "coming up").
- Length per level: `segment.words` `{ light: 120, normal: 180, deep: 240 }` (~50 s / 75 s / 100 s), so even Deep
  stays close to where it was written; Deep means more segments and more depth per area, not one long story.
- Library key: the ~5 km area (geohash5), category, level, moment bucket, language. Shared across listeners and
  prefetched `segment.prefetch` (default 2) segments ahead for the area being driven into.
- Each segment returns its sentence breaks (ms), already computed for stereo placement, so the app can pause cleanly.
- API: today's `POST /v1/narrate` with `mode: "background"`; the old single-lane mode stays for comparison.

### The scheduler (app, pure and tested: `src/lanes.ts`)

- Plays lane B continuously; keeps `segment.prefetch` segments ready.
- For each insert, computes when its side clip must start so it lands `insert.leadS` (default 8 s) before the place.
  At the next sentence break at or before that moment, it pauses lane B (remembering the position), plays the side
  clip and insert, waits `insert.gapS` (default 2 s), plays a short bridge clip ("Anyway,") if the paused segment has
  more than `segment.resumeMinS` (default 10 s) left, and resumes. Otherwise it moves to the next segment.
- If no sentence break comes in time, it pauses at `insert.latestS` before the place regardless (rare).
- An insert that would play after its place is dropped and logged as missed. At most one insert per
  `insert.minSpacingS` (default 20 s); the nearer place wins.
- Music ducks under both lanes as today. Answers to questions still take priority over both.
- Planned trips: their cues are lane A (timed by the existing TriggerEngine), lane B fills between them.

### Config

- One JSON document, defaults in `core/src/narration-config.mjs`, overridden by an SSM parameter
  (`/milemuse/narration-config`), cached 5 minutes in the Lambda. `GET /v1/config` returns it; the app fetches it at
  start, keeps the last copy, and falls back to its built-in defaults offline.
- Every number above (radius, lookahead, voice-ahead, lead, gap, spacing, words per level, prefetch, resume threshold,
  tell radius, poll distance), plus `lanes.enabled` to switch between two-lane and today's single-lane narration.

### Measuring

- The drive log and the server log each insert: planned vs actual start (seconds before the place), dropped or played,
  and each segment: played fully, paused/resumed, or cut. A small script summarises a drive so we can tune.

## Decisions already made

- Mid-story inserts pause at the end of the current sentence, then the story resumes (the user's choice).
- Inserts are side-neutral and shared, with pre-voiced side clips (my call, for cost and reuse).
- Side and bridge clips exist per language (English, Spanish, Tamil), voiced once per voice and cached (my call).
- Offline downloads hold lane B segments only; inserts need a connection, and lane B simply plays on without them
  (my call).
- Credits: both lanes count words as today (tracked, not enforced) (my call).
- Car screens show the insert's place as the title while it plays, then the segment again (my call).

## Left to the builder

- Exact default numbers (above are starting points), bridge-clip wording, how the library stores inserts, polling
  cadence on the car screens, and how the drive log summary looks.
