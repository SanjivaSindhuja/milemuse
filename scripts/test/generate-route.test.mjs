import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRouteContent } from "../generate-route.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("buildRouteContent assembles a valid manifest from mocked deps", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "mm-"));
  const line = [{ lat: 47.98, lng: -122.20 }, { lat: 47.70, lng: -122.33 }];
  const deps = {
    geocode: async (n) => ({ lat: n.includes("Everett") ? 47.98 : 47.70, lng: n.includes("Everett") ? -122.20 : -122.33, displayName: n }),
    osrmPolyline: async () => line,
    harvestAlongRoute: async () => ([
      { name: "Boeing Factory", lat: 47.907, lng: -122.28, category: "history", sourceText: "Big building.", sourceUrl: "u", atMiles: 5, side: "right", offsetMiles: 2 },
    ]),
    generateScript: async (poi, side) => `On your ${side}, ${poi.name}.`,
    synth: () => {}, durationSec: () => 42.0, audioName: () => "audio/deadbeefdeadbeef.mp3",
    outDir,
  };
  const { manifest } = await buildRouteContent({ from: "Everett, WA", to: "Seattle, WA", deps });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.clips[0].startAtMiles, 0);
  assert.match(manifest.clips[0].transcript, /Boeing Factory/);
  for (const c of manifest.clips) assert.ok("side" in c && "atMiles" in c && "audio" in c);
});
