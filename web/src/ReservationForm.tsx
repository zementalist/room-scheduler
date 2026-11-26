import { useMemo, useState } from 'react';
import type { Slot } from '../../shared/conflict.ts';
import { DAYS, fmt12, GRID_END, GRID_START, GRID_STEP, isValidDate, ymd } from '../../shared/time.ts';
import type { Category, Kind, Reservation, Room, Semester } from '../../shared/types.ts';
import { api, ApiFail } from './api.ts';
import { Timeline } from './Timeline.tsx';
import { useToast } from './ui.tsx';

export interface FormState {
  editingId: string | null;
  cat: Category;
  course: string;
  kind: Kind;
  date: string;
  weekday: number;
  semesterId: string;
  start: number;
  end: number;
  duration: number;
}

export const defaultForm = (semesterId: string): FormState => ({
  editingId: null,
  cat: 'schedule',
  course: '',
  kind: 'date',
  date: ymd(new Date()),
  weekday: 1,
  semesterId,
  start: 9 * 60,
  end: 10 * 60 + 30,
  duration: 90,
});

export const formFromReservation = (r: Reservation, fallbackSemester: string): FormState => ({
  editingId: r.id,
  cat: r.cat,
  course: r.course,
  kind: r.kind,
  date: r.date ?? ymd(new Date()),
  weekday: r.weekday ?? 1,
  semesterId: r.semesterId ?? fallbackSemester,
  start: r.start,
  end: r.end,
  duration: r.end - r.start,
});

const GRID: number[] = [];
for (let m = GRID_START; m <= GRID_END; m += GRID_STEP) GRID.push(m);

/** Grid options plus the current value when it is off-grid (e.g. 09:05 imported from Excel). */
function timeOptions(current: number): number[] {
  return GRID.includes(current) ? GRID : [...GRID, current].sort((a, b) => a - b);
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function ReservationForm({
  room,
  reservations,
  semesters,
  form,
  setForm,
  slotFilter,
  onSaved,
}: {
  room: Room;
  reservations: Reservation[];
  semesters: Semester[];
  form: FormState;
  setForm: (f: FormState) => void;
  slotFilter: { date: string; start: number; end: number } | null;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<FormState>) => {
    setError('');
    setForm({ ...form, ...p });
  };

  const currentSem = semesters.find((s) => s.isCurrent);
  const semester = semesters.find((s) => s.id === form.semesterId) ?? currentSem;

  const scope: Slot | null = useMemo(() => {
    if (form.kind === 'date') return isValidDate(form.date) ? { kind: 'date', date: form.date, start: 0, end: 1440 } : null;
    return { kind: 'weekly', weekday: form.weekday, start: 0, end: 1440, termStart: semester?.startDate, termEnd: semester?.endDate };
  }, [form.kind, form.date, form.weekday, semester]);

  const onStart = (start: number) => patch({ start, end: Math.min(start + form.duration, GRID_END) });
  const onEnd = (end: number) => patch({ end, duration: end - form.start > 0 ? end - form.start : form.duration });
  const onDuration = (duration: number) => patch({ duration, end: Math.min(form.start + duration, GRID_END) });
  const quickDate = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    patch({ date: ymd(d) });
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (form.kind === 'date' && !isValidDate(form.date)) return setError('Pick a date.');
    if (form.end <= form.start) return setError('Enter a start time earlier than the end time.');
    if (form.kind === 'weekly' && !semester) return setError('Create a semester first (Semesters button in the header).');
    setBusy(true);
    try {
      const body = {
        cat: form.cat,
        course: form.course,
        kind: form.kind,
        date: form.kind === 'date' ? form.date : null,
        weekday: form.kind === 'weekly' ? form.weekday : null,
        semesterId: form.kind === 'weekly' ? (semester?.id ?? null) : null,
        start: form.start,
        end: form.end,
      };
      if (form.editingId) await api.updateReservation(form.editingId, body);
      else await api.createReservation(room.id, body);
      toast.ok(form.editingId ? 'Booking updated.' : `Reserved ${room.name}, ${hhmm(form.start)} to ${hhmm(form.end)}.`);
      setForm(defaultForm(currentSem?.id ?? ''));
      onSaved();
    } catch (err) {
      setError(err instanceof ApiFail ? err.message : 'Could not save the booking.');
      if (err instanceof ApiFail && err.status === 409) onSaved(); // someone else may have just booked it
    } finally {
      setBusy(false);
    }
  }

  const id = (s: string) => `rf-${s}`;
  return (
    <form onSubmit={submit} noValidate>
      <h2 style={{ marginTop: 22 }}>{form.editingId ? 'Edit booking' : 'Reserve this room'}</h2>

      <label htmlFor={id('cat')}>Booking type</label>
      <select id={id('cat')} value={form.cat} onChange={(e) => patch({ cat: e.target.value as Category })}>
        <option value="schedule">Schedule (class timetable)</option>
        <option value="event">Event (one-off)</option>
      </select>

      <label htmlFor={id('course')} style={{ marginTop: 8 }}>
        Course or event name
      </label>
      <input id={id('course')} value={form.course} maxLength={200} placeholder="e.g. Phys 105 or Guest lecture" onChange={(e) => patch({ course: e.target.value })} />

      <div className="radio" role="radiogroup" aria-label="Recurrence">
        <label>
          <input type="radio" name="kind" checked={form.kind === 'date'} onChange={() => patch({ kind: 'date' })} /> One date
        </label>
        <label>
          <input type="radio" name="kind" checked={form.kind === 'weekly'} onChange={() => patch({ kind: 'weekly' })} /> Every week
        </label>
      </div>

      <div className="row">
        {form.kind === 'date' ? (
          <div className="full">
            <label htmlFor={id('date')}>Date</label>
            <input id={id('date')} type="date" value={form.date} onChange={(e) => patch({ date: e.target.value })} />
            <div className="chips">
              <button type="button" onClick={() => quickDate(0)}>
                Today
              </button>
              <button type="button" onClick={() => quickDate(1)}>
                Tomorrow
              </button>
              {slotFilter && (
                <button type="button" onClick={() => patch({ date: slotFilter.date, start: slotFilter.start, end: slotFilter.end, duration: slotFilter.end - slotFilter.start })}>
                  Use availability slot
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div>
              <label htmlFor={id('day')}>Day</label>
              <select id={id('day')} value={form.weekday} onChange={(e) => patch({ weekday: Number(e.target.value) })}>
                {DAYS.map((n, i) => (
                  <option key={n} value={i}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={id('sem')}>Semester</label>
              <select id={id('sem')} value={semester?.id ?? ''} onChange={(e) => patch({ semesterId: e.target.value })}>
                {!semesters.length && <option value="">No semester yet</option>}
                {semesters.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.isCurrent ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            </div>
            {semester && (
              <div className="full sub">
                Repeats every {DAYS[form.weekday]} from {semester.startDate} to {semester.endDate}.
              </div>
            )}
          </>
        )}
        <div>
          <label htmlFor={id('start')}>Start</label>
          <select id={id('start')} value={form.start} onChange={(e) => onStart(Number(e.target.value))}>
            {timeOptions(form.start).map((m) => (
              <option key={m} value={m}>
                {fmt12(m)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id('end')}>End</label>
          <select id={id('end')} value={form.end} onChange={(e) => onEnd(Number(e.target.value))}>
            {timeOptions(form.end).map((m) => (
              <option key={m} value={m}>
                {fmt12(m)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="chips">
        <span className="sub" style={{ alignSelf: 'center' }}>
          Length
        </span>
        {[60, 90, 120, 180].map((m) => (
          <button type="button" key={m} aria-pressed={form.end - form.start === m} onClick={() => onDuration(m)}>
            {m / 60} h
          </button>
        ))}
      </div>

      <Timeline reservations={reservations} scope={scope} pending={{ start: form.start, end: form.end }} ignoreId={form.editingId} />

      <div className="err" role="alert">
        {error}
      </div>
      <div className="form-actions">
        <button type="submit" className="p" disabled={busy}>
          {form.editingId ? 'Save changes' : 'Reserve room'}
        </button>
        {form.editingId && (
          <button type="button" onClick={() => setForm(defaultForm(currentSem?.id ?? ''))}>
            Cancel edit
          </button>
        )}
      </div>
    </form>
  );
}
