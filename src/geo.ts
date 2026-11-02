export type LatLon = { lat: number; lon: number };

const R_EARTH = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in meters. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from true north, 0..360. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return norm360(toDeg(Math.atan2(y, x)));
}

/** Point reached by moving `meters` from `a` along `bearing`. */
export function offset(a: LatLon, bearing: number, meters: number): LatLon {
  const δ = meters / R_EARTH;
  const θ = toRad(bearing);
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

export function norm360(d: number): number {
  return ((d % 360) + 360) % 360;
}

/** Signed smallest difference b - a, in -180..180. */
export function angleDiff(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/**
 * Unwraps a heading stream so rotation animates the short way across 359→0.
 * Returns the new continuous angle given the previous continuous angle.
 */
export function unwrapHeading(prevContinuous: number, nextHeading: number): number {
  return prevContinuous + angleDiff(norm360(prevContinuous), nextHeading);
}

/** Exponential smoothing on a circle. alpha = weight of the new sample. */
export function smoothHeading(prev: number | null, next: number, alpha = 0.25): number {
  if (prev == null) return norm360(next);
  return norm360(prev + angleDiff(prev, next) * alpha);
}

export function formatDistance(m: number, units: 'metric' | 'imperial'): string {
  if (units === 'imperial') {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.round(ft / 5) * 5} ft`;
    const mi = m / 1609.344;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (m < 1000) return `${m < 100 ? Math.round(m) : Math.round(m / 5) * 5} m`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function cardinal(bearing: number): string {
  return CARDINALS[Math.round(norm360(bearing) / 45) % 8];
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
