export async function osrmPolyline(from, to, { fetch = globalThis.fetch } = {}) {
  const url = `https://router.project-osrm.org/route/v1/driving/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
      const data = await res.json();
      if (data.code !== "Ok" || !data.routes?.[0]) throw new Error(`OSRM: ${data.code}`);
      return data.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    } catch (e) { lastErr = e; if (attempt < 4) await new Promise((r) => setTimeout(r, 1500 * attempt)); }
  }
  throw lastErr;
}
