import type { ApiRequestOptions, ProblemDetails } from './apiClient';
import type {
  Certification,
  ExpiringCertification,
  Transcript,
  TrainingEvent,
} from '../features/training/types';

let certifications: Certification[] = [
  {
    certId: 'CERT-1',
    memberId: 'm-1',
    certType: 'FF1',
    issueDate: '2022-01-10',
    expiryDate: '2027-01-10',
    issuingAuthority: 'CT DESPP',
    attachmentS3Key: null,
    status: 'CURRENT',
  },
  {
    certId: 'CERT-2',
    memberId: 'm-1',
    certType: 'Hazmat Ops',
    issueDate: '2020-03-01',
    expiryDate: '2026-03-01',
    issuingAuthority: 'CT DESPP',
    attachmentS3Key: null,
    status: 'EXPIRED',
  },
];

let events: TrainingEvent[] = [
  {
    eventId: 'evt-1',
    title: 'Ladder drill',
    category: 'Ladders',
    startAt: Date.now() + 86_400_000,
    endAt: Date.now() + 90_000_000,
    signedUp: false,
  },
];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(status: number, title: string): Response {
  const body: ProblemDetails = { type: 'about:blank', title, status, traceId: 'demo' };
  return json(body, status);
}

export async function trainingDemoRequest(
  path: string,
  options: ApiRequestOptions = {},
): Promise<Response | undefined> {
  const method = (options.method ?? 'GET').toUpperCase();
  const body = options.body ? (JSON.parse(options.body as string) as Record<string, unknown>) : {};
  const parts = path.split('/');

  if (parts[0] !== 'training') return undefined;

  if (path === 'training/certifications/expiring' && method === 'GET') {
    const due: ExpiringCertification[] = certifications
      .filter((c) => c.status === 'CURRENT')
      .map((c) => ({
        certId: c.certId,
        memberId: c.memberId,
        certType: c.certType,
        expiryDate: c.expiryDate,
        issuingAuthority: c.issuingAuthority,
        status: c.status,
      }));
    return json(due);
  }

  if (parts[1] === 'members' && parts[3] === 'certifications' && parts.length === 4) {
    const memberId = decodeURIComponent(parts[2] ?? '');
    if (method === 'GET') {
      return json(certifications.filter((c) => c.memberId === memberId));
    }
    if (method === 'POST') {
      const created: Certification = {
        certId: `CERT-${certifications.length + 1}`,
        memberId,
        certType: body.certType as string,
        issueDate: body.issueDate as string,
        expiryDate: body.expiryDate as string,
        issuingAuthority: body.issuingAuthority as string,
        attachmentS3Key: null,
        status: 'CURRENT',
      };
      certifications = [...certifications, created];
      return json(created, 201);
    }
  }

  if (parts[1] === 'members' && parts[3] === 'certifications' && parts[5] === 'revoke') {
    const memberId = decodeURIComponent(parts[2] ?? '');
    const certId = decodeURIComponent(parts[4] ?? '');
    let updated: Certification | undefined;
    certifications = certifications.map((c) => {
      if (c.memberId !== memberId || c.certId !== certId) return c;
      updated = { ...c, status: 'REVOKED' };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Certification not found');
  }

  if (parts[1] === 'members' && parts[3] === 'transcript') {
    const memberId = decodeURIComponent(parts[2] ?? '');
    const memberCerts = certifications.filter((c) => c.memberId === memberId);
    const transcript: Transcript = {
      memberId,
      certifications: memberCerts,
      attendance: [],
      hoursByCategory: {},
    };
    return json(transcript);
  }

  // The demo router strips the query string before it reaches here, so from/to are not echoed.
  if (path === 'training/hours' && method === 'GET') {
    return json({
      from: 0,
      to: 0,
      members: [
        {
          memberId: 'm-1',
          categories: [
            { category: 'Ladders', hours: 6 },
            { category: 'Hazmat', hours: 4 },
          ],
        },
        { memberId: 'm-3', categories: [{ category: 'Ladders', hours: 3 }] },
      ],
    });
  }

  if (path === 'training/events' && method === 'GET') {
    return json(events);
  }

  if (path === 'training/events' && method === 'POST') {
    const created: TrainingEvent = {
      eventId: `evt-${events.length + 1}`,
      title: body.title as string,
      category: body.category as string,
      startAt: body.startAt as number,
      endAt: body.endAt as number,
      signedUp: false,
    };
    events = [...events, created];
    return json(created, 201);
  }

  if (parts[1] === 'events' && parts[3] === 'signup' && method === 'POST') {
    const eventId = decodeURIComponent(parts[2] ?? '');
    let found = false;
    events = events.map((e) => {
      if (e.eventId !== eventId) return e;
      found = true;
      return { ...e, signedUp: true };
    });
    return found ? json({ eventId }) : problem(404, 'Event not found');
  }

  return problem(404, 'Not found');
}
