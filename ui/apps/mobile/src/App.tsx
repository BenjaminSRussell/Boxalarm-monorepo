import { spacing } from '@boxalarm/design-tokens';
import { Component, type ReactNode } from 'react';
import { StatusBar, Text, View } from 'react-native';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './auth/AuthContext';
import { usePushNotificationRouting } from './features/alerts/usePushNotificationRouting';
import { usePushTokenRegistration } from './features/alerts/usePushTokenRegistration';
import { RootNavigator } from './navigation/RootNavigator';
import { ConnectivityProvider } from './sync/ConnectivityContext';
import { useSyncEngine } from './sync/useSyncEngine';

function PushTokenSync() {
  usePushTokenRegistration();
  usePushNotificationRouting();
  return null;
}

function SyncEngine() {
  useSyncEngine();
  return null;
}

class ConfigErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <View
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg }}
        >
          <Text accessibilityRole="header" style={{ fontSize: 20, marginBottom: spacing.md }}>
            Boxalarm can&apos;t start
          </Text>
          <Text>
            Sign-in configuration is missing or invalid. Contact your department administrator.
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export function App() {
  return (
    <ConfigErrorBoundary>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <ConnectivityProvider>
          <AuthProvider>
            <StatusBar barStyle="default" />
            <PushTokenSync />
            <SyncEngine />
            <RootNavigator />
          </AuthProvider>
        </ConnectivityProvider>
      </SafeAreaProvider>
    </ConfigErrorBoundary>
  );
}
