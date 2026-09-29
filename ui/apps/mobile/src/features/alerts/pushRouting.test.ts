import { AppState, Platform, Settings } from 'react-native';
import notifee, { EventType } from '@notifee/react-native';
import * as messaging from '@react-native-firebase/messaging';
import { navigateToAlertDetail } from '../../navigation/navigationRef';
import { dispatchIdFromNotificationData, subscribePushNotificationRouting } from './pushRouting';

const getInitialNotification = messaging.getInitialNotification as jest.Mock;
const onNotificationOpenedApp = messaging.onNotificationOpenedApp as jest.Mock;

let mockNavigationReady = true;
let mockNavigationListener: (() => void) | undefined;
jest.mock('../../navigation/navigationRef', () => ({
  navigateToAlertDetail: jest.fn(),
  isNavigationReady: jest.fn(() => mockNavigationReady),
  onNavigationStateChange: jest.fn((listener: () => void) => {
    mockNavigationListener = listener;
    return () => {};
  }),
}));

// NSUserDefaults via the Settings stand-in from jest.setup.js, which keeps React Native's
// native store and JS-side copy apart. AppDelegate's tap record is a native write
// (`nativeWrite`), visible to JS only at cold start (`coldStart`, the constants snapshot) or
// through the settingsUpdated event (`settingsWatcher`).
const settingsStub = Settings as typeof Settings & {
  __reset: () => void;
  __nativeWrite: (values: Record<string, unknown>) => void;
  __coldStart: () => void;
  __emitChange: () => void;
};
const nativeWrite = (values: Record<string, unknown>) => settingsStub.__nativeWrite(values);
const coldStart = () => settingsStub.__coldStart();
const settingsWatcher = () => settingsStub.__emitChange();
let appStateListener: ((status: string) => void) | undefined;

beforeEach(() => {
  settingsStub.__reset();
  (Settings.get as jest.Mock).mockClear();
  mockNavigationReady = true;
  mockNavigationListener = undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListener = listener as (status: string) => void;
    return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
  });
  (navigateToAlertDetail as jest.Mock).mockClear();
  getInitialNotification.mockClear();
  (notifee.getInitialNotification as jest.Mock).mockClear();
  onNotificationOpenedApp.mockClear();
  (notifee.onForegroundEvent as jest.Mock).mockClear();
});

test('dispatchIdFromNotificationData reads a non-empty string dispatchId only', () => {
  expect(dispatchIdFromNotificationData({ dispatchId: 'DISP-1' })).toBe('DISP-1');
  expect(dispatchIdFromNotificationData({ dispatchId: '' })).toBeNull();
  expect(dispatchIdFromNotificationData({})).toBeNull();
  expect(dispatchIdFromNotificationData(undefined)).toBeNull();
});

test('a cold-start open on Android navigates from the notifee-delivered initial notification', async () => {
  Platform.OS = 'android';
  (notifee.getInitialNotification as jest.Mock).mockResolvedValueOnce({
    notification: { data: { dispatchId: 'DISP-2' } },
  });

  subscribePushNotificationRouting();
  await Promise.resolve();
  await Promise.resolve();

  expect(navigateToAlertDetail).toHaveBeenCalledWith('DISP-2');
});

test('a cold-start open on iOS navigates from the FCM-delivered initial notification', async () => {
  Platform.OS = 'ios';
  getInitialNotification.mockResolvedValueOnce({
    data: { dispatchId: 'DISP-3' },
  });

  subscribePushNotificationRouting();
  await Promise.resolve();
  await Promise.resolve();

  expect(navigateToAlertDetail).toHaveBeenCalledWith('DISP-3');
});

test('a background-to-foreground open navigates via onNotificationOpenedApp', () => {
  let openedCallback: ((message: unknown) => void) | undefined;
  onNotificationOpenedApp.mockImplementationOnce((_instance: unknown, cb: (m: unknown) => void) => {
    openedCallback = cb;
    return () => {};
  });

  subscribePushNotificationRouting();
  openedCallback?.({ data: { dispatchId: 'DISP-4' } });

  expect(navigateToAlertDetail).toHaveBeenCalledWith('DISP-4');
});

test('a foreground press on the Android critical notification navigates immediately', () => {
  let foregroundCallback: ((event: unknown) => void) | undefined;
  (notifee.onForegroundEvent as jest.Mock).mockImplementationOnce((cb) => {
    foregroundCallback = cb;
    return () => {};
  });

  subscribePushNotificationRouting();
  foregroundCallback?.({
    type: EventType.PRESS,
    detail: { notification: { data: { dispatchId: 'DISP-5' } } },
  });

  expect(navigateToAlertDetail).toHaveBeenCalledWith('DISP-5');
});

test('a non-press foreground event (e.g. dismissed) does not navigate', () => {
  let foregroundCallback: ((event: unknown) => void) | undefined;
  (notifee.onForegroundEvent as jest.Mock).mockImplementationOnce((cb) => {
    foregroundCallback = cb;
    return () => {};
  });

  subscribePushNotificationRouting();
  foregroundCallback?.({
    type: EventType.DISMISSED,
    detail: { notification: { data: { dispatchId: 'DISP-6' } } },
  });

  expect(navigateToAlertDetail).not.toHaveBeenCalled();
});

describe('iOS taps on raw-APNs dispatch notifications (review round 2 N3)', () => {
  const nowSeconds = () => Date.now() / 1000;
  const tap = (dispatchId: string, tappedAt = nowSeconds()) => ({
    'boxalarm.pendingAlertTap': { dispatchId, tappedAt },
  });

  beforeEach(() => {
    Platform.OS = 'ios';
  });

  test('cold start: a tap recorded before JS loaded routes once the navigator mounts, then is cleared', () => {
    nativeWrite(tap('DISP-COLD'));
    coldStart();
    mockNavigationReady = false;

    subscribePushNotificationRouting();
    expect(navigateToAlertDetail).not.toHaveBeenCalled();

    mockNavigationReady = true;
    mockNavigationListener?.();

    expect(navigateToAlertDetail).toHaveBeenCalledWith('DISP-COLD');
    expect(Settings.get('boxalarm.pendingAlertTap')).toBeNull();
  });

  test('background/foreground: a native tap record reaches JS only through the settings change event', () => {
    subscribePushNotificationRouting();
    nativeWrite(tap('DISP-WARM'));
    // Not visible to Settings.get yet - React Native only learns of it from settingsUpdated.
    appStateListener?.('active');
    expect(navigateToAlertDetail).not.toHaveBeenCalled();

    settingsWatcher();

    expect(navigateToAlertDetail).toHaveBeenCalledTimes(1);
    expect(navigateToAlertDetail).toHaveBeenCalledWith('DISP-WARM');
    // Clearing the record does not echo (RCTSettingsManager ignores its own writes), and a later
    // unrelated settings change must not navigate again.
    settingsWatcher();
    expect(navigateToAlertDetail).toHaveBeenCalledTimes(1);
  });

  test('resume retries a tap that reached JS while navigation could not take it', () => {
    mockNavigationReady = false;
    subscribePushNotificationRouting();
    nativeWrite(tap('DISP-RESUME'));
    settingsWatcher();
    expect(navigateToAlertDetail).not.toHaveBeenCalled();

    mockNavigationReady = true;
    appStateListener?.('active');

    expect(navigateToAlertDetail).toHaveBeenCalledWith('DISP-RESUME');
  });

  test('a stale tap (older than 10 minutes) is discarded without navigating', () => {
    nativeWrite(tap('DISP-OLD', nowSeconds() - 601));
    coldStart();

    subscribePushNotificationRouting();

    expect(navigateToAlertDetail).not.toHaveBeenCalled();
    expect(Settings.get('boxalarm.pendingAlertTap')).toBeNull();
  });

  test('a malformed record is discarded without navigating', () => {
    nativeWrite({ 'boxalarm.pendingAlertTap': { dispatchId: 7, tappedAt: nowSeconds() } });
    coldStart();

    subscribePushNotificationRouting();

    expect(navigateToAlertDetail).not.toHaveBeenCalled();
  });

  test('Android never reads the iOS tap record', () => {
    Platform.OS = 'android';
    nativeWrite(tap('DISP-IOS-ONLY'));
    coldStart();

    subscribePushNotificationRouting();

    expect(Settings.get).not.toHaveBeenCalled();
    expect(navigateToAlertDetail).not.toHaveBeenCalled();
  });
});
