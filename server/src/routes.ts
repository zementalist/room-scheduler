import type { FastifyInstance } from 'fastify';
import { clashes } from '../../shared/conflict.ts';
import { cleanName, isValidDate, parseHHMM } from '../../shared/time.ts';
import type { AppContext } from './app.ts';
import { checkLogin, createSession, destroySession, SESSION_COOKIE, SESSION_TTL_MS, sessionUser } from './auth.ts';
import { tx, type DB } from './db.ts';
import { badRequest, HttpError, notFound } from './errors.ts';
import { createReservation, editReservation } from './reservations.ts';
import {
  currentSemester,
  findRoomByName,
  getReservation,
  getRoom,
  getSemester,
  insertRoom,
  insertSemester,
  listReservations,
  listRooms,
  listSemesters,
  slotOf,
  updateRoom,
  type RoomFields,
} from './repo.ts';

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

function assertRoomNameFree(db: DB, name: string, selfId?: string) {
  const dup = findRoomByName(db, name);
  if (dup && dup.id !== selfId) throw new HttpError(409, 'duplicate', `A room named "${dup.name}" already exists.`);
}

interface SemesterBody {
  name: string;
  startDate: string;
  endDate: string;
}

function parseSemesterBody(b: Body): SemesterBody {
  const name = str(b.name, 'Semester name', 100, true);
  if (!isValidDate(b.startDate) || !isValidDate(b.endDate)) throw badRequest('Start and end dates are required.');
  if (b.endDate < b.startDate) throw badRequest('The end date must not be before the start date.');
  return { name, startDate: b.startDate, endDate: b.endDate };
}

/** After changing a semester's dates, make sure no room now holds clashing bookings. */
function assertNoClashesInSemester(db: DB, semesterId: string) {
  const roomIds = db.prepare('SELECT DISTINCT room_id FROM reservations WHERE semester_id = ?').all(semesterId) as {
    room_id: string;
  }[];
  for (const { room_id } of roomIds) {
    const list = listReservations(db, room_id);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (clashes(slotOf(list[i]!), slotOf(list[j]!))) {
          throw new HttpError(409, 'clash', 'Those dates would create booking clashes in room ' + getRoom(db, room_id)?.name + '.');
        }
      }
    }
  }
}

export function registerRoutes(app: FastifyInstance, { db, config, requireAdmin }: AppContext): void {
  const admin = { preHandler: requireAdmin };

  app.get('/api/health', async () => ({ ok: true }));

  // ----- auth -----
  app.post('/api/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = asBody(req.body);
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (!checkLogin(db, username, password)) {
      throw new HttpError(401, 'invalid_credentials', 'Wrong username or password.');
    }
    const token = createSession(db, username);
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: SESSION_TTL_MS / 1000,
    });
    return { admin: true, username };
  });

  app.post('/api/logout', async (req, reply) => {
    destroySession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { admin: false };
  });

  app.get('/api/me', async (req) => {
    const username = sessionUser(db, req.cookies[SESSION_COOKIE]);
    return { admin: username !== null, username };
  });

  // ----- public reads -----
  app.get('/api/summary', async () => {
    const r = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM rooms) AS rooms,
                (SELECT COUNT(*) FROM reservations WHERE cat = 'schedule') AS schedule,
                (SELECT COUNT(*) FROM reservations WHERE cat = 'event') AS events`,
      )
      .get() as { rooms: number; schedule: number; events: number };
    return r;
  });

  app.get('/api/rooms', async (req) => {
    const q = typeof (req.query as Body).q === 'string' ? ((req.query as Body).q as string) : '';
    return { rooms: listRooms(db, q) };
  });

  app.get('/api/rooms/:id/reservations', async (req) => {
    const { id } = req.params as { id: string };
    const room = getRoom(db, id);
    if (!room) throw notFound('Room not found.');
    return { room, reservations: listReservations(db, id) };
  });

  app.get('/api/semesters', async () => ({ semesters: listSemesters(db) }));

  /** BR-5: rooms free on `date` between `from` and `to` (HH:MM). */
  app.get('/api/availability', async (req) => {
    const { date, from, to } = req.query as Record<string, string | undefined>;
    const f = parseHHMM(from);
    const t = parseHHMM(to);
    if (!isValidDate(date) || f === null || t === null || t <= f) {
      throw badRequest('Provide a valid date and a from/to time with to later than from.');
    }
    const probe = { kind: 'date' as const, date, start: f, end: t };
    const busy = new Set<string>();
    for (const r of listReservations(db)) if (clashes(probe, slotOf(r))) busy.add(r.roomId);
    return { rooms: listRooms(db).filter((r) => !busy.has(r.id)) };
  });

  // ----- rooms (admin) -----
  app.post('/api/rooms', admin, async (req, reply) => {
    const f = parseRoomBody(req.body);
    const id = tx(db, () => {
      assertRoomNameFree(db, f.name);
      return insertRoom(db, f);
    });
    return reply.code(201).send(getRoom(db, id));
  });

  app.patch('/api/rooms/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const f = parseRoomBody(req.body);
    tx(db, () => {
      if (!getRoom(db, id)) throw notFound('Room not found.');
      assertRoomNameFree(db, f.name, id);
      updateRoom(db, id, f);
    });
    return getRoom(db, id);
  });

  app.delete('/api/rooms/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const room = getRoom(db, id);
    if (!room) throw notFound('Room not found.');
    db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
    return { deleted: room.name, bookingsDeleted: room.bookingCount };
  });

  app.delete('/api/rooms/:id/reservations', admin, async (req) => {
    const { id } = req.params as { id: string };
    if (!getRoom(db, id)) throw notFound('Room not found.');
    const r = db.prepare('DELETE FROM reservations WHERE room_id = ?').run(id);
    return { deleted: Number(r.changes) };
  });

  // ----- reservations (admin) -----
  app.post('/api/rooms/:id/reservations', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.code(201).send(createReservation(db, id, req.body));
  });

  app.patch('/api/reservations/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    return editReservation(db, id, req.body);
  });

  app.delete('/api/reservations/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    if (!getReservation(db, id)) throw notFound('Reservation not found.');
    db.prepare('DELETE FROM reservations WHERE id = ?').run(id);
    return { deleted: 1 };
  });

  // ----- semesters (admin) -----
  app.post('/api/semesters', admin, async (req, reply) => {
    const b = asBody(req.body);
    const s = parseSemesterBody(b);
    const id = tx(db, () => insertSemester(db, s.name, s.startDate, s.endDate, b.isCurrent === true));
    return reply.code(201).send(getSemester(db, id));
  });

  app.patch('/api/semesters/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const b = asBody(req.body);
    const s = parseSemesterBody(b);
    tx(db, () => {
      if (!getSemester(db, id)) throw notFound('Semester not found.');
      if (b.isCurrent === true) db.exec('UPDATE semesters SET is_current = 0');
      db.prepare(
        'UPDATE semesters SET name = ?, start_date = ?, end_date = ?, is_current = CASE WHEN ? THEN 1 ELSE is_current END WHERE id = ?',
      ).run(s.name, s.startDate, s.endDate, b.isCurrent === true ? 1 : 0, id);
      assertNoClashesInSemester(db, id);
    });
    return getSemester(db, id);
  });

  app.delete('/api/semesters/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const withBookings = (req.query as Body).withBookings === 'true';
    return tx(db, () => {
      if (!getSemester(db, id)) throw notFound('Semester not found.');
      const n = (db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE semester_id = ?').get(id) as { n: number }).n;
      if (n > 0 && !withBookings) {
        throw new HttpError(409, 'semester_in_use', `This semester has ${n} weekly booking(s). Delete them with the semester or clear them first.`, {
          bookings: n,
        });
      }
      db.prepare('DELETE FROM reservations WHERE semester_id = ?').run(id);
      db.prepare('DELETE FROM semesters WHERE id = ?').run(id);
      return { deleted: 1, bookingsDeleted: n };
    });
  });

  /**
   * FR-8.1 "Begin new semester": create the new term and make it current; by default clear every
   * schedule booking while keeping rooms and events.
   */
  app.post('/api/semesters/rollover', admin, async (req) => {
    const b = asBody(req.body);
    const s = parseSemesterBody(b);
    const clearSchedule = b.clearSchedule !== false;
    return tx(db, () => {
      let cleared = 0;
      if (clearSchedule) cleared = Number(db.prepare("DELETE FROM reservations WHERE cat = 'schedule'").run().changes);
      const id = insertSemester(db, s.name, s.startDate, s.endDate, true);
      return { semester: getSemester(db, id), scheduleCleared: cleared, current: currentSemester(db)?.id === id };
    });
  });

  // ----- destructive reset (admin) -----
  /** FR-8.2 "Clear all data": rooms and bookings. Semesters and the admin account are kept. */
  app.delete('/api/data', admin, async () => {
    return tx(db, () => {
      const res = Number(db.prepare('DELETE FROM reservations').run().changes);
      const rooms = Number(db.prepare('DELETE FROM rooms').run().changes);
      return { rooms, reservations: res };
    });
  });
}
