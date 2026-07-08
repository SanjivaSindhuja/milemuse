import { test } from "node:test";
import assert from "node:assert/strict";
import { geoSearch, fetchExtract } from "../lib/wikipedia.mjs";

test("geoSearch maps results to {pageid,title,lat,lng,distM}", async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ query: { geosearch: [{ pageid: 5, title: "Gas Works Park", lat: 47.6, lon: -122.3, dist: 120 }] } }) });
  const r = await geoSearch(47.6, -122.3, 1000, { fetch });
  assert.deepEqual(r, [{ pageid: 5, title: "Gas Works Park", lat: 47.6, lng: -122.3, distM: 120 }]);
});

test("fetchExtract pulls the page extract", async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ query: { pages: { 5: { extract: "A public park." } } } }) });
  assert.equal(await fetchExtract(5, { fetch }), "A public park.");
});
