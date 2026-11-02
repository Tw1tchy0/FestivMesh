import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, FriendDot, Row } from '../../components/ui';
import { bearingDeg, cardinal, distanceM, formatDistance, timeAgo } from '../../geo';
import { useFriends } from '../../hooks/useFriends';
import { useNow } from '../../hooks/useSensors';
import { useMesh } from '../../store/useMesh';
import { COLORS, SPACING } from '../../theme';

export default function FriendSheet() {
  const router = useRouter();
  const { num } = useLocalSearchParams<{ num: string }>();
  const friend = useFriends().find((f) => f.num === Number(num));
  const units = useMesh((s) => s.settings.units);
  const me = useMesh((s) => s.myLocation);
  const setPin = useMesh((s) => s.setPin);
  const now = useNow();

  if (!friend) {
    return (
      <View style={styles.sheet}>
        <Text style={styles.sub}>This friend is no longer on your compass.</Text>
      </View>
    );
  }

  const pinDist = me && friend.pin ? distanceM(me, friend.pin) : undefined;

  return (
    <ScrollView style={{ backgroundColor: COLORS.surface }} contentContainerStyle={styles.sheet}>
      <View style={styles.head}>
        <FriendDot color={friend.color} canMessage={friend.canMessage} size={18} />
        <Text style={styles.name}>{friend.name}</Text>
      </View>
      <Text style={styles.sub}>
        {friend.phoneActive
          ? 'Phone connected to their radio · can message'
          : friend.canMessage
            ? `Phone away (last active ${timeAgo(friend.presenceAt!, now)}) · messages wait on their radio`
            : 'Radio only · you can follow them, but there’s no phone on their radio to read messages'}
      </Text>

      {friend.dist !== undefined && friend.bearing !== undefined ? (
        <View style={styles.big}>
          <Text style={[styles.bigDist, { color: friend.color }]}>{formatDistance(friend.dist, units)}</Text>
          <Text style={styles.bigDir}>
            {cardinal(friend.bearing)} · {Math.round(friend.bearing)}°
          </Text>
        </View>
      ) : (
        <Text style={styles.sub}>{me ? 'No location from them yet.' : 'Waiting for your GPS fix…'}</Text>
      )}

      <View style={styles.rows}>
        <Row
          label="Location"
          value={friend.position ? (friend.fresh ? 'Live' : `Last known, ${timeAgo(friend.position.time, now)}`) : 'Unknown'}
        />
        <Row label="Last heard" value={friend.lastHeard ? timeAgo(friend.lastHeard, now) : '—'} />
        {friend.battery !== undefined && (
          <Row label="Radio battery" value={friend.battery > 100 ? 'Plugged in' : `${friend.battery}%`} />
        )}
        {friend.hopsAway !== undefined && (
          <Row label="Path" value={friend.hopsAway === 0 ? 'Direct' : `${friend.hopsAway} relay${friend.hopsAway > 1 ? 's' : ''}`} />
        )}
        {friend.snr !== undefined && <Row label="Signal (SNR)" value={`${friend.snr.toFixed(1)} dB`} />}
        <Row label="Radio ID" value={`!${friend.num.toString(16).padStart(8, '0')}`} />
      </View>

      {friend.pin && (
        <View style={styles.pin}>
          <Ionicons name="location-outline" size={18} color={friend.color} />
          <Text style={styles.pinText}>
            Meeting point{' '}
            {pinDist !== undefined
              ? `${formatDistance(pinDist, units)} ${cardinal(bearingDeg(me!, friend.pin))}`
              : ''}{' '}
            · {timeAgo(friend.pin.at, now)}
          </Text>
          <Text style={styles.clear} onPress={() => setPin(friend.num, undefined)}>
            Clear
          </Text>
        </View>
      )}

      <Button
        label={friend.canMessage ? `Message ${friend.name}` : 'Messaging unavailable'}
        icon="chatbubble-outline"
        disabled={!friend.canMessage}
        onPress={() => {
          router.back();
          router.push(`/chat/${friend.num}`);
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: SPACING.xl, gap: SPACING.md, backgroundColor: COLORS.surface },
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  name: { color: COLORS.text, fontSize: 24, fontWeight: '700' },
  sub: { color: COLORS.textDim, fontSize: 14 },
  big: { alignItems: 'center', paddingVertical: SPACING.md },
  bigDist: { fontSize: 44, fontWeight: '800', fontVariant: ['tabular-nums'] },
  bigDir: { color: COLORS.textDim, fontSize: 16, marginTop: 2 },
  rows: { gap: SPACING.sm, paddingVertical: SPACING.sm },
  pin: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    padding: SPACING.md,
    borderRadius: 12,
    backgroundColor: COLORS.surfaceHigh,
  },
  pinText: { color: COLORS.text, flex: 1, fontSize: 14 },
  clear: { color: COLORS.accent, fontWeight: '600' },
});
