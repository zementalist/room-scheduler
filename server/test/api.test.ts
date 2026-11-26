import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.ts';

const t = (h: number, m = 0) => h * 60 + m;

async function seed(call: Awaited<ReturnType<typeof makeApp>>['call']) {
  const room = (await call('POST', '/api/rooms', { name: 'B204', building: 'B', capacity: 40, type: 'Lab' })).body;
  const sem = (
    await call('POST', '/api/semesters', {
      name: 'Spring 2026',
      startDate: '2026-02-01',
      endDate: '2026-06-30',
      isCurrent: true,
    })
  ).body;
  return { room, sem };
}

test('public can read; mutations need admin login', async () => {
  const { call } = await makeApp();
  assert.equal((await call('GET', '/api/rooms', undefined, { anon: true })).status, 200);
  assert.equal((await call('GET', '/api/semesters', undefined, { anon: true })).status, 200);
  assert.equal((await call('POST', '/api/rooms', { name: 'X' }, { anon: true })).status, 401);
  assert.equal((await call('DELETE', '/api/data', undefined, { anon: true })).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, { anon: true })).body.admin, false);
  assert.equal((await call('GET', '/api/me')).body.admin, true);
});

test('login rejects wrong credentials and logout ends the session', async () => {
  const { app, call } = await makeApp();
  const bad = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'nope' } });
  assert.equal(bad.statusCode, 401);
  const unknown = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'x', password: 'correct-horse-battery' } });
  assert.equal(unknown.statusCode, 401);
  assert.equal((await call('POST', '/api/logout')).status, 200);
  assert.equal((await call('POST', '/api/rooms', { name: 'Y' })).status, 401);
});

test('cross-site Origin is rejected on state-changing requests', async () => {
  const { app, cookie } = await makeApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: { name: 'Evil' },
    headers: { cookie, origin: 'https://evil.example', host: 'rooms.example.edu' },
  });
  assert.equal(res.statusCode, 403);
});

test('room names are unique case- and whitespace-insensitively', async () => {
  const { call } = await makeApp();
  assert.equal((await call('POST', '/api/rooms', { name: 'B204' })).status, 201);
  const dup = await call('POST', '/api/rooms', { name: '  b204 ' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'duplicate');
});

test('weekly booking needs a semester; dated booking does not', async () => {
  const { call } = await makeApp();
  const room = (await call('POST', '/api/rooms', { name: 'A1' })).body;
  const w = await call('POST', `/api/rooms/${room.id}/reservations`, { kind: 'weekly', weekday: 1, start: t(9), end: t(10) });
  assert.equal(w.status, 400);
  const d = await call('POST', `/api/rooms/${room.id}/reservations`, { kind: 'date', date: '2026-03-02', start: t(9), end: t(10) });
  assert.equal(d.status, 201);
});

test('server-side clash matrix: weekly vs dated, back-to-back, outside term', async () => {
  const { call } = await makeApp();
  const { room } = await seed(call);
  const url = `/api/rooms/${room.id}/reservations`;
  const weekly = await call('POST', url, { kind: 'weekly', weekday: 1, start: t(9), end: t(10, 30), course: 'Phys 105' });
  assert.equal(weekly.status, 201);
  assert.equal(weekly.body.semesterName, 'Spring 2026');

  const clash = await call('POST', url, { kind: 'date', date: '2026-03-02', start: t(10), end: t(11) });
  assert.equal(clash.status, 409);
  assert.match(clash.body.message, /Every Monday, 09:00 to 10:30 \(Phys 105\)/);

  assert.equal((await call('POST', url, { kind: 'date', date: '2026-03-03', start: t(10), end: t(11) })).status, 201); // Tuesday
  assert.equal((await call('POST', url, { kind: 'date', date: '2026-03-02', start: t(10, 30), end: t(11) })).status, 201); // back-to-back
  assert.equal((await call('POST', url, { kind: 'date', date: '2026-09-07', start: t(9), end: t(10) })).status, 201); // Monday after term
});

test('input validation', async () => {
  const { call } = await makeApp();
  const { room } = await seed(call);
  const url = `/api/rooms/${room.id}/reservations`;
  assert.equal((await call('POST', url, { kind: 'date', date: '2026-03-02', start: t(10), end: t(9) })).status, 400);
  assert.equal((await call('POST', url, { kind: 'date', date: '2026-02-30', start: t(9), end: t(10) })).status, 400);
  assert.equal((await call('POST', url, { kind: 'date', start: t(9), end: t(10) })).status, 400);
  assert.equal((await call('POST', url, { kind: 'monthly', start: t(9), end: t(10) })).status, 400);
  assert.equal((await call('POST', '/api/rooms/nope/reservations', { kind: 'date', date: '2026-03-02', start: 1, end: 2 })).status, 404);
});

test('editing a booking ignores itself but still detects real clashes', async () => {
  const { call } = await makeApp();
  const { room } = await seed(call);
  const url = `/api/rooms/${room.id}/reservations`;
  const a = (await call('POST', url, { kind: 'date', date: '2026-03-02', start: t(9), end: t(10) })).body;
  const b = (await call('POST', url, { kind: 'date', date: '2026-03-02', start: t(11), end: t(12) })).body;
  const shift = await call('PATCH', `/api/reservations/${a.id}`, { kind: 'date', date: '2026-03-02', start: t(9, 15), end: t(10, 15), course: 'Moved' });
  assert.equal(shift.status, 200);
  assert.equal(shift.body.course, 'Moved');
  const bad = await call('PATCH', `/api/reservations/${b.id}`, { kind: 'date', date: '2026-03-02', start: t(10), end: t(11, 30) });
  assert.equal(bad.status, 409);
});

test('availability returns only free rooms; invalid input is rejected', async () => {
  const { call } = await makeApp();
  const { room } = await seed(call);
  const other = (await call('POST', '/api/rooms', { name: 'C1' })).body;
  await call('POST', `/api/rooms/${room.id}/reservations`, { kind: 'weekly', weekday: 1, start: t(9), end: t(10, 30) });
  const res = await call('GET', '/api/availability?date=2026-03-02&from=10:00&to=11:00', undefined, { anon: true });
  assert.deepEqual(res.body.rooms.map((r: { id: string }) => r.id), [other.id]);
  const free = await call('GET', '/api/availability?date=2026-03-03&from=10:00&to=11:00', undefined, { anon: true });
  assert.equal(free.body.rooms.length, 2);
  assert.equal((await call('GET', '/api/availability?date=2026-03-03&from=11:00&to=10:00', undefined, { anon: true })).status, 400);
});

test('room search covers name, building, type and course names', async () => {
  const { call } = await makeApp();
  const { room } = await seed(call);
  await call('POST', '/api/rooms', { name: 'C1', building: 'Science', type: 'Lecture' });
  await call('POST', `/api/rooms/${room.id}/reservations`, { kind: 'date', date: '2026-03-02', start: t(9), end: t(10), course: 'Quantum Physics' });
  const names = async (q: string) => (await call('GET', `/api/rooms?q=${encodeURIComponent(q)}`)).body.rooms.map((r: { name: string }) => r.name);
  assert.deepEqual(await names('quantum'), ['B204']);
  assert.deepEqual(await names('science'), ['C1']);
  assert.deepEqual(await names('lab'), ['B204']);
  assert.deepEqual(await names('b20'), ['B204']);
  assert.deepEqual(await names('%'), []); // LIKE wildcards are escaped
  assert.equal((await names('')).length, 2);
});

test('rooms sort naturally (B2 before B10)', async () => {
  const { call } = await makeApp();
  for (const n of ['B10', 'B2', 'B1']) await call('POST', '/api/rooms', { name: n });
  const names = (await call('GET', '/api/rooms')).body.rooms.map((r: { name: string }) => r.name);
  assert.deepEqual(names, ['B1', 'B2', 'B10']);
});

test('deleting a room removes its bookings; clear-room keeps the room', async () => {
  const { call } = await makeApp();
  const { room } = await seed(call);
  const url = `/api/rooms/${room.id}/reservations`;
  await call('POST', url, { kind: 'date', date: '2026-03-02', start: t(9), end: t(10) });
  await call('POST', url, { kind: 'date', date: '2026-03-03', start: t(9), end: t(10) });
  const cleared = await call('DELETE', url);
  assert.equal(cleared.body.deleted, 2);
  assert.equal((await call('GET', url)).body.reservations.length, 0);
  await call('POST', url, { kind: 'date', date: '2026-03-02', start: t(9), end: t(10) });
  const del = await call('DELETE', `/api/rooms/${room.id}`);
  assert.equal(del.body.bookingsDeleted, 1);
  assert.equal((await call('GET', '/api/summary')).body.schedule, 0);
});

test('rollover clears schedule bookings, keeps rooms and events, makes new term current', async () => {
  const { call } = await makeApp();
  const { room } = await seed(call);
  const url = `/api/rooms/${room.id}/reservations`;
  await call('POST', url, { kind: 'weekly', weekday: 1, start: t(9), end: t(10), cat: 'schedule' });
  await call('POST', url, { kind: 'date', date: '2026-03-04', start: t(9), end: t(10), cat: 'schedule' });
  await call('POST', url, { kind: 'date', date: '2026-03-05', start: t(9), end: t(10), cat: 'event', course: 'Guest lecture' });
  const roll = await call('POST', '/api/semesters/rollover', { name: 'Fall 2026', startDate: '2026-09-01', endDate: '2026-12-31' });
  assert.equal(roll.status, 200);
  assert.equal(roll.body.scheduleCleared, 2);
  const summary = (await call('GET', '/api/summary')).body;
  assert.deepEqual(summary, { rooms: 1, schedule: 0, events: 1 });
  const sems = (await call('GET', '/api/semesters')).body.semesters;
  assert.equal(sems.filter((s: { isCurrent: boolean }) => s.isCurrent).length, 1);
  assert.equal(sems.find((s: { isCurrent: boolean }) => s.isCurrent).name, 'Fall 2026');
});

test('extending a semester so it would clash is rejected and rolled back', async () => {
  const { call } = await makeApp();
  const { room, sem } = await seed(call);
  const url = `/api/rooms/${room.id}/reservations`;
  await call('POST', url, { kind: 'weekly', weekday: 1, start: t(9), end: t(10) });
  await call('POST', url, { kind: 'date', date: '2026-09-07', start: t(9), end: t(10) }); // Monday after term, allowed
  const res = await call('PATCH', `/api/semesters/${sem.id}`, { name: 'Spring 2026', startDate: '2026-02-01', endDate: '2026-12-31' });
  assert.equal(res.status, 409);
  const sems = (await call('GET', '/api/semesters')).body.semesters;
  assert.equal(sems[0].endDate, '2026-06-30');
});

test('semester with bookings cannot be deleted unless asked', async () => {
  const { call } = await makeApp();
  const { room, sem } = await seed(call);
  await call('POST', `/api/rooms/${room.id}/reservations`, { kind: 'weekly', weekday: 1, start: t(9), end: t(10) });
  assert.equal((await call('DELETE', `/api/semesters/${sem.id}`)).status, 409);
  const ok = await call('DELETE', `/api/semesters/${sem.id}?withBookings=true`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.bookingsDeleted, 1);
});

test('clear all data empties rooms and bookings but keeps semesters', async () => {
  const { call } = await makeApp();
  const { room } = await seed(call);
  await call('POST', `/api/rooms/${room.id}/reservations`, { kind: 'date', date: '2026-03-02', start: t(9), end: t(10) });
  const res = await call('DELETE', '/api/data');
  assert.deepEqual(res.body, { rooms: 1, reservations: 1 });
  assert.equal((await call('GET', '/api/semesters')).body.semesters.length, 1);
});
