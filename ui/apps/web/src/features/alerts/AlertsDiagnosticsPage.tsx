import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Card, PageHeader, Skeleton, StatusChip, TextInput } from '../../components/ui';
import { getCanaryStatus, getDiagnostics } from './api';
import type { DeviceState, DiagnosticsTimelineEntry } from './types';

// AC2 intent ("never a stale green"): canary/statusHandler.ts computes healthy purely from
// latestResult, with no staleness check. OQ-8 leaves the real cadence unresolved (proposed
// every 1-2 min); this is a stated default (2x a 120s assumed interval), not an architecture
// fact - see the plan's Risks section.
const CANARY_STALE_AFTER_MS = 240_000;

function timelineLabel(entry: DiagnosticsTimelineEntry): string {
  if (entry.entityType === 'DELIVERY_RECEIPT') {
    // The diagnostics route returns raw DELIVERY_RECEIPT items, which have no status field:
    // the provider callbacks set failureReason / deliveredAt / openedAt
    // (receipts/deliveryReceiptRepository.ts). Keying on `status` alone labelled every
    // delivered page "Sent, not confirmed delivered".
    if (entry.failureReason || entry.status === 'FAILED') {
      return `Failed${entry.failureReason ? ` — ${entry.failureReason}` : ''}`;
    }
    if (entry.openedAt || entry.status === 'OPENED') return 'Opened';
    if (entry.deliveredAt || entry.status === 'DELIVERED') return 'Delivered';
    return 'Sent, not confirmed delivered';
  }
  if (entry.entityType === 'ESCALATION_EVENT')
    return `Escalated${entry.reason ? ` — ${entry.reason}` : ''}`;
  if (entry.entityType === 'DISPATCH_RESPONSE_RECORD')
    return `Response logged — ${entry.ackStatus ?? ''}`;
  return entry.entityType;
}

function timelineTime(entry: DiagnosticsTimelineEntry): number | undefined {
  return entry.sentAt ?? entry.escalatedAt ?? entry.answeredAt;
}

function DeviceCheckPanel({ deviceState }: { deviceState: DeviceState | null }) {
  if (!deviceState) {
    return (
      <Card title="Device check">
        <p>No device report on file.</p>
      </Card>
    );
  }
  const checks: { label: string; ok: boolean }[] = [
    { label: 'Notification permission', ok: deviceState.notificationPermission },
    {
      label: 'Critical-alert / full-screen-intent permission',
      ok: deviceState.criticalAlertPermission,
    },
    { label: 'Battery-optimization exemption', ok: deviceState.batteryOptimizationExempt },
  ];
  return (
    <Card title="Device check">
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {checks.map((check) => (
          <li key={check.label} style={{ padding: 'var(--bx-space-xs) 0' }}>
            <StatusChip status={check.ok ? 'ok' : 'danger'}>
              {check.label}: {check.ok ? 'OK' : 'Not granted'}
            </StatusChip>
          </li>
        ))}
        <li style={{ padding: 'var(--bx-space-xs) 0' }}>
          App {deviceState.appVersion} on {deviceState.osVersion}
        </li>
      </ul>
      <p style={{ fontSize: 13, color: 'var(--bx-fg-muted)' }}>
        Reported {new Date(deviceState.reportedAt * 1000).toLocaleString()}
      </p>
    </Card>
  );
}

function TimelineTable({ dispatchId, memberId }: { dispatchId: string; memberId: string }) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerts', 'diagnostics', dispatchId, memberId],
    queryFn: () => getDiagnostics(auth, dispatchId, memberId),
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Diagnostics are unavailable.</p>
      </ApiForbiddenGate>
    );
  }
  if (query.isLoading || !query.data) return <Skeleton lines={4} />;

  const { diagnosis, timeline, deviceState } = query.data;

  if (diagnosis === 'NOT_ON_ELIGIBLE_ROSTER') {
    return (
      <Card title="Diagnosis">
        <StatusChip status="danger">Not on the eligible roster</StatusChip>
        <p>
          This member had no delivery record for this dispatch because they were not on the eligible
          roster — this is distinct from a page that was sent but not delivered.
        </p>
      </Card>
    );
  }

  return (
    <>
      <Card title="Delivery timeline">
        {timeline.length === 0 ? (
          <p>Sent, not yet delivered — no timeline entries recorded.</p>
        ) : (
          <div
            role="region"
            aria-label="Delivery timeline"
            tabIndex={0}
            style={{ overflowX: 'auto' }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <caption className="visually-hidden">Delivery timeline</caption>
              <thead>
                <tr>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Channel
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Tone
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Event
                  </th>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((entry, index) => {
                  const time = timelineTime(entry);
                  return (
                    <tr key={`${entry.entityType}-${index}`}>
                      <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                        {entry.channel ?? '—'}
                      </th>
                      <td>{entry.toneSequence ?? '—'}</td>
                      <td>{timelineLabel(entry)}</td>
                      <td>{time ? new Date(time * 1000).toLocaleString() : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <DeviceCheckPanel deviceState={deviceState} />
    </>
  );
}

function CanaryPanel() {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerts', 'canary', 'status'],
    queryFn: () => getCanaryStatus(auth),
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Canary status is unavailable.</p>
      </ApiForbiddenGate>
    );
  }
  if (query.isLoading || !query.data) return <Skeleton lines={3} />;

  const { healthy, latestResult, latestLatencyMs, latestRanAt } = query.data;
  const stale = latestRanAt === null || Date.now() - latestRanAt * 1000 > CANARY_STALE_AFTER_MS;
  const isHealthy = healthy && !stale;
  const overBudget = latestLatencyMs !== null && latestLatencyMs > 5000;

  return (
    <Card title="Canary health">
      <StatusChip status={isHealthy ? 'ok' : 'danger'}>
        {isHealthy ? 'Healthy' : stale ? 'Unhealthy — last run is stale' : 'Unhealthy'}
      </StatusChip>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          columnGap: 'var(--bx-space-lg)',
          rowGap: 'var(--bx-space-sm)',
          fontSize: 14,
          marginTop: 'var(--bx-space-md)',
        }}
      >
        <dt style={{ color: 'var(--bx-fg-muted)' }}>Last run</dt>
        <dd style={{ margin: 0 }}>
          {latestRanAt ? new Date(latestRanAt * 1000).toLocaleString() : 'No runs recorded'}
        </dd>
        <dt style={{ color: 'var(--bx-fg-muted)' }}>Result</dt>
        <dd style={{ margin: 0 }}>{latestResult ?? '—'}</dd>
        <dt style={{ color: 'var(--bx-fg-muted)' }}>Latency vs 5s budget</dt>
        <dd style={{ margin: 0 }}>
          {latestLatencyMs !== null ? `${latestLatencyMs}ms` : '—'}
          {overBudget ? ' (over budget)' : ''}
        </dd>
      </dl>
      {query.data.runs[0] ? (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 'var(--bx-space-md)' }}>
          {Object.entries(query.data.runs[0].channelResults).map(([channel, result]) => (
            <li key={channel} style={{ padding: 'var(--bx-space-xs) 0' }}>
              <StatusChip status={result === 'PASS' ? 'ok' : 'danger'}>
                {channel.toUpperCase()}: {String(result)}
              </StatusChip>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

// #160/#159: web /alerts/diagnostics (officer, chief, admin) - member+dispatch self-diagnosis
// timeline and the N8.3 canary health panel. Follows AlertsRosterPage.tsx's shape (type-and-the
// -view-updates, no submit button) - the diagnostics query only enables once both identifiers
// are entered.
export function AlertsDiagnosticsPage() {
  const [dispatchId, setDispatchId] = useState('');
  const [memberId, setMemberId] = useState('');

  return (
    <main id="main-content">
      <PageHeader title="Alert diagnostics" />

      <div
        style={{ display: 'flex', gap: 'var(--bx-space-md)', marginBottom: 'var(--bx-space-lg)' }}
      >
        <TextInput
          label="Dispatch ID"
          value={dispatchId}
          onChange={(e) => setDispatchId(e.target.value)}
          style={{ maxWidth: 260 }}
        />
        <TextInput
          label="Member ID"
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          style={{ maxWidth: 260 }}
        />
      </div>

      {dispatchId.trim() && memberId.trim() ? (
        <TimelineTable dispatchId={dispatchId.trim()} memberId={memberId.trim()} />
      ) : (
        <p>Enter a dispatch and member to see their delivery timeline and device checks.</p>
      )}

      <div style={{ marginTop: 'var(--bx-space-lg)' }}>
        <CanaryPanel />
      </div>
    </main>
  );
}
