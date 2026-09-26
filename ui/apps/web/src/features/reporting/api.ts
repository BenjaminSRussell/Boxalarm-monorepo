import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type {
  DashboardView,
  ExportFormat,
  GrantsReport,
  IsoReport,
  LosapYearEndReport,
  MembershipTrends,
  ReportExportAccepted,
  ReportExportJob,
  ReportName,
  ResponseTimesReport,
} from './types';

async function getJson<T>(tokens: AuthTokenSource, path: string): Promise<T> {
  const response = await apiRequest(path, tokens);
  return (await response.json()) as T;
}

export function getDashboard(tokens: AuthTokenSource): Promise<DashboardView> {
  return getJson(tokens, 'reporting/dashboard');
}

/** `from`/`to` are epoch seconds (incident alarm time). */
export function getResponseTimes(
  tokens: AuthTokenSource,
  from: number,
  to: number,
): Promise<ResponseTimesReport> {
  const params = new URLSearchParams({ from: String(from), to: String(to) });
  return getJson(tokens, `reporting/response-times?${params.toString()}`);
}

/** `from`/`to` are epoch seconds. */
export function getIsoReport(
  tokens: AuthTokenSource,
  from: number,
  to: number,
): Promise<IsoReport> {
  const params = new URLSearchParams({ from: String(from), to: String(to) });
  return getJson(tokens, `reporting/iso?${params.toString()}`);
}

/** ISO dates (YYYY-MM-DD), at most 731 days apart. */
export function getMembershipTrends(
  tokens: AuthTokenSource,
  startDate: string,
  endDate: string,
): Promise<MembershipTrends> {
  const params = new URLSearchParams({ startDate, endDate });
  return getJson(tokens, `reporting/membership-trends?${params.toString()}`);
}

/** `periodStart`/`periodEnd` are epoch milliseconds. */
export function getGrantsReport(
  tokens: AuthTokenSource,
  periodStart: number,
  periodEnd: number,
): Promise<GrantsReport> {
  const params = new URLSearchParams({
    periodStart: String(periodStart),
    periodEnd: String(periodEnd),
  });
  return getJson(tokens, `reporting/grants?${params.toString()}`);
}

export function getLosapYearEnd(
  tokens: AuthTokenSource,
  year: number,
): Promise<LosapYearEndReport> {
  return getJson(tokens, `reporting/losap/year-end?year=${encodeURIComponent(String(year))}`);
}

/**
 * Accept-and-queue (202). The handler reads report, format and the report's own parameters
 * from the query string, not a body.
 */
export async function startReportExport(
  tokens: AuthTokenSource,
  report: ReportName,
  format: ExportFormat,
  reportParams: Record<string, string>,
): Promise<ReportExportAccepted> {
  const params = new URLSearchParams({ ...reportParams, report, format });
  const response = await apiRequest(`reporting/export?${params.toString()}`, tokens, {
    method: 'POST',
  });
  return (await response.json()) as ReportExportAccepted;
}

export function getReportExportStatus(
  tokens: AuthTokenSource,
  jobId: string,
): Promise<ReportExportJob> {
  return getJson(tokens, `reporting/export/${encodeURIComponent(jobId)}`);
}
