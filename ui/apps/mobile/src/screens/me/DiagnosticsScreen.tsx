import { spacing, typeScale } from '@boxalarm/design-tokens';
import { useCallback, useEffect, useState } from 'react';
import Config from 'react-native-config';
import { ActivityIndicator, Text, View } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import {
  getOwnDiagnostics,
  listRecentOwnDispatches,
  type OwnDiagnostics,
  type OwnTimelineEntry,
  type RecentDispatch,
} from '../../features/alerts/diagnosticsApi';
import { ApiError } from '../../lib/apiClient';
import { Button, Card, Screen, useTheme, type SurfaceTheme } from '../../components/ui';

const CHANNEL_LABEL: Record<string, string> = { PUSH: 'Push', SMS: 'SMS', VOICE: 'Voice' };

type DispatchResult =
  { readonly kind: 'ok'; readonly diagnostics: OwnDiagnostics } | { readonly kind: 'error' };

interface Loaded {
  readonly dispatches: readonly RecentDispatch[];
  readonly results: ReadonlyMap<string, DispatchResult>;
  readonly partial: boolean;
  readonly activeWindowSeconds: number | null;
}

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loaded'; readonly data: Loaded };

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

/** Receipts have no status field — the delivery state is which timestamps the provider set. */
function describeEntry(entry: OwnTimelineEntry): { label: string; at: number | undefined } {
  const channel = CHANNEL_LABEL[entry.channel ?? ''] ?? entry.channel ?? 'Channel';
  if (entry.entityType === 'DELIVERY_RECEIPT') {
    if (entry.failureReason) {
      return { label: `${channel}: failed (${entry.failureReason})`, at: entry.sentAt };
    }
    if (entry.openedAt) return { label: `${channel}: opened`, at: entry.openedAt };
    if (entry.deliveredAt) return { label: `${channel}: delivered`, at: entry.deliveredAt };
    return { label: `${channel}: sent, delivery not confirmed`, at: entry.sentAt };
  }
  if (entry.entityType === 'ESCALATION_EVENT') {
    return {
      label: `Escalated to voice${entry.reason ? ` (${entry.reason})` : ''}`,
      at: entry.escalatedAt,
    };
  }
  if (entry.entityType === 'DISPATCH_RESPONSE_RECORD') {
    return { label: `Your response: ${entry.ackStatus ?? 'recorded'}`, at: entry.answeredAt };
  }
  return { label: entry.entityType, at: undefined };
}

function groupByTone(timeline: readonly OwnTimelineEntry[]): [number, OwnTimelineEntry[]][] {
  const byTone = new Map<number, OwnTimelineEntry[]>();
  for (const entry of timeline) {
    const tone = entry.toneSequence ?? 1;
    byTone.set(tone, [...(byTone.get(tone) ?? []), entry]);
  }
  return [...byTone.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tone, entries]) => [
      tone,
      [...entries].sort((x, y) => (describeEntry(x).at ?? 0) - (describeEntry(y).at ?? 0)),
    ]);
}

function Muted({ theme, children }: { theme: SurfaceTheme; children: React.ReactNode }) {
  return (
    <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size, marginTop: spacing.xs }}>
      {children}
    </Text>
  );
}

function DispatchTimeline({
  dispatch,
  result,
  theme,
}: {
  dispatch: RecentDispatch;
  result: DispatchResult | undefined;
  theme: SurfaceTheme;
}) {
  const title = `${dispatch.incidentType ?? 'Dispatch'} · ${formatTime(dispatch.at)}`;
  if (!result || result.kind === 'error') {
    return (
      <Card title={title}>
        <Text accessibilityRole="alert" style={{ color: theme.status.danger }}>
          The timeline for this dispatch could not be loaded.
        </Text>
      </Card>
    );
  }
  const { diagnostics } = result;
  if (diagnostics.diagnosis === 'NOT_ON_ELIGIBLE_ROSTER') {
    return (
      <Card title={title}>
        <Text style={{ color: theme.status.danger, fontWeight: '600' }}>
          You were not on the eligible roster
        </Text>
        <Muted theme={theme}>
          No page was sent to you for this call, so nothing failed to deliver. Check your
          availability and qualifications with an officer.
        </Muted>
      </Card>
    );
  }
  if (diagnostics.timeline.length === 0) {
    return (
      <Card title={title}>
        <Muted theme={theme}>
          You were on the roster, but no delivery attempt is recorded yet.
        </Muted>
      </Card>
    );
  }
  return (
    <Card title={title}>
      {groupByTone(diagnostics.timeline).map(([tone, entries]) => (
        <View key={tone} accessibilityLabel={`Tone ${tone}`} style={{ marginTop: spacing.xs }}>
          <Text style={{ color: theme.fg, fontSize: typeScale.subheading.size, fontWeight: '600' }}>
            Tone {tone}
          </Text>
          {entries.map((entry, index) => {
            const { label, at } = describeEntry(entry);
            return (
              <Text
                key={`${entry.entityType}-${index}`}
                style={{ color: theme.fg, fontSize: typeScale.body.size }}
              >
                {label}
                {at ? ` — ${formatTime(at)}` : ''}
              </Text>
            );
          })}
        </View>
      ))}
    </Card>
  );
}

function DeviceCheck({ diagnostics, theme }: { diagnostics: OwnDiagnostics; theme: SurfaceTheme }) {
  const state = diagnostics.deviceState;
  if (!state) {
    return (
      <Card title="This device">
        <Muted theme={theme}>No device report on file yet.</Muted>
      </Card>
    );
  }
  const checks = [
    { label: 'Notifications', ok: state.notificationPermission },
    { label: 'Critical alerts / full-screen alerts', ok: state.criticalAlertPermission },
    { label: 'Battery optimization exemption', ok: state.batteryOptimizationExempt },
  ];
  return (
    <Card title="This device">
      {checks.map((check) => (
        <Text
          key={check.label}
          style={{ color: check.ok ? theme.status.ok : theme.status.danger, fontWeight: '600' }}
        >
          {check.label}: {check.ok ? 'allowed' : 'not allowed'}
        </Text>
      ))}
      <Muted theme={theme}>
        App {state.appVersion} on {state.osVersion}, reported {formatTime(state.reportedAt)}
      </Muted>
    </Card>
  );
}

// N8.3: "why didn't I get the page?" — the member's own per-tone delivery timeline for their
// most recent dispatches, from alerting-service's self-diagnostics route.
export function DiagnosticsScreen() {
  const theme = useTheme();
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const memberId = auth?.memberId ?? null;
  const canFetch = Boolean(auth?.isAuthenticated && apiBaseUrl && memberId);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!canFetch || !auth || !memberId) return;
    let cancelled = false;
    setState({ kind: 'loading' });

    const load = async () => {
      try {
        const recent = await listRecentOwnDispatches(auth, apiBaseUrl!, memberId);
        const settled = await Promise.allSettled(
          recent.dispatches.map((d) => getOwnDiagnostics(auth, apiBaseUrl!, d.dispatchId)),
        );
        const results = new Map<string, DispatchResult>(
          recent.dispatches.map((d, i) => {
            const outcome = settled[i]!;
            return [
              d.dispatchId,
              outcome.status === 'fulfilled'
                ? { kind: 'ok', diagnostics: outcome.value }
                : { kind: 'error' },
            ];
          }),
        );
        if (!cancelled) {
          setState({
            kind: 'loaded',
            data: {
              dispatches: recent.dispatches,
              results,
              partial: recent.partial,
              activeWindowSeconds: recent.activeWindowSeconds,
            },
          });
        }
      } catch (error) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message:
            error instanceof ApiError &&
            (error.problem.status === 401 || error.problem.status === 403)
              ? 'You do not have access to your delivery history.'
              : 'Your delivery history could not be loaded. Check your connection and try again.',
        });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [canFetch, auth, apiBaseUrl, memberId, attempt]);

  let body: React.ReactNode;
  if (!canFetch) {
    body = <Muted theme={theme}>Sign in to see the delivery timeline for your recent pages.</Muted>;
  } else if (state.kind === 'loading') {
    body = (
      <View style={{ marginTop: spacing.lg }}>
        <ActivityIndicator accessibilityLabel="Loading your delivery history" color={theme.fg} />
      </View>
    );
  } else if (state.kind === 'error') {
    body = (
      <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
        <Text accessibilityRole="alert" style={{ color: theme.status.danger }}>
          {state.message}
        </Text>
        <Button label="Try again" variant="secondary" onPress={retry} />
      </View>
    );
  } else {
    const { dispatches, results, partial, activeWindowSeconds } = state.data;
    const firstOk = dispatches
      .map((d) => results.get(d.dispatchId))
      .find((r): r is Extract<DispatchResult, { kind: 'ok' }> => r?.kind === 'ok');
    body = (
      <View style={{ marginTop: spacing.lg, gap: spacing.md }}>
        {partial ? (
          <Text accessibilityRole="alert" style={{ color: theme.status.warning }}>
            Part of your history could not be loaded, so a recent dispatch may be missing.
          </Text>
        ) : null}
        {dispatches.length === 0 ? (
          <Muted theme={theme}>
            No pages to you are on record
            {activeWindowSeconds
              ? `, and no calls were dispatched in the last ${Math.round(activeWindowSeconds / 3600)} hours.`
              : '.'}
          </Muted>
        ) : (
          dispatches.map((d) => (
            <DispatchTimeline
              key={d.dispatchId}
              dispatch={d}
              result={results.get(d.dispatchId)}
              theme={theme}
            />
          ))
        )}
        {firstOk ? <DeviceCheck diagnostics={firstOk.diagnostics} theme={theme} /> : null}
        <Button label="Refresh" variant="secondary" onPress={retry} />
      </View>
    );
  }

  return (
    <Screen>
      <Text
        accessibilityRole="header"
        style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
      >
        Why didn&apos;t I get the page?
      </Text>
      <Muted theme={theme}>
        Each page to you, per tone and channel — sent, delivered and opened — so you can see exactly
        where a page didn&apos;t land.
      </Muted>
      {body}
    </Screen>
  );
}
