// The scheduling rules on plain JSON data. Used by the static edition (browser, data kept in the repo)
// and mirrors what server/src does against SQLite: same validation, same messages, same clash rule.
import { ApiFail } from './apiError.ts';
import { clashes, describeRange, type Slot } from './conflict.ts';
import type { ParsedFile } from './excelParse.ts';
import { planImport, summarize, type ImportMode, type ImportPlan, type ImportSummary } from './importPlan.ts';
import { cleanName, isValidDate, parseHHMM, roomKey } from './time.ts';
import type { Category, Kind, Reservation, ReservationInput, Room, RoomFields, Semester } from './types.ts';

export interface RoomRec {
  id: string;
  name: string;
  building: string;
  capacity: number | null;
  type: string;
}

export interface ReservationRec {
  id: string;
  roomId: string;
  course: string;
  cat: Category;
  kind: Kind;
  date: string | null;
  weekday: number | null;
  start: number;
  end: number;
  semesterId: string | null;
}

/** The whole database. This is exactly what schedule/data.json holds. */
export interface Data {
  version: 1;
  rooms: RoomRec[];
  semesters: Semester[];
  reservations: ReservationRec[];
}

export const emptyData = (): Data => ({ version: 1, rooms: [], semesters: [], reservations: [] });

/** Accept parsed JSON from the repo; refuse anything that is not our format rather than guessing. */
export function normalizeData(raw: unknown): Data {
  const d = raw as Partial<Data> | null;
  if (!d || typeof d !== 'object' || d.version !== 1 || !Array.isArray(d.rooms) || !Array.isArray(d.semesters) || !Array.isArray(d.reservations)) {
    throw new Error('data.json is not in the expected format (version 1).');
  }
  return { version: 1, rooms: d.rooms, semesters: d.semesters, reservations: d.reservations };
}

/** Stable, diff-friendly JSON for the repository: rooms by name, bookings by room then time. */
export function serialize(data: Data): string {
  const name = new Map(data.rooms.map((r) => [r.id, r.name.toLowerCase()]));
  const rooms = [...data.rooms].sort((a, b) => a.name.localeCompare(b.name));
  const reservations = [...data.reservations].sort(
    (a, b) =>
      (name.get(a.roomId) ?? '').localeCompare(name.get(b.roomId) ?? '') ||
      a.kind.localeCompare(b.kind) ||
      (a.date ?? '').localeCompare(b.date ?? '') ||
      (a.weekday ?? 0) - (b.weekday ?? 0) ||
      a.start - b.start,
  );
  return JSON.stringify({ ...data, rooms, reservations }, null, 1) + '\n';
}

export interface RoomBody {
  name: string;
  building: string;
  capacity: number | string | null;
  type: string;
}

export interface SemesterBody {
  name: string;
  startDate: string;
  endDate: string;
  isCurrent?: boolean;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const uuid = () => crypto.randomUUID();
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): ApiFail {
  return new ApiFail(status, code, message, { error: code, message, ...extra });
}
const badRequest = (message: string) => fail(400, 'bad_request', message);
const notFound = (message: string) => fail(404, 'not_found', message);

type Body = Record<string, unknown>;
const asBody = (b: unknown): Body => {
  if (typeof b !== 'object' || b === null) throw badRequest('Request body must be a JSON object.');
  return b as Body;
};
const str = (v: unknown, field: string, max: number, required = false): string => {
  const s = typeof v === 'string' ? cleanName(v) : v == null ? '' : String(v).trim();
  if (required && !s) throw badRequest(`${field} is required.`);
  if (s.length > max) throw badRequest(`${field} is too long (max ${max} characters).`);
  return s;
};

function parseRoomBody(raw: unknown): RoomFields {
  const b = asBody(raw);
  let capacity: number | null = null;
  if (b.capacity !== null && b.capacity !== undefined && b.capacity !== '') {
    const n = Number(b.capacity);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw badRequest('Capacity must be a whole number.');
    capacity = n;
  }
  return {
    name: str(b.name, 'Room name', 100, true),
    building: str(b.building, 'Building', 100),
    capacity,
    type: str(b.type, 'Type', 100),
  };
}

function parseSemesterBody(b: Body): { name: string; startDate: string; endDate: string } {
  const name = str(b.name, 'Semester name', 100, true);
  if (!isValidDate(b.startDate) || !isValidDate(b.endDate)) throw badRequest('Start and end dates are required.');
  if (b.endDate < b.startDate) throw badRequest('The end date must not be before the start date.');
  return { name, startDate: b.startDate, endDate: b.endDate };
}

/** FR-4.2 ordering: dated before weekly; then date or weekday ascending; then start time. */
function compareReservations(a: Reservation, b: Reservation): number {
  if (a.kind !== b.kind) return a.kind === 'date' ? -1 : 1;
  const k = a.kind === 'date' ? (a.date as string).localeCompare(b.date as string) : (a.weekday as number) - (b.weekday as number);
  return k || a.start - b.start;
}

const slotOf = (r: Reservation): Slot => ({
  kind: r.kind,
  date: r.date,
  weekday: r.weekday,
  start: r.start,
  end: r.end,
  termStart: r.termStart,
  termEnd: r.termEnd,
});

type ReservationFields = Omit<ReservationRec, 'id' | 'roomId'>;

export class Engine {
  data: Data;

  constructor(data: Data = emptyData()) {
    this.data = data;
  }

  // ---------- reads ----------

  private semester(id: string | null | undefined): Semester | undefined {
    return id ? this.data.semesters.find((s) => s.id === id) : undefined;
  }

  private currentSemester(): Semester | undefined {
    return this.data.semesters.find((s) => s.isCurrent);
  }

  private roomRec(id: string): RoomRec | undefined {
    return this.data.rooms.find((r) => r.id === id);
  }

  private toRoom(r: RoomRec): Room {
    return { ...r, bookingCount: this.data.reservations.filter((x) => x.roomId === r.id).length };
  }

  private toReservation(x: ReservationRec): Reservation {
    const s = this.semester(x.semesterId);
    return { ...x, semesterName: s?.name ?? null, termStart: s?.startDate ?? null, termEnd: s?.endDate ?? null };
  }

  private reservationsOf(roomId?: string): Reservation[] {
    return this.data.reservations
      .filter((x) => !roomId || x.roomId === roomId)
      .map((x) => this.toReservation(x))
      .sort(compareReservations);
  }

  summary() {
    const res = this.data.reservations;
    return {
      rooms: this.data.rooms.length,
      schedule: res.filter((x) => x.cat === 'schedule').length,
      events: res.filter((x) => x.cat === 'event').length,
    };
  }

  /** Everything in display order, for the Excel export. */
  exportData(): { rooms: Room[]; reservations: Reservation[] } {
    return { rooms: this.rooms().rooms, reservations: this.reservationsOf() };
  }

  /** q matches name, building, type, or any course booked in the room. */
  rooms(q = ''): { rooms: Room[] } {
    const needle = q.trim().toLowerCase();
    const courses = new Map<string, string[]>();
    if (needle) for (const x of this.data.reservations) courses.set(x.roomId, [...(courses.get(x.roomId) ?? []), x.course.toLowerCase()]);
    const rooms = this.data.rooms
      .filter(
        (r) =>
          !needle ||
          r.name.toLowerCase().includes(needle) ||
          r.building.toLowerCase().includes(needle) ||
          r.type.toLowerCase().includes(needle) ||
          (courses.get(r.id) ?? []).some((c) => c.includes(needle)),
      )
      .map((r) => this.toRoom(r))
      .sort((a, b) => collator.compare(a.name, b.name));
    return { rooms };
  }

  roomDetail(id: string): { room: Room; reservations: Reservation[] } {
    const r = this.roomRec(id);
    if (!r) throw notFound('Room not found.');
    return { room: this.toRoom(r), reservations: this.reservationsOf(id) };
  }

  semesters(): { semesters: Semester[] } {
    const semesters = [...this.data.semesters].sort(
      (a, b) => b.startDate.localeCompare(a.startDate) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    return { semesters };
  }

  /** BR-5: rooms free on `date` between `from` and `to` (HH:MM). */
  availability(date: string, from: string, to: string): { rooms: Room[] } {
    const f = parseHHMM(from);
    const t = parseHHMM(to);
    if (!isValidDate(date) || f === null || t === null || t <= f) {
      throw badRequest('Provide a valid date and a from/to time with to later than from.');
    }
    const probe: Slot = { kind: 'date', date, weekday: null, start: f, end: t, termStart: null, termEnd: null };
    const busy = new Set<string>();
    for (const r of this.reservationsOf()) if (clashes(probe, slotOf(r))) busy.add(r.roomId);
    return { rooms: this.rooms().rooms.filter((r) => !busy.has(r.id)) };
  }

  // ---------- writes ----------

  /** Run a change all-or-nothing: on any error the data is put back exactly as it was. */
  private atomic<T>(fn: () => T): T {
    const backup = structuredClone(this.data);
    try {
      return fn();
    } catch (e) {
      this.data = backup;
      throw e;
    }
  }

  private assertRoomNameFree(name: string, selfId?: string) {
    const key = roomKey(name);
    const dup = this.data.rooms.find((r) => roomKey(r.name) === key);
    if (dup && dup.id !== selfId) throw fail(409, 'duplicate', `A room named "${dup.name}" already exists.`);
  }

  private addRoom(f: RoomFields): string {
    const id = uuid();
    this.data.rooms.push({ id, name: cleanName(f.name), building: f.building, capacity: f.capacity, type: f.type });
    return id;
  }

  createRoom(body: RoomBody): Room {
    const f = parseRoomBody(body);
    return this.atomic(() => {
      this.assertRoomNameFree(f.name);
      return this.toRoom(this.roomRec(this.addRoom(f)) as RoomRec);
    });
  }

  updateRoom(id: string, body: RoomBody): Room {
    const f = parseRoomBody(body);
    return this.atomic(() => {
      const r = this.roomRec(id);
      if (!r) throw notFound('Room not found.');
      this.assertRoomNameFree(f.name, id);
      Object.assign(r, { ...f, name: cleanName(f.name) });
      return this.toRoom(r);
    });
  }

  deleteRoom(id: string): { deleted: string; bookingsDeleted: number } {
    const r = this.roomRec(id);
    if (!r) throw notFound('Room not found.');
    const room = this.toRoom(r);
    this.data.rooms = this.data.rooms.filter((x) => x.id !== id);
    this.data.reservations = this.data.reservations.filter((x) => x.roomId !== id);
    return { deleted: room.name, bookingsDeleted: room.bookingCount };
  }

  clearRoom(id: string): { deleted: number } {
    if (!this.roomRec(id)) throw notFound('Room not found.');
    const before = this.data.reservations.length;
    this.data.reservations = this.data.reservations.filter((x) => x.roomId !== id);
    return { deleted: before - this.data.reservations.length };
  }

  /** Validate and normalise a reservation payload. Weekly bookings are bound to a semester. */
  private parseReservation(body: unknown): ReservationFields {
    const b = asBody(body);
    const kind = b.kind;
    if (kind !== 'date' && kind !== 'weekly') throw badRequest('kind must be "date" or "weekly".');
    const cat = b.cat ?? 'schedule';
    if (cat !== 'schedule' && cat !== 'event') throw badRequest('cat must be "schedule" or "event".');
    const course = typeof b.course === 'string' ? b.course.trim() : '';
    if (course.length > 200) throw badRequest('Course name is too long (max 200 characters).');
    if (!isInt(b.start) || !isInt(b.end)) throw badRequest('Start and end times are required.');
    if (b.start < 0 || b.end > 1440 || b.end <= b.start) throw badRequest('Enter a start time earlier than the end time.');

    let date: string | null = null;
    let weekday: number | null = null;
    let semesterId: string | null = null;
    if (kind === 'date') {
      if (!isValidDate(b.date)) throw badRequest('Pick a valid date.');
      date = b.date;
    } else {
      if (!isInt(b.weekday) || b.weekday < 0 || b.weekday > 6) throw badRequest('Pick a weekday.');
      weekday = b.weekday;
      const sem = typeof b.semesterId === 'string' && b.semesterId ? this.semester(b.semesterId) : this.currentSemester();
      if (!sem) throw badRequest('Weekly bookings need a semester. Create or choose a semester first.');
      semesterId = sem.id;
    }
    return { course, cat, kind, date, weekday, start: b.start, end: b.end, semesterId };
  }

  private slotFor(f: ReservationFields): Slot {
    const sem = this.semester(f.semesterId);
    return { kind: f.kind, date: f.date, weekday: f.weekday, start: f.start, end: f.end, termStart: sem?.startDate ?? null, termEnd: sem?.endDate ?? null };
  }

  private assertNoClash(roomId: string, f: ReservationFields, excludeId?: string) {
    const slot = this.slotFor(f);
    const c = this.reservationsOf(roomId).find((r) => r.id !== excludeId && clashes(slot, slotOf(r)));
    if (c) throw fail(409, 'clash', `Clash: already booked ${describeRange(c)}${c.course ? ` (${c.course})` : ''}.`, { conflictWith: c });
  }

  createReservation(roomId: string, body: ReservationInput): Reservation {
    return this.atomic(() => {
      if (!this.roomRec(roomId)) throw notFound('Room not found.');
      const f = this.parseReservation(body);
      this.assertNoClash(roomId, f);
      const rec: ReservationRec = { id: uuid(), roomId, ...f };
      this.data.reservations.push(rec);
      return this.toReservation(rec);
    });
  }

  updateReservation(id: string, body: ReservationInput): Reservation {
    return this.atomic(() => {
      const rec = this.data.reservations.find((x) => x.id === id);
      if (!rec) throw notFound('Reservation not found.');
      const f = this.parseReservation(body);
      this.assertNoClash(rec.roomId, f, id);
      Object.assign(rec, f);
      return this.toReservation(rec);
    });
  }

  deleteReservation(id: string): { deleted: number } {
    if (!this.data.reservations.some((x) => x.id === id)) throw notFound('Reservation not found.');
    this.data.reservations = this.data.reservations.filter((x) => x.id !== id);
    return { deleted: 1 };
  }

  // ---------- semesters ----------

  private addSemester(name: string, startDate: string, endDate: string, makeCurrent: boolean): Semester {
    if (makeCurrent) for (const s of this.data.semesters) s.isCurrent = false;
    const s: Semester = { id: uuid(), name, startDate, endDate, isCurrent: makeCurrent };
    this.data.semesters.push(s);
    return s;
  }

  createSemester(body: SemesterBody): Semester {
    const b = asBody(body);
    const s = parseSemesterBody(b);
    return this.atomic(() => this.addSemester(s.name, s.startDate, s.endDate, b.isCurrent === true));
  }

  /** After changing a semester's dates, make sure no room now holds clashing bookings. */
  private assertNoClashesInSemester(semesterId: string) {
    const roomIds = new Set(this.data.reservations.filter((x) => x.semesterId === semesterId).map((x) => x.roomId));
    for (const roomId of roomIds) {
      const list = this.reservationsOf(roomId);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (clashes(slotOf(list[i]!), slotOf(list[j]!))) {
            throw fail(409, 'clash', 'Those dates would create booking clashes in room ' + this.roomRec(roomId)?.name + '.');
          }
        }
      }
    }
  }

  updateSemester(id: string, body: SemesterBody): Semester {
    const b = asBody(body);
    const s = parseSemesterBody(b);
    return this.atomic(() => {
      const sem = this.semester(id);
      if (!sem) throw notFound('Semester not found.');
      if (b.isCurrent === true) for (const x of this.data.semesters) x.isCurrent = false;
      Object.assign(sem, { name: s.name, startDate: s.startDate, endDate: s.endDate, isCurrent: b.isCurrent === true ? true : sem.isCurrent });
      this.assertNoClashesInSemester(id);
      return sem;
    });
  }

  deleteSemester(id: string, withBookings: boolean): { deleted: number; bookingsDeleted: number } {
    return this.atomic(() => {
      if (!this.semester(id)) throw notFound('Semester not found.');
      const n = this.data.reservations.filter((x) => x.semesterId === id).length;
      if (n > 0 && !withBookings) {
        throw fail(409, 'semester_in_use', `This semester has ${n} weekly booking(s). Delete them with the semester or clear them first.`, { bookings: n });
      }
      this.data.reservations = this.data.reservations.filter((x) => x.semesterId !== id);
      this.data.semesters = this.data.semesters.filter((x) => x.id !== id);
      return { deleted: 1, bookingsDeleted: n };
    });
  }

  /** FR-8.1 "Begin new semester": new current term; by default clears every schedule booking, keeping rooms and events. */
  rollover(body: SemesterBody & { clearSchedule?: boolean }): { semester: Semester; scheduleCleared: number; current: boolean } {
    const b = asBody(body);
    const s = parseSemesterBody(b);
    return this.atomic(() => {
      let cleared = 0;
      if (b.clearSchedule !== false) {
        const before = this.data.reservations.length;
        this.data.reservations = this.data.reservations.filter((x) => x.cat !== 'schedule');
        cleared = before - this.data.reservations.length;
      }
      const semester = this.addSemester(s.name, s.startDate, s.endDate, true);
      return { semester, scheduleCleared: cleared, current: this.currentSemester()?.id === semester.id };
    });
  }

  /** FR-8.2 "Clear all data": rooms and bookings. Semesters are kept. */
  clearAll(): { rooms: number; reservations: number } {
    const r = { rooms: this.data.rooms.length, reservations: this.data.reservations.length };
    this.data.rooms = [];
    this.data.reservations = [];
    return r;
  }

  // ---------- Excel import ----------

  /** Dry run: what importing `file` would do against the data as it is right now. */
  planImport(file: ParsedFile, mode: ImportMode, semesterId: string | null): { plan: ImportPlan; semester: Semester | undefined; summary: ImportSummary } {
    if (semesterId && !this.semester(semesterId)) throw badRequest('Unknown semester.');
    const semester = this.semester(semesterId) ?? this.currentSemester();
    const plan = planImport(file, mode, semester, {
      rooms: this.rooms().rooms,
      reservations: this.reservationsOf(),
      semesters: this.data.semesters,
    });
    return { plan, semester, summary: summarize(plan) };
  }

  /** Apply a plan atomically. Replace wipes rooms and bookings first; semesters are never touched. */
  applyPlan(plan: ImportPlan): void {
    this.atomic(() => {
      if (plan.mode === 'replace') {
        this.data.reservations = [];
        this.data.rooms = [];
      }
      for (const [id, f] of plan.update) {
        const r = this.roomRec(id);
        if (r) Object.assign(r, { ...f, name: cleanName(f.name) });
      }
      const ids = new Map<string, string>();
      for (const [key, f] of plan.create) ids.set(key, this.addRoom(f));
      for (const r of this.data.rooms) ids.set(roomKey(r.name), r.id);
      for (const r of plan.add) {
        this.data.reservations.push({
          id: uuid(),
          roomId: ids.get(r.roomKey) as string,
          course: r.course,
          cat: r.cat,
          kind: r.kind,
          date: r.date,
          weekday: r.weekday,
          start: r.start,
          end: r.end,
          semesterId: r.semesterId,
        });
      }
    });
  }
}
