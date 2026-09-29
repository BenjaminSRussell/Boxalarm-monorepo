import notifee, { EventType } from '@notifee/react-native';
import { AppState, Platform, Settings } from 'react-native';
import {
  getInitialNotification,
  getMessaging,
  onNotificationOpenedApp,
} from '@react-native-firebase/messaging';
import {
  isNavigationReady,
  navigateToAlertDetail,
  onNavigationStateChange,
} from '../../navigation/navigationRef';

const messagingInstance = getMessaging();

export function dispatchIdFromNotificationData(
  data: Record<string, unknown> | undefined,
): string | null {
  const id = data?.dispatchId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

async function routeToInitialNotification(): Promise<void> {
  if (Platform.OS === 'android') {
    const initial = await notifee.getInitialNotification();
    const dispatchId = dispatchIdFromNotificationData(initial?.notification.data);
    if (dispatchId) navigateToAlertDetail(dispatchId);
    return;
  }
  const initial = await getInitialNotification(messagingInstance);
  const dispatchId = dispatchIdFromNotificationData(initial?.data);
  if (dispatchId) navigateToAlertDetail(dispatchId);
}

/**
 * iOS dispatch pages come straight from APNs, with no FCM marker, so React Native Firebase's
 * getInitialNotification / onNotificationOpenedApp never report a tap on them. AppDelegate's
 * didReceive (ios/Boxalarm/AppDelegate.swift) records the tapped page's dispatchId in
 * NSUserDefaults under this key, as `{ dispatchId, tappedAt }` (epoch seconds). React
 * Native's built-in Settings API reads that key on launch and reports changes while running.
 * That covers cold, background and foreground taps without a custom native module.
 */
export const IOS_PENDING_ALERT_TAP_KEY = 'boxalarm.pendingAlertTap';

/** A recorded tap older than this is from an old call (e.g. the app was killed before it routed). */
export const IOS_PENDING_ALERT_TAP_MAX_AGE_SECONDS = 600;

function readPendingIosTap(nowMs: number): string | null {
  const pending = Settings.get(IOS_PENDING_ALERT_TAP_KEY) as
    { dispatchId?: unknown; tappedAt?: unknown } | null | undefined;
  if (!pending || typeof pending !== 'object') return null;
  const { dispatchId, tappedAt } = pending;
  const fresh =
    typeof tappedAt === 'number' &&
    nowMs / 1000 - tappedAt <= IOS_PENDING_ALERT_TAP_MAX_AGE_SECONDS;
  if (typeof dispatchId !== 'string' || dispatchId.length === 0 || !fresh) {
    Settings.set({ [IOS_PENDING_ALERT_TAP_KEY]: null });
    return null;
  }
  return dispatchId;
}

/**
 * Routes a recorded iOS tap once navigation can take it. A tap recorded before the navigator
 * mounted (cold start) stays pending and is routed on the first navigation state change.
 */
export function routePendingIosAlertTap(nowMs: number = Date.now()): void {
  const dispatchId = readPendingIosTap(nowMs);
  if (!dispatchId || !isNavigationReady()) return;
  Settings.set({ [IOS_PENDING_ALERT_TAP_KEY]: null });
  navigateToAlertDetail(dispatchId);
}

function subscribeIosAlertTaps(): () => void {
  routePendingIosAlertTap();
  const watchId = Settings.watchKeys(IOS_PENDING_ALERT_TAP_KEY, () => routePendingIosAlertTap());
  const unsubscribeNavigation = onNavigationStateChange(() => routePendingIosAlertTap());
  const appState = AppState.addEventListener('change', (status) => {
    if (status === 'active') routePendingIosAlertTap();
  });
  return () => {
    Settings.clearWatch(watchId);
    unsubscribeNavigation();
    appState.remove();
  };
}

export function subscribePushNotificationRouting(): () => void {
  void routeToInitialNotification();

  const unsubscribeOpened = onNotificationOpenedApp(messagingInstance, (remoteMessage) => {
    const dispatchId = dispatchIdFromNotificationData(remoteMessage?.data);
    if (dispatchId) navigateToAlertDetail(dispatchId);
  });

  const unsubscribeForeground = notifee.onForegroundEvent(({ type, detail }) => {
    if (type !== EventType.PRESS) return;
    const dispatchId = dispatchIdFromNotificationData(detail.notification?.data);
    if (dispatchId) navigateToAlertDetail(dispatchId);
  });

  const unsubscribeIosTaps = Platform.OS === 'ios' ? subscribeIosAlertTaps() : () => {};

  return () => {
    unsubscribeOpened();
    unsubscribeForeground();
    unsubscribeIosTaps();
  };
}
