# Listener memory: answers that know what you heard, and no repeats for 30 days

Date: 2026-11-12. Status: for review. Repos: MileMuseService (server), MileMuseApp (phone), MileMuseInfra (one
grant). Model unchanged (Haiku 4.5).

## Why (owner's report, Nov 12)

1. A mic question asked mid-story got an answer that had nothing to do with the story playing.
2. Over 4-5 trips through Everett, Lynnwood and Bellevue, every trip told the same core facts. The voices and wording
   changed, but the facts didn't.

The owner asked for this:

- Remember everything played and asked, per account, as short summaries at the back end.
- Answer questions from that memory, even days later.
- Don't repeat anything for 30 days (40 later), and link back to earlier stories.
- Keep the token cost low.

## Root causes (found in the code)

| # | What happens today | Where |
|---|---|---|
| R1 | The mic sends only the question, the location and the voice. The story playing is never sent. | app `api.ts ask()`, `session.ts ask()` |
| R2 | The answer prompt has only "nearby places on file", which come from planned trips' saved places (usually none on Just drive). The prompt also says "use only the facts given about nearby places". So a mid-story question gets "I don't know", or an answer about some other place. | live `handler.mjs answer()` |
| R3 | The live handler doesn't know who is asking: auth runs only at `$connect`. So it can't read any history. | live `handler.mjs` |
| R4 | What was told is remembered for 30 min in phone memory (`toldPast`) and lost when the app restarts. Across days, only the exact same story id is skipped. | app `session.ts past()`, server `library.mjs` |
| R5 | A town's Wikipedia article (its first 2,500 chars) is given "once per drive". So every drive retells Everett's, Lynnwood's and Bellevue's history from the same text, in new words. | `narrate.mjs` `isNew`, `AREA_CHARS` |
| R6 | Free-drive stories after the first are written fresh for each listener (`told` makes them "own"), from the same facts. Shared segments are skipped by id only within one exact key (cell + heading + speed band). A story from another key, or a newly written one, repeats the facts. | `library.mjs` `own`, `heardIn(user, key)` |
| R7 | The roadside-insert heard list resets on every drive, and each place has one script. Same places, same lines, every commute. | app `lanes.ts` `heard`, server `I#` items |
| R8 | Themes are kept for 30 min only. | `past.themes` |
| R9 | The facts are finite: a town's article intro plus landmarks within about 3 km. Even perfect memory runs dry without new material. | `narrate.mjs` |

## Goals

- **Mic answers** use what's playing now (what has been said so far), this drive, earlier drives (days and weeks back)
  and past questions.
- **One memory per account.** Every item played and every question is kept as a short note at the back end. It works
  across phones and reinstalls.
- **No repeats for 30 days** (configurable). No place, town-history section or theme is retold to the same listener in
  the same area within the window. New stories may link back to an earlier one in a few words.
- **Token-lean.** No extra model calls for memory, and a fixed budget for every prompt.

## Non-goals

- Sending the whole history in every prompt. A month of commuting is about 2,400 notes, roughly 100k tokens.
- Embeddings or a vector database. v1 finds notes in code by time, name and keyword.
- New content sources such as news, events or "this day in history" (see Later).
- Any change to voices, the shared library's cost model, or prices.

## Anti-goals (failures even if it works)

- **Made-up memories.** If nothing matches, the narrator says it doesn't recall telling that.
- **Creepy recall.** Never a time of day or an exact route ("at 8:02 you passed..."). Only relative days ("yesterday",
  "last week").
- **Repeats inside the window to fill airtime.** Quiet beats repeats.
- **Personal memory in shared stories.** The shared pool stays free of anything about the listener. Personal lines
  (`mine:`) never become notes.
- **Slower answers.** Memory adds at most about 150 ms of server time.
- **Memory blocking a story or an answer.** If the notes can't be read in about 300 ms, or the read fails, the request
  runs as it does today.

## The design in one picture

```
phone                                      server (DynamoDB fast table, partition U#<user>)
-----                                      ------
item played past half --notes batch-->     POST /v1/me/notes --> M#<time>#<id>   note, kept 400 days
                                                               MT#<id>         full text, kept 30 days
mic question --ws: question+NOW+DRIVE-->   live: recall(notes) -> answer -> writes an answer note
story / segment / inserts request ------>  api: memoryFor(user): the 30-day told set -> writer, pool pick, inserts
```

## 1. Notes (the memory)

| Field | Content | Example |
|---|---|---|
| `k` | kind: `story`, `segment`, `insert`, `park`, `brief`, `answer` | `segment` |
| `id` | the item's id | `m3x9k2-ab12cd34` |
| `at` | when it played (phone time, ISO) | `2026-11-10T15:02:11Z` |
| `title`, `area` | its title, and the town it played in | `Port Gardner`, `Everett` |
| `places` | place titles it told (at most 8) | `["Port Gardner", "Weyerhaeuser Mill"]` |
| `sec` | the town-article sections it used (new, see §3) | `["Everett#Economy"]` |
| `themes` | up to 3 themes | `["industry"]` |
| `gist` | a story's SUMMARY line, which the writer already produces; an insert's script; the Q+A for an answer (at most 240 chars) | |
| `cell` | geohash-5 (about 5 km) of where it played | `c23nb` |

- **Size and retention.** About 350 bytes per note, kept 400 days like other account data. The full text goes in a side
  item `MT#<id>`, kept 30 days. It is read only when a question needs a detail.
- **When a note is written.** Once the item has played past half, or ended. A skip in the first half isn't a memory
  (the same rule park packs use today).
- **Upload.** The phone queues notes and keeps the queue on disk, so offline drives and park packs aren't lost. It sends
  them in batches of up to 20, about once a minute and at trip end.
- **Answers** are written by the server when it answers. The phone doesn't report them.
- **Endpoint.** `POST /v1/me/notes { notes }`, with a schema that caps every field (text at most 2,500 chars).
  Re-sending is idempotent: the sort key `M#<at>#<id>` is the same every time.
- **Export and delete.** Notes live under `U#<user>`, so they're already in `/v1/me/export` ("other") and erased with
  the account. The builder checks that `account.erase` removes every `U#` item.
- **Backfill.** A one-off script makes notes from the account's synced trips (`user_state` trips: title, text, place,
  time). Existing listeners, the owner included, then start with their history. Old trips don't record which towns were
  introduced, so a town's history may be retold once more after the update.

## 2. Mic answers with context

**The phone adds three optional fields to the WebSocket `ask` message:**

- `now { kind, title, said }`: the item playing. `said` is its text up to the current position plus the sentence being
  spoken, at most 2,000 chars. When nothing is playing, the last item counts if it ended under 3 min ago.
- `drive`: this drive's last 8 items as `{ kind, title, gist }`, with the last 2 Q&A pairs. The phone already holds
  these (`toldPast`, `about`).
- `utcOffsetMin`, so "yesterday" means the listener's yesterday.

**Who is asking.** At `$connect` the handler stores `W#<connectionId> / CONN -> user` (TTL 15 min). `$default` reads it.
Infra: grant the live Lambda read/write on the fast table and give it the table's name.

**Recall** runs in code, with no model call:

- It loads the last 30 days of notes in one Query. An older window is read only when the question names one.
- It scores each note:
  - **Time words** ("today", "this morning", "yesterday", "two days ago", "last Tuesday", "last week", "last month"):
    notes inside the window x4, outside x0.3. "Earlier" means this drive. Non-English questions skip this.
  - **Names**: a note whose title, area or places the question names, x3.
  - **Keywords**: stemmed word overlap with title + gist, weighted by how rare each word is across the loaded notes.
  - **Recency** breaks ties.
- The top 6 notes go in (at most 400 tokens). The top 1-2 also bring their full text (at most 600 tokens) when the
  question asks for a detail (who, what, when, how many, the name, "again") or names one item.

**The prompt** has these sections, in this order, each capped:

1. WHAT'S PLAYING NOW (500 tokens)
2. EARLIER ON THIS DRIVE (300)
3. FROM EARLIER DRIVES, dated relatively ("2 days ago") (400, plus 600 of detail)
4. NEARBY PLACES, as today (600)
5. The question

**The persona changes one rule.** It answers from what it told the listener (now, this drive, earlier drives) and from
the nearby places. If none of that covers the question, it says briefly that it doesn't recall telling them that, then
offers what it knows nearby. Every safety rule stays: no sides, no directions, pull over for emergencies.

**Cost.** Typically about 1,000 more input tokens per question, at most about 1,800, which is about $0.001-0.002 on
Haiku 4.5. No extra model calls. About 2 small DynamoDB reads, done in parallel with the facts lookup.

## 3. No repeats for 30 days, and links back

**The memory.** Every story, segment and inserts request is already signed in. On each one the server loads
`memoryFor(user)`: the last 30 days of notes, in one Query of at most 1 MB, cached about 2 min per warm Lambda. The
newest items of the current drive still come from the phone's `recent`, `past` and `exclude`, as today. From those notes
it derives:

- **told**: place and town titles
- **sections**: town article sections told (`town#section`)
- **themes per town**
- **nearby gists**: notes from this cell and its neighbours

**How each part of narration changes:**

| Part | Today | New |
|---|---|---|
| Places given to the writer | skips this drive + 30 min | also skips the last 30 days |
| Town intro | once per drive (the article's intro) | once per 30 days, then the next untold section of the town's article (see below) |
| Themes | 30 min | also 30 days in this town |
| Shared story / segment pick | skips heard ids within one exact key | also skips any whose places, town intro, sections or themes were told in 30 days |
| Roadside inserts | skips this drive's | also skips places told in 30 days (server-side, from notes) |
| Links back | none | see below |

**Town sections** come from the article we already fetch (the full plain text, split at its `== headings ==`). Examples:
Economy, Arts and culture, Parks, Neighborhoods, Notable people, Transportation, Sports, Geography, and parts of
History. Sections that are dull spoken aloud are skipped through config: Government, Education lists, Demographics,
Media, References. That gives weeks of new material per town without a new source.

- A story records the sections it used (`sec`), and its note carries them.
- Topics name the town (`Everett`) only when the intro was used, so an intro story and a section story filter
  separately.

**Links back:** up to 3 dated gists from around here go into the prompt, with this rule: *"You may link back to one in
a few words when it truly connects ('Yesterday we talked about the mill...'). Never retell it. At most one link."*

- Links go only where this listener alone hears them: in stories written just for them, and in the personal line on
  two-lane drives. Shared segments are heard by everyone, so they never carry a link.
- At most one link per town per drive (about 300 tokens when offered).

**When nothing new is left nearby** (small towns, a daily commute), in this order:

1. The town article's next untold section.
2. The county article's next untold section (the wider region).
3. A story from general knowledge of the region, from an angle not heard here in 30 days.
4. Go quieter: a shorter story (60% of the length).

Far-off places are not pulled in: the Nov 10 rule (no places the car is nowhere near) stays. Never a repeat inside the
window. After 30 days a place may be told again, in new words.

**Config** (the narration config, tunable live): `memory.enabled`, `memory.noRepeatDays` (30), `memory.recallNotes` (6),
`memory.links` (on), `memory.skipSections`, `memory.thinWords` (0.6).

## 4. Scenarios

**Mic**

1. Mid-story "when was that built?" -> answered from the story playing.
2. "Say that again" / "what was that name?" -> from the playing text.
3. "What was the story before this one?" -> this drive.
4. "What was that mill story two days ago?" -> time + keyword recall, detail from the full text.
5. "What did you tell me about Bellevue last week?" -> name + time; only the summary if older than 30 days.
6. "What did you say about the ferry earlier?" (an answer) -> answer notes.
7. A follow-up such as "and how tall is it?" -> the last Q&A is in the drive section.
8. Something never told -> "I don't think I've told you about that", plus nearby facts if any.
9. A general or nearby question -> nearby facts, as today.
10. During a roadside insert -> the insert is "now".
11. Paused or between items -> the last item (under 3 min) counts as now.
12. Parked with no drive -> no "now". Memory and nearby facts are still used.
13. No signal -> as today ("Couldn't reach MileMuse"). Nothing is recorded.
14. Another language (the voice's) -> answered in it. Notes stay in the language they were told in.
15. Family trivia answers are not questions -> not recorded as Q&A.
16. Two phones on one account -> both write notes. "Now" is each phone's own.
17. Export or delete account -> notes included.

**Repeats**

18. Daily commute, same road, same time -> new places, the next town sections, new angles. Roadside places told in the
    last 30 days are skipped.
19. Evening commute the other way -> a place is a place: still skipped.
20. A different road between the same towns -> new places naturally. Town sections keep rotating.
21. A thin town (one short article) -> told once per 30 days, then the region and other angles.
22. A rich city (Seattle) -> weeks of sections.
23. Shared segments in a busy area -> skipped by content, not just by id.
24. Day 31 -> eligible again.
25. A park pack offline -> already skipped for 30 days by item id. Notes queue and upload later.
26. A planned trip repeated -> phase 2: the manifest drops cues told in 30 days.
27. A new listener -> as today.
28. A story skipped in its first half -> not a memory, not "used up".
29. Link fatigue -> at most 1 link per story, and only on the first story in each town per drive.
30. A heavy listener (over 3,000 notes a month) -> the query is capped. Ceiling noted: a per-cell index later.

## 5. Token and cost budget

| | Today | New |
|---|---|---|
| Question input | ~300-900 tokens | +~1,000 (capped ~1,800) |
| Story input | ~1,500-3,000 tokens | at most +300 memory. After day 1, one section replaces the town intro, so net about 0 |
| Extra model calls | n/a | none |
| Voicing | n/a | more newly written segments for repeat listeners, which is the cost of "new". Each one still joins the shared pool for other listeners |
| DynamoDB | n/a | 1 Query per request (cached 2 min); 1 write per item played (batched) |
| Storage | n/a | ~350 B per note; a heavy commuter is about 1 MB a month, plus 30 days of text |

## 6. Changes by repo (for the plan)

**Service**

- `core/memory.mjs` (new): notes put and query, `memoryFor(user)` with a warm cache, the recall scorer, the time-word
  parser, and the article section splitter.
- `core/dynamo.mjs`: `M#`, `MT#` and `W#` items.
- `core/narration-config.mjs`: the `memory` block.
- `core/aside.mjs`: links back in the personal line.
- `api/app.mjs`: `POST /v1/me/notes`.
- `core/narrate.mjs`: `said`, town intro and sections, themes and links from memory; returns `sec`.
- `core/library.mjs`: library and pool filters by memory.
- `core/inserts.mjs`: excludes places in memory.
- `live/handler.mjs`: the `W#` connection item at connect; recall and the new prompt; writes the answer note.
- `scripts/`: the backfill from `user_state` trips.

**App**

- `api.ts`: `ask()` sends `now`, `drive` and `utcOffsetMin`; a new `notes()` batch call.
- `session.ts`: a note at half-play for every item kind (reusing the park-pack half rule); a queue kept on disk and
  flushed; builds `now` and `drive` for `ask()`.

**Infra**

- The live Lambda gets read/write on the fast table and the table name.

## 7. Testing

- **Service unit tests:**
  - time windows ("yesterday" across midnight, with the UTC offset)
  - recall ranking (time, then name, then keyword) and the budget caps
  - the persona's "don't recall" rule
  - `memoryFor` derivations
  - section order and the skip list
  - pool and inserts filters
  - notes schema caps and idempotency
  - the connection lookup
  - export and erase include `M#` and `MT#`
- **App unit tests:**
  - the ask payload: `said` up to the position, at most 2,000 chars; `drive` at most 8 items
  - a note at half, none on an early skip
  - the queue survives a restart and retries
  - batches of at most 20
- **Emulator:**
  - Drive a fake route (the `geo fix` feeder), ask mid-story, and check that the answer is about that story.
  - Seed "yesterday" notes on a test account, drive the same route, and check that no place or section repeats.
- **Field:** the owner's commute two days running, asking about the previous day's story.

## 8. Rollout

1. Service first. Every new phone field is optional, so old phones keep working, just without memory.
2. Backfill the owner's account.
3. App build (iPhone, and the Android arm64 APK).
4. Flags: `memory.enabled` and `memory.noRepeatDays`.

## 9. Owner decisions (to confirm)

1. When nothing new is left near a commute: wider-region stories first, then quieter with more music. Never a repeat
   inside 30 days.
2. Retention: notes 400 days (summaries), full text 30 days.
3. Roadside places are told once per 30 days. A daily commute's roadside lane goes mostly quiet after day 1, apart from
   new places.

## 10. Later (not in this build)

- Planned-trip manifests skip cues told in the last 30 days.
- A second, rotating fact per roadside place (one more script per place).
- A monthly digest for very old recall, and embeddings if keyword recall misses.
- A "What MileMuse remembers" screen with a forget button. Also an update to the privacy page.
- A commute opener: "Yesterday we left off at...".
- New sources: local events, this day in history.

## Builder's calls (made in this design, owner can override)

- Notes are written on the server in the existing fast table, not in Aurora: it is always on, while Aurora can take
  15-20 s to wake, too slow for the mic.
- Who is asking is passed through a `W#` connection item rather than a new Lambda authorizer.
- Recall is done in code (time, name, keyword), not with embeddings.
- A note is written at half-play.
- Links back say only relative days, come at most once per town per drive, and only where this listener alone hears
  them.
- "Wider region" means the county's article sections, not far-off places.
- Jokes and trivia don't become notes in v1.
