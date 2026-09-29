import type { InboxNotification, NotificationPreference } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-26T12:00:00.000Z');

let notifications: InboxNotification[] = [
  {
    notificationId: 'notif-demo-4',
    category: 'apparatus-defect',
    summary: '1 defect reported',
    items: [
      {
        subjectId: 'DEF-demo-1',
        title: 'E1',
        detail: 'reported out of service',
        link: { kind: 'apparatus', id: 'E1' },
      },
    ],
    createdAt: now - 2 * 60 * 60 * 1000,
    readAt: null,
  },
  {
    notificationId: 'notif-demo-5',
    category: 'apparatus-test-due',
    summary: '2 tests due',
    items: [
      {
        subjectId: 'APP-E1:HOSE',
        title: 'APP-E1',
        detail: 'hose test due 2026-10-20',
        dueDate: '2026-10-20',
        link: { kind: 'apparatus' },
      },
      {
        subjectId: 'SCBA-001:SCBA_FLOW',
        title: 'APP-E2',
        detail: 'SCBA SCBA-001 flow test due 2026-10-02',
        dueDate: '2026-10-02',
        link: { kind: 'apparatus' },
      },
    ],
    createdAt: now - 3 * 60 * 60 * 1000,
    readAt: null,
  },
  {
    notificationId: 'notif-demo-1',
    category: 'cert-expiry',
    summary: '2 items expiring',
    items: [
      { certId: 'EMR-2291', expiryDate: '2026-10-14' },
      { certId: 'FF2-0415', expiryDate: '2026-10-30' },
    ],
    createdAt: now,
    readAt: null,
  },
  {
    notificationId: 'notif-demo-2',
    category: 'cert-expiry-officer',
    summary: '3 items expiring',
    items: [
      { certId: 'HAZMAT-0081', expiryDate: '2026-10-02' },
      { certId: 'PUMP-0112', expiryDate: '2026-10-09' },
      { certId: 'FF1-0777', expiryDate: '2026-10-21' },
    ],
    createdAt: now - DAY_MS,
    readAt: null,
  },
  {
    notificationId: 'notif-demo-3',
    category: 'cert-expiry',
    summary: '1 item expiring',
    items: [{ certId: 'CPR-3310', expiryDate: '2026-09-30' }],
    createdAt: now - 6 * DAY_MS,
    readAt: now - 5 * DAY_MS,
  },
];

let preferences: NotificationPreference[] = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** VITE_DEMO handlers for notification-service's inbox and preferences routes. */
export function tryHandleNotificationExtras(
  parts: string[],
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  if (parts[0] !== 'notifications') return undefined;

  if (parts.length === 1 && method === 'GET') {
    return json({ items: notifications, nextCursor: null });
  }
  if (parts[1] === 'preferences' && parts.length === 2) {
    if (method === 'GET') return json({ preferences });
    if (method === 'PUT') {
      const saved: NotificationPreference = {
        category: body.category as string,
        channels: body.channels as NotificationPreference['channels'],
      };
      preferences = [...preferences.filter((p) => p.category !== saved.category), saved];
      return json({ ...saved, updatedAt: Date.now() });
    }
  }
  if (parts.length === 3 && parts[2] === 'read' && method === 'POST') {
    const id = decodeURIComponent(parts[1] ?? '');
    const found = notifications.find((n) => n.notificationId === id);
    if (!found) {
      return json({ type: 'about:blank', title: 'Not found', status: 404, traceId: 'demo' }, 404);
    }
    const readAt = Date.now();
    notifications = notifications.map((n) => (n.notificationId === id ? { ...n, readAt } : n));
    return json({ notificationId: id, readAt });
  }

  return undefined;
}
