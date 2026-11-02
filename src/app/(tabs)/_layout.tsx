import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { Tabs, useRouter } from 'expo-router';
import { useEffect } from 'react';
import type { ColorValue } from 'react-native';
import { notificationsSupported, requestNotificationPermission, setUnreadBadge } from '../../notifications';
import { useMesh } from '../../store/useMesh';
import { COLORS } from '../../theme';

type IconName = keyof typeof Ionicons.glyphMap;
const icon = (on: IconName, off: IconName) =>
  function TabIcon({ focused, color, size }: { focused: boolean; color: ColorValue; size: number }) {
    return <Ionicons name={focused ? on : off} size={size} color={typeof color === 'string' ? color : undefined} />;
  };

/** Asks for alert permission, keeps the app icon badge at the unread count, and opens the chat when an alert is tapped. */
function useMessageAlerts(unread: number) {
  const router = useRouter();
  useEffect(() => {
    void requestNotificationPermission().catch(() => {});
  }, []);
  useEffect(() => setUnreadBadge(unread), [unread]);
  useEffect(() => {
    if (!notificationsSupported) return;
    const open = (response: Notifications.NotificationResponse | null) => {
      const peer = Number(response?.notification.request.content.data?.peer);
      if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER || !peer) return;
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
      router.push(`/chat/${peer}`);
    };
    // An alert tapped while the app was closed launches it; later taps arrive as events.
    void Notifications.getLastNotificationResponseAsync().then(open).catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [router]);
}

export default function TabsLayout() {
  const unread = useMesh((s) => Object.values(s.unread).reduce((a, b) => a + b, 0));
  useMessageAlerts(unread);
  return (
    <Tabs
      screenListeners={{ tabPress: () => void Haptics.selectionAsync() }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: COLORS.text,
        tabBarInactiveTintColor: COLORS.textFaint,
        tabBarStyle: { backgroundColor: COLORS.bg, borderTopColor: COLORS.border },
        sceneStyle: { backgroundColor: COLORS.bg },
      }}
    >
      <Tabs.Screen
        name="messages"
        options={{
          title: 'Messages',
          tabBarIcon: icon('chatbubbles', 'chatbubbles-outline'),
          tabBarBadge: unread > 0 ? unread : undefined,
          tabBarBadgeStyle: { backgroundColor: COLORS.danger },
        }}
      />
      <Tabs.Screen name="index" options={{ title: 'Compass', tabBarIcon: icon('compass', 'compass-outline') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('settings', 'settings-outline') }} />
    </Tabs>
  );
}
