import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { useIsFocused, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ARRIVED_M } from '../../compass/geometry';
import { CompassDial, type DialFriend, type DialPin } from '../../compass/CompassDial';
import { ConnectionPill, FriendDot } from '../../components/ui';
import { angleDiff, bearingDeg, cardinal, distanceM, formatDistance, timeAgo } from '../../geo';
import { useFriends, type LocatedFriend } from '../../hooks/useFriends';
import { useHeading, useHeadingTracking, useNow } from '../../hooks/useSensors';
import { useMesh } from '../../store/useMesh';
import { COLORS, RADIUS, SPACING } from '../../theme';

const FACING_DEG = 10;

function KeepAwake() {
  useKeepAwake();
  return null;
}

function statusLine(f: LocatedFriend, now: number) {
  if (!f.position) return 'Waiting for their location';
  const when = f.fresh ? 'live' : `last seen ${timeAgo(f.position.time, now)}`;
  if (!f.canMessage) return `${when} · radio only`;
  return f.phoneActive ? `${when} · can message` : `${when} · phone away`;
}

export default function CompassScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Tabs stay mounted when you switch away, so sensors, keep-awake and animations follow focus.
  const focused = useIsFocused();
  useHeadingTracking(focused);
  const { width } = useWindowDimensions();
  const size = Math.min(width - SPACING.lg * 2, 380);
  const heading = useHeading((s) => s.heading);
  const accuracy = useHeading((s) => s.accuracy);
  const permission = useHeading((s) => s.permission);
  const me = useMesh((s) => s.myLocation);
  const settings = useMesh((s) => s.settings);
  const friends = useFriends();
  const now = useNow();

  const located = useMemo(
    () => friends.filter((f) => f.dist !== undefined) as (LocatedFriend & { dist: number; bearing: number })[],
    [friends],
  );
  // Stable props, so the dial's SVG doesn't redraw on every heading change (it rotates itself).
  const dialFriends: DialFriend[] = useMemo(
    () =>
      located.map((f) => ({
        num: f.num,
        color: f.color,
        bearing: f.bearing,
        dist: f.dist,
        canMessage: f.canMessage,
        fresh: f.fresh,
      })),
    [located],
  );
  const openFriend = useCallback((num: number) => router.push(`/friend/${num}`), [router]);
  const pins: DialPin[] = useMemo(
    () =>
      me
        ? friends
            .filter((f) => f.pin)
            .map((f) => ({ num: f.num, color: f.color, bearing: bearingDeg(me, f.pin!), dist: distanceM(me, f.pin!) }))
        : [],
    [friends, me],
  );

  // Haptic tick when you turn to face a friend.
  const facing = heading == null ? null : located.find((f) => Math.abs(angleDiff(heading, f.bearing)) < FACING_DEG && f.dist > ARRIVED_M);
  const lastFacing = useRef<number | null>(null);
  useEffect(() => {
    const id = facing?.num ?? null;
    if (id !== null && id !== lastFacing.current) void Haptics.selectionAsync();
    lastFacing.current = id;
  }, [facing?.num]);

  const sorted = [...friends].sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {settings.keepAwake && focused && <KeepAwake />}
      <View style={styles.header}>
        <Text style={styles.title}>Compass</Text>
        <View style={styles.headerRight}>
          <ConnectionPill onPress={() => router.navigate('/settings')} />
          <Pressable style={styles.iconBtn} onPress={() => router.push('/link')} hitSlop={8}>
            <Ionicons name="qr-code-outline" size={20} color={COLORS.text} />
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.dialWrap}>
          <CompassDial
            size={size}
            active={focused}
            friends={dialFriends}
            pins={pins}
            myColor={settings.myColor}
            hasFix={!!me}
            units={settings.units}
            onPressFriend={openFriend}
          />
        </View>

        <View style={styles.headingRow}>
          {facing ? (
            <Text style={[styles.headingText, { color: facing.color }]}>
              {facing.name} · {formatDistance(facing.dist, settings.units)} ahead
            </Text>
          ) : (
            <Text style={styles.headingText}>
              {heading == null ? 'Finding north…' : `${cardinal(heading)} ${Math.round(heading)}°`}
            </Text>
          )}
          {permission === 'denied' && (
            <Text style={styles.warn}>Location is off. Enable it in iOS Settings to see where friends are.</Text>
          )}
          {permission === 'granted' && heading != null && accuracy > 0 && accuracy < 2 && (
            <Text style={styles.warn}>Compass is inaccurate. Wave your phone in a figure-8 to calibrate.</Text>
          )}
        </View>

        {sorted.length === 0 ? (
          <Pressable style={styles.empty} onPress={() => router.push('/link')}>
            <Ionicons name="people-outline" size={28} color={COLORS.textDim} />
            <Text style={styles.emptyTitle}>No friends yet</Text>
            <Text style={styles.emptyText}>
              Put your radios on the same festival channel and they’ll show up here. Tap to link people, or add radios heard nearby in Settings.
            </Text>
          </Pressable>
        ) : (
          <View style={styles.list}>
            {sorted.map((f) => {
              const rel = heading != null && f.bearing !== undefined ? f.bearing - heading : f.bearing;
              const arrived = f.dist !== undefined && f.dist <= ARRIVED_M;
              return (
                <Pressable
                  key={f.num}
                  style={({ pressed }) => [styles.friend, pressed && { opacity: 0.7 }]}
                  onPress={() => router.push(`/friend/${f.num}`)}
                >
                  <FriendDot color={f.color} canMessage={f.canMessage} size={14} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.friendName}>{f.name}</Text>
                    <Text style={[styles.friendSub, !f.fresh && f.position && { color: COLORS.warn }]}>
                      {arrived ? "You're together" : statusLine(f, now)}
                    </Text>
                  </View>
                  {f.dist !== undefined && (
                    <View style={styles.distBox}>
                      {rel !== undefined && !arrived && (
                        <Ionicons name="navigate" size={16} color={f.color} style={{ transform: [{ rotate: `${rel - 45}deg` }] }} />
                      )}
                      <Text style={styles.dist}>{formatDistance(f.dist, settings.units)}</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  title: { color: COLORS.text, fontSize: 28, fontWeight: '700' },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface,
  },
  scroll: { paddingHorizontal: SPACING.lg, paddingBottom: SPACING.xl },
  dialWrap: { alignItems: 'center', marginTop: SPACING.sm },
  headingRow: { alignItems: 'center', gap: 6, marginVertical: SPACING.md },
  headingText: { color: COLORS.textDim, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  warn: { color: COLORS.warn, fontSize: 13, textAlign: 'center' },
  list: { gap: SPACING.sm },
  friend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
  },
  friendName: { color: COLORS.text, fontSize: 16, fontWeight: '600' },
  friendSub: { color: COLORS.textDim, fontSize: 13, marginTop: 2 },
  distBox: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dist: { color: COLORS.text, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  empty: {
    alignItems: 'center',
    gap: SPACING.sm,
    padding: SPACING.xl,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
  },
  emptyTitle: { color: COLORS.text, fontSize: 17, fontWeight: '600' },
  emptyText: { color: COLORS.textDim, fontSize: 14, textAlign: 'center' },
});
