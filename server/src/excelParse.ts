import * as XLSX from 'xlsx';
import { cleanName, DAYS, makeDate } from '../../shared/time.ts';
import type { Category } from '../../shared/types.ts';

export type Field = 'room' | 'building' | 'capacity' | 'type' | 'course' | 'date' | 'start' | 'end' | 'category' | 'semester';

/** Exact (normalised) header aliases. Substring matching was deliberately removed (it matched "Weekend" as End). */
const ALIASES: Record<Field, string[]> = {
  room: ['room', 'roomname', 'roomno', 'roomnumber', 'hall', 'location', 'classroom'],
  building: ['building', 'bldg'],
  capacity: ['capacity', 'seats'],
  type: ['type', 'roomtype'],
  course: ['course', 'coursename', 'class', 'classname', 'subject', 'title', 'event', 'eventname'],
  date: ['date', 'day', 'weekday', 'dayofweek', 'dayordate', 'daydate'],
  start: ['start', 'starttime', 'from', 'fromtime'],
  end: ['end', 'endtime', 'to', 'totime', 'until', 'finish'],
  category: ['category', 'cat', 'bookingtype'],
  semester: ['semester', 'term'],
};

const normHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export type Day = { kind: 'date'; date: string } | { kind: 'weekly'; weekday: number };

export interface ParsedRow {
  sheet: string;
  /** 1-based spreadsheet row number, for diagnostics. */
  row: number;
  room: string;
  building: string;
  capacity: number | null;
  type: string;
  hasBookingInfo: boolean;
  course: string;
  cat: Category;
  day: Day | null;
  start: number | null;
  end: number | null;
  semesterName: string;
  /** Reasons the booking part of this row is unusable (empty when valid or room-only). */
  problems: string[];
}

export interface ParsedFile {
  sheets: number;
  /** field -> header text (first sheet where it appeared). */
  recognised: Partial<Record<Field, string>>;
  ignoredColumns: string[];
  ignoredSheets: { sheet: string; reason: string }[];
  rows: ParsedRow[];
  /** Rows with data but no room name. They cannot be imported. */
  orphanRows: { sheet: string; row: number; reason: string }[];
}

type Cell = XLSX.CellObject | undefined;

const isEmptyCell = (c: Cell) => c === undefined || c.v === undefined || c.v === null || String(c.v).trim() === '';

function cellText(c: Cell): string {
  if (isEmptyCell(c)) return '';
  return cleanName(String((c as XLSX.CellObject).v));
}

const isDateFormat = (c: XLSX.CellObject) => typeof c.z === 'string' && XLSX.SSF.is_date(c.z);

type Parsed<T> = { ok: T } | { error: string } | null; // null = empty cell

/**
 * Times:
 *  - 0 < v < 1                      -> fraction of a day (Excel time)
 *  - date-formatted v >= 1          -> time part of a date-time
 *  - integer 0..24                  -> whole hours (fixes "9" being read as 00:00)
 *  - strings: 9:30, 09.30, 9:30 pm, 9am, 14:05:00
 */
export function parseTimeCell(c: Cell): Parsed<number> {
  if (isEmptyCell(c)) return null;
  const cell = c as XLSX.CellObject;
  if (cell.t === 'n' && typeof cell.v === 'number') {
    const v = cell.v;
    if (v > 0 && v < 1) return { ok: Math.round(v * 1440) };
    if (isDateFormat(cell) && v >= 1) return { ok: Math.round((v - Math.floor(v)) * 1440) % 1440 };
    if (Number.isInteger(v) && v >= 0 && v <= 24) return { ok: v * 60 };
    return { error: `Ambiguous time value ${v}; write it as HH:MM` };
  }
  const s = String(cell.v).trim();
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*(am|pm)?$/i.exec(s);
  if (!m) return { error: `Unrecognised time "${s}"` };
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (mi > 59) return { error: `Unrecognised time "${s}"` };
  if (ap) {
    if (h < 1 || h > 12) return { error: `Unrecognised time "${s}"` };
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  } else if (h > 24 || (h === 24 && mi !== 0)) {
    return { error: `Unrecognised time "${s}"` };
  }
  return { ok: h * 60 + mi };
}

/** A weekday name (Mon, monday, "Every Monday") -> 0..6 (Sunday = 0), else null. */
function weekdayFromText(s: string): number | null {
  const w = s.toLowerCase().replace(/^every\s+/, '').replace(/\.$/, '');
  if (w.length < 3) return null;
  const i = DAYS.findIndex((d) => d.toLowerCase().startsWith(w));
  return i >= 0 ? i : null;
}

export function parseDayCell(c: Cell): Parsed<Day> {
  if (isEmptyCell(c)) return null;
  const cell = c as XLSX.CellObject;
  if (cell.t === 'n' && typeof cell.v === 'number') {
    const v = cell.v;
    if (isDateFormat(cell) && v < 1) return { error: 'Expected a date but found a time' };
    if (isDateFormat(cell) || (Number.isInteger(v) && v >= 20000)) {
      const p = XLSX.SSF.parse_date_code(v);
      const d = p && makeDate(p.y, p.m, p.d);
      if (d) return { ok: { kind: 'date', date: d } };
    }
    return { error: `Number ${v} is not a date` };
  }
  const s = String(cell.v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    const date = makeDate(y, m, d);
    return date ? { ok: { kind: 'date', date } } : { error: `"${s}" is not a real calendar date` };
  }
  const wd = weekdayFromText(s);
  if (wd !== null) return { ok: { kind: 'weekly', weekday: wd } };
  if (/[a-z]{3}/i.test(s) && /\d/.test(s)) {
    const t = new Date(s); // textual month names only, e.g. "3 Mar 2026"
    if (!Number.isNaN(t.getTime())) {
      const date = makeDate(t.getFullYear(), t.getMonth() + 1, t.getDate());
      if (date) return { ok: { kind: 'date', date } };
    }
  }
  return { error: `Unrecognised date "${s}" (use YYYY-MM-DD or a weekday name such as Monday)` };
}

function parseCapacity(c: Cell): number | null {
  if (isEmptyCell(c)) return null;
  const n = Number(String((c as XLSX.CellObject).v).trim());
  return Number.isInteger(n) && n >= 0 && n <= 100000 ? n : null;
}

export function parseWorkbook(buf: Buffer): ParsedFile {
  // raw: keep CSV cells as text so "3/4/2026" is never silently re-interpreted; cellNF: keep number formats.
  const wb = XLSX.read(buf, { type: 'buffer', cellNF: true, raw: true });
  const out: ParsedFile = { sheets: wb.SheetNames.length, recognised: {}, ignoredColumns: [], ignoredSheets: [], rows: [], orphanRows: [] };
  const ignored = new Set<string>();

  for (const sheet of wb.SheetNames) {
    const ws = wb.Sheets[sheet];
    if (!ws || !ws['!ref']) {
      out.ignoredSheets.push({ sheet, reason: 'Sheet is empty' });
      continue;
    }
    const range = XLSX.utils.decode_range(ws['!ref']);
    const col = new Map<Field, number>();
    for (let c = range.s.c; c <= range.e.c; c++) {
      const header = cellText(ws[XLSX.utils.encode_cell({ r: range.s.r, c })]);
      if (!header) continue;
      const n = normHeader(header);
      const field = (Object.keys(ALIASES) as Field[]).find((f) => ALIASES[f].includes(n));
      if (field && !col.has(field)) {
        col.set(field, c);
        out.recognised[field] ??= header;
      } else {
        ignored.add(header);
      }
    }
    if (!col.has('room')) {
      out.ignoredSheets.push({ sheet, reason: 'No Room column (looked for: Room, Hall, Location)' });
      continue;
    }
    const at = (r: number, f: Field): Cell => (col.has(f) ? ws[XLSX.utils.encode_cell({ r, c: col.get(f) as number })] : undefined);

    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      let anyData = false;
      for (let c = range.s.c; c <= range.e.c && !anyData; c++) anyData = !isEmptyCell(ws[XLSX.utils.encode_cell({ r, c })]);
      if (!anyData) continue;

      const room = cellText(at(r, 'room'));
      if (!room) {
        out.orphanRows.push({ sheet, row: r + 1, reason: 'Missing room name' });
        continue;
      }
      const course = cellText(at(r, 'course'));
      const dayP = parseDayCell(at(r, 'date'));
      const startP = parseTimeCell(at(r, 'start'));
      const endP = parseTimeCell(at(r, 'end'));
      const hasBookingInfo = course !== '' || dayP !== null || startP !== null || endP !== null;

      const problems: string[] = [];
      if (hasBookingInfo) {
        if (dayP === null) problems.push('Missing date or weekday');
        else if ('error' in dayP) problems.push(dayP.error);
        if (startP === null) problems.push('Missing start time');
        else if ('error' in startP) problems.push(`Start: ${startP.error}`);
        if (endP === null) problems.push('Missing end time');
        else if ('error' in endP) problems.push(`End: ${endP.error}`);
        if (startP && endP && 'ok' in startP && 'ok' in endP && endP.ok <= startP.ok) {
          problems.push('End time must be later than start time');
        }
      }

      const catText = cellText(at(r, 'category')).toLowerCase();
      out.rows.push({
        sheet,
        row: r + 1,
        room,
        building: cellText(at(r, 'building')),
        capacity: parseCapacity(at(r, 'capacity')),
        type: cellText(at(r, 'type')),
        hasBookingInfo,
        course,
        cat: catText.startsWith('event') ? 'event' : 'schedule',
        day: dayP && 'ok' in dayP ? dayP.ok : null,
        start: startP && 'ok' in startP ? startP.ok : null,
        end: endP && 'ok' in endP ? endP.ok : null,
        semesterName: cellText(at(r, 'semester')),
        problems,
      });
    }
  }
  out.ignoredColumns = [...ignored];
  return out;
}
