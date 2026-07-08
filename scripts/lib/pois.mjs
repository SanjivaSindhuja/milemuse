import { cumulativeMiles, snapToRoute, sideOfRoad, bearingDeg, haversineMiles } from "../../public/geo.js";

// Sample the route every ~spacingMiles, harvest POIs near each sample, dedupe,
// ground with Wikipedia extract, place along the route, and keep one per slot.
export async function harvestAlongRoute(polyline, cum, opts) {
  const { wikiSearch, wikiExtract, osmSearch, spacingMiles = 2, radiusM = 1600 } = opts;
  const total = cum[cum.length - 1];
  const seen = new Map(); // name(lowercased) -> poi (dedupe)

  for (let m = 0; m <= total; m += spacingMiles) {
    // find the vertex nearest mile m
    let vi = 1; while (vi < cum.length && cum[vi] < m) vi++;
    const p = polyline[Math.min(vi, polyline.length - 1)];
    const wiki = await wikiSearch(p.lat, p.lng, radiusM).catch(() => []);
    const osm = await osmSearch(p.lat, p.lng, Math.min(radiusM, 800)).catch(() => []);
    for (const w of wiki) {
      const key = w.title.toLowerCase();
      if (seen.has(key)) continue;
      const text = await wikiExtract(w.pageid).catch(() => "");
      if (text.length < 40) continue; // too thin to ground a story
      seen.set(key, { name: w.title, lat: w.lat, lng: w.lng, category: "history",
        sourceText: text, sourceUrl: `https://en.wikipedia.org/?curid=${w.pageid}`, _prom: text.length });
    }
    for (const o of osm) {
      const key = o.name.toLowerCase();
      if (seen.has(key)) continue; // Wikipedia wins on dupes
      seen.set(key, { name: o.name, lat: o.lat, lng: o.lng, category: o.category,
        sourceText: `${o.name} (${o.category}).`, sourceUrl: "https://www.openstreetmap.org/", _prom: 40 });
    }
  }

  // Place each POI on the route (atMiles + side), keep one per slot by prominence.
  const placed = [];
  for (const poi of seen.values()) {
    const snap = snapToRoute(polyline, cum, { lat: poi.lat, lng: poi.lng });
    if (snap.offsetMiles > 4) continue; // too far off the corridor
    const seg = Math.min(snap.segIndex, polyline.length - 2);
    const heading = bearingDeg(polyline[seg], polyline[seg + 1]);
    placed.push({ ...poi, atMiles: snap.atMiles, offsetMiles: snap.offsetMiles,
      side: sideOfRoad(heading, snap.snapped, { lat: poi.lat, lng: poi.lng }) });
  }
  placed.sort((a, b) => a.atMiles - b.atMiles);

  // Thin to one per slot: greedily keep the most prominent within each spacing window.
  const kept = [];
  for (const poi of placed) {
    const last = kept[kept.length - 1];
    if (last && poi.atMiles - last.atMiles < spacingMiles * 0.6) {
      if (poi._prom > last._prom) kept[kept.length - 1] = poi; // swap in the better one
      continue;
    }
    kept.push(poi);
  }
  return kept.map(({ _prom, ...p }) => p);
}
