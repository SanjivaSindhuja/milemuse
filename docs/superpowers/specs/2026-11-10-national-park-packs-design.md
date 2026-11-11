# National Park Packs: rich offline stories for every road in the US national parks

Date: 2026-11-10. Repos: MileMuseService (jobs, API), MileMuseInfra (schedule, workflow, CDN), MileMuseApp (park
pages, downloads, offline playback). Status: design approved in conversation; pilot first.

## Why

National parks are where MileMuse fits best and works worst today: families drive scenic roads for hours, and there is
usually no signal, so live narration stops. Offline packs exist (one story per ~5 km area around a point, built on the
phone from the live library), but they are generic, slow to build on the phone, and rebuilt whole.

Goal: every road in all 63 US national parks covered, every topic that has real material on that road told, packaged for
offline use, kept fresh by a server job every 30 days, synced to phones as a diff, showcased in the app, and free to try.

Success (pilot, then all parks): a family downloads a park's Essentials pack in under a minute on Wi-Fi, drives its
scenic road with no signal, and hears a story for every stretch and a short line for every named stop; a month later
the update is a few MB, not the whole pack again.

## Goals / non-goals / anti-goals

Goals
- Server-side content for every public road inside each national park, all topic categories that have material.
- Packs per park (and per road inside big parks), Essentials and Full.
- A 30-day priming job per park that rewrites and re-voices only what changed.
- Diff sync on the phone: download new or changed audio only, delete what was removed.
- App: a National Parks shelf, park pages, download/update/remove, offline playback inside the park, prompts near one.
- Pricing: Essentials free; first Full park free per account; then Plus or a park unlock (~$1.99).

Non-goals (now)
- Other tones, voices, levels or languages in packs (decided: one version, below).
- Other NPS units (monuments, seashores, recreation areas), trails, backcountry.
- Live data in stories (closures, hours, fees, events): it would be stale inside a 30-day cycle.

Anti-goals (failure even if it works)
- Regenerating every story every 30 days (cost ~$800/month for nothing).
- A pack the listener can't finish downloading (a whole big park in one file; no resume).
- A story stating a closure, an opening time, a fee or a date-bound event as current.
- Paid Full content reachable without an entitlement (public CDN paths).
- Anything personal in pack content (packs are shared by everyone).

## Decisions made with the owner

1. One pack version: **Delightful** tone (it's a national park), family-safe (kids on board is the norm), default
   narrator voice, English, normal level. Other tones/voices play online only.
2. Pricing: every park's **Essentials free**; **Full pack free for the first park** per account; after that included
   in **Plus** or a **park unlock (~$1.99)**.
3. **Pilot 5 parks** first (Mount Rainier MORA, Olympic OLYM, North Cascades NOCA, Yellowstone YELL, Yosemite YOSE)
   to measure cost, size and quality before all 63.

## Sizing (estimates to confirm in the pilot)

- Roads: NPS reports ~5,500 miles of paved road across all ~400 units; the 63 national parks hold an estimated
  ~3,000 miles (~4,800 km) of public road (Alaska parks have almost none; Yellowstone alone ~470 paved miles).
- Stretches: roads cut into ~1 km stretches -> ~4,800 stretches.
- Stories: Essentials = 1 story per stretch of the park's main scenic roads (~3,000). Full = every topic with material
  per stretch (avg 3-5 -> ~19,000) + one line per named stop (~3,000) + park-level overview per topic (63 x 21 max).
  Total ~25,000 items.
- Cost to build once: writing ~$0.005/story (light model, ~3k in / 400 out tokens) -> ~$125; voicing ~1,000
  characters at ~$30 per million characters -> ~$0.03/story -> ~$750. **~$900 once** for all 63 parks.
- Monthly: ~5% of stories change (edited articles, new NPS places) -> **~$40-50/month**; fact lookups are free APIs.
- Audio: packs encoded 32 kbps mono MP3 (speech): ~0.3 MB per 75 s story -> ~7.5 GB in S3 (~$0.20/month).
- Phone: Essentials ~10-25 MB per park; Full ~100 MB average, up to ~900 MB for Yellowstone -> **big parks download
  per road** ("Grand Loop Road", "Lamar Valley Road"); the park page offers "whole park" only when it is under ~250 MB.
- Manifest: ~3,000 entries x ~150 bytes -> ~450 KB raw, ~60 KB gzipped per park.
- CDN egress: ~$0.085/GB -> an Essentials download costs ~$0.002, a Full park ~$0.01.

## Sources

| Data | Source | Notes |
| --- | --- | --- |
| Park list, codes, boundary | NPS API `parks`, `mapdata/parkboundaries/{code}` | free key (owner signs up with an email) |
| Named stops, things to do, visitor centers, campgrounds | NPS API `places`, `thingstodo`, `visitorcenters`, `campgrounds` | public domain text; descriptions are rich facts |
| Roads inside the boundary | OpenStreetMap (Overpass), `highway` in {primary..residential, unclassified, service=park road}, `access` not private | ODbL: attribution in app |
| Landmarks and history | Wikipedia geosearch/extracts (existing shared cache) | CC BY-SA: attribution in About |
| Numbers | Wikidata (existing stats.mjs) | per park: area, established, elevation |
| Land beside the road | existing land.mjs | |
| Alerts/closures | NPS API `alerts` | shown live in the app, **never** baked into stories |

## Data model

Park → Roads → Stretches → Items.

- **Road**: OSM ways merged by name/ref into a route inside the park (e.g. "Going-to-the-Sun Road"); `{ id, name,
  km, polyline (simplified), essentials: bool }`. Essentials roads = the park's main through/scenic roads (top roads by
  length that connect entrances; a per-park override list in config for the pilot).
- **Stretch**: ~1 km of a road, `id = <park>:<road>:<n>`, its centre, start/end, bearing both ways.
- **Item** (what the phone plays), one of:
  - `story`: a stretch told from one topic, ~75 s, direction-neutral (no left/right: it is played either way);
  - `stop`: a 1-2 sentence line for a named place within ~300 m of a road (NPS place or Wikipedia landmark), told as
    the car approaches; its side is decided on the phone at play time (as roadside inserts do);
  - `overview`: a park-level story per topic (played when a stretch has no story for the listener's topic);
  - `lead`: the side lead-in clips ("Off to your left,") and bridges, voiced once.
- Every item carries `factsHash` (hash of the facts it was written from) and `hash` (of its audio bytes).

Topic coverage ("all our categories"): for each stretch, every topic in the live catalogue whose facts pass a minimum
(enough on-topic facts within the stretch's radius) gets a story; topics without stretch-level material are covered by
the park's `overview` for that topic. So every category is covered in every park, and stretches only carry real ones.

## Storage

- **DynamoDB** (existing Fast table, single-table):
  - `pk NP#<park>`, `sk META` — park name, boundary bbox, version, lastPrimedAt, status.
  - `pk NP#<park>`, `sk R#<road>` — road record.
  - `pk NP#<park>`, `sk I#<stretch|stop|overview>#<topic>` — item: text, factsHash, audio hash, bytes, durationS,
    themes, lat/lng, essentials flag. Text is kept (transcripts, re-voicing with another voice later).
- **S3** (existing audio bucket, behind CloudFront):
  - `parks/<park>/a/<sha256>.mp3` — content-addressed, immutable; cache `max-age=31536000, immutable`.
  - `parks/<park>/manifest-<v>.json` (immutable) and `parks/<park>/manifest.json` (latest, `max-age=300`).
  - No lifecycle expiry on `parks/`; the monthly job deletes audio no longer referenced by the **last two** manifest
    versions (a phone mid-sync still finds its files).
- **Paid content**: Full-only audio lives under `parks/<park>/f/`; Essentials under `parks/<park>/e/`. CloudFront
  serves `e/` publicly and `f/` only with a **signed cookie** issued by the API after an entitlement check (7 days).
  Infra: a CloudFront key group + trusted key; the private key in Secrets Manager.

## Manifest (one per park version)

```json
{ "park": "yell", "name": "Yellowstone", "version": 7, "generatedAt": "2026-12-01T03:00:00Z",
  "attribution": ["© OpenStreetMap contributors (ODbL)", "NPS", "Wikipedia (CC BY-SA)"],
  "roads": [{ "id": "grand-loop", "name": "Grand Loop Road", "km": 228, "essentials": true, "bytes": 18800000 }],
  "items": [{ "id": "yell:grand-loop:12:geology", "kind": "story", "road": "grand-loop", "topic": "geology",
    "lat": 44.46, "lng": -110.83, "durationS": 74, "bytes": 296000, "hash": "9f2c...", "tier": "e" }] }
```

`tier`: `e` (Essentials) or `f` (Full). URL = `parks/<park>/<tier>/<hash>.mp3`.

## Diff sync (phone)

- The phone keeps, per installed park: the manifest version, the set of item hashes on disk, the tier, the roads
  chosen.
- Check: `GET manifest.json` with `If-None-Match` (ETag) → 304 when unchanged (no cost).
- Diff: wanted = items in the new manifest for the installed tier and roads; download = wanted hashes not on disk;
  delete = hashes on disk no longer wanted. Content-addressed files mean an unchanged story is never re-downloaded,
  even if it moved roads or ids.
- Download: resumable and checkpointed (reuse offline.ts download patterns: parallel 3, checkpoint every 10, skip
  existing); verify bytes; on finish, write the new manifest locally (atomic swap), then delete removed files.
- When: on Wi-Fi by default (setting: allow cellular), on app open if the manifest is older than 7 days, and from the
  park page ("Update available — 12 MB").

## The 30-day priming job

- **Schedule**: EventBridge Scheduler runs **daily**; it picks parks whose `lastPrimedAt` is older than 30 days (and
  any marked `force`), so the 63 parks spread out (~2/day) instead of one monthly spike.
- **Workflow** (Step Functions standard, one execution per park):
  1. `Roads`: fetch the boundary and OSM roads; build roads/stretches; hash geometry (unchanged geometry keeps ids).
  2. `Facts` (Map over roads, concurrency 4): per stretch and stop, gather facts (Wikipedia, NPS places/things to do,
     Wikidata, land), compute `factsHash` per (stretch, topic).
  3. `Write` (Map over changed items, concurrency limited by Bedrock/Polly quotas): write and voice only items whose
     `factsHash` changed or that are new; unchanged items keep their audio hash.
  4. `Publish`: write `manifest-<v+1>.json`, then `manifest.json`; set `lastPrimedAt`.
  5. `Collect`: delete audio unreferenced by the last two versions.
- Each step is a pipeline Lambda invocation (15-minute cap) over a bounded batch (e.g. 50 stretches), so Yellowstone's
  first build runs as many short tasks. Failures retry per batch; the park keeps its last good manifest.
- Writer rules for packs (added to the story prompt): Delightful, family-safe, direction-neutral, never closures,
  hours, fees, dates of events, or "currently"; numbers only from NUMBERS (existing rule).
- Cost guard: a per-run budget (items written) in config; the job stops and alerts above it.

## API

- `GET /v1/parks` — list (code, name, state, image, Essentials/Full sizes, version, the listener's entitlement).
- `GET /v1/parks/<code>` — park page data (roads with sizes, alerts snapshot, attribution).
- `POST /v1/parks/<code>/access` — entitlement check/claim → signed cookie for `f/` (claims the free first park).
- Manifests and audio come straight from CloudFront.

## Entitlements and pricing

- Essentials: free for every signed-in listener (account needed, to keep abuse measurable).
- Full: the first park claimed per account is free (`pk U#<user>`, `sk P#<park>`, `source: free_first`); Plus gives
  all parks; otherwise a **park unlock** (consumable store product, ~$1.99) grants one park, through the existing
  billing service (credits/products).
- The UI states the rule plainly ("Your first full park is free").

## App

- **Explore**: a "National Parks" shelf (nearest first when location is on); search by name/state.
- **Park page**: hero image (NPS image with credit), what's inside (roads, stories, stops), Essentials (free) and Full
  (badge: "Free — your first park" / "Included in Plus" / "$1.99"), per-road choice for big parks, size, last updated,
  "Update available", Remove, attribution line.
- **Prompt**: when the phone is within ~30 km of a park, parked, and online: "Heading into Yellowstone? Download the
  free Essentials pack." Never while driving.
- **Offline playback**: inside a park boundary with a pack installed, the pack's items are used before anything else:
  the stretch the car is on, the listener's next topic (lensFor rotation), falling back to the park overview for that
  topic; stops play as roadside inserts with side lead-ins decided from GPS at play time; heard items are not repeated
  (by item id) for 30 days.
- **Storage screen**: packs listed with sizes; remove/update.

## Constraints

- Free sources only (NPS API key, OSM, Wikipedia/Wikidata); attribution shown in the app.
- Bedrock and Polly quotas: the Write step's concurrency stays under them; first full build of all parks spreads over
  days.
- Existing Fast table and audio bucket reused; new infra: Scheduler, Step Functions state machine, CloudFront key group.
- Content is shared by everyone: no personal data.

## Calls made after the builder check (owner may override)

- **Essentials access**: public CDN path (`e/`), sign-in enforced in the app only; usage measured from the signed-in
  `GET /v1/parks` calls and CloudFront logs. Cost of abuse is cents. (my call)
- **Payments in the pilot**: free first park + Plus only (today's billing). The ~$1.99 park unlock waits for real App
  Store / Play verification (currently stubs); then it is **one non-consumable-style entitlement per park**, bought
  through one consumable "park unlock" product that grants the park the listener picks. (my call)
- **What Essentials holds**: on Essentials roads, one story per stretch from the stretch's strongest topic (most
  material), every stop line on those roads, the lead-in/bridge clips, and the park overviews for history and nature.
  Full adds every other topic per stretch, all other roads and stops, and every overview. Offline topic rotation uses
  what is installed. Essentials target stays 10-25 MB. (my call)
- **Units**: US parks are told in miles and °F (the audience is American); metric listeners hear the same pack. (my call)
- **Pilot gates**: average build cost ≤ $25/park, Essentials ≤ 25 MB, Full median ≤ 150 MB, and the owner listens to
  ~20 sampled items per pilot park before its first manifest publishes (a `review` flag holds Publish for pilot parks).
  The pilot runs through the same Step Functions workflow started by hand; the daily schedule is switched on after.
  (my call)
- **Access lost (Plus ends, refund)**: at the next sync the park reverts to Essentials: Full-only files are deleted,
  Essentials files stay and keep playing. A drive in progress is never interrupted (the revert waits for the next sync
  off a drive). (recommended; owner did not object)
- **NPS API key**: stored by the owner as SSM SecureString `/milemuse/nps-api-key` (KMS `alias/aws/ssm`); the park
  job's Lambda gets `ssm:GetParameter` with decryption on that one parameter and reads it at run time.

## Free samples (owner request)

- Every park has **3 free samples**: the best Full items on three different topics (most facts, longest road first),
  picked at Publish and marked `sample: true` in the manifest.
- Their audio is also written to the public path `parks/<code>/s/<hash>.mp3`, so anyone can stream them (no download,
  no entitlement, not charged, not marked heard).
- Shown on the park page and on the Full purchase sheet ("Hear what's inside"), with each sample's road and topic.
- Samples never count toward a free claim and never unlock anything.

## Left to the builder

Exact stretch length (0.8–1.5 km), the topic-material threshold, Essentials road selection heuristics, batch sizes,
manifest field names beyond those above, image choice per park, UI layout of the shelf and park page, and test design.
