import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Chip, FriendDot } from '../../components/ui';
import { distanceM, formatDistance, timeAgo } from '../../geo';
import { useFriends } from '../../hooks/useFriends';
import { useNow } from '../../hooks/useSensors';
import { sendMessage } from '../../mesh/connection';
import { formatPin, parsePin } from '../../mesh/pins';
import { setOpenChat } from '../../notifications';
import { MAX_TEXT_BYTES, utf8Length } from '../../mesh/protocol';
import { useMesh, type ChatMessage } from '../../store/useMesh';
import { COLORS, RADIUS, SPACING } from '../../theme';

const QUICK_REPLIES = ['Where are you?', 'Coming to you', 'Stay there', 'OK 👍'];

const STATUS_ICON: Record<ChatMessage['status'], { name: keyof typeof Ionicons.glyphMap; label: string }> = {
  sending: { name: 'time-outline', label: 'Sending' },
  sent: { name: 'checkmark', label: 'On the mesh' },
  delivered: { name: 'checkmark-done', label: 'Delivered' },
  failed: { name: 'alert-circle', label: 'Not delivered · tap to retry' },
  received: { name: 'checkmark', label: '' },
};

function Bubble({ m, color, onRetry }: { m: ChatMessage; color: string; onRetry: () => void }) {
  const router = useRouter();
  const units = useMesh((s) => s.settings.units);
  const me = useMesh((s) => s.myLocation);
  const pin = parsePin(m.text);
  const time = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const s = STATUS_ICON[m.status];
  return (
    <View style={[styles.bubbleWrap, m.fromMe ? { alignItems: 'flex-end' } : { alignItems: 'flex-start' }]}>
      <Pressable
        disabled={!(m.fromMe && m.status === 'failed') && !pin}
        onPress={m.fromMe && m.status === 'failed' ? onRetry : () => router.navigate('/')}
        style={[styles.bubble, m.fromMe ? { backgroundColor: COLORS.surfaceHigh } : { backgroundColor: color + '33' }]}
      >
        {pin ? (
          <View style={styles.pinRow}>
            <Ionicons name="location" size={18} color={m.fromMe ? COLORS.text : color} />
            <Text style={styles.text}>
              {pin.note || (m.fromMe ? 'You shared a meeting point' : 'Meeting point')}
              {me && <Text style={styles.pinDist}>{`  ${formatDistance(distanceM(me, pin), units)} away`}</Text>}
            </Text>
          </View>
        ) : (
          <Text style={styles.text}>{m.text}</Text>
        )}
      </Pressable>
      <View style={styles.meta}>
        <Text style={styles.metaText}>{time}</Text>
        {m.fromMe && (
          <>
            <Ionicons name={s.name} size={13} color={m.status === 'failed' ? COLORS.danger : COLORS.textDim} />
            <Text style={[styles.metaText, m.status === 'failed' && { color: COLORS.danger }]}>
              {m.status === 'failed' && m.error ? m.error : s.label}
            </Text>
          </>
        )}
      </View>
    </View>
  );
}

export default function ChatScreen() {
  const router = useRouter();
  const { num: numParam } = useLocalSearchParams<{ num: string }>();
  const num = Number(numParam);
  const insets = useSafeAreaInsets();
  const friend = useFriends().find((f) => f.num === num);
  const allMessages = useMesh((s) => s.messages);
  const markRead = useMesh((s) => s.markRead);
  const me = useMesh((s) => s.myLocation);
  const [draft, setDraft] = useState('');

  const messages = useMemo(() => allMessages.filter((m) => m.peer === num).reverse(), [allMessages, num]);
  useEffect(() => {
    markRead(num);
  }, [messages.length, markRead, num]);
  // No alert banners for the chat you're looking at.
  useFocusEffect(
    useCallback(() => {
      setOpenChat(num);
      return () => setOpenChat(null);
    }, [num]),
  );

  const color = friend?.color ?? COLORS.accent;
  const canMessage = friend?.canMessage ?? false;
  const now = useNow();
  const bytes = utf8Length(draft);
  const tooLong = bytes > MAX_TEXT_BYTES;

  const send = (text: string) => {
    const t = text.trim();
    if (!t || utf8Length(t) > MAX_TEXT_BYTES) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void sendMessage(num, t);
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}
    >
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Pressable style={styles.headerTitle} onPress={() => router.push(`/friend/${num}`)}>
              {friend && <FriendDot color={color} canMessage={canMessage} />}
              <Text style={styles.headerName}>{friend?.name ?? 'Chat'}</Text>
            </Pressable>
          ),
        }}
      />
      <FlatList
        inverted
        data={messages}
        keyExtractor={(m) => m.key}
        contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.sm }}
        renderItem={({ item }) => (
          <Bubble
            m={item}
            color={color}
            onRetry={() => {
              useMesh.getState().removeMessage(item.key);
              send(item.text);
            }}
          />
        )}
        ListFooterComponent={
          <Text style={styles.intro}>
            Messages hop radio to radio over LoRa. Short texts work best; delivery can take a few seconds.
          </Text>
        }
      />

      {canMessage ? (
        <View style={[styles.composer, { paddingBottom: insets.bottom + SPACING.sm }]}>
          {friend && !friend.phoneActive && (
            <Text style={styles.away}>
              {friend.name}’s phone was last active {timeAgo(friend.presenceAt!, now)}. Messages go to their radio and
              show up when they open the app.
            </Text>
          )}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quick}>
            <Chip
              label="Send my location"
              icon="location-outline"
              disabled={!me}
              onPress={() => me && send(formatPin(me.lat, me.lon, 'Meet me here'))}
            />
            {QUICK_REPLIES.map((q) => (
              <Chip key={q} label={q} onPress={() => send(q)} />
            ))}
          </ScrollView>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder={`Message ${friend?.name ?? ''}`}
              placeholderTextColor={COLORS.textFaint}
              multiline
              maxLength={400}
            />
            <Pressable
              style={[styles.send, { backgroundColor: draft.trim() && !tooLong ? color : COLORS.surfaceHigh }]}
              disabled={!draft.trim() || tooLong}
              onPress={() => {
                send(draft);
                setDraft('');
              }}
            >
              <Ionicons name="arrow-up" size={20} color={draft.trim() && !tooLong ? COLORS.bg : COLORS.textFaint} />
            </Pressable>
          </View>
          {bytes > MAX_TEXT_BYTES - 40 && (
            <Text style={[styles.counter, tooLong && { color: COLORS.danger }]}>
              {bytes}/{MAX_TEXT_BYTES}
            </Text>
          )}
        </View>
      ) : (
        <View style={[styles.blocked, { paddingBottom: insets.bottom + SPACING.md }]}>
          <Ionicons name="radio-outline" size={20} color={COLORS.textDim} />
          <Text style={styles.blockedText}>
            {friend
              ? `${friend.name}'s radio is reachable, but no phone is connected to it, so they can't read messages. You can still follow them on the compass.`
              : 'This friend is no longer on your compass.'}
          </Text>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerName: { color: COLORS.text, fontSize: 17, fontWeight: '600' },
  intro: { color: COLORS.textFaint, fontSize: 12, textAlign: 'center', marginBottom: SPACING.lg },
  bubbleWrap: { gap: 3 },
  bubble: { maxWidth: '80%', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18 },
  text: { color: COLORS.text, fontSize: 16, lineHeight: 21 },
  pinRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pinDist: { color: COLORS.textDim, fontSize: 14 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6 },
  metaText: { color: COLORS.textFaint, fontSize: 11 },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    paddingTop: SPACING.sm,
    gap: SPACING.sm,
  },
  away: { color: COLORS.textDim, fontSize: 13, paddingHorizontal: SPACING.lg },
  quick: { gap: SPACING.sm, paddingHorizontal: SPACING.lg },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.sm, paddingHorizontal: SPACING.lg },
  input: {
    flex: 1,
    maxHeight: 110,
    color: COLORS.text,
    fontSize: 16,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
  },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  counter: { color: COLORS.textDim, fontSize: 12, textAlign: 'right', paddingHorizontal: SPACING.lg },
  blocked: {
    flexDirection: 'row',
    gap: SPACING.md,
    padding: SPACING.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  blockedText: { color: COLORS.textDim, fontSize: 14, flex: 1 },
});
