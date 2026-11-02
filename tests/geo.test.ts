import { describe, expect, it } from 'vitest';
import { arcPath, bondSpanDeg } from '../src/compass/geometry';
import { angleDiff, bearingDeg, distanceM, formatDistance, offset, smoothHeading, unwrapHeading } from '../src/geo';

const A = { lat: 40.7681, lon: -73.9819 };

describe('geo', () => {
  it('measures a known distance (1 degree of latitude ≈ 111.2 km)', () => {
    expect(distanceM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111195, -1);
  });

  it('gives cardinal bearings', () => {
    expect(bearingDeg(A, { lat: A.lat + 0.01, lon: A.lon })).toBeCloseTo(0, 0);
    expect(bearingDeg(A, { lat: A.lat, lon: A.lon + 0.01 })).toBeCloseTo(90, 0);
    expect(bearingDeg(A, { lat: A.lat - 0.01, lon: A.lon })).toBeCloseTo(180, 0);
    expect(bearingDeg(A, { lat: A.lat, lon: A.lon - 0.01 })).toBeCloseTo(270, 0);
  });

  it('offset round-trips with distance and bearing', () => {
    for (const [b, d] of [[37, 250], [200, 900], [355, 12]]) {
      const p = offset(A, b, d);
      expect(distanceM(A, p)).toBeCloseTo(d, 0);
      expect(angleDiff(bearingDeg(A, p), b)).toBeCloseTo(0, 1);
    }
  });

  it('takes the short way round 359 -> 0', () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
    expect(unwrapHeading(359, 1)).toBe(361);
    expect(unwrapHeading(720, 350)).toBe(710);
    expect(smoothHeading(350, 10, 0.5)).toBe(0);
  });

  it('formats distances', () => {
    expect(formatDistance(42.4, 'metric')).toBe('42 m');
    expect(formatDistance(1534, 'metric')).toBe('1.5 km');
    expect(formatDistance(100, 'imperial')).toBe('330 ft');
    expect(formatDistance(3218.7, 'imperial')).toBe('2.0 mi');
  });
});

describe('compass geometry', () => {
  it('Bond arcs sweep wider as a friend gets closer', () => {
    const spans = [3000, 1500, 600, 200, 50, 25, 5].map(bondSpanDeg);
    for (let i = 1; i < spans.length; i++) expect(spans[i]).toBeGreaterThanOrEqual(spans[i - 1]);
    expect(spans[0]).toBe(8);
    expect(spans.at(-1)).toBe(120);
  });

  it('draws the arc centred on the bearing', () => {
    // 90° arc centred on north, radius 10 around (0,0): from -45° to +45°.
    const d = arcPath(0, 0, 10, 0, 90);
    const [x1, y1, , , , , , x2, y2] = d.replace(/[MA]/g, '').trim().split(/\s+/).map(Number);
    expect(x1).toBeCloseTo(-7.071, 2);
    expect(y1).toBeCloseTo(-7.071, 2);
    expect(x2).toBeCloseTo(7.071, 2);
    expect(y2).toBeCloseTo(-7.071, 2);
  });
});
