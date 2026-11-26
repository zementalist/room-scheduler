import { ApiFail } from '../../shared/apiError.ts';
import type { ApiError, Reservation, ReservationInput, Room, Semester } from '../../shared/types.ts';
import type { ImportPreview, RoomBody, SemesterBody, Summary } from './apiTypes.ts';

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function request<T>(method: string, url: string, body?: unknown, form?: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiFail(0, 'network', 'Cannot reach the server. Check your connection and try again.', null);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const err = data as ApiError | null;
    if (res.status === 401 && url !== '/api/login') onUnauthorized?.();
    throw new ApiFail(res.status, err?.error ?? 'error', err?.message ?? `Request failed (${res.status}).`, err);
  }
  return data as T;
}

export const api = {
  me: () => request<{ admin: boolean; username: string | null }>('GET', '/api/me'),
  login: (username: string, password: string) => request<{ admin: boolean }>('POST', '/api/login', { username, password }),
  logout: () => request<{ admin: boolean }>('POST', '/api/logout'),
  summary: () => request<Summary>('GET', '/api/summary'),
  rooms: (q: string) => request<{ rooms: Room[] }>('GET', `/api/rooms?q=${encodeURIComponent(q)}`),
  availability: (date: string, from: string, to: string) =>
    request<{ rooms: Room[] }>('GET', `/api/availability?date=${date}&from=${from}&to=${to}`),
  roomDetail: (id: string) => request<{ room: Room; reservations: Reservation[] }>('GET', `/api/rooms/${id}/reservations`),
  semesters: () => request<{ semesters: Semester[] }>('GET', '/api/semesters'),

  createRoom: (b: RoomBody) => request<Room>('POST', '/api/rooms', b),
  updateRoom: (id: string, b: RoomBody) => request<Room>('PATCH', `/api/rooms/${id}`, b),
  deleteRoom: (id: string) => request<{ deleted: string; bookingsDeleted: number }>('DELETE', `/api/rooms/${id}`),
  clearRoom: (id: string) => request<{ deleted: number }>('DELETE', `/api/rooms/${id}/reservations`),

  createReservation: (roomId: string, b: ReservationInput) => request<Reservation>('POST', `/api/rooms/${roomId}/reservations`, b),
  updateReservation: (id: string, b: ReservationInput) => request<Reservation>('PATCH', `/api/reservations/${id}`, b),
  deleteReservation: (id: string) => request<{ deleted: number }>('DELETE', `/api/reservations/${id}`),

  createSemester: (b: SemesterBody) => request<Semester>('POST', '/api/semesters', b),
  updateSemester: (id: string, b: SemesterBody) => request<Semester>('PATCH', `/api/semesters/${id}`, b),
  deleteSemester: (id: string, withBookings: boolean) =>
    request<{ bookingsDeleted: number }>('DELETE', `/api/semesters/${id}${withBookings ? '?withBookings=true' : ''}`),
  rollover: (b: SemesterBody & { clearSchedule: boolean }) =>
    request<{ semester: Semester; scheduleCleared: number }>('POST', '/api/semesters/rollover', b),

  clearAll: () => request<{ rooms: number; reservations: number }>('DELETE', '/api/data'),

  importPreview: (file: File, mode: 'merge' | 'replace', semesterId: string) => {
    const f = new FormData();
    f.append('mode', mode); // fields must precede the file part
    f.append('semesterId', semesterId);
    f.append('file', file);
    return request<ImportPreview>('POST', '/api/import/preview', undefined, f);
  },
  importConfirm: (token: string) => request<ImportPreview & { applied: boolean }>('POST', '/api/import/confirm', { token }),
};

/** Download a file (sent with the session cookie) and surface API errors instead of saving them. */
export async function download(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    let message = `Download failed (${res.status}).`;
    try {
      message = ((await res.json()) as ApiError).message;
    } catch {
      /* keep default */
    }
    throw new ApiFail(res.status, 'download', message, null);
  }
  const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = m?.[1] ?? fallbackName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
