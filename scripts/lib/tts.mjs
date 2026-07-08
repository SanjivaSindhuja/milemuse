import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

let _voices = null;
export function voiceAvailable(voice) {
  if (_voices === null) {
    try { _voices = execFileSync("python", ["-m", "edge_tts", "--list-voices"], { encoding: "utf8" }); }
    catch { _voices = ""; }
  }
  return _voices.includes(voice);
}
export function audioName(voice, text) {
  return "audio/" + createHash("sha256").update(voice + "\n" + text).digest("hex").slice(0, 16) + ".mp3";
}
export function synth(text, voice, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = join(dirname(outPath), ".clip.txt");
  writeFileSync(tmp, text, "utf8");
  execFileSync("python", ["-m", "edge_tts", "--file", tmp, "--voice", voice, "--write-media", outPath], { stdio: "pipe" });
}
export function durationSec(mp3) {
  const out = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", mp3], { encoding: "utf8" });
  return parseFloat(JSON.parse(out).format.duration);
}
