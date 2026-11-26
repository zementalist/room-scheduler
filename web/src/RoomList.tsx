import { fmt12 } from '../../shared/time.ts';
import type { Room } from '../../shared/types.ts';
import { roomMeta } from './RoomDetail.tsx';

export interface SlotFilter {
  date: string;
  from: string;
  to: string;
}

const MINUTES: number[] = [];
for (let m = 7 * 60; m <= 22 * 60; m += 15) MINUTES.push(m);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function RoomList({
  rooms,
  totalRooms,
  selectedId,
  onSelect,
  q,
  setQ,
  slot,
  setSlot,
  slotActive,
  loading,
  isAdmin,
  onAddRoom,
}: {
  rooms: Room[];
  totalRooms: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  q: string;
  setQ: (q: string) => void;
  slot: SlotFilter;
  setSlot: (s: SlotFilter) => void;
  slotActive: boolean;
  loading: boolean;
  isAdmin: boolean;
  onAddRoom: () => void;
}) {
  const empty = !totalRooms
    ? isAdmin
      ? 'No rooms yet. Add a room or import an Excel sheet.'
      : 'No rooms have been set up yet.'
    : slotActive
      ? 'No rooms are free at that time. Try another slot.'
      : 'No rooms match.';

  return (
    <section className="card">
      <div className="card-head">
        <h2>Rooms</h2>
        {isAdmin && (
          <button type="button" onClick={onAddRoom}>
            Add room
          </button>
        )}
      </div>
      <label htmlFor="q">Search by room, building, course or type</label>
      <input id="q" type="search" placeholder="e.g. B204 or Physics" value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="sub" style={{ marginTop: 10 }}>
        Check availability for a slot (optional)
      </div>
      <div className="row">
        <div className="full">
          <label htmlFor="cd">Date</label>
          <input id="cd" type="date" value={slot.date} onChange={(e) => setSlot({ ...slot, date: e.target.value })} />
        </div>
        <div>
          <label htmlFor="cs">From</label>
          <select id="cs" value={slot.from} onChange={(e) => setSlot({ ...slot, from: e.target.value })}>
            <option value="">Any time</option>
            {MINUTES.map((m) => (
              <option key={m} value={hhmm(m)}>
                {fmt12(m)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ce">To</label>
          <select id="ce" value={slot.to} onChange={(e) => setSlot({ ...slot, to: e.target.value })}>
            <option value="">Any time</option>
            {MINUTES.map((m) => (
              <option key={m} value={hhmm(m)}>
                {fmt12(m)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {(slot.date || slot.from || slot.to) && (
        <div className="chips">
          <button type="button" onClick={() => setSlot({ date: '', from: '', to: '' })}>
            Clear slot filter
          </button>
          {!slotActive && <span className="sub">Pick a date and a later end time to filter by availability.</span>}
        </div>
      )}

      <ul id="list" aria-busy={loading}>
        {rooms.map((r) => (
          <li key={r.id}>
            <button type="button" className={`room${selectedId === r.id ? ' on' : ''}`} aria-current={selectedId === r.id ? 'true' : undefined} onClick={() => onSelect(r.id)}>
              <span>
                <b>{r.name}</b>
                <span className="sub">{roomMeta(r)}</span>
              </span>
              {slotActive ? (
                <span className="tag free">Free</span>
              ) : (
                <span className={`tag ${r.bookingCount ? 'busy' : 'free'}`}>
                  {r.bookingCount} booking{r.bookingCount === 1 ? '' : 's'}
                </span>
              )}
            </button>
          </li>
        ))}
        {!rooms.length && !loading && <li className="empty">{empty}</li>}
      </ul>
    </section>
  );
}
