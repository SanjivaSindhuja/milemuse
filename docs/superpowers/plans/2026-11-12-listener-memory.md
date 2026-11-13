# Listener Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mic answers that know what's playing and what the account heard before, and narration that doesn't repeat a
place, town section or theme to the same listener for 30 days.

**Architecture:** The phone sends a note for every item played past half. The server keeps them per account in the
fast table (DynamoDB). The live handler recalls notes in code (time words, names, keywords) for mic answers. Story,
segment, insert and personal-line requests read the listener's last 30 days of notes to skip what was told, to rotate
through each town's full Wikipedia article section by section, and to link back.

**Tech Stack:** Node 22 ESM (`.mjs`), Fastify, AWS SDK v3 DynamoDB document client, `node --test`. Expo / React Native
TypeScript (`node --test --experimental-test-module-mocks`). AWS CDK (TypeScript).

**Spec:** `docs/superpowers/specs/2026-11-12-listener-memory-design.md`. Owner decisions: the defaults in §9.

## Global Constraints

- No new dependencies in any repo.
- If memory is unavailable (read slower than 300 ms, or failed), every request runs exactly as today.
- Notes carry only a geohash-5 `cell` (about 5 km), never coordinates. Personal lines (`mine:`) never become notes.
- Retention: `M#` notes 400 days, `MT#` full text 30 days, `W#` connection 15 min.
- `memory.noRepeatDays` 30, recall top 6, full-text detail for at most 2 notes.
- Caps:
  - `now.said` at most 2,000 chars
  - `drive` at most 8 items
  - at most 20 notes per POST
  - note `text` at most 2,500 chars, `gist` at most 400
- Links back only in what this listener alone hears (own stories, the personal line), at most one per town per drive.
- "Wider region" means the county article's sections. Far-off places stay out (the Nov 10 rule).
- Service checks: `npm test` in MileMuseService (eslint + node --test). App checks: `npm test` and `npm run typecheck`
  in MileMuseApp.

## Review Focus

1. A wrong phone clock or an old offline queue: `at` in the future is clamped to now, and old notes are still stored.
   Test in Task 4.
2. A non-English question (Japanese, Tamil): the time parser returns null, recall works by name and keyword, and nothing
   throws. Test in Task 3.
3. Prompt injection in `now.said`, `drive` or note text ("ignore your instructions"): capped and placed in a section
   labelled as data. Test in Task 6.
4. A slow or failing memory read (DynamoDB throttled): the story, insert or answer is served as today. Tests in Tasks 3,
   5 and 6.
5. An article with no headings, a very short one, or none: no sections, and the ladder moves on to the county, then to a
   shorter story. Test in Task 5.

---

### Task 1: Full town articles, split into sections (service)

**Files:**
- Modify: `packages/core/src/wikipedia.mjs` (`fetchArticle`)
- Create: `packages/core/src/memory.mjs` (`articleSections` only, for now)
- Test: `packages/core/test/wikipedia.test.mjs`, `packages/core/test/memory.test.mjs`

**Interfaces:**
- Produces:
  - `fetchArticle(title, { fetch, cache, maxChars = 100_000 })` returns the full plain text. The URL carries no
    `exchars`; the shared-cache key is `full:${title}`.
  - `articleSections(name, text, { skip = [], maxChars = 2500, minChars = 300 }) => { id, heading, text }[]`.
    The intro is `{ id: name, heading: "", text: text.slice(0, maxChars) }`. Then comes each `== h ==` / `=== h ===`
    section's text beyond `maxChars`, in article order:
    - The id is `${name}#${top-level heading}` for a level-2 section. A level-3 one adds `/${sub}`, for example
      `Everett#History/Boeing and suburban development`.
    - Chunks are at most `maxChars`, split at a paragraph. Later chunks add `#2`, `#3`.
    - A section whose level-2 heading is in `skip` (case-insensitive) is left out. So is any chunk under `minChars`.

- [ ] **Step 1: Failing tests**
  - `test("a town's article is read whole: no exchars (Wikipedia caps it at 1,200), at most 100k chars")`: the faked
    fetch's URL has no `exchars`; a 150k reply comes back as 100k.
  - `test("an article splits into its intro and its sections, in order, skipping the dull ones")`: from a fixture with
    `== History ==\n=== Milltown ===\n...\n== Government ==\n...\n== Parks ==`, expect the ids `["Everett",
    "Everett#History/Milltown", "Everett#Parks"]` with `skip: ["Government"]`. Each text is at most 2,500 chars. A
    5,000-char section becomes `#…` and `#…#2`.
  - `test("an article with no headings is just its intro; an empty one is nothing")`.
- [ ] **Step 2:** Run `node --test packages/core/test/wikipedia.test.mjs packages/core/test/memory.test.mjs`. Expect FAIL.
- [ ] **Step 3:** Implement both. Do not touch narrate's intro slice (`AREA_CHARS` 2,500) yet.
- [ ] **Step 4:** Run the same command. Expect PASS.
- [ ] **Step 5:** Commit: `fix(articles): read a town's whole Wikipedia article (exchars was capped at 1,200)`.

### Task 2: The notes store (service)

**Files:**
- Modify: `packages/core/src/dynamo.mjs` (header comment, and new methods on `dynamoStore`)
- Test: `packages/core/test/dynamo.test.mjs`

**Interfaces:**
- Produces (store methods). `Note = { k, id, at /* ISO */, title, area?, places?, sec?, themes?, gist?, cell?, text? }`.
  - `putNotes(user, notes)`: a BatchWrite (25 per batch, retrying unprocessed up to 5 times).
    - `{ pk: U#user, sk: M#<at>#<id>, ...note without text, ttl: +400 d }`
    - plus `{ pk: U#user, sk: MT#<id>, text, ttl: +30 d }` when there is text.
  - `notesSince(user, fromMs, toMs = now())`: one Query with `sk BETWEEN M#<iso from> AND M#<iso to>~`,
    `ScanIndexForward: false`, `Limit: 3000`. Returns notes, newest first, without pk, sk or ttl.
    `// ponytail: one page (≤1 MB); a per-cell index when a listener passes ~3,000 notes a month.`
  - `noteTexts(user, ids) => { [id]: text }`: a BatchGet of `MT#` items, ignoring expired ones.
  - `putConn(connectionId, user)`: `{ pk: W#<id>, sk: "CONN", user, ttl: +900 s }`. `connUser(connectionId) => user | null`
    (null when expired).

- [ ] **Step 1: Failing tests** (fake client as in the file):
  - `test("notes: one item per note (400 days), its text apart (30 days), sent 25 at a time")`: 30 notes become 2
    BatchWrites; one note's exact item matches; `MT#` only for notes with text.
  - `test("notes since a time: one query on the sort key's time range, newest first")`: the exact QueryCommand input.
  - `test("note texts: expired ones are misses")`.
  - `test("a live connection's listener is kept 15 minutes, then forgotten")`.
- [ ] **Step 2:** Run `node --test packages/core/test/dynamo.test.mjs`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. Expect PASS.
- [ ] **Step 5:** Commit: `feat(memory): notes, their text and live connections in the fast store`.

### Task 3: Memory: derive, recall, label (service)

**Files:**
- Modify: `packages/core/src/memory.mjs`, `packages/core/src/narration-config.mjs` (`DEFAULTS.memory`)
- Test: `packages/core/test/memory.test.mjs`, `packages/core/test/narration-config.test.mjs`

**Interfaces:**
- Consumes: `notesSince` (Task 2), `geohash` (`library.mjs`).
- Produces:
  - `DEFAULTS.memory = { enabled: true, noRepeatDays: 30, recallNotes: 6, links: true, thinWords: 0.6, skipSections: ["Government and politics", "Government", "Politics", "Demographics", "Education", "Media", "Sister cities", "Twin towns", "References", "Bibliography", "Further reading", "External links", "See also", "Notes"] }`
  - `memoryOf(notes, { now, days })` returns `Memory = { told: Set<string>, inserts: Set<string>, themes: Map<string, Set<string>>, notes }`.
    - `told`: lowercase titles, places and sec of notes in the window.
    - `inserts`: the ids of insert notes.
    - `themes`: town (lowercase area) to themes.
  - `memoryFor(store, { config, now, waitMs = 300, ttlMs = 120_000 }) => (user) => Promise<Memory | null>`: cached per
    user. Null when disabled, slower than `waitMs`, or failed.
  - `whenSaid(atMs, nowMs) => "earlier today" | "yesterday" | "N days ago" | "last week" | "N weeks ago" | "last month" | "N months ago"`,
    by elapsed time: under 18 h earlier today, under 42 h yesterday, then by whole days and weeks.
  - `timeWindow(question, nowMs, utcOffsetMin = 0) => { from, to } | null`, English only:
    - today / this morning / this afternoon / this evening / tonight
    - yesterday
    - `N days ago` (digits or one…ten)
    - last week, last month
    - `(last|on) <weekday>`
  - `recall(question, notes, { now, utcOffsetMin, k }) => (Note & { when })[]`. The score is
    (time window ×4, outside it ×0.3) × (a named title, area or place ×3) × keyword overlap, where keywords are stemmed
    by stripping -s/-es/-ing/-ed, skip stopwords, and are weighted by rarity across the notes. Ties go to the newest.
    Answer notes count too.
  - `linksNear(memory, { cell, area, now, k = 3, minAgeMs = 3 * 3600_000 }) => { when, gist }[]`: notes in that cell or
    that town, older than `minAgeMs`, newest first.

- [ ] **Step 1: Failing tests:**
  - `test("memory of the last 30 days: told titles, places and sections, insert ids, themes per town")`: a 31-day-old
    note is ignored.
  - `test("memoryFor: cached two minutes; null when off, slow (300 ms) or failing")`.
  - `test("time words: yesterday is the listener's yesterday (UTC offset), two days ago, last Tuesday, this morning")`:
    with the clock fixed at `2026-11-12T16:00Z` and an offset of -480, check the exact window bounds.
  - `test("recall: the mill story two days ago beats yesterday's mill story and today's ferry answer")`.
  - `test("recall: a named place wins without a time word; nothing matching gives nothing")`.
  - `test("recall: a Japanese or Tamil question doesn't throw and still matches a named place")` (Review Focus 2).
  - `test("whenSaid: relative days only")`.
  - `test("links near: this cell or town, not this drive's (under 3 h), newest first, at most 3")`.
  - `narration-config.test.mjs`: `test("the memory block has its defaults and an override replaces a value")`.
- [ ] **Step 2:** Run `node --test packages/core/test/memory.test.mjs packages/core/test/narration-config.test.mjs`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. Expect PASS.
- [ ] **Step 5:** Commit: `feat(memory): what a listener was told, recalled by time, name and word`.

### Task 4: POST /v1/me/notes and the wiring (service)

**Files:**
- Modify: `packages/api/src/app.mjs` (the route, and `buildApp` deps `notes`), `packages/api/src/wire.mjs` (`notes`,
  `memory` into narrate, inserts and aside)
- Test: `packages/api/test/app.test.mjs`

**Interfaces:**
- Consumes: `putNotes` (Task 2), `memoryFor` (Task 3).
- Produces:
  - Request body: `{ notes: Note[] }`.
    - Schema: 1-20 notes; `k` is one of `story`, `segment`, `insert`, `park`, `brief` (`answer` is server-only).
    - Field limits: `id` ≤ 80, `at` ISO with `Z`, `title` ≤ 200, `area` ≤ 100, `places` ≤ 8 × 120, `sec` ≤ 4 × 160,
      `themes` ≤ 3 × 30, `gist` ≤ 400, `cell` `^[0-9b-hjkmnp-z]{5}$`, `text` ≤ 2,500; `additionalProperties: false`.
  - Handling:
    - The server clamps `at` to at most now (Review Focus 1).
    - The reply is `{ ok: true }`.
  - In `wire.mjs`:
    - `narrate(req, user)` sets `req.memory`.
    - `inserts(req, user)` adds the memory's insert ids to `exclude` and passes `told`.
    - `aside(req, user)` passes `links`.
    - Memory is set only server-side, never taken from the body.

- [ ] **Step 1: Failing tests:**
  - `test("notes: a signed-in listener's batch is stored under their account; at in the future is clamped to now")`.
  - `test("notes: more than 20, an answer kind, a coordinate field or a long text are refused (400)")`.
  - `test("a story request's memory comes from the server, never from the body")`: a body carrying `memory` gets 400.
- [ ] **Step 2:** Run `node --test packages/api/test/app.test.mjs`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. Expect PASS.
- [ ] **Step 5:** Commit: `feat(memory): the phone's notes endpoint; memory wired into stories, inserts and the personal line`.

### Task 5: No repeats for 30 days, sections, links (service)

**Files:**
- Modify:
  - `packages/core/src/narrate.mjs` (`writeStory`)
  - `packages/core/src/library.mjs` (`libraryStory`, `backgroundSegment`)
  - `packages/core/src/inserts.mjs` (`insertsAhead`: also return `text` for ready inserts)
  - `packages/core/src/aside.mjs` (links)
- Test: `packages/core/test/narrate.test.mjs`, `library.test.mjs`, `inserts.test.mjs`, `aside.test.mjs`

**Interfaces:**
- Consumes: `Memory`, `articleSections`, `linksNear` (Task 3). `req.memory`, `req.links` (Task 4).
- Produces:
  - `writeStory` input: `memory?: Memory`, `links?: { when, gist }[]`, `cfg.memory`.
  - `writeStory` output: `sec?: string[]` (the section ids used).
    - Topics name the town only when the intro was used.
  - `said` = this drive (`recent`, `past.titles`) + `memory.told`.
  - Town facts, in ladder order:
    1. The intro (as today, but from the whole article) when the town is not told.
    2. Else the first untold section of the town (`articleSections`, `cfg.memory.skipSections`).
    3. Else the county's first untold section.
    4. Else none.
  - With no untold place and no section, words are multiplied by `thinWords`.
  - Prompt wording: "Do not retell the history of X: it was already told to this listener".
  - Section facts are titled `ABOUT THE AREA (new to this listener: <heading>)`.
  - Links are printed only when `links.length` and the town is new on this drive. They go under the heading
    `EARLIER STORIES AROUND HERE (this listener heard them; never retell them)`, followed by the one-link rule.
  - `libraryStory`:
    - `told` adds `memory.told`; candidates are also skipped on `sec` and on themes for their area.
    - `links` (from `linksNear`) are passed to `write` only for own stories.
    - Background segments never get links.
  - `insertsAhead`: candidates whose title is in `told` are skipped. Ready inserts carry `text` (the script).
  - `personalAside`: `links` are printed with the same rule.

- [ ] **Step 1: Failing tests:**
  - narrate:
    - `test("a town told in the last 30 days gets its next untold section, not its intro again")`
    - `test("places told in the last 30 days are not given to the writer again")`
    - `test("no untold section left: the county's next one; nothing new at all: a shorter story")` (Review Focus 5,
      including no headings or an empty article)
    - `test("links back are offered once per town per drive, in a section marked heard, with the one-link rule")`
    - `test("with no memory (null) the prompt is exactly today's")`
  - library:
    - `test("a pool segment whose places, section or themes this listener heard in 30 days is passed over")`
    - `test("links go only into own stories, never into a shared segment")`
    - `test("a memory outage never stops a story")` (Review Focus 4)
  - inserts: `test("a place told in the last 30 days (by id or title) gets no roadside insert")`,
    `test("a ready insert carries its script")`.
  - aside: `test("the personal line may link back to an earlier story here")`.
- [ ] **Step 2:** Run `node --test packages/core/test/narrate.test.mjs packages/core/test/library.test.mjs packages/core/test/inserts.test.mjs packages/core/test/aside.test.mjs`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. Expect PASS, and the existing tests in those files still pass.
- [ ] **Step 5:** Commit: `feat(narration): nothing retold for 30 days; a town's article section by section; links back`.

### Task 6: Mic answers with context (service)

**Files:**
- Modify: `packages/live/src/handler.mjs`
- Test: `packages/live/test/handler.test.mjs`

**Interfaces:**
- Consumes: `putConn`, `connUser`, `notesSince`, `noteTexts`, `putNotes` (Task 2); `recall`, `timeWindow`, `whenSaid`
  (Task 3); `approxTokens` (`narrate.mjs`); `geohash`.
- Produces:
  - The ask message accepts `now { kind ≤ 20, title ≤ 200, said ≤ 2,000 }`, `drive [{ kind, title, gist }] ≤ 8` and
    `utcOffsetMin ∈ [-840, 840]`. Fields over a limit are cut, not refused.
  - `answer(msg, user, d)` builds the prompt sections, each capped by `approxTokens`:
    - `WHAT'S PLAYING NOW (data)` 500
    - `EARLIER ON THIS DRIVE (data)` 300
    - `FROM EARLIER DRIVES (data)`: `when: title: gist` lines, 400, plus `DETAIL` texts 600 for at most 2 notes
    - `NEARBY PLACES (data)`, as today
  - `ANSWER_PERSONA` adds the "answer from what you told them; if none of it covers it, say you don't recall telling
    them" rule and keeps every existing rule.
  - The answer note `{ k: "answer", id: a-…, at, title: question, gist: "Q: … A: …", cell }` is written after sending,
    and is never awaited before the reply.

- [ ] **Step 1: Failing tests:**
  - `test("connect remembers who the listener is; a question finds them by its connection")`
  - `test("a mid-story question gets the story playing in its prompt")`
  - `test("a question about two days ago brings the recalled note and its full text")`
  - `test("the drive's items and the last answers are in the prompt, capped")`
  - `test("listener text is data: an injected instruction stays inside a data section, cut to its cap")` (Review Focus 3)
  - `test("no user, or memory failing: answered as today from the nearby places")` (Review Focus 4)
  - `test("each answer becomes a note")`
  - Keep the existing tests passing (Spanish and Tamil, errors).
- [ ] **Step 2:** Run `node --test packages/live/test/handler.test.mjs`. Expect FAIL.
- [ ] **Step 3:** Implement. Add the store methods to the exported handler's deps (`dynamoStore()`).
- [ ] **Step 4:** Run it again. Expect PASS.
- [ ] **Step 5:** Commit: `fix(mic): answers know the story playing, this drive and earlier drives`.

### Task 7: Backfill from synced trips (service)

**Files:**
- Create: `scripts/backfill-notes.mjs`, `packages/core/src/backfill.mjs` (`notesFromState`)
- Test: `packages/core/test/backfill.test.mjs`

**Interfaces:**
- Produces: `notesFromState(state, { now, days = 30 }) => Note[]`.
  - It takes trips' `heard` entries with `status: "played"`, at `startedAt + atS * 1000`, within `days`.
  - Each note: `k: "story"`, `title`, `places: [title]`, `gist` = the first sentence of `text`, `text` (≤ 2,500), `cell`
    from `place`, and `id` = `storyId` or `bf-<trip>-<i>`.
  - CLI: `node scripts/backfill-notes.mjs <userId>` (AWS_PROFILE=milemuse). It reads `user_state` and calls `putNotes`.
- [ ] **Step 1:** Failing test: `test("played stories of the last 30 days become notes; skips, questions and older trips don't")`.
- [ ] **Step 2:** Run `node --test packages/core/test/backfill.test.mjs`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. Expect PASS.
- [ ] **Step 5:** Commit: `feat(memory): backfill notes from an account's synced trips`.

### Task 8: The phone sends notes and mic context (app)

**Files:**
- Modify: `src/api.ts` (`ask` context, `postNotes`, `InsertItem.text`), `src/freedrive.ts` (`Segment.sec`),
  `src/session.ts` (notes at half-play, the queue, `ask` context)
- Test: `src/session.test.ts` (or a new `src/notes.test.ts` for the pure queue), `src/api.test.ts`

**Interfaces:**
- Consumes: the Task 4 endpoint, the Task 6 message fields, insert `text` and segment `sec` (Task 5).
- Produces:
  - `api.ts`:
    - `ask(text, at?, voice?, ctx?: { now?: { kind; title; said }; drive?: { kind; title; gist? }[] })` also sends
      `utcOffsetMin`.
    - `postNotes(notes: Note[]) => Promise<void>`.
  - `session.ts`:
    - `about` entries carry a `note` draft: story or segment from `noted` (kind by `mode`), insert (with `text`), park
      item.
    - `noteStarted` tracks the playing note, and `onPlayer` queues it at half or at its end, with `at` = its start and
      `cell` = geohash-5 of the car (`commute.ts`'s geohash).
    - A segment's `sec` ids join its `titles`, so this drive's `past` carries them.
    - The queue is persisted (`writeCache("notes")`, at most 500 newest). It flushes in batches of 20 every 60 s
      during a drive, at trip end and at app start when signed in.
  - `ask()` builds:
    - `now`: the playing item's text up to its position, extended to the sentence end, last 2,000 chars. If nothing is
      playing, the last item when it ended under 3 min ago.
    - `drive`: the last 8 `toldPast` entries, plus the trip's last 2 questions.

- [ ] **Step 1: Failing tests:**
  - `test("an item heard past half becomes a note once; skipped in its first half, none")`
  - `test("notes survive a restart and are sent 20 at a time; a failed send keeps them")`
  - `test("a personal line is never a note")`
  - `test("a mic question carries what's playing up to now and this drive's last items")`
  - api: `test("ask sends now, drive and the UTC offset; postNotes posts the batch")`
- [ ] **Step 2:** Run `npm test` in MileMuseApp. Expect the new tests to FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expect PASS, exit 0.
- [ ] **Step 5:** Commit: `feat(memory): the phone notes what played and asks with what's playing`.

### Task 9: Infra grant (infra)

**Files:**
- Modify: `lib/services-stack.ts` (`props.data.fast.grantReadWriteData(live)`)
- Test: the existing infra test, if one covers the live function's policy. Otherwise `npx cdk synth` shows the grant.

- [ ] **Step 1:** Add the grant next to `db.grantDataApiAccess(live)`.
- [ ] **Step 2:** Run `npm test` (if any) and `npx cdk synth` in MileMuseInfra. Expect exit 0, and the live role's
  policy names the fast table.
- [ ] **Step 3:** Commit: `feat(live): the live Lambda reads and writes the fast table (listener memory)`.

### Task 10: Verify and open PRs

- [ ] Run `npm test` in MileMuseService (eslint + all), and `npm test` and `npm run typecheck` in MileMuseApp. Expect
  0 failures. On this machine, re-run a timing failure alone before treating it as real.
- [ ] Squash each repo's branch into one commit. Open the CodeCommit PRs (Service, App, Infra) against `main`. Commit
  the spec and plan in the MileMuse docs repo.
- [ ] Merge and deploy only on the owner's go-ahead. Then run the backfill for the owner's account and do a device test.
