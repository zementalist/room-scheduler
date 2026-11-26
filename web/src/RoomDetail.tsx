import { useCallback, useEffect, useState } from 'react';
import { DAYS, fmtTime, weekdayOf } from '../../shared/time.ts';
import type { Reservation, Room, Semester } from '../../shared/types.ts';
import { api, ApiFail } from './api.ts';
import { defaultForm, formFromReservation, ReservationForm, type FormState } from './ReservationForm.tsx';
import { useConfirm, useToast } from './ui.tsx';

export const roomMeta = (r: Room) => [r.building, r.type, r.capacity !== null ? `${r.capacity} seats` : ''].filter(Boolean).join(', ');

const longDate = (d: string) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return `${DAYS[weekdayOf(d)]!.slice(0, 3)}, ${day} ${new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en', { month: 'short', timeZone: 'UTC' })} ${y}`;
};
export const whenText = (r: Reservation) => (r.kind === 'date' ? longDate(r.date as string) : `Every ${DAYS[r.weekday as number]}`);

export function RoomDetail({
  roomId,
  isAdmin,
  semesters,
  version,
  form,
  setForm,
  slotFilter,
  onChanged,
  onEditRoom,
  onGone,
}: {
  roomId: string;
  isAdmin: boolean;
  semesters: Semester[];
  version: number;
  form: FormState;
  setForm: (f: FormState) => void;
  slotFilter: { date: string; start: number; end: number } | null;
  onChanged: () => void;
  onEditRoom: (r: Room) => void;
  onGone: () => void;
}) {
  const [data, setData] = useState<{ room: Room; reservations: Reservation[] } | null>(null);
  const [loadError, setLoadError] = useState('');
  const confirm = useConfirm();
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setData(await api.roomDetail(roomId));
      setLoadError('');
    } catch (e) {
      if (e instanceof ApiFail && e.status === 404) return onGone();
      setLoadError(e instanceof ApiFail ? e.message : 'Could not load this room.');
    }
  }, [roomId, onGone]);

  useEffect(() => {
    void load();
  }, [load, version]);

  if (loadError) return <div className="card"><div className="empty">{loadError}</div></div>;
  if (!data || data.room.id !== roomId) return <div className="card"><div className="empty">Loading…</div></div>;
  const { room, reservations } = data;
  const currentSem = semesters.find((s) => s.isCurrent)?.id ?? '';

  async function run(fn: () => Promise<string>) {
    try {
      toast.ok(await fn());
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiFail ? e.message : 'Something went wrong.');
    }
  }

  const removeOne = async (r: Reservation) => {
    const ok = await confirm({
      title: 'Delete booking?',
      message: (
        <p>
          {whenText(r)}, {fmtTime(r.start)} to {fmtTime(r.end)}
          {r.course ? ` (${r.course})` : ''} in {room.name} will be removed.
        </p>
      ),
      confirmLabel: 'Delete booking',
      danger: true,
    });
    if (!ok) return;
    await run(async () => {
      await api.deleteReservation(r.id);
      if (form.editingId === r.id) setForm(defaultForm(currentSem));
      return 'Booking deleted.';
    });
  };

  const clearRoom = async () => {
    const ok = await confirm({
      title: `Clear all bookings for ${room.name}?`,
      message: <p>{reservations.length} booking(s) will be deleted. The room itself is kept. This cannot be undone.</p>,
      confirmLabel: 'Clear bookings',
      danger: true,
    });
    if (ok) await run(async () => `${(await api.clearRoom(room.id)).deleted} booking(s) cleared.`);
  };

  const deleteRoom = async () => {
    const ok = await confirm({
      title: `Delete room ${room.name}?`,
      message: <p>The room and its {reservations.length} booking(s) will be permanently deleted. This cannot be undone.</p>,
      confirmLabel: 'Delete room',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteRoom(room.id);
      toast.ok(`Room ${room.name} deleted.`);
      onChanged();
      onGone();
    } catch (e) {
      toast.error(e instanceof ApiFail ? e.message : 'Could not delete the room.');
    }
  };

  return (
    <div className="card" id="detail">
      <div className="detail-head">
        <div>
          <h2>{room.name}</h2>
          <div className="sub">{roomMeta(room)}</div>
        </div>
        {isAdmin && (
          <div className="head-actions">
            <button type="button" onClick={() => onEditRoom(room)}>
              Edit room
            </button>
            <button type="button" className="d" onClick={deleteRoom}>
              Delete room
            </button>
          </div>
        )}
      </div>
      <p>
        <span className={`tag ${reservations.length ? 'busy' : 'free'}`}>{reservations.length ? 'Reserved' : 'No reservations'}</span>
      </p>

      {reservations.length ? (
        <ul className="reslist">
          {reservations.map((x) => (
            <li key={x.id} className={`res${form.editingId === x.id ? ' editing' : ''}`}>
              <span>
                <b>{whenText(x)}</b>, {fmtTime(x.start)} to {fmtTime(x.end)}
                <br />
                <span className="sub">{x.course || 'No course listed'}</span>{' '}
                <span className={`tag ${x.cat === 'event' ? 'ev' : 'n'}`}>{x.cat === 'event' ? 'Event' : 'Schedule'}</span>
                {x.kind === 'weekly' && x.semesterName && <span className="tag n">{x.semesterName}</span>}
              </span>
              {isAdmin && (
                <span className="res-actions">
                  <button type="button" onClick={() => setForm(formFromReservation(x, currentSem))}>
                    Edit
                  </button>
                  <button type="button" className="d" onClick={() => removeOne(x)}>
                    Delete
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty">This room is free.{isAdmin ? ' Add a reservation below.' : ''}</div>
      )}

      {isAdmin && reservations.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button type="button" className="d" onClick={clearRoom}>
            Clear all for {room.name}
          </button>
        </div>
      )}

      {isAdmin && (
        <ReservationForm
          room={room}
          reservations={reservations}
          semesters={semesters}
          form={form}
          setForm={setForm}
          slotFilter={slotFilter}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}
