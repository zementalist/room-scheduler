// Generates sample/room-reservations-sample.xlsx for trying the importer.
//   docker run --rm -v "${PWD}:/app" -w /app node:26-slim node scripts/make-sample.ts
import fs from 'node:fs';
import * as XLSX from 'xlsx';

const HEAD = ['Room', 'Building', 'Capacity', 'Type', 'Course', 'Category', 'Date', 'Start', 'End', 'Semester'];
const rooms: [string, string, number, string][] = [
  ['A101', 'Building A', 120, 'Lecture hall'],
  ['A102', 'Building A', 80, 'Lecture hall'],
  ['B204', 'Building B', 40, 'Lab'],
  ['B205', 'Building B', 40, 'Lab'],
  ['B10', 'Building B', 30, 'Seminar room'],
  ['B2', 'Building B', 30, 'Seminar room'],
  ['C301', 'Building C', 60, 'Classroom'],
  ['C302', 'Building C', 60, 'Classroom'],
];
const bookings: [string, string, string, string, string, string, string][] = [
  // room, course, category, date/day, start, end, semester
  ['A101', 'MATH 101', 'Schedule', 'Sunday', '08:00', '09:30', 'Spring 2026'],
  ['A101', 'MATH 101', 'Schedule', 'Tuesday', '08:00', '09:30', 'Spring 2026'],
  ['A101', 'PHYS 105', 'Schedule', 'Monday', '10:00', '11:30', 'Spring 2026'],
  ['A102', 'ENG 110', 'Schedule', 'Monday', '09:00', '10:30', 'Spring 2026'],
  ['B204', 'CS 201 Lab', 'Schedule', 'Wednesday', '13:00', '16:00', 'Spring 2026'],
  ['B205', 'CHEM 120 Lab', 'Schedule', 'Thursday', '09:00', '12:00', 'Spring 2026'],
  ['C301', 'HIST 150', 'Schedule', 'Sunday', '11:00', '12:30', 'Spring 2026'],
  ['A101', 'Guest lecture: Careers in AI', 'Event', '2026-03-12', '14:00', '16:00', ''],
  ['C302', 'Midterm exam: ENG 110', 'Event', '2026-04-08', '09:00', '11:00', ''],
];

const rows: (string | number)[][] = [HEAD];
for (const r of rooms) rows.push([...r, '', '', '', '', '', '']);
for (const [room, course, cat, when, start, end, sem] of bookings) {
  const meta = rooms.find((r) => r[0] === room)!;
  rows.push([...meta, course, cat, when, start, end, sem]);
}

const ws = XLSX.utils.aoa_to_sheet(rows);
ws['!cols'] = [10, 12, 10, 16, 32, 10, 14, 8, 8, 14].map((wch) => ({ wch }));
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Rooms');
fs.mkdirSync('sample', { recursive: true });
fs.writeFileSync('sample/room-reservations-sample.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
console.log(`Wrote sample/room-reservations-sample.xlsx (${rooms.length} rooms, ${bookings.length} bookings)`);
