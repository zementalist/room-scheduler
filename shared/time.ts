// Time/date helpers shared by server and browser.
// Times are integer minutes since midnight; dates are local calendar dates "YYYY-MM-DD".
// Nothing here touches the machine's timezone.

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Time grid offered by the booking form (07:00 to 22:00, 15-minute steps). */
export const GRID_START = 7 * 60;
export const GRID_END = 22 * 60;
export const GRID_STEP = 15;

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 540 -> "09:00" */
export function fmtTime(min: number): string {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/** "09:00" / "9:00" / "09:00:00" -> 540, otherwise null. Range 00:00..24:00. */
export function parseHHMM(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
}

/** "2026-03-02" is a real calendar date. */
export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Weekday (0 = Sunday) of a calendar date, independent of timezone. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function makeDate(y: number, m: number, d: number): string | null {
  const s = `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
  return isValidDate(s) ? s : null;
}

/** Local calendar date of a JS Date (browser "today"). */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Display name: trimmed, inner whitespace collapsed. */
export function cleanName(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** Canonical room identity key: case- and whitespace-insensitive. */
export function roomKey(s: string): string {
  return cleanName(s).toLowerCase();
}

export function fmt12(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${((h + 11) % 12) + 1}:${pad2(m)} ${h < 12 ? 'AM' : 'PM'}`;
}
