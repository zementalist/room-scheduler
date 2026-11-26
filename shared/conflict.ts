import { fmtTime, DAYS, weekdayOf } from './time.ts';

/**
 * Minimal shape needed to decide whether two bookings of the SAME room collide.
 * Weekly bookings carry the term (semester) that bounds their recurrence.
 */
export interface Slot {
  kind: 'date' | 'weekly';
  date?: string | null;
  weekday?: number | null;
  start: number;
  end: number;
  termStart?: string | null;
  termEnd?: string | null;
}

function slotWeekday(s: Slot): number {
  return s.kind === 'date' ? weekdayOf(s.date as string) : (s.weekday as number);
}

/** ISO dates compare correctly as strings. A missing bound means unbounded. */
function inTerm(date: string, w: Slot): boolean {
  if (w.termStart && date < w.termStart) return false;
  if (w.termEnd && date > w.termEnd) return false;
  return true;
}

function termsOverlap(a: Slot, b: Slot): boolean {
  const aStart = a.termStart ?? '0000-01-01';
  const aEnd = a.termEnd ?? '9999-12-31';
  const bStart = b.termStart ?? '0000-01-01';
  const bEnd = b.termEnd ?? '9999-12-31';
  return aStart <= bEnd && bStart <= aEnd;
}

/** Calendar scopes intersect: do the two bookings ever fall on the same real day? */
export function scopesIntersect(a: Slot, b: Slot): boolean {
  if (a.kind === 'date' && b.kind === 'date') return a.date === b.date;
  if (a.kind === 'weekly' && b.kind === 'weekly') {
    return slotWeekday(a) === slotWeekday(b) && termsOverlap(a, b);
  }
  const d = a.kind === 'date' ? a : b;
  const w = a.kind === 'weekly' ? a : b;
  return weekdayOf(d.date as string) === slotWeekday(w) && inTerm(d.date as string, w);
}

/**
 * BR-R1: two bookings of the same room clash iff their half-open time intervals
 * overlap (back-to-back is allowed) AND their calendar scopes intersect.
 * The caller is responsible for only comparing bookings of the same room.
 */
export function clashes(a: Slot, b: Slot): boolean {
  if (!(a.start < b.end && b.start < a.end)) return false;
  return scopesIntersect(a, b);
}

/** Human description of when a booking occurs, e.g. "Every Monday" or "2026-03-02 (Mon)". */
export function describeWhen(s: Slot): string {
  if (s.kind === 'weekly') return `Every ${DAYS[s.weekday as number]}`;
  const date = s.date as string;
  return `${date} (${DAYS[weekdayOf(date)]!.slice(0, 3)})`;
}

export function describeRange(s: Slot): string {
  return `${describeWhen(s)}, ${fmtTime(s.start)} to ${fmtTime(s.end)}`;
}

/** BR-R3: a room is free for a slot iff nothing booked there clashes with a dated probe. */
export function isFree(existing: Slot[], date: string, from: number, to: number): boolean {
  const probe: Slot = { kind: 'date', date, start: from, end: to };
  return !existing.some((x) => clashes(probe, x));
}
