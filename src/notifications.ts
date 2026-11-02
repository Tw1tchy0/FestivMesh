import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

/** Alerts are a phone feature; the web preview has no native notifications module. */
export const notificationsSupported = Platform.OS !== 'web';

/** The chat on screen right now, so its own messages don't also pop a banner. */
let openChat: number | null = null;
export function setOpenChat(num: number | null) {
  openChat = num;
}
const viewing = (peer: number) => AppState.currentState === 'active' && openChat === peer;

if (notificationsSupported) {
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const show = !viewing(Number(n.request.content.data?.peer));
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: true };
    },
  });
}

let asked = false;
/** Asks once per launch; iOS only shows the prompt the first time. */
export async function requestNotificationPermission() {
  if (asked || !notificationsSupported) return;
  asked = true;
  await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: true } });
}

/**
 * Alerts about a new DM. Works whenever the app's code is running: in the foreground, and in the
 * background in the Bluetooth build, where iOS wakes the app for each packet from the radio.
 */
export function notifyMessage(peer: number, from: string, text: string) {
  if (!notificationsSupported || viewing(peer)) return;
  void Notifications.scheduleNotificationAsync({
    content: { title: from, body: text, data: { peer }, sound: 'default' },
    trigger: null,
  }).catch(() => {});
}

export function setUnreadBadge(count: number) {
  if (!notificationsSupported) return;
  void Notifications.setBadgeCountAsync(count).catch(() => {});
}
