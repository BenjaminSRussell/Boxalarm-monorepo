import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StatusRole } from '@boxalarm/design-tokens';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, PageHeader, Skeleton, StatusChip, TextInput } from '../../components/ui';
import { approveShiftSwap, createShift, getShiftCoverage, listShifts } from './api';
import type { CoverageStatus, CreateShiftPosition } from './types';

const COVERAGE_STATUS: Record<CoverageStatus, StatusRole> = {
  covered: 'ok',
  short: 'warning',
  'qual-gapped': 'danger',
};

const COVERAGE_WORD: Record<CoverageStatus, string> = {
  covered: 'Covered',
  short: 'Short',
  'qual-gapped': 'Missing qual',
};

// DUTY_SHIFT.startAt/endAt are epoch MILLISECONDS (personnel-service shifts/
// completeShiftAttendance.ts; coverage and claim compare them with Date.now()). Sending
// seconds made every web-created shift read as 1970 — never in coverage, never completable.
function toEpochMillis(localDateTime: string): number {
  return new Date(localDateTime).getTime();
}

const emptyPosition: CreateShiftPosition = { positionCode: '', requiredQual: '' };

function CreateShiftForm({ onCreated }: { onCreated: () => void }) {
  const auth = useAuth();
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [stationId, setStationId] = useState('');
  const [positions, setPositions] = useState<CreateShiftPosition[]>([
    { ...emptyPosition },
    { ...emptyPosition },
  ]);

  const createMutation = useMutation({
    mutationFn: () =>
      createShift(auth, {
        startAt: toEpochMillis(startAt),
        endAt: toEpochMillis(endAt),
        stationId,
        positions: positions
          .filter((position) => position.positionCode.trim().length > 0)
          .map((position) =>
            position.requiredQual?.trim()
              ? { positionCode: position.positionCode, requiredQual: position.requiredQual }
              : { positionCode: position.positionCode },
          ),
      }),
    onSuccess: () => {
      setStartAt('');
      setEndAt('');
      setStationId('');
      setPositions([{ ...emptyPosition }, { ...emptyPosition }]);
      onCreated();
    },
  });

  return (
    <Card title="New shift" style={{ marginTop: 'var(--bx-space-xl)', maxWidth: 480 }}>
      <form
        aria-label="New shift"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          createMutation.mutate();
        }}
        style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
      >
        <TextInput
          label="Start"
          type="datetime-local"
          value={startAt}
          onChange={(e) => setStartAt(e.target.value)}
          required
        />
        <TextInput
          label="End"
          type="datetime-local"
          value={endAt}
          onChange={(e) => setEndAt(e.target.value)}
          required
        />
        <TextInput
          label="Station ID"
          value={stationId}
          onChange={(e) => setStationId(e.target.value)}
          required
        />
        {positions.map((position, index) => (
          <fieldset
            key={index}
            style={{ display: 'flex', gap: 'var(--bx-space-sm)', border: 'none', padding: 0 }}
          >
            <legend>Position {index + 1}</legend>
            <TextInput
              label="Position code"
              value={position.positionCode}
              onChange={(e) =>
                setPositions((prev) =>
                  prev.map((p, i) => (i === index ? { ...p, positionCode: e.target.value } : p)),
                )
              }
            />
            <TextInput
              label="Required qual"
              optional
              value={position.requiredQual ?? ''}
              onChange={(e) =>
                setPositions((prev) =>
                  prev.map((p, i) => (i === index ? { ...p, requiredQual: e.target.value } : p)),
                )
              }
            />
          </fieldset>
        ))}
        {createMutation.error ? (
          <p role="alert" aria-live="assertive">
            {createMutation.error.message}
          </p>
        ) : null}
        <Button type="submit" loading={createMutation.isPending}>
          Create shift
        </Button>
      </form>
    </Card>
  );
}

function CoverageSection() {
  const auth = useAuth();
  const coverageQuery = useQuery({
    queryKey: ['schedule', 'coverage'],
    queryFn: () => getShiftCoverage(auth),
  });

  if (coverageQuery.error) {
    return (
      <ApiForbiddenGate error={coverageQuery.error} embedded>
        <p>Unable to load coverage.</p>
      </ApiForbiddenGate>
    );
  }

  return (
    <Card title="Coverage" style={{ marginTop: 'var(--bx-space-xl)' }}>
      {coverageQuery.isLoading ? (
        <Skeleton lines={3} />
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {(coverageQuery.data ?? []).map((shift) => (
            <li key={shift.shiftId} style={{ padding: 'var(--bx-space-sm) 0' }}>
              <strong>{shift.stationId}</strong>{' '}
              <StatusChip status={COVERAGE_STATUS[shift.status]}>
                {COVERAGE_WORD[shift.status]}
              </StatusChip>
              <ul style={{ listStyle: 'none', paddingLeft: 'var(--bx-space-md)' }}>
                {shift.positions
                  .filter((position) => position.status !== 'covered')
                  .map((position) => (
                    <li key={position.positionCode}>
                      {position.positionCode} —{' '}
                      <StatusChip status={COVERAGE_STATUS[position.status]}>
                        {COVERAGE_WORD[position.status]}
                      </StatusChip>
                      {position.status === 'qual-gapped' && position.requiredQual
                        ? ` (${position.requiredQual})`
                        : ''}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SwapApprovalForm() {
  const auth = useAuth();
  const [shiftId, setShiftId] = useState('');
  const [swapId, setSwapId] = useState('');
  const approveMutation = useMutation({
    mutationFn: () => approveShiftSwap(auth, shiftId, swapId),
    onSuccess: () => {
      setShiftId('');
      setSwapId('');
    },
  });

  return (
    <Card title="Approve shift swap" style={{ marginTop: 'var(--bx-space-xl)' }}>
      <form
        aria-label="Approve shift swap"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          approveMutation.mutate();
        }}
        style={{ display: 'flex', gap: 'var(--bx-space-sm)', alignItems: 'end' }}
      >
        <TextInput
          label="Shift ID"
          value={shiftId}
          onChange={(e) => setShiftId(e.target.value)}
          required
        />
        <TextInput
          label="Swap ID"
          value={swapId}
          onChange={(e) => setSwapId(e.target.value)}
          required
        />
        <Button type="submit" loading={approveMutation.isPending}>
          Approve
        </Button>
      </form>
      {approveMutation.error ? (
        <p role="alert" aria-live="assertive">
          {approveMutation.error.message}
        </p>
      ) : null}
      {approveMutation.isSuccess ? <p role="status">Swap approved.</p> : null}
    </Card>
  );
}

export function SchedulePage() {
  const auth = useAuth();
  const queryClient = useQueryClient();

  const shiftsQuery = useQuery({
    queryKey: ['schedule', 'shifts'],
    queryFn: () => listShifts(auth),
  });

  if (shiftsQuery.error) {
    return (
      <ApiForbiddenGate error={shiftsQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  return (
    <main id="main-content">
      <PageHeader title="Schedule" />

      {shiftsQuery.isLoading ? (
        <Skeleton lines={4} />
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {(shiftsQuery.data ?? []).map((shift) => (
            <li key={shift.shiftId} style={{ padding: 'var(--bx-space-sm) 0' }}>
              <strong>{shift.stationId}</strong> — {new Date(shift.startAt).toLocaleString()} —{' '}
              {shift.status}
            </li>
          ))}
        </ul>
      )}

      <CreateShiftForm
        onCreated={() => void queryClient.invalidateQueries({ queryKey: ['schedule', 'shifts'] })}
      />
      <CoverageSection />
      <SwapApprovalForm />
    </main>
  );
}
