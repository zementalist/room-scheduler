import { describeRange } from '../../shared/conflict.ts';
import { isValidDate } from '../../shared/time.ts';
import type { Reservation } from '../../shared/types.ts';
import { tx, type DB } from './db.ts';
import { badRequest, HttpError, notFound } from './errors.ts';
import {
  currentSemester,
  findClash,
  getReservation,
  getRoom,
  getSemester,
  insertReservation,
  updateReservation,
  type ReservationFields,
} from './repo.ts';

type Body = Record<string, unknown>;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Validate and normalise a reservation payload. Weekly bookings are bound to a semester. */
export function parseReservationBody(db: DB, body: unknown): ReservationFields {
  if (typeof body !== 'object' || body === null) throw badRequest('Request body must be a JSON object.');
  const b = body as Body;

  const kind = b.kind;
  if (kind !== 'date' && kind !== 'weekly') throw badRequest('kind must be "date" or "weekly".');
  const cat = b.cat ?? 'schedule';
  if (cat !== 'schedule' && cat !== 'event') throw badRequest('cat must be "schedule" or "event".');
  const course = typeof b.course === 'string' ? b.course.trim() : '';
  if (course.length > 200) throw badRequest('Course name is too long (max 200 characters).');

  if (!isInt(b.start) || !isInt(b.end)) throw badRequest('Start and end times are required.');
  if (b.start < 0 || b.end > 1440 || b.end <= b.start) {
    throw badRequest('Enter a start time earlier than the end time.');
  }

  let date: string | null = null;
  let weekday: number | null = null;
  let semesterId: string | null = null;
  if (kind === 'date') {
    if (!isValidDate(b.date)) throw badRequest('Pick a valid date.');
    date = b.date;
  } else {
    if (!isInt(b.weekday) || b.weekday < 0 || b.weekday > 6) throw badRequest('Pick a weekday.');
    weekday = b.weekday;
    const sem =
      typeof b.semesterId === 'string' && b.semesterId ? getSemester(db, b.semesterId) : currentSemester(db);
    if (!sem) throw badRequest('Weekly bookings need a semester. Create or choose a semester first.');
    semesterId = sem.id;
  }
  return { course, cat, kind, date, weekday, start: b.start, end: b.end, semesterId };
}

function slotFor(db: DB, f: ReservationFields) {
  const sem = f.semesterId ? getSemester(db, f.semesterId) : undefined;
  return {
    kind: f.kind,
    date: f.date,
    weekday: f.weekday,
    start: f.start,
    end: f.end,
    termStart: sem?.startDate ?? null,
    termEnd: sem?.endDate ?? null,
  };
}

function clashError(c: Reservation): HttpError {
  const label = c.course ? ` (${c.course})` : '';
  return new HttpError(409, 'clash', `Clash: already booked ${describeRange(c)}${label}.`, { conflictWith: c });
}

export function createReservation(db: DB, roomId: string, body: unknown): Reservation {
  return tx(db, () => {
    if (!getRoom(db, roomId)) throw notFound('Room not found.');
    const f = parseReservationBody(db, body);
    const c = findClash(db, roomId, slotFor(db, f));
    if (c) throw clashError(c);
    return getReservation(db, insertReservation(db, roomId, f)) as Reservation;
  });
}

export function editReservation(db: DB, id: string, body: unknown): Reservation {
  return tx(db, () => {
    const existing = getReservation(db, id);
    if (!existing) throw notFound('Reservation not found.');
    const f = parseReservationBody(db, body);
    const c = findClash(db, existing.roomId, slotFor(db, f), id);
    if (c) throw clashError(c);
    updateReservation(db, id, f);
    return getReservation(db, id) as Reservation;
  });
}
