// The "static edition" backend: no server. The schedule lives in data/data.json in the GitHub repository;
// the rules run in the browser (shared/engine.ts). Same surface as serverApi.ts so the UI does not change.
import { ApiFail } from '../../shared/apiError.ts';
import { Engine } from '../../shared/engine.ts';
import type { ParsedFile } from '../../shared/excelParse.ts';
import type { ImportMode } from '../../shared/importPlan.ts';
import { pad2 } from '../../shared/time.ts';
import type { ImportPreview } from './apiTypes.ts';
import * as gh from './github.ts';
import type { api as ServerApi } from './serverApi.ts';

const TOKEN_KEY = 'adminToken';
const USER_KEY = 'adminUser';
/** Reads reuse the loaded copy for this long, then revalidate (the page also polls once a minute). */
const FRESH_MS = 30_000;

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

const engine = new Engine();
let sha: string | null = null;
let loadedAt = 0;

const token = () => localStorage.getItem(TOKEN_KEY);
function endSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  loadedAt = 0;
}

/** One operation at a time, so a read never sees a half-finished save. */
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

/** Load the newest data: straight from the repository for the admin, the published copy for everyone else. */
async function load() {
  const t = token();
  if (t) {
    try {
      const fresh = await gh.readFresh(t);
      engine.data = fresh.data;
      sha = fresh.sha;
      loadedAt = Date.now();
      return;
    } catch (e) {
      if (!(e instanceof ApiFail && (e.status === 401 || e.status === 403))) throw e;
      endSession();
      onUnauthorized?.();
    }
  }
  engine.data = await gh.readPublic();
  sha = null;
  loadedAt = Date.now();
}

const read = <T>(fn: (e: Engine) => T): Promise<T> =>
  serial(async () => {
    if (Date.now() - loadedAt > FRESH_MS) await load();
    return fn(engine);
  });

/** Admin change: reload the latest, apply the rules, commit. The commit is the save; a failed save changes nothing. */
const mutate = <T>(message: string, fn: (e: Engine) => T): Promise<T> =>
  serial(async () => {
    const t = token();
    if (!t) {
      onUnauthorized?.();
      throw new ApiFail(401, 'unauthorized', 'Log in as admin to make changes.');
    }
    await load();
    if (!token()) throw new ApiFail(401, 'unauthorized', 'Log in as admin to make changes.');
    const before = structuredClone(engine.data);
    const result = fn(engine);
    try {
      sha = await gh.write(t, engine.data, sha, message);
      loadedAt = Date.now();
    } catch (e) {
      engine.data = before;
      if (e instanceof ApiFail) {
        if (e.status === 401) {
          endSession();
          onUnauthorized?.();
        } else if (e.code === 'stale') {
          await load().catch(() => {});
        }
      }
      throw e;
    }
    return result;
  });

// ---------- Excel (runs in the browser; the library is only fetched when needed) ----------

interface Pending {
  parsed: ParsedFile;
  mode: ImportMode;
  semesterId: string | null;
  preview: ImportPreview;
}
const pending = new Map<string, Pending>();

async function importPreview(file: File, mode: ImportMode, semesterId: string): Promise<ImportPreview> {
  const { parseWorkbook } = await import('../../shared/excelParse.ts');
  if (!file.size) throw new ApiFail(400, 'bad_request', 'Choose a .xlsx, .xls or .csv file.');
  let parsed: ParsedFile;
  try {
    parsed = parseWorkbook(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new ApiFail(422, 'unreadable_file', 'Could not read that file. Use .xlsx, .xls or .csv.');
  }
  if (!parsed.rows.length && !parsed.orphanRows.length) {
    throw new ApiFail(422, 'no_rows', 'No importable rows found. The file needs a header row with a Room column.', {
      error: 'no_rows',
      message: 'No importable rows found. The file needs a header row with a Room column.',
    });
  }
  const { semester, summary } = await read((e) => e.planImport(parsed, mode, semesterId || null));
  const preview: ImportPreview = {
    token: crypto.randomUUID(),
    semester: semester ? { id: semester.id, name: semester.name } : null,
    sheets: parsed.sheets,
    recognisedColumns: parsed.recognised as Record<string, string>,
    ignoredColumns: parsed.ignoredColumns,
    ignoredSheets: parsed.ignoredSheets,
    ...summary,
  };
  pending.clear(); // one preview at a time is enough
  pending.set(preview.token, { parsed, mode, semesterId: semesterId || null, preview });
  return preview;
}

async function importConfirm(tok: string): Promise<ImportPreview & { applied: boolean }> {
  const p = pending.get(tok);
  if (!p) throw new ApiFail(410, 'preview_expired', 'This import preview expired. Choose the file again.');
  pending.delete(tok);
  // Re-plan against the newest data (mutate reloads it first), then apply and commit once.
  const summary = await mutate('Import from Excel', (e) => {
    const { plan, summary: s } = e.planImport(p.parsed, p.mode, p.semesterId);
    e.applyPlan(plan);
    return s;
  });
  return { ...p.preview, ...summary, applied: true };
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Same call shape as the server edition: '/api/export' and '/api/template' are built locally. */
export async function download(url: string, fallbackName: string): Promise<void> {
  const sheet = await import('../../shared/exportSheet.ts');
  let bytes: Uint8Array;
  let name = fallbackName;
  if (url === '/api/template') {
    bytes = sheet.workbookBytes(sheet.templateRows());
  } else {
    const d = new Date();
    name = `room-reservations-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.xlsx`;
    const data = await read((e) => e.exportData());
    bytes = sheet.workbookBytes(sheet.exportRows(data.rooms, data.reservations));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: XLSX_TYPE }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export const api: typeof ServerApi = {
  me: async () => ({ admin: !!token(), username: localStorage.getItem(USER_KEY) }),
  /** The "password" is the GitHub access token; the username is ignored. */
  login: async (_username, accessToken) => {
    const t = accessToken.trim();
    const user = await gh.verify(t);
    localStorage.setItem(TOKEN_KEY, t);
    localStorage.setItem(USER_KEY, user);
    loadedAt = 0;
    return { admin: true };
  },
  logout: async () => {
    endSession();
    return { admin: false };
  },

  summary: () => read((e) => e.summary()),
  rooms: (q) => read((e) => e.rooms(q)),
  availability: (date, from, to) => read((e) => e.availability(date, from, to)),
  roomDetail: (id) => read((e) => e.roomDetail(id)),
  semesters: () => read((e) => e.semesters()),

  createRoom: (b) => mutate(`Add room ${b.name}`, (e) => e.createRoom(b)),
  updateRoom: (id, b) => mutate(`Update room ${b.name}`, (e) => e.updateRoom(id, b)),
  deleteRoom: (id) => mutate('Delete room', (e) => e.deleteRoom(id)),
  clearRoom: (id) => mutate('Clear a room\'s bookings', (e) => e.clearRoom(id)),

  createReservation: (roomId, b) => mutate('Add booking', (e) => e.createReservation(roomId, b)),
  updateReservation: (id, b) => mutate('Edit booking', (e) => e.updateReservation(id, b)),
  deleteReservation: (id) => mutate('Delete booking', (e) => e.deleteReservation(id)),

  createSemester: (b) => mutate(`Add semester ${b.name}`, (e) => e.createSemester(b)),
  updateSemester: (id, b) => mutate(`Update semester ${b.name}`, (e) => e.updateSemester(id, b)),
  deleteSemester: (id, withBookings) => mutate('Delete semester', (e) => e.deleteSemester(id, withBookings)),
  rollover: (b) => mutate(`Begin semester ${b.name}`, (e) => e.rollover(b)),

  clearAll: () => mutate('Clear all data', (e) => e.clearAll()),

  importPreview,
  importConfirm,
};