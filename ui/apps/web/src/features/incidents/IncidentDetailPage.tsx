import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button } from '../../components/ui/Button';
import { Badge, StatusChip } from '../../components/ui/Chip';
import { Checkbox, Textarea, TextInput } from '../../components/ui/Field';
import { PageHeader } from '../../components/ui/PageHeader';
import {
  fieldErrorsFromUnknown,
  getIncident,
  getSubmission,
  putExposure,
  putNarrative,
  putResponseTimes,
  retrySubmission,
  submitIncident,
  updateIncident,
} from './api';
import { focusFieldById } from './focusField';
import { coreStrings, dateTimeLocalToEpoch, epochToDateTimeLocal, formatTimestamp } from './format';
import { CORE_SCHEMA, fieldLabel, SECONDARY_SCHEMA, SECONDARY_TYPES } from './nerisSchema';
import type {
  IncidentDetail,
  IncidentSecondary,
  IncidentStatus,
  ResponseUnit,
  SubmissionStatus,
  TimeField,
} from './types';
import { MAX_NARRATIVE_LENGTH, TIME_FIELDS } from './types';
import {
  missingRequiredCoreFields,
  missingRequiredSecondaryFields,
  validateCoreFields,
  validateSecondaryFields,
  type FieldError,
} from './validateEnum';
import styles from './IncidentDetail.module.css';

const FROM_DISPATCH = 'Filled automatically from the dispatch. You can change it.';

const STATUS_ROLE: Record<IncidentStatus, 'neutral' | 'info' | 'warning' | 'ok' | 'danger'> = {
  DRAFT: 'neutral',
  VALIDATED: 'info',
  SUBMITTED: 'warning',
  ACCEPTED: 'ok',
  REJECTED: 'danger',
};

const STATUS_LABEL: Record<IncidentStatus, string> = {
  DRAFT: 'Draft',
  VALIDATED: 'Validated',
  SUBMITTED: 'Submitted',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
};

const SUBMISSION_ROLE: Record<SubmissionStatus, 'neutral' | 'info' | 'warning' | 'ok' | 'danger'> =
  {
    SUBMITTED: 'warning',
    RETRYING: 'warning',
    ACCEPTED: 'ok',
    FAILED: 'danger',
  };

const SUBMISSION_LABEL: Record<SubmissionStatus, string> = {
  SUBMITTED: 'Sent to NERIS, waiting for a response',
  RETRYING: 'Retrying, NERIS has not accepted it yet',
  ACCEPTED: 'Accepted by NERIS',
  FAILED: 'NERIS submission failed',
};

/** While NERIS has not answered, re-read the status so a failure is never silently missed. */
const SUBMISSION_POLL_MS = 15_000;

const TIME_LABEL: Record<TimeField, string> = {
  dispatchedAt: 'Dispatched',
  enRouteAt: 'En route',
  arrivedAt: 'Arrived',
  clearedAt: 'Cleared',
};

const STEPS = [
  { id: 'dispatch', title: 'Dispatch and times' },
  { id: 'location', title: 'Location' },
  { id: 'type', title: 'Incident type and actions' },
  { id: 'units', title: 'Apparatus and personnel' },
  { id: 'narrative', title: 'Narrative' },
  { id: 'exposure', title: 'Exposure and responder safety' },
  { id: 'review', title: 'Review and submit' },
] as const;

type StepId = (typeof STEPS)[number]['id'];

function secondaryTitle(secondaryType: string): string {
  if (secondaryType === 'EXPOSURE') return 'Exposure';
  if (secondaryType === 'RESPONDER_SAFETY') return 'Responder safety';
  return secondaryType;
}

function mergeDetail(current: IncidentDetail, patch: Partial<IncidentDetail>): IncidentDetail {
  return {
    ...current,
    ...patch,
    corePayload: patch.corePayload ?? current.corePayload,
    respondingUnits: patch.respondingUnits ?? current.respondingUnits,
    respondingMembers: patch.respondingMembers ?? current.respondingMembers,
    secondaryModules: patch.secondaryModules ?? current.secondaryModules,
  };
}

function IncidentReport({ incident }: { incident: IncidentDetail }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const steps = STEPS.filter(
    (step) => step.id !== 'exposure' || incident.secondaryModules !== undefined,
  );
  const [step, setStep] = useState(0);
  const [fields, setFields] = useState(() => coreStrings(incident.corePayload));
  const [narrative, setNarrative] = useState(incident.narrative ?? '');
  const [narrativeError, setNarrativeError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [saving, setSaving] = useState(false);
  const [secondaryType, setSecondaryType] = useState<(typeof SECONDARY_TYPES)[number]>('EXPOSURE');
  const [exposureType, setExposureType] = useState('');
  const [injuryType, setInjuryType] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [extraMember, setExtraMember] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const skipInitialFocus = useRef(true);
  const errorTick = useRef(0);
  const [focusErrors, setFocusErrors] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submitted = incident.status !== 'DRAFT' && incident.status !== 'VALIDATED';
  const submissionQuery = useQuery({
    queryKey: ['incident-submission', incident.incidentId],
    queryFn: () => getSubmission(auth, incident.incidentId),
    enabled: submitted,
    refetchInterval: (query) => {
      const status = query.state.data?.submissionStatus;
      return status === 'SUBMITTED' || status === 'RETRYING' ? SUBMISSION_POLL_MS : false;
    },
  });
  const submissionIncidentStatus = submissionQuery.data?.status;

  const active = steps[step] ?? steps[0];
  const missing = missingRequiredCoreFields(CORE_SCHEMA, fields);

  useEffect(() => {
    const filled = [
      incident.address,
      incident.incidentType,
      incident.narrative,
      incident.alarmAt,
      incident.dispatchAt,
    ].filter(Boolean).length;
    setAnnounce(
      `Incident report for ${incident.incidentType ?? 'unclassified'} at ${incident.address ?? 'unknown address'}. ${filled} of 5 fields already filled from the dispatch and the response roster. ${missingRequiredCoreFields(CORE_SCHEMA, coreStrings(incident.corePayload)).length} still needed.`,
    );
  }, [incident]);

  // The worker moves the incident to ACCEPTED/REJECTED; keep the report's status chip in step.
  useEffect(() => {
    if (submissionIncidentStatus && submissionIncidentStatus !== incident.status) {
      queryClient.setQueryData<IncidentDetail>(['incident', incident.incidentId], (current) =>
        current ? { ...current, status: submissionIncidentStatus } : current,
      );
    }
  }, [submissionIncidentStatus, incident.status, incident.incidentId, queryClient]);

  useEffect(() => {
    if (skipInitialFocus.current) {
      skipInitialFocus.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (focusErrors === 0) return;
    const first = errors[0];
    if (first) focusFieldById(`field-${first.field}`);
  }, [focusErrors, errors]);

  function showErrors(next: FieldError[]) {
    errorTick.current += 1;
    setErrors(next);
    setFocusErrors(errorTick.current);
  }

  function selectStep(index: number) {
    const next = steps[index];
    if (!next) return;
    setStep(index);
    setAnnounce(`Step ${index + 1} of ${steps.length}. ${next.title}.`);
  }

  function onStepKeyDown(event: KeyboardEvent<HTMLOListElement>) {
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'ArrowLeft'
    ) {
      return;
    }
    event.preventDefault();
    const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    selectStep((step + delta + steps.length) % steps.length);
  }

  function errorFor(field: string): string | undefined {
    return errors.find((item) => item.field === field)?.message;
  }

  function writeIncident(patch: Partial<IncidentDetail>) {
    queryClient.setQueryData<IncidentDetail>(['incident', incident.incidentId], (current) =>
      current ? mergeDetail(current, patch) : current,
    );
  }

  async function saveCore(keys: string[], advance: boolean) {
    const payload: Record<string, string> = {};
    for (const key of keys) {
      const value = fields[key]?.trim() ?? '';
      if (value) payload[key] = value;
    }
    const clientErrors = validateCoreFields(CORE_SCHEMA, payload);
    if (clientErrors.length > 0) {
      showErrors(clientErrors);
      setAnnounce(
        `${fieldLabel(clientErrors[0]?.field ?? 'field')} ${clientErrors[0]?.message ?? ''}`,
      );
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const updated = await updateIncident(auth, incident.incidentId, { fields: payload });
      writeIncident(updated);
      setFields((current) => ({ ...current, ...coreStrings(updated.corePayload) }));
      setErrors([]);
      if (advance) selectStep(step + 1);
    } catch (error) {
      const serverErrors = fieldErrorsFromUnknown(error);
      if (serverErrors.length > 0) {
        showErrors(serverErrors);
        setAnnounce(
          `${fieldLabel(serverErrors[0]?.field ?? 'field')} ${serverErrors[0]?.message ?? ''}`,
        );
        return;
      }
      setFormError(
        error instanceof ApiError
          ? (error.problem.detail ?? error.problem.title)
          : 'Unable to save the report.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveNarrative() {
    setSaving(true);
    setNarrativeError(null);
    try {
      const updated = await putNarrative(auth, incident.incidentId, narrative);
      writeIncident(updated);
      setNarrative(updated.narrative ?? narrative);
      setAnnounce('Narrative saved.');
    } catch (error) {
      const detail =
        error instanceof ApiError
          ? (error.problem.detail ?? error.problem.title)
          : 'Unable to save the narrative.';
      setNarrativeError(detail);
      setAnnounce(detail);
    } finally {
      setSaving(false);
    }
  }

  async function saveTime(unit: ResponseUnit, field: TimeField) {
    const epoch = dateTimeLocalToEpoch(
      (
        document.getElementById(
          `field-${unit.unitId.replaceAll(' ', '-')}-${field}`,
        ) as HTMLInputElement | null
      )?.value ?? '',
    );
    if (epoch === undefined) return;
    setSaving(true);
    setFormError(null);
    try {
      const saved = await putResponseTimes(auth, incident.incidentId, {
        unitId: unit.unitId,
        unitType: unit.unitType,
        [field]: epoch,
      });
      const units = (incident.respondingUnits ?? []).map((item) =>
        item.unitId === saved.unitId ? { ...item, ...saved } : item,
      );
      writeIncident({ respondingUnits: units });
      setAnnounce(`${TIME_LABEL[field]} saved for ${unit.unitId}.`);
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? (error.problem.detail ?? error.problem.title)
          : 'Unable to save the response time.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function markComplete() {
    const fieldName = secondaryType === 'EXPOSURE' ? 'exposure_type' : 'injury_type';
    const value = (secondaryType === 'EXPOSURE' ? exposureType : injuryType).trim();
    const allowed = SECONDARY_SCHEMA.enumerationsByType[secondaryType]?.[fieldName] ?? [];
    const payload = value ? { [fieldName]: value } : {};
    const clientErrors = validateSecondaryFields(SECONDARY_SCHEMA, secondaryType, payload);
    const nextErrors =
      clientErrors.length > 0
        ? clientErrors
        : value
          ? missingRequiredSecondaryFields(SECONDARY_SCHEMA, secondaryType, payload).map(
              (field) => ({
                field,
                message: `must be one of: ${allowed.join(', ')}`,
              }),
            )
          : [{ field: fieldName, message: `must be one of: ${allowed.join(', ')}` }];
    if (nextErrors.length > 0) {
      showErrors(nextErrors);
      setAnnounce(
        `${fieldLabel(nextErrors[0]?.field ?? fieldName)} ${nextErrors[0]?.message ?? ''}`,
      );
      return;
    }
    const affectedMemberIds = [
      ...selectedMembers,
      ...(extraMember.trim() ? [extraMember.trim()] : []),
    ];
    setSaving(true);
    setFormError(null);
    try {
      const saved = await putExposure(auth, incident.incidentId, {
        secondaryType,
        payload,
        affectedMemberIds,
      });
      const modules = incident.secondaryModules ?? [];
      const replaced: IncidentSecondary[] = [
        ...modules.filter((module) => module.secondaryType !== saved.secondaryType),
        {
          incidentId: saved.incidentId,
          secondaryType: saved.secondaryType,
          payload: saved.payload,
          affectedMemberIds: saved.affectedMemberIds,
          complete: saved.complete,
          updatedAt: saved.updatedAt,
        },
      ];
      writeIncident({ secondaryModules: replaced });
      setErrors([]);
      setExposureType('');
      setInjuryType('');
      setAnnounce(
        saved.complete
          ? `${secondaryTitle(saved.secondaryType)} marked complete.`
          : `${secondaryTitle(saved.secondaryType)} saved. Required fields are still missing.`,
      );
    } catch (error) {
      const serverErrors = fieldErrorsFromUnknown(error);
      if (serverErrors.length > 0) {
        showErrors(serverErrors);
        return;
      }
      setFormError(
        error instanceof ApiError
          ? (error.problem.detail ?? error.problem.title)
          : 'Unable to save the exposure record.',
      );
    } finally {
      setSaving(false);
    }
  }

  function problemText(error: unknown, fallback: string): string {
    return error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : fallback;
  }

  async function submitToNeris() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitIncident(auth, incident.incidentId);
      writeIncident({ status: 'SUBMITTED' });
      await queryClient.invalidateQueries({
        queryKey: ['incident-submission', incident.incidentId],
      });
      setAnnounce('Report sent to NERIS. Waiting for NERIS to accept it.');
    } catch (error) {
      const detail = problemText(error, 'Unable to submit the report to NERIS.');
      setSubmitError(detail);
      setAnnounce(detail);
    } finally {
      setSubmitting(false);
    }
  }

  async function retryNeris() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await retrySubmission(auth, incident.incidentId);
      await queryClient.invalidateQueries({
        queryKey: ['incident-submission', incident.incidentId],
      });
      setAnnounce('Submission queued for retry.');
    } catch (error) {
      const detail = problemText(error, 'Unable to retry the NERIS submission.');
      setSubmitError(detail);
      setAnnounce(detail);
    } finally {
      setSubmitting(false);
    }
  }

  const title = `Incident ${incident.dispatchNumber} — ${incident.incidentType ?? 'Unclassified'} at ${incident.address ?? 'unknown address'}`;

  return (
    <main id="main-content">
      <PageHeader
        title={title}
        breadcrumbs={[{ label: 'Incidents', to: '/incidents' }, { label: incident.dispatchNumber }]}
      />
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>
      <div className={styles.layout}>
        <nav aria-label="Report steps">
          <ol className={styles.steps} onKeyDown={onStepKeyDown}>
            {steps.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={styles.stepButton}
                  aria-current={index === step ? 'step' : undefined}
                  onClick={() => selectStep(index)}
                >
                  {item.title}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section className={styles.panel} aria-labelledby="incident-step-heading">
          <h2 id="incident-step-heading" ref={headingRef} tabIndex={-1}>
            {active?.title}
          </h2>
          <p className={styles.count}>
            Step {(step + 1).toString()} of {steps.length.toString()}. {missing.length.toString()}{' '}
            {missing.length === 1 ? 'issue' : 'issues'} before you can submit.
          </p>
          {formError ? (
            <div role="alert" tabIndex={-1}>
              {formError}
            </div>
          ) : null}
          {active ? <StepBody stepId={active.id} /> : null}
        </section>

        <aside className={styles.issues} aria-label="Validation">
          <h2>Before you can submit</h2>
          <p>
            {missing.length === 0
              ? 'No issues before you can submit.'
              : missing.length === 1
                ? '1 issue before you can submit.'
                : `${missing.length} issues before you can submit.`}
          </p>
          {missing.length > 0 ? (
            <ul>
              {missing.map((field) => (
                <li key={field}>{fieldLabel(field)} is still needed.</li>
              ))}
            </ul>
          ) : null}
        </aside>
      </div>
    </main>
  );

  function StepBody({ stepId }: { stepId: StepId }) {
    if (stepId === 'dispatch') {
      const units = (incident.respondingUnits ?? []).map((unit) => unit.unitId).join(', ');
      const members = (incident.respondingMembers ?? [])
        .map((member) => member.memberId)
        .join(', ');
      return (
        <div className={styles.summary}>
          <div className={styles.mark}>
            <Badge>From dispatch</Badge>
          </div>
          <TextInput label="Address" value={incident.address ?? ''} readOnly help={FROM_DISPATCH} />
          <TextInput
            label="Incident type"
            value={incident.incidentType ?? ''}
            readOnly
            help={FROM_DISPATCH}
          />
          <TextInput
            label="Narrative"
            value={incident.narrative ?? ''}
            readOnly
            help={FROM_DISPATCH}
          />
          <TextInput
            label="Alarm time"
            value={formatTimestamp(incident.alarmAt)}
            readOnly
            help={FROM_DISPATCH}
          />
          <TextInput
            label="Dispatch time"
            value={formatTimestamp(incident.dispatchAt)}
            readOnly
            help={FROM_DISPATCH}
          />
          <TextInput
            label="Responding units"
            value={units || 'None recorded'}
            readOnly
            help="Filled automatically from the response roster."
          />
          <TextInput
            label="Responding members"
            value={members || 'None recorded'}
            readOnly
            help="Filled automatically from the response roster."
          />
          <div className={styles.actions}>
            <Button type="button" onClick={() => selectStep(step + 1)}>
              Continue
            </Button>
          </div>
        </div>
      );
    }

    if (stepId === 'location') {
      return (
        <div className={styles.fields}>
          <TextInput
            id="field-cross_streets"
            label="Cross streets"
            optional
            value={fields.cross_streets ?? ''}
            error={errorFor('cross_streets')}
            onChange={(event) =>
              setFields((current) => ({ ...current, cross_streets: event.target.value }))
            }
          />
          <div className={styles.actions}>
            <Button
              type="button"
              loading={saving}
              onClick={() => void saveCore(['cross_streets'], true)}
            >
              Save and continue
            </Button>
          </div>
        </div>
      );
    }

    if (stepId === 'type') {
      return (
        <div className={styles.fields}>
          <EnumField
            field="incident_type"
            value={fields.incident_type ?? ''}
            onChange={(value) => setFields((current) => ({ ...current, incident_type: value }))}
            error={errorFor('incident_type')}
          />
          <EnumField
            field="action_taken"
            value={fields.action_taken ?? ''}
            onChange={(value) => setFields((current) => ({ ...current, action_taken: value }))}
            error={errorFor('action_taken')}
          />
          <div className={`${styles.actions} ${styles.span}`}>
            <Button
              type="button"
              loading={saving}
              onClick={() => void saveCore(['incident_type', 'action_taken'], true)}
            >
              Save and continue
            </Button>
          </div>
        </div>
      );
    }

    if (stepId === 'units') {
      const units = incident.respondingUnits ?? [];
      return (
        <div className={styles.panel}>
          {units.length === 0 ? (
            <p>
              No responding units are on this report. Units appear from the response roster when the
              report is created from a dispatch.
            </p>
          ) : (
            units.map((unit) => (
              <article
                key={unit.unitId}
                className={styles.unit}
                aria-labelledby={`unit-${unit.unitId}`}
              >
                <h3 id={`unit-${unit.unitId}`} className={styles.mono}>
                  {unit.unitId}
                </h3>
                <p>Assigned position: {(unit.assignedPositions ?? []).join(', ') || '—'}</p>
                <div className={styles.times}>
                  {TIME_FIELDS.map((field) => (
                    <div key={field} className={styles.timeField}>
                      <TextInput
                        id={`field-${unit.unitId.replaceAll(' ', '-')}-${field}`}
                        label={`${TIME_LABEL[field]} for ${unit.unitId}`}
                        type="datetime-local"
                        defaultValue={epochToDateTimeLocal(unit[field])}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void saveTime(unit, field)}
                      >
                        Save {TIME_LABEL[field].toLowerCase()} time for {unit.unitId}
                      </Button>
                    </div>
                  ))}
                </div>
              </article>
            ))
          )}
          <div className={styles.actions}>
            <Button type="button" onClick={() => selectStep(step + 1)}>
              Continue
            </Button>
          </div>
        </div>
      );
    }

    if (stepId === 'narrative') {
      return (
        <div className={styles.panel}>
          <Textarea
            id="field-narrative"
            label="Narrative"
            className={styles.narrative}
            rows={8}
            value={narrative}
            error={narrativeError ?? undefined}
            onChange={(event) => setNarrative(event.target.value)}
          />
          <p className={styles.count} aria-live="polite">
            {narrative.length.toLocaleString()} of {MAX_NARRATIVE_LENGTH.toLocaleString()}{' '}
            characters
          </p>
          <div className={styles.actions}>
            <Button type="button" loading={saving} onClick={() => void saveNarrative()}>
              Save narrative
            </Button>
            <Button type="button" variant="secondary" onClick={() => selectStep(step + 1)}>
              Continue
            </Button>
          </div>
        </div>
      );
    }

    if (stepId === 'exposure') {
      const modules = incident.secondaryModules ?? [];
      const fieldName = secondaryType === 'EXPOSURE' ? 'exposure_type' : 'injury_type';
      const value = secondaryType === 'EXPOSURE' ? exposureType : injuryType;
      const setValue = secondaryType === 'EXPOSURE' ? setExposureType : setInjuryType;
      return (
        <div className={styles.panel}>
          {modules.length === 0 ? (
            <p>No exposure or responder-safety records yet.</p>
          ) : (
            <ul className={styles.moduleList}>
              {modules.map((module) => (
                <li key={module.secondaryType} className={styles.module}>
                  <h3>{secondaryTitle(module.secondaryType)}</h3>
                  <p>Affected members: {module.affectedMemberIds.join(', ') || 'None'}</p>
                  <StatusChip status={module.complete ? 'ok' : 'warning'}>
                    {module.complete ? 'Complete' : 'Incomplete'}
                  </StatusChip>
                </li>
              ))}
            </ul>
          )}
          <TextInput
            label="Module"
            value={secondaryType}
            list="secondary-types"
            onChange={(event) => {
              const next = event.target.value;
              if (next === 'EXPOSURE' || next === 'RESPONDER_SAFETY') setSecondaryType(next);
              else setSecondaryType(next as (typeof SECONDARY_TYPES)[number]);
            }}
          />
          <datalist id="secondary-types">
            {SECONDARY_TYPES.map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
          <EnumField
            field={fieldName}
            schema="secondary"
            secondaryType={secondaryType}
            value={value}
            error={errorFor(fieldName)}
            onChange={setValue}
          />
          <fieldset className={styles.panel}>
            <legend>Affected members</legend>
            {(incident.respondingMembers ?? []).map((member) => (
              <Checkbox
                key={member.memberId}
                label={member.memberId}
                checked={selectedMembers.includes(member.memberId)}
                onCheckedChange={(checked) =>
                  setSelectedMembers((current) =>
                    checked
                      ? [...current, member.memberId]
                      : current.filter((id) => id !== member.memberId),
                  )
                }
              />
            ))}
            <TextInput
              label="Additional member"
              optional
              value={extraMember}
              onChange={(event) => setExtraMember(event.target.value)}
            />
          </fieldset>
          <div className={styles.actions}>
            <Button type="button" loading={saving} onClick={() => void markComplete()}>
              Mark complete
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className={styles.panel}>
        <p>
          Report status:{' '}
          <StatusChip status={STATUS_ROLE[incident.status]}>
            {STATUS_LABEL[incident.status]}
          </StatusChip>
        </p>
        {submitError ? <p role="alert">{submitError}</p> : null}
        {submitted ? (
          <SubmissionPanel />
        ) : (
          <>
            <p id="submit-status">
              {incident.status === 'VALIDATED'
                ? 'Report status is Validated. Submit is available.'
                : 'Submit stays unavailable until the report status is Validated.'}
            </p>
            <Button
              type="button"
              disabled={incident.status !== 'VALIDATED'}
              loading={submitting}
              aria-describedby="submit-status"
              onClick={() => void submitToNeris()}
            >
              Submit
            </Button>
          </>
        )}
      </div>
    );
  }

  function SubmissionPanel() {
    if (submissionQuery.isLoading) {
      return <p aria-busy="true">Checking the NERIS submission status.</p>;
    }
    if (submissionQuery.error) {
      const forbidden =
        submissionQuery.error instanceof ApiError && submissionQuery.error.problem.status === 403;
      return (
        <p role={forbidden ? undefined : 'alert'}>
          {forbidden
            ? 'Only officers, admins and chiefs can see the NERIS submission status.'
            : 'Unable to read the NERIS submission status.'}
        </p>
      );
    }
    const state = submissionQuery.data;
    const status = state?.submissionStatus ?? null;
    return (
      <div aria-live="polite">
        <p>
          NERIS submission:{' '}
          {status ? (
            <StatusChip status={SUBMISSION_ROLE[status]}>{SUBMISSION_LABEL[status]}</StatusChip>
          ) : (
            'Not sent to NERIS.'
          )}
        </p>
        {status === 'FAILED' ? (
          <>
            <p>Reason: {state?.submissionFailureReason ?? 'NERIS did not give a reason.'}</p>
            <Button type="button" loading={submitting} onClick={() => void retryNeris()}>
              Retry submission
            </Button>
          </>
        ) : null}
      </div>
    );
  }
}

function EnumField({
  field,
  value,
  onChange,
  error,
  schema = 'core',
  secondaryType,
}: {
  field: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  schema?: 'core' | 'secondary';
  secondaryType?: string;
}) {
  const allowed =
    schema === 'secondary'
      ? (SECONDARY_SCHEMA.enumerationsByType[secondaryType ?? '']?.[field] ?? [])
      : (CORE_SCHEMA.enumerations[field] ?? []);
  return (
    <>
      <TextInput
        id={`field-${field}`}
        label={fieldLabel(field)}
        value={value}
        list={`${field}-codes`}
        autoComplete="off"
        error={error}
        help={`Allowed values: ${allowed.join(', ')}`}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={`${field}-codes`}>
        {allowed.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>
    </>
  );
}

export function IncidentDetailPage() {
  const auth = useAuth();
  const { id = '' } = useParams();
  const incidentQuery = useQuery({
    queryKey: ['incident', id],
    queryFn: () => getIncident(auth, id),
    enabled: id.length > 0,
  });

  if (incidentQuery.isLoading) {
    return (
      <main id="main-content" aria-busy="true">
        <h1>Incident report</h1>
        <p>Loading the report.</p>
      </main>
    );
  }

  if (incidentQuery.error || !incidentQuery.data) {
    return (
      <ApiForbiddenGate error={incidentQuery.error ?? new Error('missing')}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  return <IncidentReport key={incidentQuery.data.incidentId} incident={incidentQuery.data} />;
}
