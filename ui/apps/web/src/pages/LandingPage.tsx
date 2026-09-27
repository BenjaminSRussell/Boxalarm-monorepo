import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import { spacing, typography } from '@boxalarm/design-tokens';
import { useAuth, type Role } from '../auth/AuthContext';
import { primaryRole } from '../auth/roles';
import { canAccessPath, firstGrantedNavPath } from '../routing/routeTable';
import { listApparatus } from '../features/apparatus/api';
import { listActiveDispatches } from '../features/alerts/api';
import type { ActiveDispatchList } from '../features/alerts/types';
import { listMembers } from '../features/personnel/api';
import type { Member } from '../features/personnel/types';
import { listShifts } from '../features/schedule/api';
import type { DutyShift } from '../features/schedule/types';
import { listExpiringCertifications } from '../features/training/api';
import type { ExpiringCertification } from '../features/training/types';
import { ApiError } from '../lib/apiClient';
import { ApiForbiddenGate } from '../components/ApiForbiddenGate';
import { Button, Card, Skeleton, Stat } from '../components/ui';
import styles from './LandingPage.module.css';

const ROLE_LABEL: Record<Role, string> = {
  CHIEF: 'Chief dashboard',
  ADMIN: 'Admin dashboard',
  OFFICER: 'Officer dashboard',
  TRAINING: 'Training dashboard',
  APPARATUS: 'Apparatus dashboard',
  MEMBER: 'Member home',
};

// Command-console dashboards are shown for roles that manage the department; a plain member's
// home stays a simple summary (docs/design.md §4.4 — member read-only scope).
const DASHBOARD_ROLES: readonly Role[] = ['CHIEF', 'ADMIN', 'OFFICER', 'APPARATUS'];

// GET training/certifications/expiring is ViewExpiringCertifications, an OFFICER_TIER_ACTIONS
// action (infrastructure/components/authz/cedar-policies.ts OFFICER_TIER_GROUPS). A role outside
// it would only ever get a 403, so it never asks (same rule as MAJOR-3 below).
const EXPIRING_CERT_ROLES: readonly Role[] = ['OFFICER', 'TRAINING', 'CHIEF', 'ADMIN'];

// The dashboard shows the next few expiring certs; the full list lives on /certifications.
const EXPIRING_CERTS_SHOWN = 5;
const ACTIVE_CALL_REFRESH_MS = 30_000;

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatWindow(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? 'hour' : `${hours} hours`;
  }
  return `${Math.round(seconds / 60)} minutes`;
}

/**
 * A tile's failed read. Never falls back to an empty or zero rendering: a failure must not read
 * as "nothing happening" on a life-safety dashboard (MAJOR-2/MAJOR-3, PR #318 review).
 */
function TileError({
  error,
  what,
  onRetry,
}: {
  error: unknown;
  what: string;
  onRetry: () => void;
}) {
  if (error instanceof ApiError && error.problem.status === 403) {
    return <p className={styles.tileMessage}>You don&rsquo;t have access to {what}.</p>;
  }
  return (
    <div className={styles.tileError}>
      <p className={styles.tileMessage}>Couldn&rsquo;t load {what}. This is not an empty result.</p>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function ActiveCalls({ canOpenRoster }: { canOpenRoster: boolean }) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerting', 'dispatches', 'active'],
    queryFn: () => listActiveDispatches(auth),
    refetchInterval: ACTIVE_CALL_REFRESH_MS,
  });

  return (
    <Card title="Active calls" className={styles.callCard}>
      <ActiveCallsBody
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        onRetry={() => void query.refetch()}
        canOpenRoster={canOpenRoster}
      />
    </Card>
  );
}

function ActiveCallsBody({
  isLoading,
  error,
  data,
  onRetry,
  canOpenRoster,
}: {
  isLoading: boolean;
  error: unknown;
  data: ActiveDispatchList | undefined;
  onRetry: () => void;
  canOpenRoster: boolean;
}) {
  if (isLoading) return <Skeleton lines={1} />;
  // An error wins over stale data: showing the last good list after a failed refresh would
  // present an unknown state as current.
  if (error || !data)
    return <TileError error={error} what="active-call status" onRetry={onRetry} />;

  const windowLabel = formatWindow(data.activeWindowSeconds);
  const asOf = formatTime(data.asOf * 1000);
  if (data.dispatches.length === 0) {
    return (
      <p className={styles.tileMessage}>
        No calls dispatched in the last {windowLabel} (as of {asOf}).
      </p>
    );
  }

  return (
    <>
      <p className={styles.tileMessage}>
        Dispatched in the last {windowLabel} (as of {asOf}):
      </p>
      <ul className={styles.list}>
        {data.dispatches.map((dispatch) => (
          <li key={dispatch.dispatchId} className={styles.listItem}>
            <strong>{dispatch.incidentType ?? 'Unknown call type'}</strong>
            {' — '}
            {dispatch.address ?? 'No address on the dispatch'}
            {dispatch.crossStreets ? ` (${dispatch.crossStreets})` : null}
            <span className={styles.meta}>
              {' · '}dispatched {formatTime(dispatch.dispatchedAt * 1000)} · tone{' '}
              {dispatch.toneLadder.currentToneSequence}
            </span>
            {canOpenRoster ? (
              <>
                {' · '}
                <Link to={`/alerts/roster?dispatchId=${encodeURIComponent(dispatch.dispatchId)}`}>
                  Live roster
                </Link>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {data.truncated ? (
        <p className={styles.tileMessage}>More calls than shown; this list is incomplete.</p>
      ) : null}
    </>
  );
}

function startOfToday(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Shifts overlapping today (local time). DUTY_SHIFT times are epoch milliseconds. */
function shiftsOverlappingToday(shifts: readonly DutyShift[], now: Date): DutyShift[] {
  const dayStart = startOfToday(now);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  return shifts
    .filter((shift) => shift.startAt < dayEnd && shift.endAt > dayStart)
    .sort((a, b) => a.startAt - b.startAt);
}

const SHIFT_STATUS_WORD: Record<string, string> = {
  OPEN: 'open',
  PARTIALLY_FILLED: 'partially filled',
  FULL: 'full',
  CANCELLED: 'cancelled',
};

function TodaysShifts() {
  const auth = useAuth();
  const query = useQuery({ queryKey: ['schedule', 'shifts'], queryFn: () => listShifts(auth) });

  let body: React.ReactNode;
  if (query.isLoading) {
    body = <Skeleton lines={2} />;
  } else if (query.error || !query.data) {
    body = <TileError error={query.error} what="shifts" onRetry={() => void query.refetch()} />;
  } else {
    const today = shiftsOverlappingToday(query.data, new Date());
    body =
      today.length === 0 ? (
        <p className={styles.tileMessage}>No duty shifts are scheduled today.</p>
      ) : (
        <ul className={styles.list}>
          {today.map((shift) => (
            <li key={shift.shiftId} className={styles.listItem}>
              <strong>{shift.stationId}</strong> {formatTime(shift.startAt)}–
              {formatTime(shift.endAt)}
              <span className={styles.meta}>
                {' · '}
                {SHIFT_STATUS_WORD[shift.status] ?? shift.status}
              </span>
            </li>
          ))}
        </ul>
      );
  }

  return <Card title="Today's shifts">{body}</Card>;
}

function memberName(members: readonly Member[] | undefined, memberId: string): string {
  const member = members?.find((m) => m.memberId === memberId);
  return member ? `${member.firstName} ${member.lastName}` : memberId;
}

function ExpiringCertifications({
  query,
  members,
  canOpenCertifications,
}: {
  query: {
    isLoading: boolean;
    error: unknown;
    data: ExpiringCertification[] | undefined;
    refetch: () => unknown;
  };
  members: readonly Member[] | undefined;
  canOpenCertifications: boolean;
}) {
  let body: React.ReactNode;
  if (query.isLoading) {
    body = <Skeleton lines={2} />;
  } else if (query.error || !query.data) {
    body = (
      <TileError
        error={query.error}
        what="expiring certifications"
        onRetry={() => void query.refetch()}
      />
    );
  } else if (query.data.length === 0) {
    body = (
      <p className={styles.tileMessage}>
        No certifications expire within the department&rsquo;s reminder window.
      </p>
    );
  } else {
    const sorted = [...query.data].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
    const hidden = sorted.length - EXPIRING_CERTS_SHOWN;
    body = (
      <>
        <ul className={styles.list}>
          {sorted.slice(0, EXPIRING_CERTS_SHOWN).map((cert) => (
            <li key={cert.certId} className={styles.listItem}>
              <strong>{memberName(members, cert.memberId)}</strong> — {cert.certType}
              <span className={styles.meta}> · expires {cert.expiryDate}</span>
            </li>
          ))}
        </ul>
        {hidden > 0 ? (
          <p className={styles.tileMessage}>
            and {hidden} more
            {canOpenCertifications ? (
              <>
                {' — '}
                <Link to="/certifications">see all certifications</Link>
              </>
            ) : null}
          </p>
        ) : null}
      </>
    );
  }

  return <Card title="Expiring certifications">{body}</Card>;
}

function CommandConsole() {
  const auth = useAuth();
  // MAJOR-3 (PR #318 review): §7.1 grants /apparatus to APPARATUS|CHIEF only and /personnel to
  // OFFICER|TRAINING|ADMIN|CHIEF only, but this dashboard used to fetch both unconditionally for
  // every DASHBOARD_ROLES member — e.g. an OFFICER (who can't read /apparatus) or an APPARATUS
  // officer (who can't read /personnel) triggered a query that Cedar denies with 403 on every
  // dashboard visit. Gate each query on the same route table the rest of the app uses, so a role
  // that can't read a resource never requests it.
  const canViewApparatus = canAccessPath('/apparatus', auth.roles);
  const canViewMembers = canAccessPath('/personnel', auth.roles);
  const canViewExpiring = auth.roles.some((r) => EXPIRING_CERT_ROLES.includes(r));

  const apparatusQuery = useQuery({
    queryKey: ['apparatus'],
    queryFn: () => listApparatus(auth),
    enabled: canViewApparatus,
  });
  const membersQuery = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
    enabled: canViewMembers,
  });
  const expiringQuery = useQuery({
    queryKey: ['training', 'certifications', 'expiring'],
    queryFn: () => listExpiringCertifications(auth),
    enabled: canViewExpiring,
  });

  // MAJOR-3: a failed query (offline, 500, or a 403 that slips through the gate above) used to
  // fall through to `?? []`, so the tile silently read "0 / 0 apparatus in service" — a failure
  // rendered as a clean, healthy zero. Route it through the project's ApiError/ApiForbiddenGate
  // convention (same pattern as ApparatusListPage/PersonnelListPage) instead: a 403 renders
  // ForbiddenState, anything else renders the generic retryable ApiErrorState. `embedded` +
  // `headingLevel="h2"` because LandingPage already owns the page's one <h1>. Scoped to the
  // unit/member counts only, so their failure never hides the active-call tile.
  const countsError = apparatusQuery.error ?? membersQuery.error;

  const apparatus = apparatusQuery.data ?? [];
  const inService = apparatus.filter((a) => a.status === 'IN_SERVICE').length;
  const outOfService = apparatus.filter((a) => a.status === 'OUT_OF_SERVICE').length;
  const members = membersQuery.data ?? [];
  const activeMembers = members.filter((m) => m.status === 'ACTIVE').length;

  let expiringValue: React.ReactNode = '—';
  let expiringHint: string | undefined;
  if (expiringQuery.error) {
    expiringHint = 'Unavailable';
  } else if (expiringQuery.data) {
    expiringValue = expiringQuery.data.length;
  }

  return (
    <>
      {/* MAJOR-2 (PR #318 review): this used to hardcode "No active call." as fact. It now reads
          GET alerting/dispatches?status=active and says only what that returned: the calls
          dispatched within the server's stated window, or a loading/error state — never an
          assumed "all clear". */}
      <ActiveCalls canOpenRoster={canAccessPath('/alerts/roster', auth.roles)} />

      {countsError ? (
        <ApiForbiddenGate error={countsError} embedded>
          {null}
        </ApiForbiddenGate>
      ) : (
        <div className={styles.statGrid}>
          {canViewApparatus ? (
            <>
              <Stat
                label="Apparatus in service"
                value={apparatusQuery.isLoading ? '—' : `${inService} / ${apparatus.length}`}
              />
              <Stat
                label="Out of service"
                value={apparatusQuery.isLoading ? '—' : outOfService}
                alarm={outOfService > 0}
              />
            </>
          ) : null}
          {canViewMembers ? (
            <Stat
              label="Active members"
              value={membersQuery.isLoading ? '—' : `${activeMembers} / ${members.length}`}
            />
          ) : null}
          {canViewExpiring ? (
            <Stat
              label="Expiring certifications"
              value={expiringValue}
              hint={expiringHint}
              alarm={typeof expiringValue === 'number' && expiringValue > 0}
            />
          ) : null}
        </div>
      )}

      <div className={styles.sectionGrid}>
        <TodaysShifts />
        {canViewExpiring ? (
          <ExpiringCertifications
            query={expiringQuery}
            members={membersQuery.data}
            canOpenCertifications={canAccessPath('/certifications', auth.roles)}
          />
        ) : null}
      </div>
    </>
  );
}

export function LandingPage() {
  const { roles } = useAuth();
  const role = primaryRole(roles);

  if (!canAccessPath('/', roles)) {
    const fallback = firstGrantedNavPath(roles);
    if (fallback) return <Navigate to={fallback} replace />;
  }

  return (
    <main id="main-content" style={{ padding: spacing.lg }}>
      <h1 style={{ fontSize: typography.size.xl, margin: 0 }}>{ROLE_LABEL[role]}</h1>
      {DASHBOARD_ROLES.includes(role) ? <CommandConsole /> : null}
    </main>
  );
}
