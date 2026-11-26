import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiFail } from './apiError.ts';
import { Engine, emptyData, normalizeData, serialize } from './engine.ts';
import { parseWorkbook } from './excelParse.ts';
import { exportRows, workbookBytes } from './exportSheet.ts';
import type { ReservationInput } from './types.ts';

const dated = (date: string, start: number, end: number, course = ''): ReservationInput => ({ course, cat: 'schedule', kind: 'date', date, start, end });
const weekly = (weekday: number, start: number, end: number, course = '', semesterId?: string): ReservationInput => ({
  course,
  cat: 'schedule',
  kind: 'weekly',
  weekday,
  start,
  end,
  semesterId,
});
const room = (name: string, extra = {}) => ({ name, building: '', capacity: null, type: '', ...extra });

function fails(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, (e) => e instanceof ApiFail && e.status === status && e.code === code && e.payload?.error === code);
}

function seeded() {
  const e = new Engine();
  const a = e.createRoom(room('B204'));
  const b = e.createRoom(room('B10'));
  const sem = e.createSemester({ name: 'Spring', startDate: '2026-02-02', endDate: '2026-06-05', isCurrent: true });
  return { e, a, b, sem };
}

test('room names are unique ignoring case and spacing; capacity is validated', () => {
  const { e, a } = seeded();
  fails(() => e.createRoom(room('  b204 ')), 409, 'duplicate');
  fails(() => e.updateRoom(e.rooms().rooms.find((r) => r.name === 'B10')!.id, room('b204')), 409, 'duplicate');
  e.updateRoom(a.id, room('B204', { capacity: '40' })); // renaming to itself is fine; numeric strings accepted
  assert.equal(e.roomDetail(a.id).room.capacity, 40);
  fails(() => e.createRoom(room('X', { capacity: 1.5 })), 400, 'bad_request');
  fails(() => e.createRoom(room('')), 400, 'bad_request');
});

test('rooms sort naturally and search by name, building, type and course', () => {
  const { e, a } = seeded();
  e.createRoom(room('B2', { building: 'North', type: 'Lab' }));
  assert.deepEqual(e.rooms().rooms.map((r) => r.name), ['B2', 'B10', 'B204']);
  e.createReservation(a.id, dated('2026-03-02', 540, 600, 'Quantum Physics'));
  assert.deepEqual(e.rooms('quantum').rooms.map((r) => r.name), ['B204']);
  assert.deepEqual(e.rooms('north').rooms.map((r) => r.name), ['B2']);
  assert.deepEqual(e.rooms('LAB').rooms.map((r) => r.name), ['B2']);
  assert.equal(e.rooms().rooms.find((r) => r.id === a.id)!.bookingCount, 1);
});

test('same room clashes on overlap, but back-to-back and other rooms are fine', () => {
  const { e, a, b } = seeded();
  e.createReservation(a.id, dated('2026-03-02', 540, 600, 'Algebra'));
  e.createReservation(a.id, dated('2026-03-02', 600, 660)); // back to back
  e.createReservation(b.id, dated('2026-03-02', 540, 600)); // other room
  assert.throws(
    () => e.createReservation(a.id, dated('2026-03-02', 570, 630)),
    (err) => err instanceof ApiFail && err.status === 409 && err.code === 'clash' && /Algebra/.test(err.message) && err.payload?.conflictWith?.course === 'Algebra',
  );
  assert.equal(e.summary().schedule, 3); // the failed attempt left nothing behind
});

test('weekly bookings need a semester and are bounded by its term', () => {
  const { e, a, sem } = seeded();
  e.createReservation(a.id, weekly(1, 540, 600, 'Algebra')); // current semester used
  fails(() => e.createReservation(a.id, dated('2026-03-02', 570, 630)), 409, 'clash'); // Monday inside the term
  e.createReservation(a.id, dated('2026-08-03', 540, 600)); // Monday after the term
  e.createReservation(a.id, dated('2026-03-03', 540, 600)); // Tuesday
  const none = new Engine();
  const r = none.createRoom(room('A1'));
  fails(() => none.createReservation(r.id, weekly(1, 540, 600)), 400, 'bad_request');
  assert.equal(e.roomDetail(a.id).reservations.find((x) => x.kind === 'weekly')!.semesterName, sem.name);
});

test('editing a booking ignores itself; validation errors are 400', () => {
  const { e, a } = seeded();
  const r = e.createReservation(a.id, dated('2026-03-02', 540, 600));
  const edited = e.updateReservation(r.id, dated('2026-03-02', 550, 610, 'Edited'));
  assert.equal(edited.course, 'Edited');
  fails(() => e.updateReservation(r.id, dated('2026-03-02', 600, 600)), 400, 'bad_request');
  fails(() => e.updateReservation('nope', dated('2026-03-02', 600, 700)), 404, 'not_found');
  fails(() => e.createReservation(a.id, dated('2026-02-30', 600, 700)), 400, 'bad_request');
});

test('changing a semester that would create clashes is rolled back completely', () => {
  const { e, a, sem } = seeded();
  e.createReservation(a.id, weekly(1, 540, 600, 'Algebra'));
  const later = e.createSemester({ name: 'Summer', startDate: '2026-06-08', endDate: '2026-08-28' });
  e.createReservation(a.id, weekly(1, 540, 600, 'Geometry', later.id)); // same slot, disjoint term: allowed
  const before = serialize(e.data);
  fails(() => e.updateSemester(later.id, { name: 'Summer', startDate: '2026-05-01', endDate: '2026-08-28' }), 409, 'clash');
  assert.equal(serialize(e.data), before);
  assert.equal(e.semesters().semesters.find((s) => s.id === sem.id)!.isCurrent, true);
});

test('only one semester is current; deleting one in use needs confirmation', () => {
  const { e, a, sem } = seeded();
  const other = e.createSemester({ name: 'Fall', startDate: '2026-09-01', endDate: '2026-12-18', isCurrent: true });
  assert.deepEqual(e.semesters().semesters.filter((s) => s.isCurrent).map((s) => s.name), ['Fall']);
  assert.deepEqual(e.semesters().semesters.map((s) => s.name), ['Fall', 'Spring']); // newest first
  e.createReservation(a.id, weekly(2, 540, 600, '', sem.id));
  assert.throws(
    () => e.deleteSemester(sem.id, false),
    (err) => err instanceof ApiFail && err.status === 409 && err.code === 'semester_in_use' && (err.payload as unknown as { bookings: number }).bookings === 1,
  );
  assert.deepEqual(e.deleteSemester(sem.id, true), { deleted: 1, bookingsDeleted: 1 });
  assert.equal(e.deleteSemester(other.id, false).bookingsDeleted, 0);
});

test('rollover clears schedule bookings, keeps events and rooms, and makes the new term current', () => {
  const { e, a } = seeded();
  e.createReservation(a.id, weekly(1, 540, 600, 'Algebra'));
  e.createReservation(a.id, { course: 'Open day', cat: 'event', kind: 'date', date: '2026-04-01', start: 600, end: 700 });
  const r = e.rollover({ name: 'Fall', startDate: '2026-09-01', endDate: '2026-12-18', clearSchedule: true });
  assert.equal(r.scheduleCleared, 1);
  assert.equal(r.current, true);
  assert.deepEqual(e.summary(), { rooms: 2, schedule: 0, events: 1 });
});

test('clearing a room, deleting a room, and clearing everything', () => {
  const { e, a, b } = seeded();
  e.createReservation(a.id, dated('2026-03-02', 540, 600));
  e.createReservation(a.id, dated('2026-03-03', 540, 600));
  e.createReservation(b.id, dated('2026-03-02', 540, 600));
  assert.deepEqual(e.clearRoom(a.id), { deleted: 2 });
  assert.deepEqual(e.deleteRoom(b.id), { deleted: 'B10', bookingsDeleted: 1 });
  e.createReservation(a.id, dated('2026-03-02', 540, 600));
  assert.deepEqual(e.clearAll(), { rooms: 1, reservations: 1 });
  assert.equal(e.semesters().semesters.length, 1); // semesters survive
  fails(() => e.roomDetail(a.id), 404, 'not_found');
});

test('availability lists rooms with no clash for the probe', () => {
  const { e, a, b } = seeded();
  e.createReservation(a.id, dated('2026-03-02', 540, 600));
  e.createReservation(b.id, weekly(1, 700, 760));
  assert.deepEqual(e.availability('2026-03-02', '09:30', '10:30').rooms.map((r) => r.name), ['B10']);
  // 2026-03-02 is a Monday: B10's weekly 11:40-12:40 slot makes it busy, B204 is free after its 09:00-10:00 booking.
  assert.deepEqual(e.availability('2026-03-02', '11:40', '12:00').rooms.map((r) => r.name), ['B204']);
  fails(() => e.availability('2026-03-02', '10:30', '09:30'), 400, 'bad_request');
});

test('a failed change never leaves partial data (atomic)', () => {
  const { e, a } = seeded();
  const before = serialize(e.data);
  fails(() => e.createReservation(a.id, weekly(9, 540, 600)), 400, 'bad_request');
  fails(() => e.createSemester({ name: 'X', startDate: '2026-05-01', endDate: '2026-04-01' }), 400, 'bad_request');
  assert.equal(serialize(e.data), before);
});

test('export then import reproduces the same schedule (round trip through .xlsx bytes)', () => {
  const { e, a, b } = seeded();
  e.updateRoom(a.id, room('B204', { building: 'North', capacity: 40, type: 'Lab' }));
  e.createReservation(a.id, weekly(1, 540, 630, 'PHYS 105'));
  e.createReservation(a.id, { course: 'Guest, "lecture"', cat: 'event', kind: 'date', date: '2026-03-12', start: 840, end: 960 });
  void b; // B10 stays an empty room

  const d = e.exportData();
  const parsed = parseWorkbook(workbookBytes(exportRows(d.rooms, d.reservations)));
  assert.equal(parsed.orphanRows.length, 0);

  const fresh = new Engine(structuredClone({ ...emptyData(), semesters: e.data.semesters }));
  const { plan, summary } = fresh.planImport(parsed, 'merge', null);
  assert.equal(summary.reservations.conflicts + summary.reservations.skipped, 0);
  fresh.applyPlan(plan);

  const flat = (x: Engine) => ({
    rooms: x.rooms().rooms.map(({ name, building, capacity, type, bookingCount }) => ({ name, building, capacity, type, bookingCount })),
    bookings: x.exportData().reservations.map(({ course, cat, kind, date, weekday, start, end, semesterName }) => ({ course, cat, kind, date, weekday, start, end, semesterName })),
  });
  assert.deepEqual(flat(fresh), flat(e));
});

test('import merge skips clashing and duplicate rows; replace discards first', () => {
  const { e, a } = seeded();
  e.createReservation(a.id, dated('2026-03-02', 540, 600, 'Algebra'));
  const rows = [
    ['Room', 'Course', 'Date', 'Start', 'End'],
    ['B204', 'Algebra', '2026-03-02', '09:00', '10:00'], // duplicate
    ['B204', 'Clasher', '2026-03-02', '09:30', '10:30'], // clash
    ['B204', 'Fine', '2026-03-02', '10:00', '11:00'],
    ['New1', '', '', '', ''], // room only
  ];
  const parsed = parseWorkbook(workbookBytes(rows as (string | number)[][]));
  const merge = e.planImport(parsed, 'merge', null).summary;
  assert.deepEqual(merge.reservations, { valid: 1, duplicates: 1, skipped: 0, conflicts: 1 });
  assert.deepEqual(merge.rooms, { new: 1, updated: 1 });
  const replace = e.planImport(parsed, 'replace', null);
  assert.deepEqual(replace.summary.removal, { rooms: 2, reservations: 1 });
  e.applyPlan(replace.plan);
  assert.deepEqual(e.rooms().rooms.map((r) => r.name), ['B204', 'New1']);
  assert.equal(e.summary().schedule, 2); // Algebra (re-added) + Fine; the clash is still rejected
  fails(() => e.planImport(parsed, 'merge', 'no-such-semester'), 400, 'bad_request');
});

test('CSV with non-ASCII text survives the browser-style (array) read', () => {
  const csv = new TextEncoder().encode('Room,Course,Date,Start,End\nÆ-101,Café économie,2026-03-02,09:00,10:00\n');
  const parsed = parseWorkbook(csv);
  assert.equal(parsed.rows[0]!.room, 'Æ-101');
  assert.equal(parsed.rows[0]!.course, 'Café économie');

  const withBom = parseWorkbook(new Uint8Array([0xef, 0xbb, 0xbf, ...csv]));
  assert.equal(withBom.recognised.room, 'Room'); // BOM must not poison the first header

  const latin1 = parseWorkbook(Uint8Array.from('Room,Course,Date,Start,End\nA1,Café,2026-03-02,09:00,10:00\n', (c) => c.charCodeAt(0)));
  assert.equal(latin1.rows[0]!.course, 'Café'); // legacy Excel "CSV" (Windows-1252)
});

test('the repository file is stable and strictly validated', () => {
  const { e, a } = seeded();
  e.createReservation(a.id, dated('2026-03-03', 540, 600));
  e.createReservation(a.id, dated('2026-03-02', 540, 600));
  const text = serialize(e.data);
  assert.equal(serialize(normalizeData(JSON.parse(text))), text); // idempotent => no noisy diffs
  assert.ok(text.endsWith('\n'));
  assert.ok(text.indexOf('2026-03-02') < text.indexOf('2026-03-03')); // bookings sorted
  assert.throws(() => normalizeData({ version: 2, rooms: [], semesters: [], reservations: [] }));
  assert.throws(() => normalizeData(null));
  assert.throws(() => normalizeData({ version: 1, rooms: {} }));
});
