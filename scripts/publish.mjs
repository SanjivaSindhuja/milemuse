// publish.mjs - one command to refresh + ship content.
//   npm run publish
// Rebuilds all audio (incremental - only changed scripts re-synthesize), then
// commits, pushes, and deploys the site to GitHub Pages. Live in ~1 min.
import { execSync } from "node:child_process";

const run = (cmd, opts = {}) => { console.log("\n$ " + cmd); execSync(cmd, { stdio: "inherit", ...opts }); };
const msg = process.argv[2] || "content: refresh";

run("node scripts/build-content.mjs");
run("git add -A");
try {
  run(`git -c commit.gpgsign=false commit -m ${JSON.stringify(msg)}`);
} catch {
  console.log("(no content changes to commit)");
}
run("git push origin master");
run("git subtree push --prefix public origin gh-pages");
console.log("\n✅ Published. Live in ~1 min at https://sanjivasindhuja.github.io/milemuse/");
console.log("   (On your phone: reopen + pull-to-refresh to pick up the new content.)");
