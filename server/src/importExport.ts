import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import * as XLSX from 'xlsx';
import { DAYS, fmtTime, pad2 } from '../../shared/time.ts';
import type { AppContext } from './app.ts';
import { HttpError, badRequest } from './errors.ts';
import { parseWorkbook, type ParsedFile } from './excelParse.ts';
import { applyPlan, planImport, summarize, takeSnapshot, type ImportMode } from './importPlan.ts';
import { currentSemester, getSemester, listReservations, listRooms } from './repo.ts';
import type { DB } from './db.ts';

export const EXPORT_HEADERS = ['Room', 'Building', 'Capacity', 'Type', 'Course', 'Category', 'Date', 'Start', 'End', 'Semester'];
const COL_WIDTHS = [10, 12, 10, 16, 32, 10, 14, 8, 8, 16];

function toBuffer(aoa: (string | number)[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = COL_WIDTHS.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Rooms');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** One row per booking, plus one row for each room that has none. Always writes Category (round-trip safe). */
export function buildExport(db: DB): Buffer {
  const rows: (string | number)[][] = [EXPORT_HEADERS];
  const byRoom = new Map<string, ReturnType<typeof listReservations>>();
  for (const r of listReservations(db)) byRoom.set(r.roomId, [...(byRoom.get(r.roomId) ?? []), r]);
  for (const room of listRooms(db)) {
    const base = [room.name, room.building, room.capacity ?? '', room.type];
    const list = byRoom.get(room.id) ?? [];
    if (!list.length) rows.push([...base, '', '', '', '', '', '']);
    for (const x of list) {
      rows.push([
        ...base,
        x.course,
        x.cat === 'event' ? 'Event' : 'Schedule',
        x.kind === 'date' ? (x.date as string) : DAYS[x.weekday as number]!,
        fmtTime(x.start),
        fmtTime(x.end),
        x.kind === 'weekly' ? (x.semesterName ?? '') : '',
      ]);
    }
  }
  return toBuffer(rows);
}

export function buildTemplate(): Buffer {
  return toBuffer([
    EXPORT_HEADERS,
    ['B204', 'Building B', 40, 'Lab', '', '', '', '', '', ''],
    ['B204', 'Building B', 40, 'Lab', 'PHYS 105', 'Schedule', 'Monday', '09:00', '10:30', 'Spring 2026'],
    ['B204', 'Building B', 40, 'Lab', 'Guest lecture', 'Event', '2026-03-12', '14:00', '16:00', ''],
  ]);
}

interface PendingImport {
  parsed: ParsedFile;
  mode: ImportMode;
  semesterId: string | null;
  expires: number;
}
const PENDING_TTL_MS = 15 * 60 * 1000;

export function registerImportExport(app: FastifyInstance, { db, requireAdmin }: AppContext): void {
  const admin = { preHandler: requireAdmin };
  const pending = new Map<string, PendingImport>();
  const sweep = () => {
    for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
  };

  const xlsxHeaders = (reply: { header: (k: string, v: string) => unknown }, filename: string) => {
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
  };

  app.get('/api/export', admin, async (_req, reply) => {
    const d = new Date();
    xlsxHeaders(reply, `room-reservations-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.xlsx`);
    return reply.send(buildExport(db));
  });

  app.get('/api/template', async (_req, reply) => {
    xlsxHeaders(reply, 'room-reservations-template.xlsx');
    return reply.send(buildTemplate());
  });

  /** multipart: mode (merge|replace), semesterId (optional), file. Returns a diagnostic preview and a confirm token. */
  app.post('/api/import/preview', admin, async (req) => {
    if (!req.isMultipart()) throw badRequest('Upload the workbook as multipart form data.');
    const fields: Record<string, string> = {};
    let file: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') file = await part.toBuffer();
      else fields[part.fieldname] = String(part.value ?? '');
    }
    if (!file || file.length === 0) throw badRequest('Choose a .xlsx, .xls or .csv file.');
    const mode: ImportMode = fields.mode === 'replace' ? 'replace' : 'merge';
    const semesterId = fields.semesterId || null;
    if (semesterId && !getSemester(db, semesterId)) throw badRequest('Unknown semester.');

    let parsed: ParsedFile;
    try {
      parsed = parseWorkbook(file);
    } catch {
      throw new HttpError(422, 'unreadable_file', 'Could not read that file. Use .xlsx, .xls or .csv.');
    }
    if (!parsed.rows.length && !parsed.orphanRows.length) {
      throw new HttpError(422, 'no_rows', 'No importable rows found. The file needs a header row with a Room column.', {
        ignoredSheets: parsed.ignoredSheets,
      });
    }

    const semester = (semesterId && getSemester(db, semesterId)) || currentSemester(db);
    const plan = planImport(parsed, mode, semester, takeSnapshot(db));
    sweep();
    const token = crypto.randomBytes(16).toString('hex');
    pending.set(token, { parsed, mode, semesterId, expires: Date.now() + PENDING_TTL_MS });
    return {
      token,
      semester: semester ? { id: semester.id, name: semester.name } : null,
      sheets: parsed.sheets,
      recognisedColumns: parsed.recognised,
      ignoredColumns: parsed.ignoredColumns,
      ignoredSheets: parsed.ignoredSheets,
      ...summarize(plan),
    };
  });

  /** Re-plans against the CURRENT data (it may have changed since the preview) and applies atomically. */
  app.post('/api/import/confirm', admin, async (req) => {
    const token = (req.body as { token?: unknown } | null)?.token;
    sweep();
    const p = typeof token === 'string' ? pending.get(token) : undefined;
    if (!p) throw new HttpError(410, 'preview_expired', 'This import preview expired. Choose the file again.');
    pending.delete(token as string);
    const semester = (p.semesterId && getSemester(db, p.semesterId)) || currentSemester(db);
    const plan = planImport(p.parsed, p.mode, semester, takeSnapshot(db));
    applyPlan(db, plan);
    return { applied: true, ...summarize(plan) };
  });
}
