import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  TextInput,
} from '../../components/ui';
import {
  assignRidingSeat,
  getDispatch,
  getReceipts,
  getRidingBoard,
  getRoster,
  submitManualDispatch,
} from './api';
import { PrePlanPanel } from './PrePlanPanel';
import type { DeliveryReceipt, FieldError, ManualDispatchInput, RosterEntry } from './types';

const REFETCH_INTERVAL_MS = 10_000;
const RECEIPT_CHANNELS = ['push', 'sms', 'voice'];

const EMPTY_FORM: ManualDispatchInput = {
  incidentType: '',
  address: '',
  crossStreets: '',
  unitsRequested: [],
  narrative: '',
  externalDispatchId: '',
};

function ackLabel(status: RosterEntry['ackStatus']): string {
  if (status === 'RESPONDING') return 'Responding';
  if (status === 'DIRECT_TO_SCENE') return 'Direct to scene';
  if (status === 'NOT_RESPONDING') return 'Not responding';
  return 'Awaiting response';
}

function ManualEntryForm({ onCreated }: { onCreated: (dispatchId: string) => void }) {
  const auth = useAuth();
  const [form, setForm] = useState<ManualDispatchInput>(EMPTY_FORM);
  const [unitsText, setUnitsText] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: ManualDispatchInput) => submitManualDispatch(auth, input),
    onSuccess: ({ dispatchId }) => {
      setForm(EMPTY_FORM);
      setUnitsText('');
      setFieldErrors([]);
      setFormError(null);
      onCreated(dispatchId);
    },
    onError: (error: unknown) => {
      const problem = (
        error as { problem?: { status?: number; detail?: string; errors?: FieldError[] } }
      ).problem;
      if (problem?.status === 409) {
        setFormError('This dispatch was already entered. It has not been resubmitted.');
      } else if (problem?.errors) {
        setFieldErrors(problem.errors);
      } else {
        setFormError(problem?.detail ?? 'Could not submit the dispatch.');
      }
    },
  });

  const errorFor = (field: string) => fieldErrors.find((e) => e.field === field)?.message;

  return (
    <Card
      title="Enter dispatch manually"
      style={{ maxWidth: 480, marginBottom: 'var(--bx-space-xl)' }}
    >
      <form
        aria-label="Enter dispatch manually"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          mutation.mutate({
            ...form,
            unitsRequested: unitsText
              .split(',')
              .map((u) => u.trim())
              .filter(Boolean),
          });
        }}
        style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
      >
        {(
          [
            ['incidentType', 'Incident type'],
            ['address', 'Address'],
            ['crossStreets', 'Cross streets'],
          ] as const
        ).map(([key, label]) => (
          <TextInput
            key={key}
            label={label}
            required
            value={form[key]}
            onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
            error={errorFor(key)}
          />
        ))}
        <TextInput
          label="Units requested (comma separated)"
          optional
          value={unitsText}
          onChange={(e) => setUnitsText(e.target.value)}
        />
        <Textarea
          label="Narrative"
          required
          value={form.narrative}
          onChange={(e) => setForm((prev) => ({ ...prev, narrative: e.target.value }))}
          error={errorFor('narrative')}
        />
        <TextInput
          label="Operator-entered reference"
          required
          value={form.externalDispatchId}
          onChange={(e) => setForm((prev) => ({ ...prev, externalDispatchId: e.target.value }))}
          error={errorFor('externalDispatchId')}
        />
        {formError ? (
          <p role="alert" aria-live="assertive">
            {formError}
          </p>
        ) : null}
        <Button type="submit" loading={mutation.isPending}>
          {mutation.isPending ? 'Submitting…' : 'Submit dispatch'}
        </Button>
      </form>
    </Card>
  );
}

function ReceiptsTable({ dispatchId }: { dispatchId: string }) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerts', 'receipts', dispatchId],
    queryFn: () => getReceipts(auth, dispatchId),
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Receipts are unavailable.</p>
      </ApiForbiddenGate>
    );
  }

  const byMember = new Map<string, Map<string, DeliveryReceipt>>();
  for (const receipt of query.data ?? []) {
    const row = byMember.get(receipt.memberId) ?? new Map();
    row.set(receipt.channel.toLowerCase(), receipt);
    byMember.set(receipt.memberId, row);
  }

  return (
    <Card title="Delivery receipts" style={{ marginTop: 'var(--bx-space-lg)' }}>
      <div role="region" aria-label="Delivery receipts" tabIndex={0} style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <caption className="visually-hidden">Delivery receipts</caption>
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left' }}>
                Member
              </th>
              {RECEIPT_CHANNELS.map((channel) => (
                <th key={channel} scope="col" style={{ textAlign: 'left' }}>
                  {channel.toUpperCase()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...byMember.entries()].map(([memberId, channels]) => (
              <tr key={memberId}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                  {memberId}
                </th>
                {RECEIPT_CHANNELS.map((channel) => {
                  const receipt = channels.get(channel);
                  const label = !receipt
                    ? '—'
                    : receipt.status === 'SENT_UNCONFIRMED'
                      ? 'Sent, not confirmed delivered'
                      : receipt.status.charAt(0) + receipt.status.slice(1).toLowerCase();
                  return <td key={channel}>{label}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RosterTable({ dispatchId }: { dispatchId: string }) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerts', 'roster', dispatchId],
    queryFn: () => getRoster(auth, dispatchId),
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Roster is unavailable.</p>
      </ApiForbiddenGate>
    );
  }

  return (
    <Card title="Live roster">
      <div role="region" aria-label="Live roster" tabIndex={0} style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <caption className="visually-hidden">Live roster</caption>
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left' }}>
                Member
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Status
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Quals
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Assigned
              </th>
            </tr>
          </thead>
          <tbody>
            {(query.data ?? []).map((entry) => (
              <tr key={entry.memberId}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                  {entry.name}
                </th>
                <td>{ackLabel(entry.ackStatus)}</td>
                <td>{entry.quals.join(', ')}</td>
                <td>{entry.assignedApparatusId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RidingBoardSection({ dispatchId }: { dispatchId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [assignError, setAssignError] = useState<string | null>(null);
  const boardQuery = useQuery({
    queryKey: ['alerts', 'riding-board', dispatchId],
    queryFn: () => getRidingBoard(auth, dispatchId),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const rosterQuery = useQuery({
    queryKey: ['alerts', 'roster', dispatchId],
    queryFn: () => getRoster(auth, dispatchId),
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  const assignMutation = useMutation({
    mutationFn: (input: {
      unitId: string;
      positionCode: string;
      memberId: string | null;
      expectedVersion: number;
    }) => assignRidingSeat(auth, dispatchId, input),
    onSuccess: () => setAssignError(null),
    onError: (error: unknown) => {
      // Mirrors ManualEntryForm's error branching above: a failed seat assignment must not
      // fail silently - the officer needs to know whether it was a version conflict (another
      // officer just assigned this seat), an auth problem, or something else, since the
      // <select>'s value only re-syncs from query data on the next successful render.
      const problem = (error as { problem?: { status?: number; detail?: string } }).problem;
      if (problem?.status === 409) {
        setAssignError('This seat was changed by another officer. The board has been refreshed.');
      } else if (problem?.status === 401) {
        setAssignError('Your session has expired. Sign in again to continue.');
      } else if (problem?.status === 403) {
        setAssignError('You are not authorized to assign riding-board seats.');
      } else {
        setAssignError(
          problem?.detail ?? 'Could not update the assignment. The board has been refreshed.',
        );
      }
    },
    onSettled: () => {
      // Explicitly reconcile the board either way - on success the new assignment should show,
      // and on failure the <select> must be pulled back to the server's actual value rather
      // than silently keeping whatever the user last picked.
      void queryClient.invalidateQueries({ queryKey: ['alerts', 'riding-board', dispatchId] });
    },
  });

  if (boardQuery.error) {
    return (
      <ApiForbiddenGate error={boardQuery.error} embedded>
        <p>Riding board is unavailable.</p>
      </ApiForbiddenGate>
    );
  }

  const assignable = (rosterQuery.data ?? []).filter(
    (entry) => entry.ackStatus === 'RESPONDING' || entry.ackStatus === 'DIRECT_TO_SCENE',
  );

  return (
    <Card title="Riding board" style={{ marginTop: 'var(--bx-space-lg)' }}>
      {assignError ? (
        <p role="alert" aria-live="assertive" style={{ color: 'var(--bx-status-danger)' }}>
          {assignError}
        </p>
      ) : null}
      {(boardQuery.data?.apparatus ?? []).map((unit) => (
        <div key={unit.apparatusId} style={{ marginBottom: 'var(--bx-space-md)' }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{unit.unitId}</h3>
          {!unit.assignable ? (
            <p style={{ color: 'var(--bx-status-danger)' }}>
              Out of service{unit.outOfServiceReason ? `: ${unit.outOfServiceReason}` : ''}
            </p>
          ) : null}
          <ul>
            {unit.positions.map((position) => (
              <li key={position.code}>
                <Select
                  label={`${position.label}${position.assignment?.qualStatus === 'UNMET' ? ' (missing qualification)' : ''}`}
                  disabled={!unit.assignable}
                  value={position.assignment?.memberId ?? ''}
                  onChange={(e) =>
                    assignMutation.mutate({
                      unitId: unit.unitId,
                      positionCode: position.code,
                      memberId: e.target.value || null,
                      expectedVersion: position.assignment?.version ?? 0,
                    })
                  }
                >
                  <option value="">Unassigned</option>
                  {assignable.map((member) => (
                    <option key={member.memberId} value={member.memberId}>
                      {member.name}
                      {member.ackStatus === 'DIRECT_TO_SCENE' ? ' (direct to scene)' : ''}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}

function DispatchHeader({ dispatchId }: { dispatchId: string }) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerts', 'dispatch', dispatchId],
    queryFn: () => getDispatch(auth, dispatchId),
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Dispatch details are unavailable.</p>
      </ApiForbiddenGate>
    );
  }
  if (!query.data) return <Skeleton lines={3} />;

  return (
    <Card>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{query.data.incidentType}</h2>
      <p>{query.data.address}</p>
      {query.data.crossStreets ? <p>Cross streets: {query.data.crossStreets}</p> : null}
      {query.data.mapLink ? (
        <a href={query.data.mapLink} target="_blank" rel="noreferrer">
          Open in maps
        </a>
      ) : null}
      <p>{query.data.narrative}</p>
      <PrePlanPanel prePlan={query.data.prePlan} />
    </Card>
  );
}

// E1-S1-UI, E1-S4-UI, E1-S5-UI, E1-S6-UI, E1-S17-UI, E5-S8-UI, E1-S18-UI: one screen (/alerts/roster
// per the existing route table) - dispatch header + pre-plan, live roster, delivery receipts, and
// the riding board, plus the manual-entry fallback that lands here on submit. The dispatchId is
// kept in the URL (?dispatchId=); the dashboard's active-call tile links here with it set.
export function AlertsRosterPage() {
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const dispatchId = searchParams.get('dispatchId');
  // Route access is OFFICER/CHIEF only (routeTable.ts) - ADMIN is not currently granted
  // /alerts/roster, so it never reaches this check; see PR notes on the ticket's "officer,
  // chief, admin" text vs. the existing, tested route-guard invariant.
  const canEnterManually = auth.roles.some((r) => r === 'OFFICER' || r === 'CHIEF');

  return (
    <main id="main-content">
      <PageHeader title={!dispatchId ? 'Live roster' : 'Alert'} />

      {canEnterManually ? (
        <ManualEntryForm onCreated={(id) => setSearchParams({ dispatchId: id })} />
      ) : null}

      <TextInput
        label="Dispatch ID"
        defaultValue={dispatchId ?? ''}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const value = (e.target as HTMLInputElement).value.trim();
          if (value) setSearchParams({ dispatchId: value });
        }}
        style={{ maxWidth: 320, marginBottom: 'var(--bx-space-lg)' }}
      />

      {dispatchId ? (
        <>
          <DispatchHeader dispatchId={dispatchId} />
          <RosterTable dispatchId={dispatchId} />
          <ReceiptsTable dispatchId={dispatchId} />
          <RidingBoardSection dispatchId={dispatchId} />
        </>
      ) : (
        <p>Enter a dispatch ID to see its roster, receipts, and riding board.</p>
      )}
    </main>
  );
}
