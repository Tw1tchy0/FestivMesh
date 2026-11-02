import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useMesh } from '../store/useMesh';
import { COLORS, RADIUS, SPACING } from '../theme';

export function FriendDot({ color, canMessage, size = 12 }: { color: string; canMessage: boolean; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: canMessage ? color : 'transparent',
        borderWidth: canMessage ? 0 : 2,
        borderColor: color,
      }}
    />
  );
}

const STATUS_COLOR = { connected: COLORS.ok, connecting: COLORS.warn, error: COLORS.danger, disconnected: COLORS.textFaint };
const KIND_LABEL = { sim: 'Simulator', bridge: 'PC bridge', ble: 'Bluetooth' };

export function ConnectionPill({ onPress }: { onPress?: () => void }) {
  const status = useMesh((s) => s.status);
  const ready = useMesh((s) => s.configReady);
  const kind = useMesh((s) => s.settings.transport);
  const label =
    status === 'connected' ? (ready ? KIND_LABEL[kind] : 'Syncing…') : status === 'connecting' ? 'Connecting…' : status === 'error' ? 'Radio lost' : 'No radio';
  return (
    <Pressable onPress={onPress} style={styles.pill} hitSlop={8}>
      <View style={[styles.pillDot, { backgroundColor: STATUS_COLOR[status] }]} />
      <Text style={styles.pillText}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.section}>{children}</Text>;
}

export function Chip({
  label,
  selected,
  onPress,
  disabled,
  icon,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipOn,
        disabled && { opacity: 0.4 },
        pressed && { opacity: 0.7 },
      ]}
    >
      {icon && <Ionicons name={icon} size={14} color={selected ? COLORS.bg : COLORS.text} />}
      <Text style={[styles.chipText, selected && { color: COLORS.bg }]}>{label}</Text>
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  icon,
  kind = 'primary',
  disabled,
}: {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}) {
  const bg = kind === 'primary' ? COLORS.text : kind === 'danger' ? '#3a1219' : COLORS.surfaceHigh;
  const fg = kind === 'primary' ? COLORS.bg : kind === 'danger' ? COLORS.danger : COLORS.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, { backgroundColor: bg }, (pressed || disabled) && { opacity: disabled ? 0.4 : 0.75 }]}
    >
      {icon && <Ionicons name={icon} size={18} color={fg} />}
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Row({ label, value, children }: { label: string; value?: string; children?: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {value !== undefined ? <Text style={styles.rowValue} numberOfLines={1}>{value}</Text> : children}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
  },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { color: COLORS.textDim, fontSize: 12, fontWeight: '600' },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    gap: SPACING.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
  },
  section: {
    color: COLORS.textDim,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: SPACING.xl,
    marginBottom: SPACING.sm,
    marginLeft: SPACING.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.surfaceHigh,
  },
  chipOn: { backgroundColor: COLORS.text },
  chipText: { color: COLORS.text, fontSize: 14, fontWeight: '500' },
  button: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: RADIUS.md,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACING.md, minHeight: 24 },
  rowLabel: { color: COLORS.textDim, fontSize: 15 },
  rowValue: { color: COLORS.text, fontSize: 15, flexShrink: 1, textAlign: 'right' },
});
