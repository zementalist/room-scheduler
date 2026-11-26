import crypto from 'node:crypto';
import { clashes, type Slot } from '../../shared/conflict.ts';
import { cleanName, roomKey } from '../../shared/time.ts';
import type { Category, Kind, Reservation, Room, Semester } from '../../shared/types.ts';
import type { DB } from './db.ts';

export const uuid = () => crypto.randomUUID();

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// ---------- rooms ----------

interface RoomRow {
  id: string;
  name: string;
  building: string;
  capacity: number | null;
  type: string;
  booking_count: number;
}

const toRoom = (r: RoomRow): Room => ({
  id: r.id,
  name: r.name,
  building: r.building,
  capacity: r.capacity,
  type: r.type,
  bookingCount: r.booking_count,
});

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Rooms with booking counts. q matches name, building, type, or any course booked in the room. */
export function listRooms(db: DB, q = ''): Room[] {
  const needle = `%${likeEscape(q.trim().toLowerCase())}%`;
  const rows = db
    .prepare(
      `SELECT r.id, r.name, r.building, r.capacity, r.type,
              (SELECT COUNT(*) FROM reservations x WHERE x.room_id = r.id) AS booking_count
         FROM rooms r
        WHERE ?1 = '%%'
           OR lower(r.name)     LIKE ?1 ESCAPE '\\'
           OR lower(r.building) LIKE ?1 ESCAPE '\\'
           OR lower(r.type)     LIKE ?1 ESCAPE '\\'
           OR EXISTS (SELECT 1 FROM reservations x
                       WHERE x.room_id = r.id AND lower(x.course) LIKE ?1 ESCAPE '\\')`,
    )
    .all(needle) as unknown as RoomRow[];
  return rows.map(toRoom).sort((a, b) => collator.compare(a.name, b.name));
}

export function getRoom(db: DB, id: string): Room | undefined {
  const r = db
    .prepare(
      `SELECT r.id, r.name, r.building, r.capacity, r.type,
              (SELECT COUNT(*) FROM reservations x WHERE x.room_id = r.id) AS booking_count
         FROM rooms r WHERE r.id = ?`,
    )
    .get(id) as RoomRow | undefined;
  return r && toRoom(r);
}

export function findRoomByName(db: DB, name: string): { id: string; name: string } | undefined {
  return db.prepare('SELECT id, name FROM rooms WHERE name_norm = ?').get(roomKey(name)) as
    | { id: string; name: string }
    | undefined;
}

export interface RoomFields {
  name: string;
  building: string;
  capacity: number | null;
  type: string;
}

export function insertRoom(db: DB, f: RoomFields): string {
  const id = uuid();
  const name = cleanName(f.name);
  db.prepare('INSERT INTO rooms (id, name, name_norm, building, capacity, type) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    name,
    roomKey(name),
    f.building,
    f.capacity,
    f.type,
  );
  return id;
}

export function updateRoom(db: DB, id: string, f: RoomFields): void {
  const name = cleanName(f.name);
  db.prepare('UPDATE rooms SET name = ?, name_norm = ?, building = ?, capacity = ?, type = ? WHERE id = ?').run(
    name,
    roomKey(name),
    f.building,
    f.capacity,
    f.type,
    id,
  );
}

// ---------- semesters ----------

interface SemesterRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: number;
}

const toSemester = (s: SemesterRow): Semester => ({
  id: s.id,
  name: s.name,
  startDate: s.start_date,
  endDate: s.end_date,
  isCurrent: s.is_current === 1,
});

export function listSemesters(db: DB): Semester[] {
  const rows = db.prepare('SELECT * FROM semesters ORDER BY start_date DESC, name').all() as unknown as SemesterRow[];
  return rows.map(toSemester);
}

export function getSemester(db: DB, id: string): Semester | undefined {
  const r = db.prepare('SELECT * FROM semesters WHERE id = ?').get(id) as SemesterRow | undefined;
  return r && toSemester(r);
}

export function currentSemester(db: DB): Semester | undefined {
  const r = db.prepare('SELECT * FROM semesters WHERE is_current = 1').get() as SemesterRow | undefined;
  return r && toSemester(r);
}

export function insertSemester(db: DB, name: string, startDate: string, endDate: string, makeCurrent: boolean): string {
  const id = uuid();
  if (makeCurrent) db.exec('UPDATE semesters SET is_current = 0');
  db.prepare('INSERT INTO semesters (id, name, start_date, end_date, is_current) VALUES (?, ?, ?, ?, ?)').run(
    id,
    name,
    startDate,
    endDate,
    makeCurrent ? 1 : 0,
  );
  return id;
}

// ---------- reservations ----------

interface ReservationRow {
  id: string;
  room_id: string;
  course: string;
  cat: Category;
  kind: Kind;
  date: string | null;
  weekday: number | null;
  start_min: number;
  end_min: number;
  semester_id: string | null;
  semester_name: string | null;
  term_start: string | null;
  term_end: string | null;
}

const RES_SELECT = `
  SELECT x.id, x.room_id, x.course, x.cat, x.kind, x.date, x.weekday, x.start_min, x.end_min, x.semester_id,
         s.name AS semester_name, s.start_date AS term_start, s.end_date AS term_end
    FROM reservations x LEFT JOIN semesters s ON s.id = x.semester_id`;

const toReservation = (r: ReservationRow): Reservation => ({
  id: r.id,
  roomId: r.room_id,
  course: r.course,
  cat: r.cat,
  kind: r.kind,
  date: r.date,
  weekday: r.weekday,
  start: r.start_min,
  end: r.end_min,
  semesterId: r.semester_id,
  semesterName: r.semester_name,
  termStart: r.term_start,
  termEnd: r.term_end,
});

/** FR-4.2 ordering: dated before weekly; then date or weekday ascending; then start time. */
export function compareReservations(a: Reservation, b: Reservation): number {
  if (a.kind !== b.kind) return a.kind === 'date' ? -1 : 1;
  const k = a.kind === 'date' ? (a.date as string).localeCompare(b.date as string) : (a.weekday as number) - (b.weekday as number);
  return k || a.start - b.start;
}

export function listReservations(db: DB, roomId?: string): Reservation[] {
  const rows = (
    roomId
      ? db.prepare(`${RES_SELECT} WHERE x.room_id = ?`).all(roomId)
      : db.prepare(RES_SELECT).all()
  ) as unknown as ReservationRow[];
  return rows.map(toReservation).sort(compareReservations);
}

export function getReservation(db: DB, id: string): Reservation | undefined {
  const r = db.prepare(`${RES_SELECT} WHERE x.id = ?`).get(id) as ReservationRow | undefined;
  return r && toReservation(r);
}

export const slotOf = (r: Reservation): Slot => ({
  kind: r.kind,
  date: r.date,
  weekday: r.weekday,
  start: r.start,
  end: r.end,
  termStart: r.termStart,
  termEnd: r.termEnd,
});

/** First existing booking in the room that clashes with `slot` (ignoring `excludeId`). */
export function findClash(db: DB, roomId: string, slot: Slot, excludeId?: string): Reservation | undefined {
  return listReservations(db, roomId).find((r) => r.id !== excludeId && clashes(slot, slotOf(r)));
}

export interface ReservationFields {
  course: string;
  cat: Category;
  kind: Kind;
  date: string | null;
  weekday: number | null;
  start: number;
  end: number;
  semesterId: string | null;
}

export function insertReservation(db: DB, roomId: string, f: ReservationFields): string {
  const id = uuid();
  db.prepare(
    `INSERT INTO reservations (id, room_id, course, cat, kind, date, weekday, start_min, end_min, semester_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, roomId, f.course, f.cat, f.kind, f.date, f.weekday, f.start, f.end, f.semesterId);
  return id;
}

export function updateReservation(db: DB, id: string, f: ReservationFields): void {
  db.prepare(
    `UPDATE reservations SET course = ?, cat = ?, kind = ?, date = ?, weekday = ?,
            start_min = ?, end_min = ?, semester_id = ? WHERE id = ?`,
  ).run(f.course, f.cat, f.kind, f.date, f.weekday, f.start, f.end, f.semesterId, id);
}
