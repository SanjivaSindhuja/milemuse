import { test } from "node:test";
import assert from "node:assert/strict";
import { overpassPois } from "../lib/osm.mjs";

test("overpassPois keeps only named nodes and maps category", async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ elements: [
    { lat: 1, lon: 2, tags: { name: "Old Fort", historic: "fort" } },
    { lat: 3, lon: 4, tags: { natural: "peak" } }, // no name -> dropped
    { lat: 5, lon: 6, tags: { name: "Big Tree", natural: "tree" } },
  ] }) });
  const r = await overpassPois(1, 2, 500, { fetch });
  assert.equal(r.length, 2);
  assert.equal(r[0].category, "history");
  assert.equal(r[1].category, "nature");
});
