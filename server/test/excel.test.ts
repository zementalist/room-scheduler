import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseWorkbook, parseDayCell, parseTimeCell } from '../src/excelParse.ts';
import { makeApp, type TestApp } from './helpers.ts';

type Cell = string | number | { v: number; z: string } | null;

/** Build an .xlsx buffer; {v,z} makes a number cell with a number format (date/time cells). */
function workbook(rows: Cell[][], sheetName = 'Rooms'): Buffer {
  const ws: XLSX.WorkSheet = {};
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell === null) return;
      const ref = XLSX.utils.encode_cell({ r, c });
      if (typeof cell === 'string') ws[ref] = { t: 's', v: cell };
      else if (typeof cell === 'number') ws[ref] = { t: 'n', v: cell };
      else ws[ref] = { t: 'n', v: cell.v, z: cell.z };
    }),
  );
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: Math.max(...rows.map((r) => r.length)) - 1 } });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const serial = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
const HEAD = ['Room', 'Building', 'Capacity', 'Type', 'Course', 'Category', 'Date', 'Start', 'End'];

function multipart(fields: Record<string, string>, file: { name: string; data: Buffer }) {
  const boundary = '----t' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(t: TestApp, data: Buffer, mode: string, step: 'preview' | 'confirm', extra: Record<string, string> = {}, name = 'rooms.xlsx') {
  const mp = multipart({ mode, ...extra }, { name, data });
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/import/preview',
    payload: mp.payload,
    headers: { cookie: t.cookie, 'content-type': mp.contentType },
  });
  const preview = JSON.parse(res.body);
  if (step === 'preview' || res.statusCode !== 200) return { status: res.statusCode, body: preview };
  const c = await t.call('POST', '/api/import/confirm', { token: preview.token });
  return { status: c.status, body: c.body, preview };
}

// ---------- parser ----------

test('headers match exactly, not by substring', () => {
  const buf = workbook([
    ['Room', 'Weekend plan', 'Update', 'Prototype', 'Date', 'Start', 'End'],
    ['A1', 'x', 'x', 'x', '2026-03-02', '09:00', '10:00'],
  ]);
  const p = parseWorkbook(buf);
  assert.equal(p.recognised.end, 'End');
  assert.equal(p.recognised.date, 'Date');
  assert.equal(p.recognised.type, undefined);
  assert.deepEqual(p.ignoredColumns.sort(), ['Prototype', 'Update', 'Weekend plan']);
});

test('time cells: fraction, integer hours, formatted, text, am/pm, ambiguous', () => {
  const ok = (v: number) => ({ ok: v });
  assert.deepEqual(parseTimeCell({ t: 'n', v: 0.375 }), ok(540)); // 09:00 as day fraction
  assert.deepEqual(parseTimeCell({ t: 'n', v: 9 }), ok(540)); // integer hours (was 00:00 in the prototype)
  assert.deepEqual(parseTimeCell({ t: 'n', v: 46113.5, z: 'yyyy-mm-dd h:mm' }), ok(720)); // date-time -> 12:00
  assert.deepEqual(parseTimeCell({ t: 's', v: '9:30 pm' }), ok(21 * 60 + 30));
  assert.deepEqual(parseTimeCell({ t: 's', v: '12am' }), ok(0));
  assert.deepEqual(parseTimeCell({ t: 's', v: '14.05' }), ok(14 * 60 + 5));
  assert.deepEqual(parseTimeCell({ t: 's', v: '09:00:00' }), ok(540));
  assert.ok('error' in (parseTimeCell({ t: 'n', v: 9.5 }) as object));
  assert.ok('error' in (parseTimeCell({ t: 's', v: '25:00' }) as object));
  assert.ok('error' in (parseTimeCell({ t: 's', v: 'soon' }) as object));
  assert.equal(parseTimeCell({ t: 's', v: '  ' }), null);
});

test('day cells: date serial, ISO text, weekday names, textual dates, ambiguous slashes', () => {
  assert.deepEqual(parseDayCell({ t: 'n', v: serial(2026, 3, 2), z: 'yyyy-mm-dd' }), { ok: { kind: 'date', date: '2026-03-02' } });
  assert.deepEqual(parseDayCell({ t: 's', v: '2026-03-02' }), { ok: { kind: 'date', date: '2026-03-02' } });
  assert.deepEqual(parseDayCell({ t: 's', v: 'Monday' }), { ok: { kind: 'weekly', weekday: 1 } });
  assert.deepEqual(parseDayCell({ t: 's', v: 'thu' }), { ok: { kind: 'weekly', weekday: 4 } });
  assert.deepEqual(parseDayCell({ t: 's', v: 'Every Sunday' }), { ok: { kind: 'weekly', weekday: 0 } });
  assert.deepEqual(parseDayCell({ t: 's', v: '3 Mar 2026' }), { ok: { kind: 'date', date: '2026-03-03' } });
  assert.ok('error' in (parseDayCell({ t: 's', v: '03/04/2026' }) as object)); // ambiguous D/M vs M/D
  assert.ok('error' in (parseDayCell({ t: 's', v: '2026-02-30' }) as object));
  assert.ok('error' in (parseDayCell({ t: 'n', v: 0.5, z: 'h:mm' }) as object));
});

// ---------- import through the API ----------

test('acceptance 1: 10 rooms, 5 schedule rows, 2 event rows -> 10 rooms, 7 bookings, 0 skipped', async () => {
  const t = await makeApp();
  await t.call('POST', '/api/semesters', { name: 'Spring 2026', startDate: '2026-02-01', endDate: '2026-06-30', isCurrent: true });
  const rows: Cell[][] = [HEAD];
  for (let i = 1; i <= 10; i++) rows.push([`R${i}`, 'B', 30, 'Lab', null, null, null, null, null]);
  for (let i = 1; i <= 5; i++) rows.push([`R${i}`, null, null, null, `Course ${i}`, 'Schedule', 'Monday', '09:00', '10:00']);
  for (let i = 1; i <= 2; i++) rows.push([`R${i}`, null, null, null, `Event ${i}`, 'Event', '2026-03-12', '14:00', '15:00']);
  const res = await upload(t, workbook(rows), 'merge', 'confirm');
  assert.equal(res.status, 200);
  assert.equal(res.body.rooms.new, 10);
  assert.equal(res.body.reservations.valid, 7);
  assert.equal(res.body.reservations.skipped, 0);
  assert.deepEqual((await t.call('GET', '/api/summary')).body, { rooms: 10, schedule: 5, events: 2 });
});

test('acceptance 2: room with end before start is created, row skipped with a reason', async () => {
  const t = await makeApp();
  const res = await upload(t, workbook([HEAD, ['A1', 'B', 20, 'Lab', 'Bad', 'Schedule', '2026-03-02', '10:00', '09:00']]), 'merge', 'confirm');
  assert.equal(res.body.rooms.new, 1);
  assert.equal(res.body.reservations.valid, 0);
  assert.equal(res.body.skipped.length, 1);
  assert.equal(res.body.skipped[0].row, 2);
  assert.match(res.body.skipped[0].reason, /End time must be later/);
  assert.equal((await t.call('GET', '/api/rooms')).body.rooms.length, 1);
});

test('rows are reported, not silently dropped: missing room, partial booking, unknown semester', async () => {
  const t = await makeApp();
  const rows: Cell[][] = [
    [...HEAD, 'Semester'],
    [null, null, null, null, 'Orphan', null, '2026-03-02', '09:00', '10:00', null],
    ['A1', null, null, null, 'No times', null, '2026-03-02', null, null, null],
    ['A1', null, null, null, 'Weekly', null, 'Monday', '09:00', '10:00', 'Nonexistent'],
    ['A1', null, null, null, 'Fine', null, '2026-03-02', '11:00', '12:00', null],
  ];
  const res = await upload(t, workbook(rows), 'merge', 'preview');
  assert.equal(res.body.reservations.valid, 1);
  const reasons = res.body.skipped.map((s: { reason: string }) => s.reason).join(' | ');
  assert.match(reasons, /Missing room name/);
  assert.match(reasons, /Missing start time; Missing end time/);
  assert.match(reasons, /Unknown semester "Nonexistent"/);
});

test('preview does not change data; confirm applies; token is single-use', async () => {
  const t = await makeApp();
  const data = workbook([HEAD, ['A1', 'B', 20, 'Lab', null, null, null, null, null]]);
  const pre = await upload(t, data, 'merge', 'preview');
  assert.equal(pre.status, 200);
  assert.equal((await t.call('GET', '/api/rooms')).body.rooms.length, 0);
  assert.equal((await t.call('POST', '/api/import/confirm', { token: pre.body.token })).status, 200);
  assert.equal((await t.call('GET', '/api/rooms')).body.rooms.length, 1);
  assert.equal((await t.call('POST', '/api/import/confirm', { token: pre.body.token })).status, 410);
});

test('import requires admin', async () => {
  const t = await makeApp();
  const mp = multipart({ mode: 'merge' }, { name: 'x.xlsx', data: workbook([HEAD]) });
  const res = await t.app.inject({ method: 'POST', url: '/api/import/preview', payload: mp.payload, headers: { 'content-type': mp.contentType } });
  assert.equal(res.statusCode, 401);
  assert.equal((await t.app.inject({ method: 'GET', url: '/api/export' })).statusCode, 401);
});

test('garbage and header-less files give clear errors', async () => {
  const t = await makeApp();
  const noRoom = await upload(t, workbook([['Foo', 'Bar'], ['1', '2']]), 'merge', 'preview');
  assert.equal(noRoom.status, 422);
  assert.equal(noRoom.body.error, 'no_rows');
});

test('merge keeps existing data and reports clashes (with existing and within the file)', async () => {
  const t = await makeApp();
  const room = (await t.call('POST', '/api/rooms', { name: 'A1', capacity: 10 })).body;
  await t.call('POST', `/api/rooms/${room.id}/reservations`, { kind: 'date', date: '2026-03-02', start: 540, end: 600, course: 'Existing' });
  const rows: Cell[][] = [
    HEAD,
    ['a1', 'North', null, null, 'Clashes existing', null, '2026-03-02', '09:30', '10:30'],
    ['A1', null, null, null, 'New one', null, '2026-03-02', '11:00', '12:00'],
    ['A1', null, null, null, 'Clashes in-file', null, '2026-03-02', '11:30', '12:30'],
    ['A1', null, null, null, 'Same slot, other course', null, '2026-03-02', '09:00', '10:00'],
  ];
  const res = await upload(t, workbook(rows), 'merge', 'confirm');
  assert.equal(res.body.reservations.valid, 1);
  assert.equal(res.body.reservations.conflicts, 3);
  assert.equal(res.body.reservations.duplicates, 0); // course name differs, so it is a clash rather than a duplicate
  assert.equal(res.body.rooms.new, 0);
  const after = (await t.call('GET', '/api/rooms')).body.rooms;
  assert.equal(after.length, 1); // 'a1' matched 'A1' case-insensitively
  assert.equal(after[0].building, 'North'); // metadata filled from import
  assert.equal(after[0].capacity, 10); // kept (import had none)
  assert.equal(after[0].bookingCount, 2);
});

test('exact duplicates are skipped and counted', async () => {
  const t = await makeApp();
  const room = (await t.call('POST', '/api/rooms', { name: 'A1' })).body;
  await t.call('POST', `/api/rooms/${room.id}/reservations`, { kind: 'date', date: '2026-03-02', start: 540, end: 600, course: 'Same' });
  const res = await upload(t, workbook([HEAD, ['A1', null, null, null, 'same', 'Schedule', '2026-03-02', '09:00', '10:00']]), 'merge', 'confirm');
  assert.equal(res.body.reservations.duplicates, 1);
  assert.equal(res.body.reservations.conflicts, 0);
});

test('replace discards existing rooms and bookings and says so in the preview', async () => {
  const t = await makeApp();
  const old = (await t.call('POST', '/api/rooms', { name: 'Old' })).body;
  await t.call('POST', `/api/rooms/${old.id}/reservations`, { kind: 'date', date: '2026-03-02', start: 540, end: 600 });
  const data = workbook([HEAD, ['New', null, null, null, null, null, null, null, null]]);
  const pre = await upload(t, data, 'replace', 'preview');
  assert.deepEqual(pre.body.removal, { rooms: 1, reservations: 1 });
  assert.equal((await t.call('GET', '/api/rooms')).body.rooms.length, 1); // still untouched
  await upload(t, data, 'replace', 'confirm');
  const rooms = (await t.call('GET', '/api/rooms')).body.rooms;
  assert.deepEqual(rooms.map((r: { name: string }) => r.name), ['New']);
});

test('weekly rows use the selected semester; semester column overrides it', async () => {
  const t = await makeApp();
  const spring = (await t.call('POST', '/api/semesters', { name: 'Spring', startDate: '2026-02-01', endDate: '2026-06-30', isCurrent: true })).body;
  const fall = (await t.call('POST', '/api/semesters', { name: 'Fall', startDate: '2026-09-01', endDate: '2026-12-31' })).body;
  const rows: Cell[][] = [
    [...HEAD, 'Semester'],
    ['A1', null, null, null, 'Default', null, 'Monday', '09:00', '10:00', null],
    ['A1', null, null, null, 'Explicit', null, 'Monday', '09:00', '10:00', 'fall'], // same slot, different term: no clash
  ];
  const res = await upload(t, workbook(rows), 'merge', 'confirm', { semesterId: spring.id });
  assert.equal(res.body.reservations.valid, 2);
  const room = (await t.call('GET', '/api/rooms')).body.rooms[0];
  const list = (await t.call('GET', `/api/rooms/${room.id}/reservations`)).body.reservations;
  assert.deepEqual(list.map((r: { semesterId: string }) => r.semesterId).sort(), [spring.id, fall.id].sort());
});

test('CSV files import, with ambiguous slash dates rejected rather than guessed', async () => {
  const t = await makeApp();
  const csv = Buffer.from('Room,Course,Date,Start,End\nA1,Algebra,2026-03-02,9:00,10:30\nA1,Calc,03/04/2026,11:00,12:00\n');
  const res = await upload(t, csv, 'merge', 'confirm', {}, 'rooms.csv');
  assert.equal(res.body.reservations.valid, 1);
  assert.match(res.body.skipped[0].reason, /Unrecognised date "03\/04\/2026"/);
});

test('acceptance 9: export, wipe, re-import gives identical rooms and bookings (round trip)', async () => {
  const t = await makeApp();
  const spring = (await t.call('POST', '/api/semesters', { name: 'Spring 2026', startDate: '2026-02-01', endDate: '2026-06-30', isCurrent: true })).body;
  const a = (await t.call('POST', '/api/rooms', { name: 'B204', building: 'B', capacity: 40, type: 'Lab' })).body;
  await t.call('POST', '/api/rooms', { name: 'C1' }); // room with no bookings
  const b = (await t.call('POST', '/api/rooms', { name: 'A10', building: 'A', capacity: 120, type: 'Hall' })).body;
  await t.call('POST', `/api/rooms/${a.id}/reservations`, { kind: 'weekly', weekday: 1, start: 540, end: 630, course: 'PHYS 105', cat: 'schedule', semesterId: spring.id });
  await t.call('POST', `/api/rooms/${a.id}/reservations`, { kind: 'date', date: '2026-03-12', start: 840, end: 960, course: 'Guest lecture', cat: 'event' });
  await t.call('POST', `/api/rooms/${b.id}/reservations`, { kind: 'date', date: '2026-04-01', start: 480, end: 540, course: '', cat: 'schedule' });

  const snapshot = async () => {
    const rooms = (await t.call('GET', '/api/rooms')).body.rooms as { id: string; name: string; building: string; capacity: number | null; type: string }[];
    const out = [];
    for (const r of rooms) {
      const list = (await t.call('GET', `/api/rooms/${r.id}/reservations`)).body.reservations as Record<string, unknown>[];
      out.push({
        name: r.name, building: r.building, capacity: r.capacity, type: r.type,
        res: list.map((x) => [x.course, x.cat, x.kind, x.date, x.weekday, x.start, x.end, x.semesterName]),
      });
    }
    return out;
  };
  const before = await snapshot();

  const exported = await t.app.inject({ method: 'GET', url: '/api/export', headers: { cookie: t.cookie } });
  assert.equal(exported.statusCode, 200);
  assert.match(String(exported.headers['content-disposition']), /room-reservations-\d{4}-\d{2}-\d{2}\.xlsx/);
  await t.call('DELETE', '/api/data');
  assert.equal((await t.call('GET', '/api/rooms')).body.rooms.length, 0);

  const res = await upload(t, exported.rawPayload, 'replace', 'confirm', { semesterId: spring.id });
  assert.equal(res.body.reservations.skipped, 0);
  assert.equal(res.body.reservations.conflicts, 0);
  assert.deepEqual(await snapshot(), before);
});

test('template downloads and re-imports cleanly', async () => {
  const t = await makeApp();
  await t.call('POST', '/api/semesters', { name: 'Spring 2026', startDate: '2026-02-01', endDate: '2026-06-30', isCurrent: true });
  const tpl = await t.app.inject({ method: 'GET', url: '/api/template' });
  assert.equal(tpl.statusCode, 200);
  const res = await upload(t, tpl.rawPayload, 'merge', 'confirm');
  assert.equal(res.body.reservations.valid, 2);
  assert.equal(res.body.reservations.skipped, 0);
});
