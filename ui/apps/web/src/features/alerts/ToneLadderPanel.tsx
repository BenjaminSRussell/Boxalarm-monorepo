import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, ConfirmDialog, Dialog, Skeleton, Textarea } from '../../components/ui';
import { ApiError } from '../../lib/apiClient';
import {
  acknowledgeMutualAid,
  advanceToneLadder,
  getDispatch,
  haltToneLadder,
  triggerMutualAid,
} from './api';
import type { MutualAid, ToneLadder, TriggerMutualAidResult } from './types';

const REFETCH_INTERVAL_MS = 10_000;
const FINAL_TONE = 3;
const MAX_NOTES_LENGTH = 1000;

type Control = 'advance' | 'halt' | 'trigger' | 'resend' | 'acknowledge';

function formatTime(epochSeconds: number | null): string {
  return epochSeconds === null
    ? 'unknown time'
    : new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** What the officer is told when a control fails - the server's own words where it has them,
 * and never a claim that nothing happened when the outcome is unknown. */
function controlErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const { status, detail } = error.problem;
    if (status === 401) return 'Your session has expired. Sign in again to continue.';
    if (status === 403)
      return 'You are not authorized to use the tone-ladder or mutual-aid controls.';
    if (detail) return detail;
    if (status === 502 || status === 504) {
      return 'The outcome is unknown. Check the ladder and delivery receipts before trying again.';
    }
  }
  return 'Boxalarm did not confirm this request. It may or may not have been received - check the ladder before trying again.';
}

function ladderSummary(ladder: ToneLadder): string {
  if (ladder.status === 'HALTED_MANUAL') {
    return `Halted after tone ${ladder.currentToneSequence}. No further automatic tones, and automatic mutual aid is suppressed.`;
  }
  if (ladder.status === 'COMPLETED' || ladder.currentToneSequence >= FINAL_TONE) {
    return `All ${FINAL_TONE} tones have fired.`;
  }
  // nextToneAt is null once no automatic tone is left - e.g. tone 3 was skipped because enough
  // members responded - so the ladder is not waiting on anything.
  if (ladder.nextToneAt === null) {
    return `Tone ${ladder.currentToneSequence} of ${FINAL_TONE} has fired. No further tone is scheduled to fire automatically - advance by hand if more members are needed.`;
  }
  return `Tone ${ladder.currentToneSequence} of ${FINAL_TONE} has fired. The next tone fires automatically if too few members respond.`;
}

/** What a trigger did - the first request, or a repeat that re-sends only missed prompts. */
function triggerResultMessage(triggered: TriggerMutualAidResult): string {
  const notified = triggered.officersNotified ?? 0;
  if (!triggered.created) {
    return notified > 0
      ? `Mutual aid was already requested. The prompt was re-sent to ${notified} officer(s) who had not received it.`
      : 'Mutual aid was already requested, and every reachable officer has already been prompted.';
  }
  if (notified === 0) {
    return 'Mutual aid recorded, but no officer has a push device registered - make the call now.';
  }
  return `Mutual aid requested. ${notified} officer(s) prompted to make the call.`;
}

function mutualAidReason(reason: string | null): string {
  if (reason === 'MANUAL') return 'requested by an officer';
  if (reason === 'TONE_3_PREDICATE_UNMET') return 'automatic: still short after tone 3';
  return reason ?? 'reason not recorded';
}

function MutualAidSummary({ mutualAid }: { mutualAid: MutualAid | null | undefined }) {
  if (mutualAid === undefined) {
    return <p role="status">Mutual-aid status could not be loaded. It may already be requested.</p>;
  }
  if (mutualAid === null) {
    return <p>Mutual aid has not been requested for this dispatch.</p>;
  }
  return (
    <>
      <p>
        Mutual aid requested at {formatTime(mutualAid.triggeredAt)} (
        {mutualAidReason(mutualAid.reason)}).
      </p>
      {mutualAid.acknowledgedAt !== null ? (
        <p>
          Call confirmed at {formatTime(mutualAid.acknowledgedAt)}
          {mutualAid.acknowledgedBy ? ` by ${mutualAid.acknowledgedBy}` : ''}
          {mutualAid.notes ? `: ${mutualAid.notes}` : '.'}
        </p>
      ) : (
        <p>The mutual-aid call has not been confirmed yet.</p>
      )}
    </>
  );
}

// F1.13/F1.14 (architecture.md §9 /alerts/roster): the department tone ladder's state plus the
// officer-gated Advance / Halt and mutual-aid Trigger / Acknowledge controls. Every control is
// confirmed first, and its result is re-read from the server rather than assumed.
export function ToneLadderPanel({ dispatchId }: { dispatchId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canControl = auth.roles.some((r) => r === 'OFFICER' || r === 'CHIEF' || r === 'ADMIN');
  const [open, setOpen] = useState<Control | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [ackPending, setAckPending] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['alerts', 'dispatch', dispatchId],
    queryFn: () => getDispatch(auth, dispatchId),
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['alerts', 'dispatch', dispatchId] });
    void queryClient.invalidateQueries({ queryKey: ['alerts', 'receipts', dispatchId] });
  };

  /** Runs a control; a failure is rethrown as the message ConfirmDialog shows inline. */
  const run = async (action: () => Promise<string>): Promise<void> => {
    setResult(null);
    try {
      setResult(await action());
    } catch (error) {
      throw new Error(controlErrorMessage(error), { cause: error });
    } finally {
      refresh();
    }
  };

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Tone ladder status is unavailable.</p>
      </ApiForbiddenGate>
    );
  }
  if (!query.data) return <Skeleton lines={2} />;

  const ladder = query.data.toneLadder;
  const mutualAid = query.data.mutualAid;
  const ladderActive =
    ladder !== undefined && ladder.status === 'ACTIVE' && ladder.currentToneSequence < FINAL_TONE;
  const nextTone = ladder ? ladder.currentToneSequence + 1 : null;
  const canAcknowledge =
    mutualAid !== undefined && mutualAid !== null && mutualAid.acknowledgedAt === null;

  return (
    <Card title="Tone ladder and mutual aid" style={{ marginTop: 'var(--bx-space-lg)' }}>
      <section aria-label="Tone ladder">
        {ladder ? (
          <>
            <p>{ladderSummary(ladder)}</p>
            {ladder.nextToneAt !== null && ladderActive ? (
              <p>Next tone check at {formatTime(ladder.nextToneAt)}.</p>
            ) : null}
          </>
        ) : (
          <p role="status">Tone ladder status could not be loaded for this dispatch.</p>
        )}
        {canControl && ladderActive && nextTone !== null ? (
          <div style={{ display: 'flex', gap: 'var(--bx-space-sm)', flexWrap: 'wrap' }}>
            <Button onClick={() => setOpen('advance')}>Advance to tone {nextTone}</Button>
            <Button variant="danger" onClick={() => setOpen('halt')}>
              Halt tone ladder
            </Button>
          </div>
        ) : null}
      </section>

      <section aria-label="Mutual aid" style={{ marginTop: 'var(--bx-space-md)' }}>
        <MutualAidSummary mutualAid={mutualAid} />
        {canControl ? (
          <div style={{ display: 'flex', gap: 'var(--bx-space-sm)', flexWrap: 'wrap' }}>
            {mutualAid === null || mutualAid === undefined ? (
              <Button variant="secondary" onClick={() => setOpen('trigger')}>
                Trigger mutual aid
              </Button>
            ) : null}
            {canAcknowledge ? (
              // The request is recorded, but an officer's prompt may have failed - a repeat
              // trigger re-sends only to officers who did not receive it.
              <Button variant="secondary" onClick={() => setOpen('resend')}>
                Re-send officer prompts
              </Button>
            ) : null}
            {canAcknowledge ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setNotes('');
                  setAckError(null);
                  setOpen('acknowledge');
                }}
              >
                Confirm mutual-aid call made
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      {result ? (
        <p role="status" aria-live="polite" style={{ marginTop: 'var(--bx-space-md)' }}>
          {result}
        </p>
      ) : null}

      {nextTone !== null ? (
        <ConfirmDialog
          open={open === 'advance'}
          onOpenChange={(next) => setOpen(next ? 'advance' : null)}
          title={`Fire tone ${nextTone} now?`}
          consequence={`Every eligible member is paged again now as tone ${nextTone} - push and SMS, then voice if they don't answer - however many have already responded. The scheduled tone ${nextTone} will not fire a second time.`}
          confirmLabel={`Fire tone ${nextTone}`}
          onConfirm={() =>
            run(async () => {
              const fired = await advanceToneLadder(auth, dispatchId, nextTone - 1);
              return `Tone ${fired.toneSequence} sent to every eligible member.`;
            })
          }
        />
      ) : null}

      <ConfirmDialog
        open={open === 'halt'}
        onOpenChange={(next) => setOpen(next ? 'halt' : null)}
        title="Halt the tone ladder?"
        consequence="No further tones fire automatically for this dispatch and mutual aid will not be requested automatically. A tone already being sent is not recalled, and a halted ladder cannot be advanced or resumed - mutual aid can still be triggered by hand."
        confirmLabel="Halt tone ladder"
        danger
        onConfirm={() =>
          run(async () => {
            const halted = await haltToneLadder(auth, dispatchId);
            return halted.changed
              ? `Tone ladder halted after tone ${halted.toneLadder.currentToneSequence}.`
              : 'The tone ladder was already halted.';
          })
        }
      />

      <ConfirmDialog
        open={open === 'trigger'}
        onOpenChange={(next) => setOpen(next ? 'trigger' : null)}
        title="Request mutual aid?"
        consequence="Records a mutual-aid request for this dispatch and pushes a prompt to the department's officers. It does not page the neighboring department - an officer must make that call."
        confirmLabel="Request mutual aid"
        onConfirm={() =>
          run(async () => triggerResultMessage(await triggerMutualAid(auth, dispatchId)))
        }
      />

      <ConfirmDialog
        open={open === 'resend'}
        onOpenChange={(next) => setOpen(next ? 'resend' : null)}
        title="Re-send the mutual-aid prompt?"
        consequence="Pushes the prompt again to any officer who did not receive it. Officers who already received it are not prompted twice."
        confirmLabel="Re-send prompts"
        onConfirm={() =>
          run(async () => triggerResultMessage(await triggerMutualAid(auth, dispatchId)))
        }
      />

      <Dialog
        open={open === 'acknowledge'}
        onOpenChange={(next) => {
          if (ackPending) return;
          setOpen(next ? 'acknowledge' : null);
        }}
        title="Confirm the mutual-aid call was made"
        description="Records that you called the neighboring department. Notes are kept with the alert record - do not enter caller or occupant names."
        footer={
          <>
            {ackError ? (
              <p
                role="alert"
                style={{ color: 'var(--bx-status-danger)', marginRight: 'auto', fontSize: 13 }}
              >
                {ackError}
              </p>
            ) : null}
            <Button variant="secondary" onClick={() => setOpen(null)} disabled={ackPending}>
              Cancel
            </Button>
            <Button
              loading={ackPending}
              onClick={() => {
                if (notes.trim().length > MAX_NOTES_LENGTH) {
                  setAckError(`Notes must be ${MAX_NOTES_LENGTH} characters or fewer.`);
                  return;
                }
                setAckPending(true);
                setAckError(null);
                run(async () => {
                  const acked = await acknowledgeMutualAid(auth, dispatchId, notes);
                  return acked.changed
                    ? 'Mutual-aid call recorded.'
                    : 'You had already confirmed this call; it is unchanged.';
                })
                  .then(() => setOpen(null))
                  .catch((error: unknown) =>
                    setAckError(
                      error instanceof Error ? error.message : controlErrorMessage(error),
                    ),
                  )
                  .finally(() => setAckPending(false));
              }}
            >
              Confirm call made
            </Button>
          </>
        }
      >
        <Textarea
          label="Notes"
          optional
          value={notes}
          maxLength={MAX_NOTES_LENGTH}
          onChange={(e) => setNotes(e.target.value)}
          help="For example: Called Trumbull Center, requested Engine 3."
        />
      </Dialog>
    </Card>
  );
}
