# MileMuse — Competitive Landscape & Technical Building Blocks

**Research brief** · Date: 2026-07-06 · Method: multi-agent web survey + adversarial verification pass

This is the background research that the [design spec](../specs/2026-07-06-milemuse-design.md) is
built on. Claims marked **(verified)** survived an independent fact-check.

---

## 1. The one-glance landscape

| App | Talks whole drive? | Never silent? | Bulletproof offline? | Directional? | Content model |
|---|---|---|---|---|---|
| **Autio** (ex-HearHere, Costner) | ✅ only one aiming here | ❌ real gaps | ⚠️ story-by-story; unreliable off-grid | ❌ | Human pre-recorded, subscription (~$36/yr) |
| **GuideAlong** (ex-GyPSy) | ❌ inside park only | ❌ | ✅ solid | ❌ | Human, one-time per tour (~$20) |
| **Shaka Guide** | ❌ inside park only | ❌ | ✅ solid | ❌ | Human + music, one-time per tour |
| **Action Tour Guide** | ❌ inside park only | ❌ | ✅ solid | ❌ | Human, per-tour or $99/yr pass |
| **Just Ahead** | ❌ ~12 parks only | ❌ | ✅ | ❌ | Human, per-tour; **no Glacier**; stale |
| **TravelStorys** | ❌ tour-bound | ❌ | ✅ | ❌ | Partner-sourced, mostly free; uneven |
| **AI newcomers** (Roadguide, Summer AI, Votura, Roadtrip Buddy) | ⚠️ some | ⚠️ | ❌ cloud-only | ❌ | AI-generated on the fly, online |

**Verified corrections from the fact-check:**
- **Autio is NOT truly "continuous."** It is POI-geofence-triggered, so rural corridors have silent
  stretches; Autio's own docs recommend pairing it with your own podcast to fill gaps. *(verified)*
- **All five tour apps (Autio, GuideAlong, Shaka, Just Ahead, TravelStorys) do support full offline
  playback** after download — GPS is satellite-based, so triggering works with no cell. *(verified)*
- **Real AI-generated narration ships today** (Roadguide, Summer AI, Roadtrip Buddy, Votura) — but
  the *market leader (Autio) is human pre-recorded*, and no dominant AI incumbent or mature
  open-source drive-narrator exists yet. *(verified)*

---

## 2. The gap MileMuse targets

No product combines all four: **never-silent + directional ("on your left") + guaranteed-offline +
fresh AI content.**
- The offline champs (GuideAlong/Shaka/Action) nail offline but only narrate *inside* a park and go
  silent on the drive there; none are directional; all are fixed human recordings.
- The AI newcomers have fresh generated content but are **cloud-dependent**, so they break in exactly
  the rural dead zones (Stevens Pass, Idaho Panhandle, most of Glacier) where you most want them.
- **Bake-at-home** (generate the whole route on WiFi, play with zero network code) turns the
  category's hardest problem — reliable offline — into a non-problem.

---

## 3. AI-native players (the emerging category)

- **Roadguide** (roadguide.app) — GPS + generative AI, fresh facts each pass, ElevenLabs TTS, audio-only.
- **Summer AI** (summer.ai) — agents scrape located features → LLM condenses → multi-voice TTS →
  fact-checking + human moderation; multiple "hosts" (history buff, economist).
- **Roadtrip Buddy / Voygent** (roadtrip.voygent.app) — proactive briefings every 15–20 min via a
  Claude/ChatGPT connector; free beta.
- **Votura** (votura.app) — AI-built, AI-narrated tours across 500+ cities.
- **Incumbent contrast — Autio** is ~25,000 professionally human-narrated stories; the quality bar,
  but a fixed library, not generated.

**Reference architecture (most useful technical source):** *"Hierarchical geofencing for
location-aware generative audio tours,"* Urban Informatics (2024),
<https://link.springer.com/article/10.1007/s44212-024-00064-6> — essentially a blueprint: GPT-4o
scripts + Amazon Polly TTS, grounded on scraped local docs + Wikipedia + historical markers;
**hierarchical geofences** (landmark > path > district) keep narration continuous where POIs are
sparse (cut "undelivered time" 786s → 20s over a 26-min tour); **generate-ahead** during current
playback hides latency. This directly informs MileMuse's never-silent fallback and Baker pipeline.

---

## 4. Data sources (the building blocks)

| Source | Access | Notes |
|---|---|---|
| **Wikipedia GeoSearch** | Free MediaWiki `API:Geosearch` (lat/lon + radius) | Canonical "articles near me"; article extract = grounding text. |
| **Wikivoyage** | Wikimedia Enterprise API; POIs w/ coords | Curated traveler POIs (see/eat/sleep). |
| **OpenStreetMap / Overpass** | Free Overpass API (rate-limited); tag queries | Best free structured POI layer; self-hostable. |
| **Google Places** | Paid | **$200/mo free credit ended Feb 2025**; ~$275/mo at scale — avoid; OSM/TomTom ~40× cheaper. |
| **Atlas Obscura** | No official API | Great "hidden gems" but scraping/ToS risk — avoid for now. |
| **Historical Marker DB (HMdb.org)** | No public API | Ideal roadside history but web-only — avoid for now. |

**Chosen for MVP:** Wikipedia GeoSearch + OSM Overpass (both free, cover the populated US well).
Richness thins in true wilderness → the hierarchical region fallback is essential.

---

## 5. TTS & offline packaging trade-offs

- **Pre-generate the route (MileMuse's choice):** LLM + cloud TTS (ElevenLabs/Polly) server/laptop
  side, cache one clip per slot, bundle for offline. Best quality; needs a known route. This is how
  the human-recorded incumbents already ship offline (parks/passes lack cell — the NPS says download
  first).
- **On-device TTS** (Kokoro, Picovoice, system voices) — flexible/offline but you still need the
  *text* generated somewhere; lower quality ceiling. Deferred.
- **True on-the-fly generation offline** needs an on-device LLM — **not practical on phones in
  2026**, which is why today's AI apps are effectively online-only. MileMuse sidesteps this entirely
  by baking at home.

---

## 6. The rural-offline reality (why offline is the whole game)

Representative route Seattle → Glacier (US-2 "Great Northern" or I-90):
- **Dead zones:** Stevens Pass (WA Cascades); Idaho Panhandle ("5G to total silence in a few miles");
  NW Montana approaches (Hwy 83 has 10–15 min no-service gaps); **Glacier itself** — cell only near
  West Glacier/Apgar and limited at St. Mary; **none** at Logan Pass, Many Glacier, Two Medicine,
  North Fork, or US-2 along the park's south edge. NPS explicitly says download apps/audio *before*
  arriving.
- **Documented failure mode:** the only app covering the corridor (Autio) has user reports it
  **won't play / buffers forever** out of range if stories weren't pre-downloaded.
- **The unmet need (verbatim from the gap analysis):** *a single "download my planned route corridor
  for offline, GPS-only playback" experience — route-aware pre-caching (like Google Maps offline
  areas) with continuous highway content and a hard guarantee that nothing ever tries to stream.*
  That is precisely MileMuse.

---

## 7. Key sources

Autio: <https://autio.com/> · <https://autio.com/here-and-there/gps-audio-tours-how-they-work> ·
GuideAlong: <https://guidealong.com/> · Shaka Guide: <https://www.shakaguide.com/> ·
Action Tour Guide: <https://actiontourguide.com/> · Just Ahead: <https://www.justahead.com/> ·
TravelStorys: <https://travelstorys.com/> · Roadguide: <https://roadguide.app/> ·
Summer AI: <https://summer.ai/> · Roadtrip Buddy: <https://roadtrip.voygent.app/> ·
Generative audio tours paper: <https://link.springer.com/article/10.1007/s44212-024-00064-6> ·
Wikipedia Geosearch: <https://www.mediawiki.org/wiki/API:Geosearch> ·
OSM Overpass: <https://wiki.openstreetmap.org/wiki/Overpass_API> ·
NPS Glacier connectivity: <https://www.nps.gov/glac/planyourvisit/connectivity.htm>
