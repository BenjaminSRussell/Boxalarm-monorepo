import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ForbiddenState } from '../../components/ForbiddenState';
import { ApiError } from '../../lib/apiClient';
import { Button, Card, Select } from '../../components/ui';
import { getReportExportStatus, startReportExport } from './api';
import type { ExportFormat, ReportName } from './types';
import styles from './ReportingPage.module.css';

const EXPORT_POLL_INTERVAL_MS = 3_000;

/**
 * CSV/PDF export of one report with the parameters currently on screen (F8.7). The backend
 * accepts and queues (202) and a worker renders the file; this polls the job until it is
 * COMPLETED (signed download link) or FAILED (shown, never hidden).
 */
export function ReportExport({
  report,
  params,
  disabled = false,
}: {
  report: ReportName;
  /** The report's own query parameters, exactly as its GET route takes them. */
  params: Record<string, string>;
  /** True while the on-screen parameters are invalid — nothing to export yet. */
  disabled?: boolean;
}) {
  const auth = useAuth();
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [jobId, setJobId] = useState<string | null>(null);
  const [queuedFailed, setQueuedFailed] = useState(false);

  const start = useMutation({
    mutationFn: () => startReportExport(auth, report, format, params),
    onSuccess: (accepted) => {
      setQueuedFailed(accepted.status === 'FAILED');
      setJobId(accepted.status === 'FAILED' ? null : accepted.jobId);
    },
  });

  const status = useQuery({
    queryKey: ['reporting', 'export', jobId],
    queryFn: () => getReportExportStatus(auth, jobId as string),
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === 'PENDING' ? EXPORT_POLL_INTERVAL_MS : false,
  });

  function handleExport() {
    setJobId(null);
    setQueuedFailed(false);
    start.mutate();
  }

  const job = status.data;
  const startForbidden = start.error instanceof ApiError && start.error.problem.status === 403;

  return (
    <Card title="Export">
      <div className={styles.exportRow}>
        <Select
          label="Format"
          value={format}
          onChange={(e) => setFormat(e.target.value as ExportFormat)}
        >
          <option value="csv">CSV</option>
          <option value="pdf">PDF</option>
        </Select>
        <Button
          type="button"
          onClick={handleExport}
          loading={start.isPending}
          disabled={disabled}
          variant="secondary"
        >
          Export {format.toUpperCase()}
        </Button>
      </div>
      {startForbidden ? (
        <ForbiddenState embedded headingLevel="h2" />
      ) : start.isError ? (
        <p role="alert">Could not start the export. Try again.</p>
      ) : null}
      {queuedFailed ? <p role="alert">The export could not be queued. Try again.</p> : null}
      {jobId && status.isError ? (
        <p role="alert">Could not check the export&apos;s status. Try again.</p>
      ) : jobId && job?.status === 'FAILED' ? (
        <p role="alert">The export failed. Try again.</p>
      ) : jobId && job?.status === 'COMPLETED' && job.downloadUrl ? (
        <p role="status">
          <a href={job.downloadUrl} download>
            Download {job.format.toUpperCase()}
          </a>{' '}
          <span className={styles.meta}>(link expires 15 minutes after it was issued)</span>
        </p>
      ) : jobId ? (
        <p role="status">Export in progress…</p>
      ) : null}
    </Card>
  );
}
