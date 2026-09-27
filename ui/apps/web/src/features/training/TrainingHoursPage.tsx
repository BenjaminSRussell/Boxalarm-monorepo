import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Card, DataTable, DatePicker, PageHeader, type DataTableColumn } from '../../components/ui';
import { canAccessPath } from '../../routing/routeTable';
import { listMembers } from '../personnel/api';
import { getRosterTrainingHours } from './api';
import type { CategoryHours } from './types';

interface MemberRow {
  memberId: string;
  name: string;
  byCategory: Map<string, number>;
  total: number;
}

function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DD` local date -> epoch ms at local midnight, or null when not a valid date. */
function startOfLocalDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const ms = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isNaN(ms) ? null : ms;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function sumHours(categories: readonly CategoryHours[]): number {
  return categories.reduce((total, c) => total + c.hours, 0);
}

// P1 #12: department training hours by member and category (F3.5 / AP 26), from the deployed
// GET training/hours roster view. The handler takes an epoch-millisecond [from, to] range over
// training event start times; the default range is the calendar year to date.
export function TrainingHoursPage() {
  const auth = useAuth();
  const today = new Date();
  const [fromDate, setFromDate] = useState(toDateInput(new Date(today.getFullYear(), 0, 1)));
  const [toDate, setToDate] = useState(toDateInput(today));

  const from = startOfLocalDay(fromDate);
  const toStart = startOfLocalDay(toDate);
  // Inclusive of the whole "to" day.
  const to = toStart === null ? null : toStart + DAY_MS - 1;
  const rangeValid = from !== null && to !== null && from <= to;

  const hoursQuery = useQuery({
    queryKey: ['training', 'hours', from, to],
    queryFn: () => getRosterTrainingHours(auth, from!, to!),
    enabled: rangeValid,
  });
  // Names are a convenience; the table still renders member IDs if the roster can't load.
  const canViewMembers = canAccessPath('/personnel', auth.roles);
  const membersQuery = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
    enabled: canViewMembers,
  });

  if (hoursQuery.error) {
    return (
      <ApiForbiddenGate error={hoursQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const members = hoursQuery.data?.members ?? [];
  const categories = [...new Set(members.flatMap((m) => m.categories.map((c) => c.category)))].sort(
    (a, b) => a.localeCompare(b),
  );
  const rows: MemberRow[] = members.map((m) => {
    const member = membersQuery.data?.find((x) => x.memberId === m.memberId);
    return {
      memberId: m.memberId,
      name: member ? `${member.firstName} ${member.lastName}` : m.memberId,
      byCategory: new Map(m.categories.map((c) => [c.category, c.hours])),
      total: sumHours(m.categories),
    };
  });
  const columns: DataTableColumn<MemberRow>[] = [
    {
      key: 'member',
      header: 'Member',
      render: (row) => row.name,
      sortValue: (row) => row.name,
      isRowHeader: true,
    },
    ...categories.map((category): DataTableColumn<MemberRow> => ({
      key: `cat-${category}`,
      header: category,
      render: (row) => formatHours(row.byCategory.get(category) ?? 0),
      sortValue: (row) => row.byCategory.get(category) ?? 0,
      align: 'right',
    })),
    {
      key: 'total',
      header: 'Total hours',
      render: (row) => formatHours(row.total),
      sortValue: (row) => row.total,
      align: 'right',
    },
  ];

  return (
    <main id="main-content">
      <PageHeader title="Training hours" />
      <Card>
        <form
          aria-label="Date range"
          onSubmit={(e) => e.preventDefault()}
          style={{ display: 'flex', gap: 'var(--bx-space-md)', flexWrap: 'wrap' }}
        >
          <DatePicker label="From" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <DatePicker label="To" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </form>
        {!rangeValid ? <p role="alert">Choose a start date on or before the end date.</p> : null}
      </Card>

      {rangeValid ? (
        <div style={{ marginTop: 'var(--bx-space-lg)' }}>
          <DataTable
            caption="Training hours by member and category"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.memberId}
            loading={hoursQuery.isLoading}
            emptyMessage={`No training hours were recorded for events between ${fromDate} and ${toDate}.`}
          />
        </div>
      ) : null}
    </main>
  );
}
