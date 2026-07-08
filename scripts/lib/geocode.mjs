export async function geocode(name, { fetch = globalThis.fetch } = {}) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { "User-Agent": "MileMuse/0.1 (dev; contact via github)" } });
  if (!res.ok) throw new Error(`geocode HTTP ${res.status}`);
  const arr = await res.json();
  if (!arr.length) throw new Error(`no geocode result for "${name}"`);
  return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), displayName: arr[0].display_name };
}
