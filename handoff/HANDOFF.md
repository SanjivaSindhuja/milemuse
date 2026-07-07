# MileMuse - Session Handoff Invariants (read this FIRST, it governs everything)

You are ONE of two parallel autonomous Claude sessions building **MileMuse**, a GPS-triggered travel-audio
web app. Demo route: Everett -> Seattle. Your assignment (files + exact behavior) is in your spawn prompt;
the binding schemas + UI/engine spec are in `CONTRACT.md` at the repo root. **Read `CONTRACT.md` now.**

## Environment (all preinstalled - do NOT install anything)
- Repo root: `C:\Users\jeyan\Projects\MileMuse` (you are in a git worktree of it).
- Node 24, npm 11, Python 3.14, `python -m edge_tts` (v7.2.8, free neural TTS), `ffmpeg`/`ffprobe`, `curl`,
  global `fetch` in Node. Internet is available (OSRM, edge-tts endpoints).
- **No `npm install`.** The content pipeline uses only Node built-ins + child_process to call
  python/ffprobe. The web app is vanilla HTML/CSS/JS (no bundler, no deps).

## Hard rules
1. **Edit ONLY the files your task assigns.** Never touch the other session's files. Never edit the
   owner-provided read-only files: `public/geo.js`, `content/landmarks.json`, `CONTRACT.md`, `handoff/`.
2. **All web asset paths are RELATIVE (`./x`)** - the site ships under a GitHub Pages subpath.
3. **Commit to YOUR branch only. Do NOT push, merge, or deploy.** The owner integrates + deploys.
4. Keep source ASCII (normal punctuation is fine). Use your own Edit/Write tools (UTF-8 safe).
5. When done, write **`RESULT.md`** in the worktree: what you built, how it is scalable + extensible
   (UX and data), how you verified it, and anything the owner must know. Then
   `git add -A && git commit -m "..."`. Stop. Do not open a PR.

## How to work (use the skills, actually follow them)
- Net-new UI/logic: a quick `superpowers:brainstorming` pass is fine, then `superpowers:test-driven-
  development` where a test makes sense (geo wiring, manifest validation, engine ordering).
- **Session B (the player) MUST use `ui-ux-pro-max`** - it is a user-facing, driving-safe surface:
  mobile-first, big tap targets, high contrast, accessible (aria-labels, reduced-motion), no tiny text.
- Finish with `superpowers:verification-before-completion`: actually RUN it. Session A: run the pipeline,
  confirm manifest validates + audio exists with real durations. Session B: serve `public/` and load it,
  run the simulate "fast preview", confirm clips play in order with the right side.
- Implement END TO END and WIRE it - no half-built stubs. Make it scalable + extensible: everything is
  driven by `manifest.json` / `landmarks.json`, never hardcoded to Everett.

## Verify commands
- Session A: `node scripts/build-content.mjs` then `node --test scripts/` ; inspect `public/manifest.json`.
- Session B: `cd public && python -m http.server 8080` then load `http://localhost:8080/` in a browser.
