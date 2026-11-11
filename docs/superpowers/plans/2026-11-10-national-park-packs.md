# National Park Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-built offline story packs for every road in the US national parks (pilot 5 parks first), refreshed by a
30-day job that rewrites only what changed, diff-synced to phones, showcased in the app, Essentials free.

**Architecture:** A Step Functions workflow per park (started daily by EventBridge Scheduler for parks due) runs pipeline
Lambda steps: roads (NPS boundary + OSM) → facts per stretch/topic with a facts hash → write+voice only changed items →
publish a content-addressed manifest to S3/CloudFront → collect unreferenced audio. The API lists parks and grants Full
access (first park free, Plus) via CloudFront signed cookies. The app shows a National Parks shelf and park page, syncs
packs by diffing manifests, and plays pack items offline inside a park.

**Tech Stack:** Node 22 ESM (MileMuseService), AWS CDK TypeScript (MileMuseInfra: Step Functions, Scheduler,
CloudFront key group, custom resource), Expo/RN TypeScript (MileMuseApp); tests `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-10-national-park-packs-design.md`

## Global Constraints

- One pack version: tone `delightful`, party `family`, units imperial, default voice (`Matthew`), level normal (segment ~180 words, ~75 s).
- Pilot parks: `mora`, `olym`, `noca`, `yell`, `yose`; pilot parks publish only after owner review (`review: true` holds Publish).
- Stories never state closures, hours, fees, event dates or "currently"; no left/right (direction-neutral); numbers only from NUMBERS.
- Audio: 32 kbps mono MP3, content-addressed `parks/<park>/<e|f>/<sha256>.mp3`, `Cache-Control: max-age=31536000, immutable`; manifest `parks/<park>/manifest.json` `max-age=300` and immutable `manifest-<v>.json`.
- Monthly refresh rewrites only items whose `factsHash` changed or that are new; per-run item budget in config (`parks.budgetItems`, default 600); stop + log above it.
- Collect deletes only audio unreferenced by the last 2 manifest versions.
- NPS key from SSM `/milemuse/nps-api-key` (SecureString, read with decryption at run time; never logged).
- OSM attribution "© OpenStreetMap contributors" shown on park pages; NPS image credits shown.
- Access: Essentials public (`e/`); Full (`f/`) needs a CloudFront signed cookie (7 days) from `POST /v1/parks/<code>/access`; first Full park free per account; Plus = all; unlock product deferred.
- Losing Full access: next sync off a drive reverts to Essentials (delete `f/` files).
- Sizing gates (pilot): build cost ≤ $25/park avg, Essentials ≤ 25 MB, Full median ≤ 150 MB.
- Free samples: 3 per park (best Full items, three different topics), `sample: true` in the manifest, audio also at public `parks/<code>/s/<hash>.mp3`; streamed free on the park page and purchase sheet, never charged or marked heard. Owners: P4 (pick + write `s/`), P6 (`GET /v1/parks/:code` returns `samples: [{ title, road, topic, durationS, url }]`), I1 (`parks/*/s/*` public), A1 (sample buttons on the page and sheet).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A park with OSM roads crossing the boundary in and out (loops, roads that exit and re-enter) → stretches only inside, no duplicate stretch ids, ids stable across runs when geometry is unchanged. Test in P1.
2. NPS API or Overpass down / 429 mid-run → the park keeps its last good manifest; the run retries per batch; nothing is published half-built. Test in P5.
3. A phone mid-sync when a new version publishes → its files remain (two versions kept); diff from an older-than-previous version still works (downloads what's missing). Test in A2.
4. A listener whose Plus ends while a Full pack is installed and a drive is running → nothing deleted mid-drive; reverted at the next sync off a drive. Test in A2.
5. Pack story text with a closure/hours/fee phrase (model slip) → caught by a deterministic check and rewritten once, else dropped from the manifest. Test in P3.

---

## Server (MileMuseService)

### Task P1: Park roads and stretches

**Files:** Create `packages/core/src/parks/roads.mjs`, `packages/core/test/parks.roads.test.mjs`, fixtures `packages/core/test/fixtures/parks/` (small boundary GeoJSON + Overpass JSON).

**Interfaces — Produces:**
- `npsKey(getParameter) → Promise<string>` (reads `/milemuse/nps-api-key` WithDecryption; cached 1 h).
- `parkInfo(code, { fetch, key }) → { code, name, states, images: [{url, credit}], boundary: GeoJSON MultiPolygon, bbox }` (NPS `parks?parkCode=` + `mapdata/parkboundaries/<code>`).
- `parkRoads(boundary, { fetch }) → Road[]` where `Road = { id: slug(name|ref), name, km, coords: [lat,lng][], essentials: false }` — Overpass ways `highway~"^(primary|secondary|tertiary|unclassified|residential|service)$"`, not `access=private`, `service` only with `name`; clipped to the boundary; merged by name/ref; parts < 300 m dropped.
- `stretchesOf(road, lenM = 1000) → Stretch[]` with `Stretch = { id: "<park>:<road>:<n>", road, n, start, end, mid, km }`.
- `essentialRoads(roads, override?: string[]) → Set<roadId>` (override list from config `parks.essentials[<code>]`, else the longest roads covering 60% of total km).

- [ ] Step 1: failing tests — fixture with a road that exits and re-enters the boundary yields stretches only inside and unique ids; same fixture twice → identical ids; 2.5 km road → 3 stretches (1 km, 1 km, 0.5 km); private road dropped; `essentialRoads` with override returns exactly the override.
- [ ] Step 2: run `node --test packages/core/test/parks.roads.test.mjs` → FAIL (module missing).
- [ ] Step 3: implement (geo helpers from `geo.js`; point-in-polygon ray cast; no new dependencies).
- [ ] Step 4: `npm test` → PASS.
- [ ] Step 5: commit `feat(parks): park boundary, roads inside it and ~1 km stretches`.

### Task P2: Facts per stretch and topic, with a facts hash

**Files:** Create `packages/core/src/parks/facts.mjs`, test `packages/core/test/parks.facts.test.mjs`.

**Interfaces:**
- Consumes: P1 `Stretch`; existing `wikiSearch`, `wikiExtracts`, `placeStats`, `landAround`; catalogue `topics` (narration-config).
- Produces: `npsPlaces(code, { fetch, key }) → Place[]` (`places`, `thingstodo`, `visitorcenters`, `campgrounds`: `{ id, title, lat, lng, text, tags }`); `stretchFacts(stretch, parkPlaces, d) → Fact[]` (`{ source, title, text, lat, lng }` within 1.5 km); `topicFacts(facts, topics) → Map<topicId, Fact[]>` (keyword + NPS tag rules, a fact may serve several topics); `factsHash(topic, facts) → string` (sha256 of topic + sorted `source|title|text`); `MIN_FACTS = 2`; `strongest(map) → topicId`.

- [ ] Step 1: failing tests — geyser + wildlife fixture facts map to `geology` and `wildlife`, not `food`; reordering facts gives the same hash; a changed text changes it; `strongest` picks the topic with most facts; a stretch with 1 on-topic fact yields no story for that topic.
- [ ] Step 2: run → FAIL. - [ ] Step 3: implement. - [ ] Step 4: `npm test` → PASS.
- [ ] Step 5: commit `feat(parks): facts per stretch and topic, hashed`.

### Task P3: Writing and voicing pack items

**Files:** Create `packages/core/src/parks/write.mjs`, test `packages/core/test/parks.write.test.mjs`; Modify `packages/core/src/spatial.mjs` (export the MP3 encode with a bitrate option, 32 kbps mono for packs).

**Interfaces:**
- Consumes: `storySystem` (narrate.mjs) with `{ tone: "delightful", party: "family", imperial: true }`; P2 facts; existing `d.complete`, `d.speak`.
- Produces: `PACK_RULES` (string added to the prompt: no closures/hours/fees/event dates/"currently", no left/right, family-safe); `TIME_WORDS` regex (`closed|closure|open (daily|until|from)|hours|fee|\$\d|currently|this (week|month|season)`); `writeItem({ kind: "story"|"stop"|"overview", park, road?, stretch?, topic, facts }, d) → { text, themes } | null` (one rewrite if `TIME_WORDS` matches, else null); `voiceItem(text, d) → { bytes: Buffer, hash, durationS }` (32 kbps mono).

- [ ] Step 1: failing tests — prompt contains PACK_RULES and the delightful tone prompt and no side words; a fake model replying "The road is closed in winter…" twice → `null`, once → rewritten text kept; `voiceItem` hash is sha256 of the bytes and stable for the same bytes.
- [ ] Step 2: run → FAIL. - [ ] Step 3: implement. - [ ] Step 4: `npm test` → PASS.
- [ ] Step 5: commit `feat(parks): pack stories, stop lines and overviews, voiced at 32 kbps`.

### Task P4: Store, manifest and collect

**Files:** Create `packages/core/src/parks/manifest.mjs`, test `packages/core/test/parks.manifest.test.mjs`; Modify `packages/core/src/dynamo.mjs` (park items).

**Interfaces — Produces:**
- dynamo: `getParkMeta(code)`, `putParkMeta(code, meta)`, `parkItems(code) → Item[]`, `putParkItem(code, item)`, `deleteParkItem(code, id)` (pk `NP#<code>`, sk `META` | `R#<road>` | `I#<id>`).
- `Item = { id, kind, road?, stretch?, topic, lat, lng, text, themes, factsHash, hash, bytes, durationS, tier: "e"|"f" }`.
- `buildManifest(meta, roads, items, version) → Manifest` (spec shape; road bytes per tier).
- `publish(manifest, { putObject })` — writes `manifest-<v>.json` then `manifest.json` with the cache headers.
- `unreferenced(allKeys, lastTwo: Manifest[]) → key[]`.

- [ ] Step 1: failing tests — manifest has only items of known roads, road `bytes` sums by tier; `publish` writes the versioned file before `manifest.json` (call order); `unreferenced` keeps hashes in either of the last two manifests and returns the rest.
- [ ] Step 2–4: FAIL → implement → `npm test` PASS. - [ ] Step 5: commit `feat(parks): park items, manifests and garbage collection`.

### Task P5: The park job (pipeline steps + workflow input/outputs)

**Files:** Create `packages/pipeline/src/parks.mjs`, test `packages/pipeline/test/parks.test.mjs`; Modify `packages/pipeline/src/handler.mjs` (job types).

**Interfaces — Produces job handlers** (each bounded to ≤ 50 stretches or ≤ 60 items so a Lambda stays under 15 min):
- `park.roads { code } → { code, roads: [{id, stretches: n}], batches: [{code, road, from, to}] }`
- `park.facts { code, road, from, to } → { changed: [{ id, kind, topic, factsHash }] }` (compares with stored items)
- `park.write { code, items: [...] } → { written: n, dropped: n }` (respects `parks.budgetItems`; stops with `budget_exceeded`)
- `park.publish { code } → { version }` (skipped with `held_for_review` when meta.review is true and not yet approved)
- `park.collect { code } → { deleted: n }`
- `park.due {} → { started: [code] }` (parks with `lastPrimedAt` older than 30 days or `force`)

- [ ] Step 1: failing tests (fakes for fetch, store, model, voice, S3) — unchanged facts on a second run → 0 written, version unchanged when nothing changed; one changed stretch → only its items rewritten; a 429 from Overpass makes `park.roads` throw (Step Functions retries) and publish is not reached; `held_for_review` until `meta.reviewApprovedAt`; budget stop.
- [ ] Step 2–4: FAIL → implement → `npm test` PASS. - [ ] Step 5: commit `feat(parks): the park priming job, rewriting only what changed`.

### Task P6: Parks API and Full access

**Files:** Modify `packages/api/src/app.mjs`, `packages/api/src/wire.mjs`, `packages/api/src/lambda.mjs`; Create `packages/core/src/parks/access.mjs`; tests `packages/api/test/app.test.mjs`, `packages/core/test/parks.access.test.mjs`.

**Interfaces — Produces:**
- `GET /v1/parks` → `[{ code, name, states, image, essentialsBytes, fullBytes, version, access: "full"|"essentials" }]`.
- `GET /v1/parks/:code` → park page data (roads with sizes per tier, attribution, alerts snapshot).
- `POST /v1/parks/:code/access` → `{ access, claimed?: true, cookies?: { "CloudFront-Policy", "CloudFront-Signature", "CloudFront-Key-Pair-Id" }, expiresAt }`.
- `access.mjs`: `fullAccess(user, code, { billing, store }) → { ok, source: "plus"|"free_first"|"none" }` (claims the free first park atomically: conditional put `U#<user>` / `FREEPARK`); `signedCookies(code, keyPairId, privateKeyPem, expiresAt)` (CloudFront canned-policy-free custom policy for `https://<cdn>/parks/<code>/f/*`).

- [ ] Step 1: failing tests — first park claim → `free_first`, second park → `none` for a free user, `plus` user → `plus` for any; concurrent first claims grant one park only; cookie policy resource matches `parks/<code>/f/*` and expires in 7 days; unknown park → 404.
- [ ] Step 2–4: FAIL → implement → `npm test` PASS. - [ ] Step 5: commit `feat(parks): parks API, free first park and Full access cookies`.

## Infra (MileMuseInfra)

### Task I1: Workflow, schedule, CDN and permissions

**Files:** Modify `lib/services-stack.ts`; Create `lib/parks.ts` (construct), `lambda/cf-keypair/index.mjs` (custom resource); test `test/parks.test.ts` (CDK assertions).

**Produces:** Step Functions state machine `ParkPrime` (Roads → Map facts (maxConcurrency 4) → Map write (maxConcurrency 2) → Publish → Collect, retries with backoff on Lambda errors); EventBridge Scheduler daily 03:00 UTC → `park.due`; S3 `parks/` with no lifecycle expiry; CloudFront behaviors `parks/*/f/*` (trusted key group) and `parks/*` (public, compress); custom resource that generates an RSA key pair inside AWS, stores the private key in Secrets Manager `/milemuse/cf-parks-key` and registers the public key + key group (no key passes through a person); pipeline Lambda: `ssm:GetParameter` + `kms:Decrypt` on `/milemuse/nps-api-key`, `s3:PutObject/DeleteObject/ListBucket` on `parks/*`; API Lambda: `secretsmanager:GetSecretValue` on the key secret.

- [ ] Step 1: failing CDK assertions (state machine exists with 5 states; schedule daily; behavior for `parks/*/f/*` has trusted key groups; pipeline role can read only the one SSM parameter).
- [ ] Step 2–4: FAIL → implement → `npm test` PASS; `cdk diff` reviewed (new resources only, no replacements).
- [ ] Step 5: commit `feat(infra): park priming workflow, daily schedule, signed park CDN paths`.

## App (MileMuseApp)

### Task A1: National Parks shelf and park page

**Files:** Modify `src/api.ts`, `src/screens/explore.tsx`; Create `src/screens/park.tsx`; tests `src/api.test.ts`, `src/contract.test.ts`.

**Produces:** `parks()`, `park(code)`, `parkAccess(code)` in api.ts; Explore shelf (nearest first); park page (hero + credit, roads with sizes, Essentials free / Full badge "Free — your first park" | "Included in Plus" | "Plus only for now", Update available size, Remove, attribution "© OpenStreetMap contributors").

- [ ] Steps: failing api/contract tests (paths, shapes) → implement → `npx tsc --noEmit && npm test` PASS → commit `feat(app): National Parks shelf and park page`.

### Task A2: Pack storage and diff sync

**Files:** Create `src/parkpacks.ts`, `src/parkpacks.test.ts`; Modify `src/native.ts` (download with cookie header, file delete), `src/session.ts` (sync triggers).

**Produces:** `diffManifest(local: { hashes: Set<string>, tier, roads }, m: Manifest) → { download: Item[], remove: string[] }`; `syncPark(code, opts, d) → { version, downloaded, removed, bytes }` (resumable, parallel 3, checkpoint every 10, atomic manifest swap, then deletes); `revertToEssentials(code, d)`; triggers: park page, app open when local manifest > 7 days old (Wi-Fi unless allowed), never during a drive.

- [ ] Steps: failing tests — unchanged hash never re-downloaded; removed hash deleted only after the new manifest is saved; an item moved to another road with the same hash is not downloaded; lost access during a drive → no deletes until `driving` ends, then `f/` files deleted; diff from version v-3 downloads all missing → implement → PASS → commit `feat(app): park packs synced by diff`.

### Task A3: Offline playback inside a park

**Files:** Create `src/parkplay.ts`, `src/parkplay.test.ts`; Modify `src/session.ts` (offline source order), `src/lanes.ts` (stop items as inserts).

**Produces:** `inPark(pos, packs) → code|null` (bbox + boundary); `parkItemFor(pos, pack, topic, heard) → Item|null` (nearest stretch within 300 m, the listener's topic else strongest installed, else the park overview for that topic; skips heard ids for 30 days); stops within 300 m ahead → insert items (side from GPS, existing lead-in clips from the pack).

- [ ] Steps: failing tests — on a stretch with geology+wildlife and topic wildlife → the wildlife story; topic food with none → park overview; heard id skipped; outside the park → null (normal offline area packs) → implement → PASS → commit `feat(app): park packs play offline inside the park`.

### Task A4: Near-a-park prompt

**Files:** Modify `src/session.ts`, `src/notify.ts`; test `src/session.test.ts`.

- [ ] Steps: failing test — parked, online, within 30 km of a park without its pack → one prompt; never while driving; not again for that park within 30 days → implement → PASS → commit `feat(app): suggest a park's free pack when parked nearby`.

## Rollout

### Task R1: Pilot

- [ ] Merge P1–P6, I1 (ship_branch per repo); `cdk diff` then deploy.
- [ ] Set `parks.pilot` + `review: true`; start `ParkPrime` for the 5 pilot parks by hand; read run logs: items, cost (model+Polly characters), MB per tier.
- [ ] Owner listens to ~20 items per park (a review page/list from `GET /v1/parks/:code` in admin mode or the run's sample list); approve → publish.
- [ ] Gates: ≤ $25/park, Essentials ≤ 25 MB, Full median ≤ 150 MB. Report numbers to the owner.
- [ ] App: merge A1–A4, release check (signed-in emulator audio), APK upload, iPhone install; field test in a pilot park.

### Task R2: All parks

- [ ] Owner go-ahead on pilot numbers → add all 63 park codes; enable the daily schedule; monitor the first month's runs (written counts ≈ changed facts only).
