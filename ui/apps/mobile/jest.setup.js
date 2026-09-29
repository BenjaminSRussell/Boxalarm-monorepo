// @react-navigation/native's NavigationContainer resolves Linking.getInitialURL() as a
// microtask during mount; without this flag that late state update warns "not configured to
// support act(...)" even though every assertion in a test already awaited settling via
// findBy*. Standard fix for RN + React Navigation + React 19's test renderer.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Native Config module is absent in Jest; any import of react-native-config (e.g. via
// apiChecksRepository → ApparatusPicker → ChecksStack → AppTabs) throws without this mock.
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: {
    COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    COGNITO_NATIVE_CLIENT_ID: 'native-client',
    COGNITO_HOSTED_UI_ORIGIN: 'https://boxalarm.auth.us-east-1.amazoncognito.com',
    API_BASE_URL: '',
  },
}));

// Official jest mock: exposes addEventListener/fetch as jest.fn()s so a test can override the
// connected/disconnected state per case without touching the native module.
jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);

// react-native-image-picker has no test double of its own; every screen test that doesn't
// exercise the camera flow still transitively imports it via photoCapture.ts, so it needs a
// default that never touches a native module. Tests override launchCamera's mock per case.
jest.mock('react-native-image-picker', () => ({
  __esModule: true,
  launchCamera: jest.fn().mockResolvedValue({ didCancel: true }),
}));

// @op-engineering/op-sqlite has no native binding under Jest (NativeModules.OPSQLite is
// undefined), so importing it for real throws at module load. This fake implements exactly the
// statements outboxStore.ts issues against an in-memory array, scoped per test file (module
// registry resets between files) so tests don't leak rows into each other.
jest.mock('@op-engineering/op-sqlite', () => {
  function createFakeDb() {
    let rows = [];
    return {
      executeSync: () => ({ rows: [] }),
      execute: async (sql, params = []) => {
        const statement = sql.trim();
        if (statement.startsWith('INSERT INTO outbox')) {
          const columns = [
            'id',
            'kind',
            'label',
            'method',
            'path',
            'body',
            'stage',
            'photoLocalUri',
            'photoS3Key',
            'photoUploadUrl',
            'status',
            'attempts',
            'lastError',
            'queuedAt',
            'nextAttemptAt',
            'syncedAt',
          ];
          const row = {};
          columns.forEach((column, index) => {
            row[column] = params[index];
          });
          rows.push(row);
          return { rows: [] };
        }
        if (statement.startsWith('SELECT * FROM outbox ORDER BY queuedAt ASC')) {
          const sorted = [...rows].sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : 1));
          return { rows: sorted };
        }
        if (statement.startsWith('SELECT * FROM outbox WHERE id = ?')) {
          return { rows: rows.filter((row) => row.id === params[0]) };
        }
        if (statement.startsWith('UPDATE outbox SET')) {
          const id = params[params.length - 1];
          const assignments = statement.slice(
            'UPDATE outbox SET '.length,
            statement.indexOf(' WHERE'),
          );
          const columns = assignments
            .split(',')
            .map((assignment) => assignment.split('=')[0].trim());
          const row = rows.find((candidate) => candidate.id === id);
          if (row) {
            columns.forEach((column, index) => {
              row[column] = params[index];
            });
          }
          return { rows: [] };
        }
        if (statement.startsWith('DELETE FROM outbox WHERE id = ?')) {
          rows = rows.filter((row) => row.id !== params[0]);
          return { rows: [] };
        }
        throw new Error(`op-sqlite fake does not support: ${sql}`);
      },
    };
  }
  return { open: () => createFakeDb() };
});

// React Native's Settings (NSUserDefaults on iOS) needs the native SettingsManager, which Jest
// does not link. This stand-in models what Settings.ios.js really does. `get` reads a JS-side copy
// taken from the native constants at module load (`__coldStart`) and refreshed only by the
// native settingsUpdated event (`__emitChange`). A native NSUserDefaults write (`__nativeWrite`,
// e.g. AppDelegate recording a tap) is invisible to `get` until that event arrives. `set` writes
// both copies without an event, as RCTSettingsManager ignores its own writes.
jest.mock('react-native/Libraries/Settings/Settings', () => {
  let native = {};
  let js = {};
  const watchers = [];
  const merge = (target, next) => {
    const merged = { ...target, ...next };
    Object.keys(next).forEach((key) => {
      if (next[key] === null || next[key] === undefined) delete merged[key];
    });
    return merged;
  };
  return {
    __esModule: true,
    default: {
      get: jest.fn((key) => js[key]),
      set: jest.fn((next) => {
        js = { ...js, ...next };
        native = merge(native, next);
      }),
      watchKeys: jest.fn((_keys, callback) => watchers.push(callback) - 1),
      clearWatch: jest.fn((id) => {
        watchers[id] = null;
      }),
      __reset: () => {
        native = {};
        js = {};
        watchers.length = 0;
      },
      __nativeWrite: (next) => {
        native = merge(native, next);
      },
      __coldStart: () => {
        js = { ...native };
      },
      __emitChange: () => {
        js = { ...native };
        watchers.forEach((callback) => callback && callback());
      },
    },
  };
});

// No Firebase/notifee native modules are linked in Jest - every push-path test supplies its own
// jest.mock for these with the behavior it needs; this default keeps every other test (which
// only imports something that transitively pulls in the push modules) from crashing on load.
jest.mock('@react-native-firebase/messaging', () => {
  const instance = {};
  return {
    __esModule: true,
    getMessaging: jest.fn(() => instance),
    getToken: jest.fn(async () => null),
    getAPNSToken: jest.fn(async () => null),
    registerDeviceForRemoteMessages: jest.fn(async () => undefined),
    onTokenRefresh: jest.fn(() => () => {}),
    onMessage: jest.fn(() => () => {}),
    onNotificationOpenedApp: jest.fn(() => () => {}),
    getInitialNotification: jest.fn(async () => null),
    setBackgroundMessageHandler: jest.fn(),
  };
});

jest.mock('@notifee/react-native', () => {
  const instance = {
    createChannel: jest.fn(async () => undefined),
    requestPermission: jest.fn(async () => ({ authorizationStatus: 1 })),
    displayNotification: jest.fn(async () => undefined),
    getInitialNotification: jest.fn(async () => null),
    onForegroundEvent: jest.fn(() => () => {}),
    onBackgroundEvent: jest.fn(),
  };
  return {
    __esModule: true,
    default: instance,
    AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
    AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
    EventType: { DISMISSED: 0, PRESS: 1, ACTION_PRESS: 2, DELIVERED: 3, APP_BLOCKED: 4 },
  };
});

// SafeAreaProvider reports insets via a native event listener that never fires in Jest, so it
// renders nothing without initialMetrics. @react-navigation/bottom-tabs reads the package's
// context object directly (not just its public hooks), so a full-module mock isn't safe - this
// keeps every real export and only forces a default initialMetrics onto SafeAreaProvider.
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  const { testSafeAreaMetrics } = require('./src/testUtils/safeAreaMetrics');
  const React = require('react');
  return {
    ...actual,
    SafeAreaProvider: (props) =>
      React.createElement(actual.SafeAreaProvider, {
        ...props,
        initialMetrics: props.initialMetrics ?? testSafeAreaMetrics,
      }),
  };
});
