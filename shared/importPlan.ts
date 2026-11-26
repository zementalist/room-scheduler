// Pure import planning, shared by the server (SQLite) and the static edition (JSON in the browser).
import { clashes, describeRange, type Slot } from './conflict.ts';
import { cleanName, roomKey } from './time.ts';
import type { Category, Kind, Reservation, RoomFields, Semester } from './types.ts';
import type { ParsedFile } from './excelParse.ts';

export type ImportMode = 'merge' | 'replace';

export interface Snapshot {
  rooms: { id: string; name: string; building: string; capacity: number | null; type: string }[];
  reservations: Reservation[];
  semesters: Semester[];
}

export interface Diagnostic {
  sheet: string;
  row: number;
  reason: string;
}

export interface PlannedReservation {
  roomKey: string;
  course: string;
  cat: Category;
  kind: Kind;
  date: string | null;
  weekday: number | null;
  start: number;
  end: number;
  semesterId: string | null;
}

export interface ImportPlan {
  mode: ImportMode;
  /** Rooms to create (key -> fields) and existing rooms to update (id -> fields). */
  create: Map<string, RoomFields>;
  update: Map<string, RoomFields>;
  add: PlannedReservation[];
  skipped: Diagnostic[];
  conflicts: Diagnostic[];
  duplicates: number;
  /** What Replace mode discards; zero for Merge. */
  removal: { rooms: number; reservations: number };
}

export interface ImportSummary {
  mode: ImportMode;
  rooms: { new: number; updated: number };
  reservations: { valid: number; duplicates: number; skipped: number; conflicts: number };
  removal: { rooms: number; reservations: number };
  skipped: Diagnostic[];
  conflicts: Diagnostic[];
  truncated: boolean;
}

const sameBooking = (a: PlannedReservation, b: PlannedReservation) =>
  a.cat === b.cat &&
  a.kind === b.kind &&
  a.date === b.date &&
  a.weekday === b.weekday &&
  a.start === b.start &&
  a.end === b.end &&
  a.semesterId === b.semesterId &&
  a.course.toLowerCase() === b.course.toLowerCase();

/**
 * Decide what importing `file` would do. Pure: reads only the snapshot.
 *  - merge:   upsert rooms (never deletes), add bookings that do not clash.
 *  - replace: discard all existing rooms and bookings first (reported in `removal`).
 * Clashes are checked against existing bookings AND earlier rows of the same file.
 */
export function planImport(
  file: ParsedFile,
  mode: ImportMode,
  defaultSemester: Semester | undefined,
  snap: Snapshot,
): ImportPlan {
  const plan: ImportPlan = {
    mode,
    create: new Map(),
    update: new Map(),
    add: [],
    skipped: file.orphanRows.map((o) => ({ ...o })),
    conflicts: [],
    duplicates: 0,
    removal: mode === 'replace' ? { rooms: snap.rooms.length, reservations: snap.reservations.length } : { rooms: 0, reservations: 0 },
  };

  const existingRooms = mode === 'merge' ? snap.rooms : [];
  const roomByKey = new Map(existingRooms.map((r) => [roomKey(r.name), r]));
  const semByName = new Map(snap.semesters.map((s) => [s.name.toLowerCase(), s]));

  // Working bookings per room key: existing (merge only) then accepted rows.
  interface Working extends PlannedReservation {
    slot: Slot;
  }
  const working = new Map<string, Working[]>();
  if (mode === 'merge') {
    const keyById = new Map(snap.rooms.map((r) => [r.id, roomKey(r.name)]));
    for (const r of snap.reservations) {
      const key = keyById.get(r.roomId);
      if (!key) continue;
      const list = working.get(key) ?? [];
      list.push({
        roomKey: key,
        course: r.course,
        cat: r.cat,
        kind: r.kind,
        date: r.date,
        weekday: r.weekday,
        start: r.start,
        end: r.end,
        semesterId: r.semesterId,
        slot: { kind: r.kind, date: r.date, weekday: r.weekday, start: r.start, end: r.end, termStart: r.termStart, termEnd: r.termEnd },
      });
      working.set(key, list);
    }
  }

  // Room metadata first (later non-empty values win, FR-1.3), so rooms exist even if their booking row is skipped.
  const meta = new Map<string, RoomFields>();
  for (const row of file.rows) {
    const key = roomKey(row.room);
    const m = meta.get(key) ?? { name: cleanName(row.room), building: '', capacity: null, type: '' };
    if (row.building) m.building = row.building;
    if (row.capacity !== null) m.capacity = row.capacity;
    if (row.type) m.type = row.type;
    meta.set(key, m);
  }
  for (const [key, m] of meta) {
    const existing = roomByKey.get(key);
    if (existing) {
      plan.update.set(existing.id, {
        name: existing.name,
        building: m.building || existing.building,
        capacity: m.capacity ?? existing.capacity,
        type: m.type || existing.type,
      });
    } else {
      plan.create.set(key, m);
    }
  }

  for (const row of file.rows) {
    if (!row.hasBookingInfo) continue;
    const where = { sheet: row.sheet, row: row.row };
    if (row.problems.length) {
      plan.skipped.push({ ...where, reason: row.problems.join('; ') });
      continue;
    }
    const day = row.day!;
    let semester: Semester | undefined;
    if (day.kind === 'weekly') {
      if (row.semesterName) {
        semester = semByName.get(row.semesterName.toLowerCase());
        if (!semester) {
          plan.skipped.push({ ...where, reason: `Unknown semester "${row.semesterName}" (create it first)` });
          continue;
        }
      } else {
        semester = defaultSemester;
        if (!semester) {
          plan.skipped.push({ ...where, reason: 'Weekly booking needs a semester (none selected or current)' });
          continue;
        }
      }
    }
    const key = roomKey(row.room);
    const planned: PlannedReservation = {
      roomKey: key,
      course: row.course,
      cat: row.cat,
      kind: day.kind,
      date: day.kind === 'date' ? day.date : null,
      weekday: day.kind === 'weekly' ? day.weekday : null,
      start: row.start!,
      end: row.end!,
      semesterId: semester?.id ?? null,
    };
    const slot: Slot = {
      kind: planned.kind,
      date: planned.date,
      weekday: planned.weekday,
      start: planned.start,
      end: planned.end,
      termStart: semester?.startDate ?? null,
      termEnd: semester?.endDate ?? null,
    };
    const list = working.get(key) ?? [];
    if (list.some((w) => sameBooking(w, planned))) {
      plan.duplicates++;
      continue;
    }
    const other = list.find((w) => clashes(slot, w.slot));
    if (other) {
      plan.conflicts.push({ ...where, reason: `${row.room}: clashes with ${describeRange(other.slot)}${other.course ? ` (${other.course})` : ''}` });
      continue;
    }
    list.push({ ...planned, slot });
    working.set(key, list);
    plan.add.push(planned);
  }
  return plan;
}

const CAP = 200;

export function summarize(plan: ImportPlan): ImportSummary {
  return {
    mode: plan.mode,
    rooms: { new: plan.create.size, updated: plan.update.size },
    reservations: {
      valid: plan.add.length,
      duplicates: plan.duplicates,
      skipped: plan.skipped.length,
      conflicts: plan.conflicts.length,
    },
    removal: plan.removal,
    skipped: plan.skipped.slice(0, CAP),
    conflicts: plan.conflicts.slice(0, CAP),
    truncated: plan.skipped.length > CAP || plan.conflicts.length > CAP,
  };
}