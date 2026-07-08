import { test } from "node:test";
import assert from "node:assert/strict";
import { cumulativeMiles } from "../../public/geo.js";
import { harvestAlongRoute } from "../lib/pois.mjs";

const line = [{ lat: 47.98, lng: -122.20 }, { lat: 47.90, lng: -122.22 }, { lat: 47.70, lng: -122.30 }];
const cum = cumulativeMiles(line);

test("harvest dedupes, grounds, and places POIs in mile order", async () => {
  const wikiSearch = async () => ([{ pageid: 1, title: "Boeing Factory", lat: 47.907, lng: -122.28, distM: 100 }]);
  const wikiExtract = async () => "The largest building in the world by volume.";
  const osmSearch = async () => ([{ name: "Boeing Factory", lat: 47.907, lng: -122.28, category: "history", tags: {} }]); // dup by name
  // maxOffsetMiles: 4 preserves this fixture's original corridor width (offset ~2.81mi);
  // this test targets dedupe/grounding/ordering, not the corridor cutoff itself (default is 1.5mi).
  const pois = await harvestAlongRoute(line, cum, { wikiSearch, wikiExtract, osmSearch, spacingMiles: 2, maxOffsetMiles: 4 });
  assert.ok(pois.length >= 1);
  assert.equal(pois[0].name, "Boeing Factory");
  assert.match(pois[0].sourceText, /largest building/);
  assert.ok(["left", "right"].includes(pois[0].side));
  for (let i = 1; i < pois.length; i++) assert.ok(pois[i].atMiles >= pois[i - 1].atMiles);
  // deduped: Boeing appears once
  assert.equal(pois.filter((p) => p.name === "Boeing Factory").length, 1);
});
