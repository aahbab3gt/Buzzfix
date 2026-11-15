// Location helpers: nearest building, reverse geocoding (OpenStreetMap Nominatim), formatting.
// Reverse geocoding is best-effort and cached; the app never blocks on it.

const cache = new Map();

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Returns { building, distanceMeters } for the closest building, or null if none within maxMeters.
export function nearestBuilding(buildings, lat, lng, maxMeters = 400) {
  let best = null;
  for (const b of buildings) {
    if (typeof b.lat !== "number" || typeof b.lng !== "number") continue;
    const d = haversineMeters(lat, lng, b.lat, b.lng);
    if (!best || d < best.distanceMeters) best = { building: b, distanceMeters: Math.round(d) };
  }
  return best && best.distanceMeters <= maxMeters ? best : null;
}

// Parse lat/lng from loose inputs (form strings, Twilio params). Returns null if invalid.
export function parseLatLng(lat, lng, accuracy) {
  const la = parseFloat(lat);
  const ln = parseFloat(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  const acc = parseFloat(accuracy);
  return { lat: +la.toFixed(6), lng: +ln.toFixed(6), accuracy: Number.isFinite(acc) ? Math.round(acc) : null };
}

// Reverse geocode to a short street address. Nominatim usage policy: 1 req/s, identify your app.
export async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18`;
    const res = await fetch(url, {
      headers: { "User-Agent": "BuzzFix/0.1 (Georgia Tech campus maintenance; hackathon demo)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const a = j.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(" ");
    const place = a.building || a.amenity || a.university || null;
    const short = [place, street].filter(Boolean).join(", ") || j.display_name?.split(",").slice(0, 2).join(",") || null;
    const out = short ? { short, full: j.display_name || short } : null;
    cache.set(key, out);
    return out;
  } catch (err) {
    console.error("Reverse geocode failed:", err.message);
    return null;
  }
}

export function mapsLink(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

export function describeGps(gps) {
  if (!gps) return "";
  const acc = gps.accuracy ? ` (±${gps.accuracy} m)` : "";
  return `${gps.lat}, ${gps.lng}${acc}`;
}
