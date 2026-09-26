import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Bell } from '../../components/ui/icons';
import { listNotifications } from './api';
import styles from './Notifications.module.css';

export const UNREAD_SUMMARY_QUERY_KEY = ['notifications', 'unread-summary'] as const;

/** Inbox content is a once-a-day digest; a minute is plenty fresh for the badge. */
const REFETCH_INTERVAL_MS = 60_000;

/**
 * Top-bar link to the notification inbox, with the unread count from the newest page.
 * Never shows a count it doesn't have: while loading, or if the inbox can't be reached, the
 * bell renders without a number and its label says why — a fabricated "0" would read as
 * "nothing needs your attention".
 */
export function NotificationBell() {
  const auth = useAuth();
  const query = useQuery({
    queryKey: UNREAD_SUMMARY_QUERY_KEY,
    queryFn: () => listNotifications(auth),
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  let label = 'Notifications';
  let count: string | null = null;
  if (query.data) {
    const unread = query.data.items.filter((n) => n.readAt === null).length;
    // Unread items on a later page aren't counted; say so rather than undercount.
    const more = query.data.nextCursor !== null && unread === query.data.items.length;
    if (unread > 0) {
      count = `${unread}${more ? '+' : ''}`;
      label = `Notifications, ${count} unread`;
    } else {
      label = 'Notifications, none unread';
    }
  } else if (query.isError) {
    label = 'Notifications (unread count unavailable)';
  }

  return (
    <Link to="/notifications" className={styles.bell} aria-label={label} title={label}>
      <Bell size={16} aria-hidden="true" />
      {count ? (
        <span className={styles.bellCount} aria-hidden="true">
          {count}
        </span>
      ) : null}
    </Link>
  );
}
