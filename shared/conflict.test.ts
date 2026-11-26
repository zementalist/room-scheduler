import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clashes, isFree, type Slot } from './conflict.ts';
import { weekdayOf, parseHHMM, isValidDate, roomKey } from './time.ts';

const t = (s: string) => parseHHMM(s) as number;
const dated = (date: string, from: string, to: string): Slot => ({ kind: 'date', date, start: t(from), end: t(to) });
const weekly = (weekday: number, from: string, to: string, termStart = '2026-02-01', termEnd = '2026-06-30'): Slot => ({
  kind: 'weekly',
  weekday,
  start: t(from),
  end: t(to),
  termStart,
  termEnd,
});

test('weekday of known dates is timezone independent', () => {
  assert.equal(weekdayOf('2026-03-02'), 1); // Monday
  assert.equal(weekdayOf('2026-03-01'), 0); // Sunday
  assert.equal(weekdayOf('2024-02-29'), 4); // leap day, Thursday
});

test('date validation rejects impossible dates', () => {
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('2026-3-1'), false);
  assert.equal(isValidDate('2026-03-02'), true);
});

test('time parsing', () => {
  assert.equal(parseHHMM('09:00'), 540);
  assert.equal(parseHHMM('9:05'), 545);
  assert.equal(parseHHMM('24:00'), 1440);
  assert.equal(parseHHMM('24:30'), null);
  assert.equal(parseHHMM('9'), null);
});

test('room keys ignore case and whitespace', () => {
  assert.equal(roomKey('  B 204 '), roomKey('b  204'));
});

test('date vs date: same date overlapping clashes, other date does not', () => {
  assert.equal(clashes(dated('2026-03-02', '09:00', '10:30'), dated('2026-03-02', '10:00', '11:00')), true);
  assert.equal(clashes(dated('2026-03-02', '09:00', '10:30'), dated('2026-03-03', '10:00', '11:00')), false);
});

test('back-to-back bookings are allowed (half-open intervals)', () => {
  assert.equal(clashes(dated('2026-03-02', '09:00', '10:00'), dated('2026-03-02', '10:00', '11:00')), false);
  assert.equal(clashes(weekly(1, '09:00', '10:00'), weekly(1, '10:00', '11:00')), false);
});

test('containment and identical intervals clash', () => {
  assert.equal(clashes(dated('2026-03-02', '09:00', '12:00'), dated('2026-03-02', '10:00', '11:00')), true);
  assert.equal(clashes(dated('2026-03-02', '09:00', '10:00'), dated('2026-03-02', '09:00', '10:00')), true);
});

test('weekly vs dated: clashes on the matching weekday inside the term', () => {
  const w = weekly(1, '09:00', '10:30'); // Mondays
  assert.equal(clashes(w, dated('2026-03-02', '10:00', '11:00')), true); // Monday in term
  assert.equal(clashes(dated('2026-03-02', '10:00', '11:00'), w), true); // symmetric
  assert.equal(clashes(w, dated('2026-03-03', '10:00', '11:00')), false); // Tuesday
});

test('weekly vs dated: a date OUTSIDE the term does not clash', () => {
  const w = weekly(1, '09:00', '10:30', '2026-02-01', '2026-06-30');
  assert.equal(clashes(w, dated('2026-09-07', '10:00', '11:00')), false); // Monday after term
  assert.equal(clashes(w, dated('2026-01-26', '10:00', '11:00')), false); // Monday before term
  assert.equal(clashes(w, dated('2026-06-29', '10:00', '11:00')), true); // last Monday in term
  assert.equal(clashes(w, dated('2026-06-30', '10:00', '11:00')), false); // term end is a Tuesday
});

test('term bounds are inclusive', () => {
  const w = weekly(1, '09:00', '10:00', '2026-03-02', '2026-03-02');
  assert.equal(clashes(w, dated('2026-03-02', '09:00', '10:00')), true);
});

test('weekly vs weekly: same weekday needs overlapping terms', () => {
  const spring = weekly(1, '09:00', '10:30', '2026-02-01', '2026-06-30');
  const fall = weekly(1, '09:00', '10:30', '2026-09-01', '2026-12-31');
  assert.equal(clashes(spring, fall), false);
  assert.equal(clashes(spring, weekly(1, '10:00', '11:00', '2026-06-30', '2026-08-01')), true); // 1-day overlap
  assert.equal(clashes(spring, weekly(2, '09:00', '10:30')), false); // different weekday
});

test('availability: free iff no existing booking clashes with the dated probe', () => {
  const existing = [weekly(1, '09:00', '10:30')];
  assert.equal(isFree(existing, '2026-03-02', t('10:00'), t('11:00')), false);
  assert.equal(isFree(existing, '2026-03-02', t('10:30'), t('12:00')), true);
  assert.equal(isFree(existing, '2026-03-03', t('09:00'), t('10:30')), true);
});
