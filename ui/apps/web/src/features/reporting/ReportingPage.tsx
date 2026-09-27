import { useState, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiErrorState } from '../../components/ApiErrorState';
import { ForbiddenState } from '../../components/ForbiddenState';
import {
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  Skeleton,
  Stat,
  StatusChip,
  Tabs,
  TextInput,
} from '../../components/ui';
import { ClipboardList, LayoutDashboard } from '../../components/ui/icons';
import { ApiError } from '../../lib/apiClient';
import { canAccessPath } from '../../routing/routeTable';
import {
  getDashboard,
  getGrantsReport,
  getIsoReport,
  getLosapYearEnd,
  getMembershipTrends,
  getResponseTimes,
} from './api';
import {
  formatDate,
  formatDuration,
  formatPercent,
  isoDateDaysAgo,
  isoDateToEpochSeconds,
  todayIsoDate,
} from './format';
import { ReportExport } from './ReportExport';
import { ACTIVITY_TYPES, type ReportName, type TimeSummary } from './types';
import styles from './ReportingPage.module.css';

const MAX_TREND_RANGE_DAYS = 731;

/** Loading → Skeleton; 403 → ForbiddenState; any other error → retryable ApiErrorState. */
function QueryState<T>({
  query,
  children,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
}) {
  if (query.isLoading) return <Skeleton lines={5} />;
  if (query.error) {
    if (query.error instanceof ApiError && query.error.problem.status === 403) {
      return <ForbiddenState problem={query.error.problem} embedded headingLevel="h2" />;
    }
    return <ApiErrorState embedded headingLevel="h2" onRetry={() => void query.refetch()} />;
  }
  if (query.data === undefined) return null;
  return <>{children(query.data)}</>;
}

function useCanExport(): boolean {
  const { roles } = useAuth();
  // Mirrors the Cedar ExportReport tier (CHIEF/ADMIN); the backend enforces it regardless.
  return roles.includes('CHIEF') || roles.includes('ADMIN');
}

function ExportIfAllowed(props: {
  report: ReportName;
  params: Record<string, string>;
  disabled?: boolean;
}) {
  return useCanExport() ? <ReportExport {...props} /> : null;
}

/** A from/to date pair, with the from-after-to case flagged on the field. */
function useDateRange(defaultFrom: string, defaultTo: string) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const valid = from !== '' && to !== '' && from <= to;
  const fields = (
    <div className={styles.filters}>
      <TextInput label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      <TextInput
        label="To"
        type="date"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        error={from !== '' && to !== '' && from > to ? 'Must be on or after From.' : undefined}
      />
    </div>
  );
  return { from, to, valid, fields };
}

function summaryStat(label: string, summary: TimeSummary) {
  return (
    <Stat
      label={`${label} (median)`}
      value={formatDuration(summary.medianSeconds)}
      hint={`90th percentile ${formatDuration(summary.p90Seconds)} · ${summary.sampleCount} measured, ${summary.excludedCount} missing a timestamp`}
    />
  );
}

function DashboardPanel() {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['reporting', 'dashboard'],
    queryFn: () => getDashboard(auth),
  });
  const canOpenIncidents = canAccessPath('/incidents/x', auth.roles);

  return (
    <>
      <QueryState query={query}>
        {(view) =>
          view.lastUpdated === null ? (
            <EmptyState
              icon={LayoutDashboard}
              title="No dashboard data yet"
              description="The dashboard is built from staffing, apparatus, certification and NERIS events as they happen. None has been recorded for your department yet."
            />
          ) : (
            <>
              <p className={styles.meta}>Last updated {formatDate(view.lastUpdated)}</p>
              <div className={styles.statGrid}>
                <Stat label="Active members" value={view.staffing.activeMemberCount} />
                <Stat label="Marked unavailable" value={view.staffing.unavailableCount} />
                <Stat
                  label="Shift coverage gaps"
                  value={view.staffing.shiftCoverage.gapCount}
                  alarm={view.staffing.shiftCoverage.gapCount > 0}
                />
                <Stat
                  label="Apparatus out of service"
                  value={view.outOfServiceApparatus.length}
                  alarm={view.outOfServiceApparatus.length > 0}
                />
                <Stat label="Expiring certifications" value={view.expiringCertifications.count} />
                <Stat
                  label="NERIS submissions"
                  value={`${view.nerisCompliance.failedCount} failed`}
                  hint={`${view.nerisCompliance.pendingCount} pending`}
                  alarm={view.nerisCompliance.failedCount > 0}
                />
              </div>
              <div className={styles.sections}>
                <Card title="Apparatus out of service">
                  <DataTable
                    caption="Apparatus out of service"
                    rowKey={(row) => row.unitId}
                    rows={view.outOfServiceApparatus}
                    emptyMessage="Every unit is in service."
                    columns={[
                      { key: 'unit', header: 'Unit', isRowHeader: true, render: (r) => r.unitId },
                      { key: 'reason', header: 'Reason', render: (r) => r.reason || '—' },
                      {
                        key: 'duration',
                        header: 'Out of service for',
                        render: (r) => formatDuration(r.durationSeconds),
                      },
                    ]}
                  />
                </Card>
                <Card title="Expiring certifications">
                  <DataTable
                    caption="Expiring certifications"
                    rowKey={(row) => `${row.memberId}-${row.certId}`}
                    rows={view.expiringCertifications.certifications}
                    emptyMessage="No certifications are expiring."
                    columns={[
                      { key: 'member', header: 'Member', render: (r) => r.memberId },
                      { key: 'cert', header: 'Certification', render: (r) => r.certId },
                      {
                        key: 'expiry',
                        header: 'Expires',
                        sortValue: (r) => r.expiryDate,
                        render: (r) => r.expiryDate,
                      },
                    ]}
                  />
                </Card>
                <Card title="NERIS submissions needing attention">
                  <DataTable
                    caption="NERIS submissions needing attention"
                    rowKey={(row) => row.incidentId}
                    rows={view.nerisCompliance.submissions}
                    emptyMessage="No pending or failed NERIS submissions."
                    columns={[
                      {
                        key: 'incident',
                        header: 'Incident',
                        render: (r) =>
                          canOpenIncidents ? (
                            <Link to={`/incidents/${encodeURIComponent(r.incidentId)}`}>
                              {r.incidentId}
                            </Link>
                          ) : (
                            r.incidentId
                          ),
                      },
                      {
                        key: 'status',
                        header: 'Status',
                        render: (r) => (
                          <StatusChip status={r.status === 'FAILED' ? 'danger' : 'caution'}>
                            {r.status === 'FAILED' ? 'Failed' : 'Pending'}
                          </StatusChip>
                        ),
                      },
                    ]}
                  />
                </Card>
                <Card title="Shift coverage gaps">
                  <DataTable
                    caption="Shift coverage gaps"
                    rowKey={(row) => row.shiftId}
                    rows={view.staffing.shiftCoverage.gaps}
                    emptyMessage="No open coverage gaps."
                    columns={[
                      { key: 'shift', header: 'Shift', render: (r) => r.shiftId },
                      { key: 'reason', header: 'Gap', render: (r) => r.gapReason || '—' },
                    ]}
                  />
                </Card>
              </div>
            </>
          )
        }
      </QueryState>
      <div className={styles.sections}>
        <ExportIfAllowed report="dashboard" params={{}} />
      </div>
    </>
  );
}

function ResponseTimesPanel() {
  const auth = useAuth();
  const range = useDateRange(isoDateDaysAgo(30), todayIsoDate());
  const from = isoDateToEpochSeconds(range.from);
  const to = isoDateToEpochSeconds(range.to) + 86_399;
  const query = useQuery({
    queryKey: ['reporting', 'response-times', from, to],
    queryFn: () => getResponseTimes(auth, from, to),
    enabled: range.valid,
  });

  return (
    <>
      {range.fields}
      {range.valid ? (
        <QueryState query={query}>
          {(report) =>
            report.units.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="No unit response times in this range"
                description="Response times come from the dispatched, en-route and on-scene times recorded on each incident's responding units."
              />
            ) : (
              <>
                <div className={styles.statGrid}>
                  {summaryStat('Turnout', report.turnout)}
                  {summaryStat('Travel', report.travel)}
                  {summaryStat('Total response', report.total)}
                </div>
                <div className={styles.sections}>
                  <DataTable
                    caption="Response times by unit"
                    rowKey={(r) => `${r.incidentId}-${r.unitId}`}
                    rows={report.units}
                    columns={[
                      { key: 'incident', header: 'Incident', render: (r) => r.incidentId },
                      { key: 'unit', header: 'Unit', render: (r) => r.unitId },
                      {
                        key: 'turnout',
                        header: 'Turnout',
                        align: 'right',
                        sortValue: (r) => r.turnoutSeconds ?? -1,
                        render: (r) => formatDuration(r.turnoutSeconds),
                      },
                      {
                        key: 'travel',
                        header: 'Travel',
                        align: 'right',
                        sortValue: (r) => r.travelSeconds ?? -1,
                        render: (r) => formatDuration(r.travelSeconds),
                      },
                      {
                        key: 'total',
                        header: 'Total',
                        align: 'right',
                        sortValue: (r) => r.totalSeconds ?? -1,
                        render: (r) => formatDuration(r.totalSeconds),
                      },
                    ]}
                  />
                </div>
              </>
            )
          }
        </QueryState>
      ) : null}
      <div className={styles.sections}>
        <ExportIfAllowed
          report="response-times"
          params={{ from: String(from), to: String(to) }}
          disabled={!range.valid}
        />
      </div>
    </>
  );
}

function IsoPanel() {
  const auth = useAuth();
  const range = useDateRange(`${new Date().getUTCFullYear()}-01-01`, todayIsoDate());
  const from = isoDateToEpochSeconds(range.from);
  const to = isoDateToEpochSeconds(range.to) + 86_399;
  const query = useQuery({
    queryKey: ['reporting', 'iso', from, to],
    queryFn: () => getIsoReport(auth, from, to),
    enabled: range.valid,
  });

  return (
    <>
      {range.fields}
      {range.valid ? (
        <QueryState query={query}>
          {(report) => (
            <div className={styles.sections}>
              <Card title="Training hours">
                <p className={styles.meta}>Total {report.trainingHours.totalHours} hours</p>
                <DataTable
                  caption="Training hours by category"
                  rowKey={(r) => r.category}
                  rows={report.trainingHours.categories}
                  emptyMessage="No training attendance recorded in this period."
                  columns={[
                    { key: 'category', header: 'Category', render: (r) => r.category },
                    {
                      key: 'hours',
                      header: 'Hours',
                      align: 'right',
                      sortValue: (r) => r.totalHours,
                      render: (r) => r.totalHours,
                    },
                  ]}
                />
              </Card>
              <Card title="Apparatus tests">
                <DataTable
                  caption="Apparatus tests by type"
                  rowKey={(r) => r.testType}
                  rows={report.apparatusTests.byType}
                  emptyMessage="No apparatus tests recorded in this period."
                  columns={[
                    { key: 'type', header: 'Test', render: (r) => r.testType },
                    { key: 'pass', header: 'Passed', align: 'right', render: (r) => r.passCount },
                    { key: 'fail', header: 'Failed', align: 'right', render: (r) => r.failCount },
                  ]}
                />
              </Card>
              <Card title="Hydrant flow tests">
                <p className={styles.meta}>
                  {report.hydrantFlowTests.currentCount} current ·{' '}
                  {report.hydrantFlowTests.overdueCount} overdue of {report.hydrantFlowTests.count}{' '}
                  due in this period
                </p>
                <DataTable
                  caption="Hydrant flow tests"
                  rowKey={(r) => r.hydrantId}
                  rows={report.hydrantFlowTests.hydrants}
                  emptyMessage="No hydrant flow tests fall due in this period."
                  columns={[
                    { key: 'hydrant', header: 'Hydrant', render: (r) => r.hydrantId },
                    { key: 'due', header: 'Next flow test due', render: (r) => r.nextFlowTestDue },
                    {
                      key: 'current',
                      header: 'Status',
                      render: (r) => (
                        <StatusChip status={r.current ? 'ok' : 'danger'}>
                          {r.current ? 'Current' : 'Overdue'}
                        </StatusChip>
                      ),
                    },
                  ]}
                />
              </Card>
              <Card title="Response times">
                {report.responseTimes.units.length === 0 ? (
                  <p className={styles.meta}>No unit response times in this period.</p>
                ) : (
                  <div className={styles.statGrid}>
                    {summaryStat('Turnout', report.responseTimes.turnout)}
                    {summaryStat('Travel', report.responseTimes.travel)}
                    {summaryStat('Total response', report.responseTimes.total)}
                  </div>
                )}
              </Card>
            </div>
          )}
        </QueryState>
      ) : null}
      <div className={styles.sections}>
        <ExportIfAllowed
          report="iso"
          params={{ from: String(from), to: String(to) }}
          disabled={!range.valid}
        />
      </div>
    </>
  );
}

function MembershipTrendsPanel() {
  const auth = useAuth();
  const range = useDateRange(isoDateDaysAgo(365), todayIsoDate());
  const spanDays =
    (isoDateToEpochSeconds(range.to) - isoDateToEpochSeconds(range.from)) / 86_400 + 1;
  const tooLong = range.valid && spanDays > MAX_TREND_RANGE_DAYS;
  const enabled = range.valid && !tooLong;
  const query = useQuery({
    queryKey: ['reporting', 'membership-trends', range.from, range.to],
    queryFn: () => getMembershipTrends(auth, range.from, range.to),
    enabled,
  });

  return (
    <>
      {range.fields}
      {tooLong ? <p role="alert">Pick a range of at most {MAX_TREND_RANGE_DAYS} days.</p> : null}
      {enabled ? (
        <QueryState query={query}>
          {(trends) =>
            trends.startCount === 0 && trends.endCount === 0 && trends.joins === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="No members on record for this period"
                description="Membership trends are built from each member's join date and status history."
              />
            ) : (
              <>
                <div className={styles.statGrid}>
                  <Stat label="Active at start" value={trends.startCount} />
                  <Stat label="Active at end" value={trends.endCount} />
                  <Stat label="Joined" value={trends.joins} />
                  <Stat label="Departed" value={trends.departures} />
                  <Stat
                    label="Net change"
                    value={trends.netChange > 0 ? `+${trends.netChange}` : trends.netChange}
                  />
                </div>
                <div className={styles.sections}>
                  <DataTable
                    caption="Monthly active members and attendance rate by activity"
                    rowKey={(r) => r.bucket}
                    rows={trends.buckets}
                    columns={[
                      { key: 'month', header: 'Month', render: (r) => r.bucket },
                      {
                        key: 'active',
                        header: 'Active members',
                        align: 'right',
                        render: (r) => r.activeMemberCount,
                      },
                      ...ACTIVITY_TYPES.map((type) => ({
                        key: type,
                        header: type.replace('_', ' ').toLowerCase(),
                        align: 'right' as const,
                        render: (r: (typeof trends.buckets)[number]) =>
                          formatPercent(r.attendanceRateByActivityType[type]),
                      })),
                    ]}
                  />
                </div>
              </>
            )
          }
        </QueryState>
      ) : null}
      <div className={styles.sections}>
        <ExportIfAllowed
          report="membership-trends"
          params={{ startDate: range.from, endDate: range.to }}
          disabled={!enabled}
        />
      </div>
    </>
  );
}

function GrantsPanel() {
  const auth = useAuth();
  const range = useDateRange(`${new Date().getUTCFullYear()}-01-01`, todayIsoDate());
  const periodStart = isoDateToEpochSeconds(range.from) * 1000;
  const periodEnd = (isoDateToEpochSeconds(range.to) + 86_399) * 1000 + 999;
  const query = useQuery({
    queryKey: ['reporting', 'grants', periodStart, periodEnd],
    queryFn: () => getGrantsReport(auth, periodStart, periodEnd),
    enabled: range.valid,
  });

  return (
    <>
      {range.fields}
      {range.valid ? (
        <QueryState query={query}>
          {(report) => (
            <>
              <div className={styles.statGrid}>
                <Stat label="Active members" value={report.activeMemberCount} />
                <Stat
                  label="Joined in period"
                  value={report.memberCountTrend.joinedInPeriod}
                  hint="Counted from join dates"
                />
                <Stat
                  label="Training hours"
                  value={report.trainingHoursCompliance.totalHours}
                  hint={`${report.trainingHoursCompliance.memberCount} members · ${report.trainingHoursCompliance.eventCount} events`}
                />
                <Stat
                  label="Apparatus out-of-service events"
                  value={report.apparatusOutOfServiceHistory.totalOutOfServiceEvents}
                />
                <Stat
                  label="Incident volume"
                  value="Not available"
                  hint="Incident data isn't connected to this report yet."
                />
              </div>
              <div className={styles.sections}>
                <Card title="Apparatus out-of-service history">
                  <DataTable
                    caption="Apparatus out-of-service history"
                    rowKey={(r) => `${r.unitId}-${r.startAt}`}
                    rows={report.apparatusOutOfServiceHistory.records}
                    emptyMessage="No apparatus went out of service in this period."
                    columns={[
                      { key: 'unit', header: 'Unit', render: (r) => r.unitId },
                      { key: 'reason', header: 'Reason', render: (r) => r.reason || '—' },
                      {
                        key: 'start',
                        header: 'Out of service',
                        sortValue: (r) => r.startAt,
                        render: (r) => formatDate(r.startAt),
                      },
                      {
                        key: 'end',
                        header: 'Back in service',
                        render: (r) => (r.endAt === null ? 'Still out' : formatDate(r.endAt)),
                      },
                    ]}
                  />
                </Card>
              </div>
            </>
          )}
        </QueryState>
      ) : null}
      <div className={styles.sections}>
        <ExportIfAllowed
          report="grants"
          params={{ periodStart: String(periodStart), periodEnd: String(periodEnd) }}
          disabled={!range.valid}
        />
      </div>
    </>
  );
}

function LosapYearEndPanel() {
  const auth = useAuth();
  const [yearText, setYearText] = useState(String(new Date().getFullYear()));
  const valid = /^\d{4}$/.test(yearText);
  const year = Number(yearText);
  const query = useQuery({
    queryKey: ['reporting', 'losap', year],
    queryFn: () => getLosapYearEnd(auth, year),
    enabled: valid,
  });

  return (
    <>
      <div className={styles.filters}>
        <TextInput
          label="Year"
          inputMode="numeric"
          value={yearText}
          onChange={(e) => setYearText(e.target.value.trim())}
          error={valid ? undefined : 'Enter a four-digit year.'}
        />
      </div>
      {valid ? (
        <QueryState query={query}>
          {(report) =>
            !report.hasData ? (
              <EmptyState
                icon={ClipboardList}
                title={`No LOSAP points recorded for ${report.year}`}
                description="Points accrue from recorded call, drill and meeting attendance."
              />
            ) : (
              <div className={styles.sections}>
                {report.totalUnreadableEntryCount > 0 ? (
                  <p role="status" className={styles.warning}>
                    {report.totalUnreadableEntryCount} point{' '}
                    {report.totalUnreadableEntryCount === 1 ? 'entry' : 'entries'} could not be read
                    and {report.totalUnreadableEntryCount === 1 ? 'is' : 'are'} not counted in these
                    totals.
                  </p>
                ) : null}
                <DataTable
                  caption={`LOSAP year-end totals for ${report.year}`}
                  rowKey={(r) => r.memberId}
                  rows={report.members}
                  columns={[
                    {
                      key: 'member',
                      header: 'Member',
                      isRowHeader: true,
                      render: (r) => r.memberId,
                    },
                    {
                      key: 'points',
                      header: 'Points',
                      align: 'right',
                      sortValue: (r) => r.totalPoints,
                      render: (r) => r.totalPoints,
                    },
                    {
                      key: 'entries',
                      header: 'Entries',
                      align: 'right',
                      sortValue: (r) => r.entryCount,
                      render: (r) => r.entryCount,
                    },
                    {
                      key: 'unreadable',
                      header: 'Unreadable',
                      align: 'right',
                      render: (r) => r.unreadableEntryCount,
                    },
                  ]}
                />
              </div>
            )
          }
        </QueryState>
      ) : null}
      <div className={styles.sections}>
        <ExportIfAllowed report="losap" params={{ year: yearText }} disabled={!valid} />
      </div>
    </>
  );
}

/**
 * /reporting — the chief/officer reports (F8.1-F8.7). Each tab owns its own filters and query,
 * and Radix unmounts inactive tabs, so only the report on screen is fetched.
 */
export function ReportingPage() {
  return (
    <main id="main-content">
      <PageHeader title="Reporting" />
      <Tabs
        label="Reports"
        items={[
          { value: 'dashboard', label: 'Dashboard', content: <DashboardPanel /> },
          { value: 'response-times', label: 'Response times', content: <ResponseTimesPanel /> },
          { value: 'iso', label: 'ISO', content: <IsoPanel /> },
          {
            value: 'membership-trends',
            label: 'Membership trends',
            content: <MembershipTrendsPanel />,
          },
          { value: 'grants', label: 'Grants', content: <GrantsPanel /> },
          { value: 'losap', label: 'LOSAP year-end', content: <LosapYearEndPanel /> },
        ]}
      />
    </main>
  );
}
