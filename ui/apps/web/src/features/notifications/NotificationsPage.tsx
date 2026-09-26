import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiErrorState } from '../../components/ApiErrorState';
import { ForbiddenState } from '../../components/ForbiddenState';
import { Button, Card, Checkbox, EmptyState, PageHeader, Skeleton } from '../../components/ui';
import { Bell } from '../../components/ui/icons';
import { ApiError } from '../../lib/apiClient';
import {
  getNotificationPreferences,
  listNotifications,
  markNotificationRead,
  putNotificationPreference,
} from './api';
import { CERT_EXPIRY_CATEGORY, categoryLabel } from './labels';
import { UNREAD_SUMMARY_QUERY_KEY } from './NotificationBell';
import styles from './Notifications.module.css';
import type { InboxNotification, NotificationChannelMutes, NotificationPreference } from './types';

const INBOX_QUERY_KEY = ['notifications', 'inbox'] as const;
const PREFERENCES_QUERY_KEY = ['notifications', 'preferences'] as const;

function SectionError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiError && error.problem.status === 403) {
    return <ForbiddenState problem={error.problem} embedded headingLevel="h2" />;
  }
  return <ApiErrorState embedded headingLevel="h2" onRetry={onRetry} />;
}

function NotificationRow({ notification }: { notification: InboxNotification }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const unread = notification.readAt === null;
  const markRead = useMutation({
    mutationFn: () => markNotificationRead(auth, notification.notificationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: UNREAD_SUMMARY_QUERY_KEY });
    },
  });
  const title = categoryLabel(notification.category);

  return (
    <li className={styles.item}>
      <div className={styles.itemBody}>
        <p className={[styles.itemTitle, unread ? '' : styles.itemTitleRead].join(' ')}>
          {unread ? <span className={styles.srOnly}>Unread: </span> : null}
          {title}
        </p>
        <p className={styles.itemMeta}>
          {notification.summary} · {new Date(notification.createdAt).toLocaleString()}
          {unread ? '' : ' · Read'}
        </p>
        {notification.items.length > 0 ? (
          <ul className={styles.dueList} aria-label={`${title}: items`}>
            {notification.items.map((item) => (
              <li key={`${item.certId}-${item.expiryDate}`}>
                {item.certId} expires {item.expiryDate}
              </li>
            ))}
          </ul>
        ) : null}
        {markRead.error ? (
          <p role="alert" className={styles.itemMeta}>
            Could not mark this notification read. Try again.
          </p>
        ) : null}
      </div>
      {unread ? (
        <Button
          variant="secondary"
          size="sm"
          loading={markRead.isPending}
          onClick={() => markRead.mutate()}
          aria-label={`Mark "${title}" from ${new Date(notification.createdAt).toLocaleDateString()} read`}
        >
          Mark read
        </Button>
      ) : null}
    </li>
  );
}

function InboxSection() {
  const auth = useAuth();
  const inbox = useInfiniteQuery({
    queryKey: INBOX_QUERY_KEY,
    queryFn: ({ pageParam }) => listNotifications(auth, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  if (inbox.isLoading) {
    return (
      <Card title="Inbox">
        <Skeleton lines={4} />
      </Card>
    );
  }
  if (inbox.error) {
    return (
      <Card title="Inbox">
        <SectionError error={inbox.error} onRetry={() => void inbox.refetch()} />
      </Card>
    );
  }

  const notifications = inbox.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Card title="Inbox">
      {notifications.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No notifications"
          description="Certification-expiry reminders arrive here as a once-a-day digest. Dispatch alerts never appear in this inbox."
        />
      ) : (
        <ul className={styles.list}>
          {notifications.map((notification) => (
            <NotificationRow key={notification.notificationId} notification={notification} />
          ))}
        </ul>
      )}
      {inbox.hasNextPage ? (
        <Button
          variant="secondary"
          loading={inbox.isFetchingNextPage}
          onClick={() => void inbox.fetchNextPage()}
        >
          Load older notifications
        </Button>
      ) : null}
      {inbox.isFetchNextPageError ? (
        <p role="alert" className={styles.itemMeta}>
          Older notifications could not be loaded. Try again.
        </p>
      ) : null}
    </Card>
  );
}

function PreferencesSection() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [saveError, setSaveError] = useState(false);
  const preferences = useQuery({
    queryKey: PREFERENCES_QUERY_KEY,
    queryFn: () => getNotificationPreferences(auth),
  });
  const save = useMutation({
    mutationFn: (channels: NotificationChannelMutes) =>
      putNotificationPreference(auth, CERT_EXPIRY_CATEGORY, channels),
    onMutate: () => setSaveError(false),
    onSuccess: (_result, channels) =>
      queryClient.setQueryData<NotificationPreference[]>(PREFERENCES_QUERY_KEY, (previous) => [
        ...(previous ?? []).filter((p) => p.category !== CERT_EXPIRY_CATEGORY),
        { category: CERT_EXPIRY_CATEGORY, channels },
      ]),
    onError: () => {
      setSaveError(true);
      void queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY });
    },
  });

  if (preferences.isLoading) {
    return (
      <Card title="Notification preferences">
        <Skeleton lines={2} />
      </Card>
    );
  }
  if (preferences.error) {
    return (
      <Card title="Notification preferences">
        <SectionError error={preferences.error} onRetry={() => void preferences.refetch()} />
      </Card>
    );
  }

  // Stored flags are mutes; no stored row means nothing is muted. While a save is in flight
  // show what was asked for; a failed save falls back to what the server still has.
  const stored = preferences.data?.find((p) => p.category === CERT_EXPIRY_CATEGORY)?.channels ?? {
    push: false,
    email: false,
  };
  const mutes = save.isPending && save.variables ? save.variables : stored;

  return (
    <Card title="Notification preferences">
      <p className={styles.prefHint}>
        Applies to your own certification-expiry reminders. Dispatch alerts are delivered separately
        and cannot be muted here.
      </p>
      <fieldset className={styles.prefGroup} aria-busy={save.isPending || undefined}>
        <legend>Certification-expiry reminders</legend>
        <Checkbox
          label="Push notification"
          checked={!mutes.push}
          onCheckedChange={(on) => save.mutate({ ...mutes, push: !on })}
        />
        <Checkbox
          label="Email"
          checked={!mutes.email}
          onCheckedChange={(on) => save.mutate({ ...mutes, email: !on })}
        />
      </fieldset>
      {saveError ? (
        <p role="alert" className={styles.itemMeta}>
          Your change was not saved. Check your connection and try again.
        </p>
      ) : null}
      {save.isSuccess && !saveError ? (
        <p role="status" className={styles.itemMeta}>
          Preferences saved.
        </p>
      ) : null}
    </Card>
  );
}

export function NotificationsPage() {
  return (
    <main id="main-content">
      <PageHeader title="Notifications" />
      <div className={styles.stack}>
        <InboxSection />
        <PreferencesSection />
      </div>
    </main>
  );
}
