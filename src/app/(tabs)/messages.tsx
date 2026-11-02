import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FriendDot } from '../../components/ui';
import { timeAgo } from '../../geo';
import { useFriends } from '../../hooks/useFriends';
import { useMesh } from '../../store/useMesh';
import { COLORS, RADIUS, SPACING } from '../../theme';

export default function MessagesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const friends = useFriends();
  const messages = useMesh((s) => s.messages);
  const unread = useMesh((s) => s.unread);

  const rows = friends
    .map((f) => {
      const last = [...messages].reverse().find((m) => m.peer === f.num);
      return { f, last };
    })
    .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Text style={styles.title}>Messages</Text>
      <FlatList
        data={rows}
        keyExtractor={(r) => String(r.f.num)}
        contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.sm }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="chatbubbles-outline" size={28} color={COLORS.textDim} />
            <Text style={styles.emptyText}>
              Friends on your festival channel appear here. Messages go radio to radio, no cell service needed.
            </Text>
          </View>
        }
        renderItem={({ item: { f, last } }) => {
          const n = unread[f.num] ?? 0;
          return (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
              onPress={() => router.push(`/chat/${f.num}`)}
            >
              <FriendDot color={f.color} canMessage={f.canMessage} size={14} />
              <View style={{ flex: 1 }}>
                <View style={styles.rowTop}>
                  <Text style={styles.name}>{f.name}</Text>
                  {last && <Text style={styles.time}>{timeAgo(last.at)}</Text>}
                </View>
                <View style={styles.rowTop}>
                  <Text style={[styles.preview, n > 0 && { color: COLORS.text }]} numberOfLines={1}>
                    {last ? `${last.fromMe ? 'You: ' : ''}${last.text}` : f.canMessage ? 'Say hi' : 'Radio only · trackable'}
                  </Text>
                  {n > 0 && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{n}</Text>
                    </View>
                  )}
                </View>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  title: { color: COLORS.text, fontSize: 28, fontWeight: '700', paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  name: { color: COLORS.text, fontSize: 16, fontWeight: '600' },
  time: { color: COLORS.textFaint, fontSize: 12 },
  preview: { color: COLORS.textDim, fontSize: 14, flex: 1, marginTop: 2 },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    backgroundColor: COLORS.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  empty: { alignItems: 'center', gap: SPACING.sm, padding: SPACING.xl },
  emptyText: { color: COLORS.textDim, fontSize: 14, textAlign: 'center' },
});
