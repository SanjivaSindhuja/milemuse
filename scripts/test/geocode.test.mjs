import { test } from "node:test";
import assert from "node:assert/strict";
import { geocode } from "../lib/geocode.mjs";

const fakeFetch = async () => ({ ok: true, json: async () => ([{ lat: "47.979", lon: "-122.202", display_name: "Everett, WA" }]) });

test("geocode returns numeric lat/lng from Nominatim", async () => {
  const r = await geocode("Everett, WA", { fetch: fakeFetch });
  assert.equal(r.lat, 47.979);
  assert.equal(r.lng, -122.202);
  assert.equal(r.displayName, "Everett, WA");
});

test("geocode throws on empty result", async () => {
  await assert.rejects(() => geocode("zzzz", { fetch: async () => ({ ok: true, json: async () => [] }) }));
});
