/** YYYY-MM-DD for today (UTC), the value shape a native date input takes. */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Start of the given UTC day, in epoch seconds. */
export function isoDateToEpochSeconds(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000);
}

/** m:ss (or h:mm:ss) for a duration in seconds; an em dash when it could not be measured. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A 0..1 fraction as a whole-number percentage. */
export function formatPercent(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** An ISO string or epoch-ms number as a local date + time. */
export function formatDate(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
