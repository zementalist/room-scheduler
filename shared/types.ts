// DTOs exchanged between API and frontend.

export type Kind = 'date' | 'weekly';
export type Category = 'schedule' | 'event';

export interface Room {
  id: string;
  name: string;
  building: string;
  capacity: number | null;
  type: string;
  bookingCount: number;
}

export interface Semester {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}

export interface Reservation {
  id: string;
  roomId: string;
  course: string;
  cat: Category;
  kind: Kind;
  /** Present when kind === 'date'. */
  date: string | null;
  /** 0 = Sunday. Present when kind === 'weekly'. */
  weekday: number | null;
  start: number;
  end: number;
  /** Weekly bookings only: the term bounding the recurrence. */
  semesterId: string | null;
  semesterName: string | null;
  termStart: string | null;
  termEnd: string | null;
}

export interface ReservationInput {
  course: string;
  cat: Category;
  kind: Kind;
  date?: string | null;
  weekday?: number | null;
  start: number;
  end: number;
  semesterId?: string | null;
}

export interface ApiError {
  error: string;
  message: string;
  conflictWith?: Reservation;
}
