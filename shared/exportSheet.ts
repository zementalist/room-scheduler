import * as XLSX from 'xlsx';
import { DAYS, fmtTime } from './time.ts';
import type { Reservation, Room } from './types.ts';

export const EXPORT_HEADERS = ['Room', 'Building', 'Capacity', 'Type', 'Course', 'Category', 'Date', 'Start', 'End', 'Semester'];
const COL_WIDTHS = [10, 12, 10, 16, 32, 10, 14, 8, 8, 16];

type Aoa = (string | number)[][];

/** .xlsx bytes for a single "Rooms" sheet. */
export function workbookBytes(aoa: Aoa): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = COL_WIDTHS.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Rooms');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

/** One row per booking, plus one row for each room that has none. Always writes Category (round-trip safe). */
export function exportRows(rooms: Room[], reservations: Reservation[]): Aoa {
  const rows: Aoa = [EXPORT_HEADERS];
  const byRoom = new Map<string, Reservation[]>();
  for (const r of reservations) byRoom.set(r.roomId, [...(byRoom.get(r.roomId) ?? []), r]);
  for (const room of rooms) {
    const base = [room.name, room.building, room.capacity ?? '', room.type];
    const list = byRoom.get(room.id) ?? [];
    if (!list.length) rows.push([...base, '', '', '', '', '', '']);
    for (const x of list) {
      rows.push([
        ...base,
        x.course,
        x.cat === 'event' ? 'Event' : 'Schedule',
        x.kind === 'date' ? (x.date as string) : DAYS[x.weekday as number]!,
        fmtTime(x.start),
        fmtTime(x.end),
        x.kind === 'weekly' ? (x.semesterName ?? '') : '',
      ]);
    }
  }
  return rows;
}

export const templateRows = (): Aoa => [
  EXPORT_HEADERS,
  ['B204', 'Building B', 40, 'Lab', '', '', '', '', '', ''],
  ['B204', 'Building B', 40, 'Lab', 'PHYS 105', 'Schedule', 'Monday', '09:00', '10:30', 'Spring 2026'],
  ['B204', 'Building B', 40, 'Lab', 'Guest lecture', 'Event', '2026-03-12', '14:00', '16:00', ''],
];
