# Simpler settings: locked during a drive, depth from speed, one Style bar, other apps' audio first

## Why

The owner tested the app and found four problems:

- **Settings take effect at an unknown time.** A drive copies the settings when it starts (`startFree` in
  `session.ts` reads `s.app.prefs` once). A change to voice, language, tone, level, topics or who's in the car is
  ignored for the rest of the drive, and nothing tells the listener. Mic answers do switch to the new voice at once,
  so one drive can play two voices.
- **Too many settings, and some don't mean much.** Level is a guess the app could make itself. "Delightful, funny,
  serious, crazy" don't describe what the stories do, and "funny" stories aren't reliably funny. Topics duplicate
  what a tone should decide.
- **Other apps' audio mixes with ours.** On iPhone the audio session uses `mixWithOthers`, so nav prompts can talk
  over a story. That also lets music started in another app play under the story. The owner wants MileMuse to pause
  instead.
- **Cost.** The owner said: "If we pay the cost, it has to be taken from the customer."

## Owner's decisions

1. **Locked during a drive.** Settings that would remake stories can't change while a drive runs. To change them,
   the listener stops the drive. No trying voices mid-story.
2. **Any regeneration the listener causes costs credits.** Nothing they trigger is free.
3. **No Level setting.** Depth follows speed. Stopped at a signal or under 25 mph: deep. 35 to 45 mph: normal. Above
   45 mph: normal or light, depending on how much there is to tell.
4. **Tone becomes meaningful, and topics merge into it.** No topics picker: every topic is used. One bar decides the
   kind of story, and each choice has to deliver what its name promises:
   - **Funny:** really funny, few facts.
   - **Serious:** lots of facts.
   - **Crazy:** a dive deep into the information.
   - **Delightful:** casual trip talk about the place, said nicely.

   The server holds what each choice means, so it can change without an app update.
5. **Other apps' audio comes first, always.** Remove the "Lower other audio" setting. When other audio starts,
   MileMuse pauses and lets it play.
6. **Make the settings very simple.**

## Behavior

### A. Settings during a drive

- **Story settings are locked while a trip runs** (Just drive or a planned trip): Style, Voice and language, Who's in
  the car, Personal touches, Family trivia, Units, Live local brief.
  - Their rows show as disabled with the caption "Stop the drive to change this".
  - A tap shows the toast "Stop the drive first to change this". Nothing is half-applied.
  - Before the trip starts, the route plan's sheet stays editable.
- **Sound settings still change at once:** Voice pace, Background music, Music volume.
- **The drive reads the settings it started with,** so nothing changes mid-drive. A guard in `session.update()`
  refuses a story-setting change while a trip runs; the UI must not be the only lock.
- **Mic answers** use the drive's voice, not the current setting.

### B. Story depth from speed (no Level)

The server picks story length from the speed the phone already sends. The bands live in the narration config, so the
owner can tune them:

| Speed | Depth | Free drive story | Two-lane segment |
|---|---|---|---|
| unknown, stopped, under 25 mph | deep | about 500 words | about 240 words |
| 25 to 45 mph | normal | about 300 words | about 180 words |
| over 45 mph | normal when the place has enough to tell, else light | 300, or 150 when thin | 180, or 120 when thin |

- "Thin" means fewer than 3 usable facts in the story's facts. The builder may tune the number.
- **Config:** a new `depth` block, `{ deepBelowMph: 25, lightAboveMph: 45, words: {...}, segmentWords: {...}, thinFacts: 3 }`.
- **When a request has no `words`,** the server takes the length from these bands. Today's band caps
  (`speed.capS`: town 90 s, freeway 120 s) don't apply then. They would cut "deep under 25 mph" to about 225 words.
- The app stops sending `words` from a level. An older app that still sends `words` keeps today's behavior: level
  words, then the band caps.
- 25 to 35 mph wasn't named: it is treated as normal (builder's call).
- A planned trip's stories are written before the drive: normal (builder's call). They need no speed.
- Interstate and park packs keep their pre-written lengths.

### C. One Style bar (tone plus topics)

One segmented bar with four choices and a one-line description each. It replaces Tone, Level and Topics. The stored
ids stay (`delightful`, `funny`, `serious`, `crazy`), so existing settings carry over. Labels and descriptions are
the builder's draft for the owner to approve:

| id | Label | What it does |
|---|---|---|
| delightful | Easygoing | A friendly ride-along: what's around you, said warmly. About 3 facts, a light touch. |
| funny | Funny | Comedy first: a joke or a playful aside in most sentences, about 2 facts, ends on a laugh. |
| serious | Just the facts | Fact-dense: about 6 or more facts with dates, numbers and causes. No jokes. |
| crazy | Deep dive | One subject told in depth: about 5 connected facts and why they matter, the surprising details. |

- **The server defines each style** in the narration config's tone catalogue. That covers its prompt, its fact budget
  and its topic mix: which topics it leans on. Funny leans on food, oddities, film and sports. Just the facts leans on
  history, science and industry. Deep dive goes wherever the richest facts are. Easygoing mixes them all. Changing
  the config changes this for everyone, with no app update.
- **The app sends no topics** (all of them). Each tone in the catalogue gets a `topics` list, its mix.
  - The app already reads the catalogue (`config.ts` `tonesOf`). It rotates each story's angle (`lens`) through the
    style's list, the way `lensFor` rotates the listener's topics today.
  - With no list, the angle rotates through every topic.
  - An older app that sends topics is honoured.
- **Removed from the app:**
  - the Topics picker and its favourite stars, in settings and onboarding
  - the car's Topics folder and its topic drives
  - the route plan's Story level card and the Level step in onboarding
- **Delivery is checked before release.** A script writes sample stories for each style at a few places and speeds.
  The owner listens and approves before the new styles ship. If Funny isn't funny, its prompt is reworked first.

### D. Other apps' audio first

- **The audio session no longer mixes:** `doNotMix` on both platforms, instead of iPhone's `mixWithOthers`. The
  "Lower other audio" setting and the `duck` pref are removed.
- **Music, podcasts or a video from another app start:** the story pauses. The trip screen shows it paused. Nothing
  restarts it until the listener taps play, or the other app stops and hands audio back.
- **A phone call or a navigation prompt:** the story pauses for it and resumes on its own.
  - **Android:** expo-audio already does this with `doNotMix` (checked in its `AudioModule.kt`). A lost focus
    pauses. A short loss, whether a call or a duckable nav prompt, pauses and resumes on regain.
  - **iPhone:** our native module (`modules/milemuse-platform`, iOS) sets the session's mode to `.spokenAudio` after
    every `setAudioModeAsync`. expo-audio doesn't offer this mode and can reset it to default. Nav apps then pause the
    story for a prompt and resume it, as podcast apps get.
  - Where this doesn't take effect, the fallback is the OS default, ducking. That counts as acceptable, not failed.
- **The playback watchdog must treat a pause from the OS as a pause.** It must never restart a story the OS paused.
- **The background music bed** pauses and resumes with the story.

### E. Credits

- Today a live story is charged when it starts playing. Preloaded and downloaded stories are free.
- With the lock (A), a settings change can never throw away a story made in the old settings mid-drive.
- **New story** and **Try again** make a fresh story. It is charged when it starts, as every live story is. The
  story it replaced was charged when it started.
- A story the app prepared in advance and then dropped (the car turned, the drive ended) stays free: the listener
  never heard it, and preparing ahead is our choice. New story keeps the waiting story for later (`keep(queued)`),
  so nothing is thrown away.
- **Leak found:** the first story of a drive is made when the app opens (`prefetch`) and is free when it plays.
  Explore's Refresh remakes it (`preload(true)`) at our cost on every tap. See the owner question below.

### F. The settings, after

- **You > Stories:**
  - Style (the bar)
  - Who's in the car
  - Voice and language, with Voice pace
  - Personal touches
  - Family trivia
  - Jokes, unchanged
- **You > Driving and sound:**
  - Navigate with
  - Units
  - Live local brief
  - Background music and its volume
- **Gone:** Level, Topics, Tone (now Style), Lower other audio.

## Builder's calls

These came from the review. The owner can override them.

- **Unknown speed means deep only on a live drive request that has no GPS speed.** The preloaded first story,
  offline area downloads and place stories (Explore, the car) have no speed by design, so they use normal. That
  keeps downloads at today's size and cost.
- **Level feedback goes with Level.** That covers the trip summary's "Was Normal about right?", its switch, and the
  drive-start "Switch to Deep?" prompt.
- **Jokes is a story setting,** so it is locked during a drive.
- **Night map and Appearance are display settings.** They stay and change at once.
- **"Just the facts" tells no jokes,** including the end-of-segment joke, whatever the Jokes toggle says.

## Owner's answers (2026-11-13: "Yes, go ahead")

1. **Charge all four.** Show the price first where the listener chooses: before a download, and on Start trip.
   - Mic question: 1 credit.
   - Planned-trip story: charged when it starts playing.
   - The drive's first story: charged when it plays. Refresh makes a new one only if the phone moved or the settings
     changed.
   - Downloaded stories: charged per story at download.
2. **Planned trips follow the settings:** Style, voice, language and who's in the car.
3. **A flat 2 credits per story,** whatever its length.
4. **Style names:** Easygoing, Funny, Just the facts, Deep dive.

## Open for the owner (from the review, now answered above)

These were verified in the code on 2026-11-13. Today only live stories are charged: `narrate()` registers a story,
and it is charged when it starts playing (`/v1/stories-heard`, then the pipeline's `charge`, 1, 2 or 3 credits by
words). The following are never charged:

1. **Paths the listener triggers that we pay for:**
   - **Mic questions:** the live service writes no ledger entry, but the Wallet lists "Live question · 1 credit".
   - **Planned-trip stories:** the pipeline writes them, and the phone plays them without reporting them, while the
     route screen shows "Start trip · N credits".
   - **The drive's first story:** it is preloaded, and Refresh remakes it on every tap.
   - **"Download stories around here".**
2. **Planned trips ignore Style, voice, language and who's in the car.** `planTrip` always writes "storyteller",
   Matthew, English. Either they follow the settings (a pipeline change, and re-planning writes new stories), or
   they stay fixed and are labelled.
3. **Price once speed picks the length:** by actual length (a deep story at a red light costs 3 credits), or flat.

## Non-goals

- Changing story settings during a drive, including a "try it now" button.
- Re-voicing or rewriting a story that is already playing.
- New styles beyond the four.
- Pausing the story for our own mic answers. That works today and stays as it is.

## Anti-goals

- A setting that looks changed but quietly doesn't apply.
- MileMuse talking over the listener's own music or call.
- A style whose stories don't match its name.

## Constraints

- **Old app versions keep working.** The server must accept `words`, `topics` and `level` from them as today.
- **Settings sync:** the account's settings store keeps `tone`. `level` and `topics` are no longer written, but are
  tolerated when they come back from the account.
- **iPhone builds** go through the Mac. Android builds run on this machine.
- **No Polly or Bedrock bulk runs** without the owner's OK on their cost. Sample stories for review are a few dollars
  at most.

## Left to the builder

- Exact copy for the disabled rows and toasts.
- The style prompts, within the fact budgets above.
- The thin threshold.
- How the server's speed bands reuse the existing speed-band config.
- Test design.
