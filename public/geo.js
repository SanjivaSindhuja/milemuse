// geo.js - shared geodesy for MileMuse. Pure ES module, works in the browser
// (<script type="module">) AND in Node (import from build-content.mjs). No deps.
// All coordinates are {lat, lng}. Distances are in MILES.

export const EARTH_MI = 3958.7613;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Great-circle distance in miles between two {lat,lng} points.
export function haversineMiles(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing in degrees (0=N, 90=E, 180=S, 270=W) travelling from -> to.
export function bearingDeg(from, to) {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Cumulative mileage per vertex of a polyline (array of {lat,lng}). [0] = 0.
export function cumulativeMiles(polyline) {
  const cum = [0];
  for (let i = 1; i < polyline.length; i++) {
    cum[i] = cum[i - 1] + haversineMiles(polyline[i - 1], polyline[i]);
  }
  return cum;
}

// Local equirectangular projection (miles, x=east y=north) around an origin.
// Accurate enough for the short segments of a road polyline.
function toXY(origin, p) {
  const x = toRad(p.lng - origin.lng) * Math.cos(toRad(origin.lat)) * EARTH_MI;
  const y = toRad(p.lat - origin.lat) * EARTH_MI;
  return { x, y };
}

// Snap a point p onto the polyline. Returns:
//   { atMiles, snapped:{lat,lng}, segIndex, offsetMiles }
// atMiles = distance along the route to the closest point; offsetMiles =
// perpendicular distance from p to the route (used for off-route detection).
export function snapToRoute(polyline, cum, p) {
  let best = {
    offsetMiles: Infinity,
    atMiles: 0,
    snapped: polyline[0],
    segIndex: 0,
  };
  for (let i = 0; i < polyline.length - 1; i++) {
    const A = polyline[i];
    const B = polyline[i + 1];
    const a = toXY(A, A); // {0,0}
    const b = toXY(A, B);
    const pt = toXY(A, p);
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = pt.x - a.x;
    const apy = pt.y - a.y;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? (apx * abx + apy * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const snapped = {
      lat: A.lat + t * (B.lat - A.lat),
      lng: A.lng + t * (B.lng - A.lng),
    };
    const offset = haversineMiles(p, snapped);
    if (offset < best.offsetMiles) {
      best = {
        offsetMiles: offset,
        atMiles: cum[i] + haversineMiles(A, snapped),
        snapped,
        segIndex: i,
      };
    }
  }
  return best;
}

// Which side of travel a POI sits on, given the local travel heading.
// Returns 'left' | 'right'. Direction-aware: northbound and southbound flip
// automatically because the heading flips. (Facing N, west is left; facing S,
// west is right.)
export function sideOfRoad(headingDeg, from, poi) {
  const v = toXY(from, poi); // east(x), north(y)
  const th = toRad(headingDeg);
  // travel dir d=(sin th, cos th); cross = d x v (z) ; >0 => poi is to the left
  const cross = Math.sin(th) * v.y - Math.cos(th) * v.x;
  return cross > 0 ? "left" : "right";
}
