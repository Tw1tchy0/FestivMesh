/** Inside this distance a friend has "arrived" and rings your center dot. */
export const ARRIVED_M = 15;
/** Faint distance arcs drawn inside the halo. */
export const DISTANCE_RINGS = [50, 200, 1000];

const NEAR_M = 25;
const FAR_M = 1500;
const MIN_SPAN_DEG = 8;
const MAX_SPAN_DEG = 120;

/** Angular length of a friend's Bond arc on the halo: a sliver far away, a wide sweep up close. */
export function bondSpanDeg(distM: number): number {
  if (distM <= NEAR_M) return MAX_SPAN_DEG;
  if (distM >= FAR_M) return MIN_SPAN_DEG;
  const t = (Math.log10(distM) - Math.log10(NEAR_M)) / (Math.log10(FAR_M) - Math.log10(NEAR_M));
  return MAX_SPAN_DEG - t * (MAX_SPAN_DEG - MIN_SPAN_DEG);
}

/** SVG path for an arc of radius r centred on `bearing`, `spanDeg` wide (bearings: 0 = up, clockwise). */
export function arcPath(cx: number, cy: number, r: number, bearing: number, spanDeg: number): string {
  const a = polar(cx, cy, r, bearing - spanDeg / 2);
  const b = polar(cx, cy, r, bearing + spanDeg / 2);
  const large = spanDeg > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`;
}

const MIN_R_M = 10;
const MAX_R_M = 2000;

/** Log-scaled radius for a distance, between your center dot (inner) and the halo (outer). */
export function radiusForDistance(distM: number, inner: number, outer: number): number {
  const d = Math.min(Math.max(distM, MIN_R_M), MAX_R_M);
  const t = (Math.log10(d) - Math.log10(MIN_R_M)) / (Math.log10(MAX_R_M) - Math.log10(MIN_R_M));
  return inner + t * (outer - inner);
}

/** SVG coordinates for a compass bearing (0 = up) at radius r around (cx, cy). */
export function polar(cx: number, cy: number, r: number, bearing: number) {
  const a = ((bearing - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
