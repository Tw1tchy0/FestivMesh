import { useMemo } from 'react';
import { bearingDeg, distanceM } from '../geo';
import { selectFriends, useMesh, type FriendView } from '../store/useMesh';
import { useNow } from './useSensors';

export type LocatedFriend = FriendView & { dist?: number; bearing?: number };

/** Visible friends with distance/bearing from my phone's position (when both are known). */
export function useFriends(): LocatedFriend[] {
  const nodes = useMesh((s) => s.nodes);
  const myNum = useMesh((s) => s.myNodeNum);
  const me = useMesh((s) => s.myLocation);
  const now = useNow();
  return useMemo(
    () =>
      selectFriends(nodes, myNum, now).map((f) =>
        me && f.position
          ? { ...f, dist: distanceM(me, f.position), bearing: bearingDeg(me, f.position) }
          : f,
      ),
    [nodes, myNum, me, now],
  );
}
