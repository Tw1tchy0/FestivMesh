import * as Location from 'expo-location';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { angleDiff, smoothHeading } from '../geo';
import { useMesh } from '../store/useMesh';

type HeadingState = {
  heading: number | null;
  /** 0 none … 3 high (iOS: <20° error). */
  accuracy: number;
  permission: 'unknown' | 'granted' | 'denied';
};

export const useHeading = create<HeadingState>(() => ({ heading: null, accuracy: 0, permission: 'unknown' }));

/** Starts GPS once for the whole app (chats and the friend sheet use it too). Mounted in the root layout. */
export function useSensorTracking() {
  useEffect(() => {
    let posSub: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      useHeading.setState({ permission: granted ? 'granted' : 'denied' });
      if (!granted) return;

      // Best GPS accuracy, but not BestForNavigation (meant for phones on a charger), and only after moving 2 m.
      posSub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Highest, distanceInterval: 2, timeInterval: 2000 },
        (loc) =>
          useMesh.getState().setMyLocation({
            lat: loc.coords.latitude,
            lon: loc.coords.longitude,
            accuracy: loc.coords.accuracy ?? undefined,
            at: loc.timestamp,
          }),
      );
      if (cancelled) posSub.remove();
    })().catch(() => useHeading.setState({ permission: 'denied' }));

    return () => {
      cancelled = true;
      posSub?.remove();
    };
  }, []);
}

/** Smaller turns than this don't re-render anything. */
const HEADING_STEP_DEG = 0.5;

/** Runs the compass sensor only while `active` (the compass is on screen). */
export function useHeadingTracking(active: boolean) {
  const granted = useHeading((s) => s.permission === 'granted');
  useEffect(() => {
    if (!active || !granted) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    Location.watchHeadingAsync((h) => {
      const raw = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
      const { heading: prev, accuracy } = useHeading.getState();
      const next = smoothHeading(prev, raw, 0.3);
      if (prev !== null && Math.abs(angleDiff(prev, next)) < HEADING_STEP_DEG && accuracy === h.accuracy) return;
      useHeading.setState({ heading: next, accuracy: h.accuracy });
    })
      .then((s) => {
        if (cancelled) s.remove();
        else sub = s;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [active, granted]);
}

/** Re-renders every `ms` so "2m ago" and freshness states stay current. */
export function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
