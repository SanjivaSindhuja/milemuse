# MileMuse at Scale — Backend Architecture

**Design spec** · Date: 2026-07-07 · Status: For review
**Goal:** Serve GPS travel narration for **any driving route in the USA**, with content that stays
**fresh for daily commuters**, on-demand, at a cost that scales with *places* — not with users × trips.

---

## 1. The one principle everything follows

> **Generate each place's stories once. Cache them. Serve them to everyone. Rotate for freshness.**

The demo hand-authors ~40 scripts and pre-bakes audio into static files. That cannot cover the USA.
The scalable version replaces hand-authoring with **AI generation grounded on free open data**, and —
critically — **caches every generated story keyed by content**, shared across all users. Generation
cost is then `O(unique stories)`, a finite number, instead of `O(users × trips)`.

The **offline-first player stays exactly as it is** — it just fetches its manifest from an API instead
of static files, caches it locally for the drive, and re-syncs when back on WiFi to pick up fresh
content.

---

## 2. Architecture

```
  INGEST (batch)            GENERATE (queue workers)          SERVE (per request, cheap)
  ┌───────────────┐         ┌──────────────────────────┐      ┌───────────────────────────┐
  │ Wikipedia     │         │ for each POI needing it:  │      │ POST /route {from,to}     │
  │  GeoSearch    │──POIs──▶ │  1. gather source text    │      │   → OSRM polyline         │
  │ OpenStreetMap │         │  2. Claude writes N angles │      │   → PostGIS: POIs along it│
  │  Overpass     │         │     (grounded, no halluc.) │      │   → assemble manifest from│
  └───────────────┘         │  3. TTS each → audio       │      │     cached stories        │
        │                   │  4. store audio→S3, meta→DB│      │   → cold POIs? enqueue +  │
        ▼                   └──────────────────────────┘      │     generate on demand    │
  ┌───────────────┐                    │                        │   → return manifest       │
  │ POI store     │◀───────────────────┘   audio in S3/CDN      └───────────────────────────┘
  │ (PostGIS)     │        Story pool per POI in DB                        │ manifest + CDN URLs
  └───────────────┘                                                        ▼
                                                              ┌───────────────────────────┐
   NIGHTLY: grow pools for hot commuter corridors             │ App: download for offline,│
   (scheduler enqueues new angles for popular routes)         │ play by GPS, re-sync WiFi │
                                                              └───────────────────────────┘
```

**Five services, each with one job:**

1. **POI ingestion** — pull geotagged places from **Wikipedia GeoSearch** and **OSM Overpass**
   (both free, global, US-complete), normalize into a **PostGIS** table (`poi`: id, lat/lng,
   category, source text, source URLs, prominence score). Batch-seed populated corridors first;
   the long tail fills in on demand.
2. **Generation workers** — a queue (SQS / Cloud Tasks) feeds workers that, per POI, generate a
   **pool of story "angles"** (history / nature / quirky / practical) with **Claude**, *grounded
   strictly on the POI's source text* (RAG — no hallucination), then **TTS** each to audio. Audio →
   object storage (**S3**), metadata → **DB** (`story`: id, poi_id, angle, transcript, audio_key,
   duration, content_hash).
3. **Routing** — **OSRM self-hosted** (free, scales, no per-call fees) turns from/to into a polyline.
4. **Route/Manifest API** — the only thing the app calls. Given a route: get the polyline, spatial-
   query POIs within a corridor buffer, compute each POI's along-route mileage + side (the demo's
   `geo.js` math), pick a **date-seeded** story per POI from its pool, and return a **manifest**
   (same schema as the demo). **Cold POIs** (no stories yet) are enqueued for generation and either
   filled synchronously (fast models) or skipped this pass and ready next time.
5. **Freshness** — two mechanisms:
   - **Rotation (free, instant):** each POI holds a pool of N angles; the manifest picks a
     **different one per day** (seed = `hash(poi_id + date + user)`), so a daily commuter's identical
     drive feels new every morning.
   - **Growth (scheduled):** a nightly job identifies **hot corridors** (routes requested repeatedly)
     and enqueues **new angles** for their POIs, so popular commutes keep gaining genuinely new
     content over time.

Plus the **region filler pool** (the demo's fillers) generalizes to **state/region-level fillers**
for never-silent playback in sparse stretches.

---

## 3. Data model (sketch)

```
poi(id, lat, lng, name, category, prominence, source_text, source_urls[], geom GEOMETRY)
story(id, poi_id, angle, voice, transcript, audio_key, duration_sec, content_hash, created_at)
filler(id, region, category, transcript, audio_key, duration_sec)      -- region-level
route_request(id, from, to, polyline_hash, requested_at)               -- for hot-corridor stats
```
`content_hash = sha(voice + transcript)` — **the same dedup the demo pipeline already uses**, so a
story is never synthesized twice.

**Manifest returned to the app** is the demo's exact shape (clips with `startAtMiles`, `side`,
`audio` URL, `transcript`), so **the player needs no rework** — only its data source changes from
static files to `POST /route`.

---

## 4. Why it scales (cost model)

- **Data: free.** Wikipedia (CC BY-SA) + OSM (ODbL), attribution retained. Avoid Google Places.
- **TTS is the dominant cost** → synthesize **once**, cache forever (content-hash keyed). At neural-
  TTS rates (~$16/1M chars) a ~120-word story is ~$0.012. Even a very rich pool — say ~2M US POIs ×
  a few angles — is a **one-time, demand-spread** cost in the low hundreds of thousands, not per user.
- **LLM: cheap + once.** A fast model (Claude Haiku-class) per story, grounded; generated once, cached.
- **Demand-driven.** Empty rural roads are never generated until someone drives them; popular
  corridors get rich pools. Cost tracks real usage.
- **Serving is mostly CDN bandwidth** once pools are warm — the marginal cost of the millionth
  listener on a known corridor is ~a few audio files from cache.

---

## 5. Recommended stack (for review — see Open Questions)

| Concern | Choice | Note |
|---|---|---|
| Compute | **AWS serverless** (Lambda + SQS + EventBridge) | you already run AWS (DotMd); serverless = pay-per-use |
| POI + spatial | **PostGIS** (RDS/Aurora) | spatial "POIs along a polyline" query |
| Audio store + CDN | **S3 + CloudFront** | cache-friendly, cheap egress at scale |
| Routing | **OSRM** on a small always-on box/ECS | free, no per-call fee |
| LLM | **Claude** (Haiku for scale, Sonnet for premium) | grounded generation |
| TTS | **Amazon Polly Neural** or **Azure Neural** | licensed for production (edge-tts is unofficial — demo only) |
| App | the existing **Expo/PWA offline player** | swap static files → `/route` API + local cache |

---

## 6. Phasing

- **Phase 1 — Auto-route generation (prove it):** wire the *existing* pipeline to harvest Wikipedia +
  OSM **live** and generate a brand-new route end-to-end (no hand-authoring). One route, on a laptop
  or a single Lambda. Deliverable: type any A→B, get a playable manifest.
- **Phase 2 — Cache + API:** move generation behind a queue, store audio in S3, metadata in PostGIS,
  and expose `POST /route` that assembles from cache and cold-generates misses. App points at the API.
- **Phase 3 — Freshness:** per-POI pools + date-seeded rotation + nightly hot-corridor growth. This is
  the "daily-fresh for commuters" feature.
- **Phase 4 — Scale + polish:** licensed TTS, CDN, autoscaling workers, cost dashboards, attribution
  UI, account/sync for saved commutes.

Each phase produces something usable on its own. Phase 1 is the smallest step that proves the whole
model.

---

## 7. Open questions / decisions for you

1. **Cloud:** AWS (matches your existing infra) vs GCP (you have tooling) vs stay static+serverless.
2. **TTS vendor** at production scale (Polly vs Azure vs ElevenLabs) — quality vs cost trade-off.
3. **Voice/persona** consistency — one signature "witty local" voice nationwide, or regional voices?
4. **Business shape** — free/ad-supported, subscription, or personal-only — changes cost tolerance.
5. **Freshness cadence** — truly daily-new, or "new when the pool grows"? Affects generation spend.
6. **Cold-route latency** — generate synchronously on first request (slower first drive) vs pre-warm
   popular corridors nightly and skip-cold-this-pass.

---

## 8. Risks

- **Content quality at scale** — grounding controls hallucination, but tone/accuracy needs sampling +
  a feedback loop (thumbs-down → regenerate/suppress).
- **Data licensing** — CC BY-SA / ODbL require visible attribution; bake into the app.
- **TTS cost creep** — the whole model depends on cache discipline; never regenerate unchanged text.
- **Sparse rural coverage** — Wikipedia/OSM thin out; region fillers + "hierarchical" fallback cover it.
