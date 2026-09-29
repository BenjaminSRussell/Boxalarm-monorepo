import { palette, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { FlatList, Text, TouchableOpacity, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { categoryLabel, itemText } from '../../features/notifications/categories';
import { getNotifications, markNotificationRead } from '../../features/training/api';
import type { NotificationItem } from '../../features/training/types';

/** Items shown per row before "+N more"; the web inbox lists them all. */
const ITEMS_SHOWN = 3;

/** A PPE reminder about the viewer's own gear links to My PPE, the one reminder page on mobile. */
function isOwnPpe(item: NotificationItem, memberId: string | null | undefined): boolean {
  return (
    item.category === 'ppe-expiry' &&
    Boolean(memberId) &&
    (item.items ?? []).some((i) => i.link?.kind === 'member' && i.link.id === memberId)
  );
}

export function InboxScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const auth = useOptionalAuth();
  const navigation = useNavigation();
  const apiBaseUrl = Config.API_BASE_URL;
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const canFetch = Boolean(auth?.isAuthenticated && apiBaseUrl);

  useEffect(() => {
    let cancelled = false;
    if (!canFetch || !auth) return;
    setLoadError(null);
    getNotifications(auth, apiBaseUrl!)
      .then((result) => {
        if (!cancelled) setItems(result);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('Notifications could not be loaded. Check your connection and try again.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canFetch, auth, apiBaseUrl]);

  const onOpen = async (item: NotificationItem) => {
    if (!auth || !apiBaseUrl || item.readAt) return;
    await markNotificationRead(auth, apiBaseUrl, item.notificationId);
    setItems((prev) =>
      prev.map((n) =>
        n.notificationId === item.notificationId ? { ...n, readAt: Date.now() } : n,
      ),
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      {loadError ? (
        <Text
          accessibilityRole="alert"
          style={{
            color: tokens.error,
            fontSize: typography.size.sm,
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.md,
          }}
        >
          {loadError}
        </Text>
      ) : null}
      <FlatList
        data={items}
        keyExtractor={(item) => item.notificationId}
        contentContainerStyle={{ padding: spacing.lg }}
        ListEmptyComponent={
          <Text style={{ color: tokens.foreground, opacity: 0.7 }}>No notifications.</Text>
        }
        renderItem={({ item }) => {
          const title = categoryLabel(item.category);
          const lines = (item.items ?? []).map(itemText);
          const shown = lines.slice(0, ITEMS_SHOWN);
          return (
            <View
              style={{
                paddingVertical: spacing.md,
                borderBottomWidth: 1,
                borderBottomColor: tokens.foreground + '22',
              }}
            >
              <TouchableOpacity
                accessibilityRole="button"
                // An explicit label replaces the children's text for screen readers, so it must
                // carry the due items themselves, not just the category and count.
                accessibilityLabel={[
                  `${item.readAt ? '' : 'Unread: '}${title}, ${item.summary}`,
                  ...shown,
                  ...(lines.length > shown.length
                    ? [`and ${lines.length - shown.length} more`]
                    : []),
                ].join('. ')}
                accessibilityHint={item.readAt ? undefined : 'Marks this notification read'}
                onPress={() => void onOpen(item)}
                style={{ minHeight: touchTarget.baseline.ios, justifyContent: 'center' }}
              >
                <Text
                  style={{
                    color: tokens.foreground,
                    fontSize: typography.size.base,
                    fontWeight: item.readAt ? '400' : '700',
                  }}
                >
                  {title}
                  {item.readAt ? '' : ' · Unread'}
                </Text>
                <Text
                  style={{ color: tokens.foreground, opacity: 0.7, fontSize: typography.size.sm }}
                >
                  {item.summary}
                </Text>
                {shown.map((line, index) => (
                  <Text
                    key={`${item.notificationId}-${index}`}
                    style={{ color: tokens.foreground, fontSize: typography.size.sm }}
                  >
                    {line}
                  </Text>
                ))}
                {lines.length > shown.length ? (
                  <Text
                    style={{ color: tokens.foreground, opacity: 0.7, fontSize: typography.size.sm }}
                  >
                    +{lines.length - shown.length} more
                  </Text>
                ) : null}
              </TouchableOpacity>
              {isOwnPpe(item, auth?.memberId) ? (
                <TouchableOpacity
                  accessibilityRole="link"
                  onPress={() => navigation.navigate('MyPpe' as never)}
                  style={{ minHeight: touchTarget.baseline.ios, justifyContent: 'center' }}
                >
                  <Text
                    style={{
                      color: tokens.foreground,
                      fontSize: typography.size.base,
                      textDecorationLine: 'underline',
                    }}
                  >
                    View my PPE
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}
