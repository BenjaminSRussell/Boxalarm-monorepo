import { palette, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { ScrollView, Switch, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { preferencesFor } from '../../features/notifications/categories';
import { getNotificationPreferences, putNotificationPreference } from '../../features/training/api';
import type { NotificationPreference } from '../../features/training/types';

// Stored channels are MUTES (notification-service repository.ts) - true means that channel is
// muted for the category - so each switch shows the inverse. No stored row: nothing is muted.
const UNMUTED: NotificationPreference['channels'] = { push: false, email: false };

export function NotificationPreferencesScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.isAuthenticated || !apiBaseUrl) return;
    setLoadError(null);
    getNotificationPreferences(auth, apiBaseUrl)
      .then((result) => {
        if (!cancelled) setPreferences(result);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(
            'Notification preferences could not be loaded. Check your connection and try again.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [auth, apiBaseUrl]);

  const channelsFor = (category: string) =>
    preferences.find((p) => p.category === category)?.channels ?? UNMUTED;

  const togglePush = async (category: string, enabled: boolean) => {
    if (!auth || !apiBaseUrl) return;
    const previous = channelsFor(category);
    const next = { ...previous, push: !enabled };
    const withChannels = (channels: NotificationPreference['channels']) =>
      setPreferences((prev) => [
        ...prev.filter((p) => p.category !== category),
        { category, channels },
      ]);
    setSaveError(null);
    withChannels(next);
    try {
      await putNotificationPreference(auth, apiBaseUrl, category, next);
    } catch {
      // Revert the optimistic toggle: the member must not believe a reminder was muted or
      // unmuted when nothing was saved (PR #321 review M11).
      withChannels(previous);
      setSaveError('Your change was not saved. Check your connection and try again.');
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        {saveError ? (
          <Text
            accessibilityRole="alert"
            style={{
              color: tokens.error,
              fontSize: typography.size.sm,
              marginBottom: spacing.md,
            }}
          >
            {saveError}
          </Text>
        ) : null}
        {loadError ? (
          <Text
            accessibilityRole="alert"
            style={{
              color: tokens.error,
              fontSize: typography.size.sm,
              marginBottom: spacing.md,
            }}
          >
            {loadError}
          </Text>
        ) : null}
        <Text
          style={{
            color: tokens.foreground,
            opacity: 0.7,
            fontSize: typography.size.sm,
            marginBottom: spacing.md,
          }}
        >
          Muting push still delivers the reminder to your inbox. Dispatch alerts cannot be muted
          here.
        </Text>
        {auth?.roles.includes('TRAINING') ? (
          <Text
            style={{
              color: tokens.foreground,
              opacity: 0.7,
              fontSize: typography.size.sm,
              marginBottom: spacing.md,
            }}
          >
            As a training officer you also get the department-wide certification-expiry digest; it
            cannot be muted. The switch below covers only your own certifications.
          </Text>
        ) : null}
        {preferencesFor(auth?.roles ?? []).map(({ category, label }) => (
          <View
            key={category}
            style={{
              minHeight: touchTarget.baseline.ios,
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
              {label}
            </Text>
            <Switch
              accessibilityLabel={`${label} push notifications`}
              value={!channelsFor(category).push}
              onValueChange={(value) => void togglePush(category, value)}
            />
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
