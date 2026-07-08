export async function overpassPois(lat, lng, radiusM = 500, { fetch = globalThis.fetch } = {}) {
  const q = `[out:json][timeout:25];(` +
    `node(around:${radiusM},${lat},${lng})["historic"]["name"];` +
    `node(around:${radiusM},${lat},${lng})["tourism"]["name"];` +
    `node(around:${radiusM},${lat},${lng})["natural"]["name"];` +
    `);out body 30;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: q });
  if (!res.ok) throw new Error(`overpass HTTP ${res.status}`);
  const data = await res.json();
  return (data.elements || []).filter((e) => e.tags?.name).map((e) => ({
    name: e.tags.name, lat: e.lat, lng: e.lon,
    category: e.tags.historic ? "history" : e.tags.natural ? "nature" : "quirky",
    tags: e.tags,
  }));
}
