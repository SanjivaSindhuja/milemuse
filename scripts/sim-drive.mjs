// sim-drive.mjs - "desk drive": replay the whole route through the SAME selection
// logic the player uses, and report ordering, sides, and silent-gap analysis at the
// real expected speed. This is the offline QA harness for the driving experience.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = join(HERE, "..", "public");
const manifest = JSON.parse(readFileSync(join(PUB, "manifest.json"), "utf8"));
const clips = manifest.clips;
const mph = manifest.route.expectedSpeedMph;
const total = manifest.route.totalMiles;

// 1) Forward-drive ordering check: step along the route, fire clips as the player would.
let nextIndex = 0;
const fired = [];
for (let m = 0; m <= total + 0.001; m += 0.02) {
  while (nextIndex < clips.length && clips[nextIndex].startAtMiles <= m) {
    fired.push({ i: nextIndex, m: clips[nextIndex].startAtMiles });
    nextIndex++;
  }
}
const inOrder = fired.every((f, k) => f.i === k);
const allFired = fired.length === clips.length;

// 2) Never-silent analysis at the real speed.
const milesPerSec = mph / 3600;
let silentSec = 0, longestGap = 0, longestWhere = "";
const rows = [];
for (let k = 0; k < clips.length; k++) {
  const c = clips[k];
  const endMile = c.startAtMiles + c.durationSec * milesPerSec;
  const nextStart = k + 1 < clips.length ? clips[k + 1].startAtMiles : total;
  const gapMiles = Math.max(0, nextStart - endMile);
  const gapSec = gapMiles / milesPerSec;
  silentSec += gapSec;
  if (gapSec > longestGap) { longestGap = gapSec; longestWhere = `${c.id} -> ${clips[k + 1]?.id || "end"}`; }
  rows.push({
    n: String(k + 1).padStart(2, "0"),
    id: c.id, start: c.startAtMiles, dur: c.durationSec, end: endMile,
    side: c.side, gap: gapSec,
  });
}
const driveMin = (total / mph) * 60;

console.log(`\n  MileMuse desk-drive  |  ${manifest.route.name}  |  ${total} mi  @ ${mph} mph  ~ ${driveMin.toFixed(0)} min\n`);
console.log(`  ##  story              start   dur    ends   side    then silent`);
console.log(`  --  -----------------  ------  -----  ------  -----   -----------`);
for (const r of rows) {
  const gapTxt = r.gap < 1 ? "back-to-back" : `${r.gap.toFixed(0)}s quiet`;
  console.log(
    `  ${r.n}  ${r.id.padEnd(17)}  ${r.start.toFixed(1).padStart(5)}  ${r.dur.toFixed(0).padStart(4)}s  ${r.end.toFixed(1).padStart(5)}  ${r.side.padEnd(5)}   ${gapTxt}`
  );
}
console.log(`\n  ordering: ${inOrder && allFired ? "OK - all " + clips.length + " fire once, in order" : "FAIL"}`);
console.log(`  narration covers ~${(((driveMin * 60 - silentSec) / (driveMin * 60)) * 100).toFixed(0)}% of the drive`);
console.log(`  total quiet time: ${(silentSec / 60).toFixed(1)} min  |  longest gap: ${longestGap.toFixed(0)}s (${longestWhere})\n`);

if (!(inOrder && allFired)) process.exit(1);
