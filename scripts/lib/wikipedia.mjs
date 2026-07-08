export async function geoSearch(lat, lng, radiusM = 1000, { fetch = globalThis.fetch, limit = 20 } = {}) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=geosearch` +
    `&gscoord=${lat}%7C${lng}&gsradius=${radiusM}&gslimit=${limit}&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wiki geosearch HTTP ${res.status}`);
  const data = await res.json();
  return (data.query?.geosearch || []).map((g) => ({ pageid: g.pageid, title: g.title, lat: g.lat, lng: g.lon, distM: g.dist }));
}
export async function fetchExtract(pageid, { fetch = globalThis.fetch, chars = 900 } = {}) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1` +
    `&exchars=${chars}&pageids=${pageid}&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wiki extract HTTP ${res.status}`);
  const data = await res.json();
  return data.query?.pages?.[pageid]?.extract || "";
}
