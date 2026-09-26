import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type { InboxPage, NotificationChannelMutes, NotificationPreference } from './types';

export async function listNotifications(
  tokens: AuthTokenSource,
  cursor?: string | null,
): Promise<InboxPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await apiRequest(`notifications${query}`, tokens);
  return (await response.json()) as InboxPage;
}

export async function markNotificationRead(
  tokens: AuthTokenSource,
  notificationId: string,
): Promise<{ notificationId: string; readAt: number }> {
  const response = await apiRequest(
    `notifications/${encodeURIComponent(notificationId)}/read`,
    tokens,
    { method: 'POST' },
  );
  return (await response.json()) as { notificationId: string; readAt: number };
}

export async function getNotificationPreferences(
  tokens: AuthTokenSource,
): Promise<NotificationPreference[]> {
  const response = await apiRequest('notifications/preferences', tokens);
  const body = (await response.json()) as { preferences: NotificationPreference[] };
  return body.preferences;
}

export async function putNotificationPreference(
  tokens: AuthTokenSource,
  category: string,
  channels: NotificationChannelMutes,
): Promise<void> {
  await apiRequest('notifications/preferences', tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, channels }),
  });
}
