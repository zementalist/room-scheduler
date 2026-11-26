import { tx, type DB } from './db.ts';
import { insertReservation, insertRoom, listReservations, listRooms, listSemesters, updateRoom } from './repo.ts';
import type { ImportPlan, Snapshot } from '../../shared/importPlan.ts';

// Planning is pure and shared with the browser (static edition); only the SQLite parts live here.
export * from '../../shared/importPlan.ts';

export function takeSnapshot(db: DB): Snapshot {
  return { rooms: listRooms(db), reservations: listReservations(db), semesters: listSemesters(db) };
}

/** Apply a plan atomically. Replace wipes rooms and bookings first; semesters are never touched. */
export function applyPlan(db: DB, plan: ImportPlan): void {
  tx(db, () => {
    if (plan.mode === 'replace') {
      db.exec('DELETE FROM reservations');
      db.exec('DELETE FROM rooms');
    }
    const ids = new Map<string, string>();
    for (const [id, f] of plan.update) updateRoom(db, id, f);
    for (const [key, f] of plan.create) ids.set(key, insertRoom(db, f));
    for (const r of db.prepare('SELECT id, name_norm FROM rooms').all() as { id: string; name_norm: string }[]) {
      ids.set(r.name_norm, r.id);
    }
    for (const r of plan.add) {
      insertReservation(db, ids.get(r.roomKey) as string, {
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
