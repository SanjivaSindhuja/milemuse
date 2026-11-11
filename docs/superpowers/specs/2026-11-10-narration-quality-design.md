# Narration quality: smoother inserts, less repetition, tones, speed-aware stories, exits, local numbers

Date: 2026-11-10. Repos: MileMuseService (server), MileMuseApp (phone). Infra unchanged unless noted.

## Why

Field tests (Nov 9–10, Everett/Snohomish, freeway and town roads) showed:

- Left/right roadside inserts chop the story they interrupt.
- Themes repeat across stories (movies/Hollywood, logging/timber) even though places don't.
- Filler phrasing ("nestled", "boasts", "rich history", "picture this") — some listeners like it, many don't.
- A story prepared at speed about places 1–2 miles ahead plays while the car sits in traffic: out of context. Same in
  town at 25–35 mph, not only on freeways.
- Exit inserts name one stop; drivers want to know what's off the exit (gas, food, groceries, things to do).
- "Look over to the left" assumes the listener can see the place; often they can't (trees, sound walls, distance).
- Stories have no numbers: population, area, founding year, incomes — the concrete facts that make a place stick.
- Ads will later need brand mentions at exits; the code should have a slot for that now.

Success: on a 30-minute drive mixing freeway and town, no story is cut mid-sentence, no theme is told twice, no story
talks about places the car is nowhere near, side wording never assumes sight, exits list what's there, and town
stories carry at least one sourced, dated number when one exists.

## Goals / non-goals / anti-goals

Goals: the eight changes below, each behind the existing narration config where it has tunable numbers.

Non-goals: real ad brand deals (only the interface); business/sales counts (Census County Business Patterns: later);
a second "style" setting; changing voices or TTS providers.

Anti-goals (failure even if it works):
- A number the model made up, or one without its year. Numbers come only from the facts.
- More than 4 versions of each shared story (cost and cache hit rate).
- An insert that waits so long for a sentence break that its place has gone by.
- Any personal data in shared stories (unchanged rule from the personalization work).

## Decisions (made with the owner)

### 1. Tones replace a filler setting

One setting, **Tone**: `delightful` (default), `funny`, `serious`, `crazy`. Filler control is folded in:

- delightful: warm, natural, light on flourish; avoid the banned-phrase list.
- funny: jokes and playful asides; some colour allowed.
- serious: plain and factual, no filler at all, no jokes.
- crazy: over-the-top, wild comparisons, still true to the facts.

Set once in You (settings); the trip start screen shows it as a one-tap chip row so a single drive can differ.
Tone joins the story system prompt (storySystem settings block) and the library key (`#t:<tone>`), so at most 4
versions per story. A shared "banned phrases" list (nestled, boasts, hidden gem, rich history, rich tapestry, picture
this, imagine, interestingly, it's worth noting, a testament to, steeped in, vibrant) lives in the narration config so
it can change without a deploy; delightful and serious must avoid it, funny/crazy may use it sparingly.

Existing library entries (no tone) count as `delightful`: no cache wipe.

### 2. Inserts never cut a story

App (lanes.ts):
- Never start an insert mid-sentence. Today, with no sentence break in time and the insert due (`latestS`), it starts
  at the current position (lanes.ts:270). Instead: fade the story out over ~400 ms, play the insert, and on resume
  start from the beginning of the interrupted sentence (the last break before the pause point).
- Fade in on resume (~300 ms).
- Always say a short bridge when resuming ("Anyway," and the server's other voiced bridges), not every other time.
- If less than `segment.resumeMinS` is left, still finish the story unless the next one is already due (today it
  is dropped).

### 3. No repeated themes

Server: the writer already returns a SUMMARY line; it also returns `THEMES: a, b, c` (1–3 short lowercase themes from a
fixed vocabulary in the config, e.g. logging, film, railroads, rivers, farming, war, music, sports, industry, native
history, disasters, architecture, food, nature). Stored on the story (`themes`).

Phone: keeps the themes heard in the last 30 min (with `past`) and sends them (`past.themes`).

Server: a library candidate whose themes overlap past themes is skipped (falls through to the next candidate or a new
write). The writer's prompt lists themes already used: "Do not build this story around: …". A place whose main
fact is a used theme may still be told, but from another angle.

### 4. Speed-aware stories, every road

Speed bands (config, mph shown; server uses m/s):

| band | speed | story about | length |
| --- | --- | --- | --- |
| still | < 10 mph | where the car is (radius ~800 m), no "coming up", no sides | level's length |
| town | 10–45 mph | places within the time to pass them (≤ ~1 km ahead or around) | min(level, ~90 s) |
| freeway | ≥ 45 mph | as today (aheadM = speed × TELL_S, capped) | min(level, ~120 s) |

The phone sends speed (it already does) and the server picks the band. Length is capped per band, not raised.

Play-time staleness (phone): when a prepared segment is about to start, if the car is more than `staleM` (config,
~1.5 km) from where it was requested, or the segment's ahead-places are now behind or beyond reach at current speed,
the segment is dropped and a fresh one requested. Applies to background segments and library picks alike.

### 5. Exits tell what's there

Server (inserts.mjs, freeway only, as today): at the next exit with stops, collect places off it by kind (fuel, EV
charging, food, coffee, grocery, things to do, lodging if available) and write one line: "Exit 194: gas, an EV charger,
a few places to eat and a grocery." No brand names by default. Searches reuse map-cell caching where possible
(placesNearby SingleUse stays for stops; the exit summary may use the cached `mapPlaces` cell around the exit).

### 6. Ads: a brand slot

A `sponsor(exit, kinds) → { brand, line } | null` hook in the insert writer's deps, default returning null. When it
returns something, the exit line may name that brand once ("…a few places to eat, including <brand>"). Behind
`ads.enabled` and a new `ads.spoken` config flag (default false). No partner integration now.

### 7. Sides without assuming sight

- Lead-ins (languages.mjs) drop "If you glance left", "Look over to the left": keep position words ("Off to your left,",
  "Over on the left,", "On the left side of the road,").
- Prompt rule (story and insert writers): say where a place is (side and rough distance: "about half a mile off to the
  right") and never ask the listener to look or assume they can see it, unless the facts mark it visible: on the road
  itself (a bridge, a river crossing), a mountain/peak, or within ~150 m of the road.
- Sentence panning (spatial.mjs) unchanged.

### 8. Local numbers

New lookup `stats(place)`, cached in the shared lookup table 30 days per place:

- Wikidata (worldwide, CC0): population (P1082, with point-in-time year), area (P2046), elevation (P2044), inception
  (P571), named after (P138). Reached from the Wikipedia page's wikibase item (pageprops) for the town/city/county the
  car is in (reverseGeocode) and for told places that are settlements.
- US Census ACS 5-year API (US only, public domain; key optional): for the place/county: median age, median household
  income, median home value, mean commute minutes, share working from home. Year is the ACS vintage.

Facts block line: `NUMBERS (data, each with its year): Everett: population 111,180 (2020); area 125 km²; founded 1893; median age 36 (ACS 2022)…`.
Prompt rule: use a number only from NUMBERS, say its year when it matters, round naturally ("about 110,000"), at most
two numbers per story, and only when they add something.

## Calls made after the builder check (owner may override)

- **Speed band in the key (my call):** foreground story keys replace today's freeway flag with the band (`s|t|f`);
  background segment keys stay as they are and rely on the phone's staleness drop. The "at most 4 versions" anti-goal
  means 4 tones per key, not counting the band.
- **Tone reaches stories and background segments only (my call, pending owner):** roadside/exit inserts, lead-ins and
  bridges stay neutral (short facts; 4× insert voicing cost for little gain).
- **Numbers are optional (my call):** every story writer gets NUMBERS when the lookup has them; the model uses them only
  when they add something. Acceptance: no unsourced or undated number; a number appears in most town stories.
- **Exit summary replaces the single-stop exit insert (my call):** one exit insert per exit; its id is `x:<exit ref>@<cell>`.
- **Planned trips and offline packs (my call):** tone and themes apply to newly written stories; the staleness drop
  never discards a planned-route or downloaded story (they are placed by position already), only live requests.
- **Inserts stay side-neutral (my call):** insert scripts never say left/right (cached without direction); they only get
  the "never ask them to look" rule. Sides stay in the lead-in clips, reworded per item 7.

Owner confirmed (Nov 10): tone stays off inserts, lead-ins and bridges.

### 9. Level × speed (owner question, answered)

Light/normal/deep keeps its meaning: how much is told (light: standout places only, short; deep: more places, more
detail). Speed bands only cap duration so the story stays in context. Effective length = min(level's length, band cap).
`still` has no cap (stuck in traffic, a deep listener gets the full deep story about where they are); `town` caps at
~90 s; `freeway` at ~120 s. Within a cap, light vs deep changes density and which places qualify, not just length.

### 10. Topics, favourites, tones from server config (no app release to change them)

`/v1/config` (narration-config.mjs, SSM-overridable) serves the catalogues the app renders:

- `topics`: `[{ id, label, icon, lens (the angle text the writer gets), on (default on), star (default favourite), order }]`
  — today's 21 topics move here from the app's TOPICS and the server's LENSES.
- `tones`: `[{ id, label, blurb, prompt }]` (the four tones; prompt text goes into storySystem).
- `themes` (vocabulary for item 3) and `bannedPhrases` (item 1).

The app renders topics/tones from config, keeps its bundled list as the fallback (offline, old config), ignores ids it
doesn't know, and drops a user's selected/starred ids that the catalogue no longer has. The server validates incoming
topic/tone ids against the live catalogue (unknown ids are dropped, not 400). Adding, renaming, reordering or retiring
a topic or tone is a config override only.

## Constraints

- Lambda cold-start and request latency: new lookups run in parallel with existing gathers and are cached; a failed
  lookup just leaves the line out.
- Shared story cache: one new key part (tone). Theme skipping must not starve the library (if every candidate
  overlaps, write new).
- Field verification on the owner's iPhone via the Mac (install-iphone.command) and the Android APK flow.
- All tunable numbers in `narration-config.mjs` (live-overridable via SSM).

## Left to the builder

Exact config numbers (fade ms, staleM, band edges within ±5 mph), the theme vocabulary's final list, Wikidata query
shape (SPARQL vs wbgetentities), ACS variable codes, the You-screen layout of the Tone row, test structure, and
the order of work (each item ships independently).
