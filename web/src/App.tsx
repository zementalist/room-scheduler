import { useCallback, useEffect, useRef, useState } from 'react';
import { isValidDate, parseHHMM } from '../../shared/time.ts';
import type { Room, Semester } from '../../shared/types.ts';
import { api, ApiFail, download, setUnauthorizedHandler, type Summary } from './api.ts';
import { ImportDialog, LoginDialog, RolloverDialog, RoomDialog, SemestersDialog } from './dialogs.tsx';
import { defaultForm, type FormState } from './ReservationForm.tsx';
import { RoomDetail } from './RoomDetail.tsx';
import { RoomList, type SlotFilter } from './RoomList.tsx';
import { ConfirmProvider, ToastProvider, useConfirm, useToast } from './ui.tsx';

type Dialog = { kind: 'login' } | { kind: 'import' } | { kind: 'semesters' } | { kind: 'rollover' } | { kind: 'room'; room: Room | null } | null;

const SELECTED_KEY = 'selectedRoom';
const POLL_MS = 60_000;

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Main />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Main() {
  const toast = useToast();
  const confirm = useConfirm();

  const [admin, setAdmin] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [semesters, setSemesters] = useState<Semester[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [slot, setSlot] = useState<SlotFilter>({ date: '', from: '', to: '' });
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem(SELECTED_KEY));
  const [version, setVersion] = useState(0);
  const [form, setForm] = useState<FormState>(() => defaultForm(''));

  const from = parseHHMM(slot.from);
  const to = parseHHMM(slot.to);
  const slotActive = isValidDate(slot.date) && from !== null && to !== null && to > from;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAdmin(false);
      setUsername(null);
      toast.error('Your session ended. Log in again to continue.');
    });
  }, [toast]);

  useEffect(() => {
    api.me().then((m) => {
      setAdmin(m.admin);
      setUsername(m.username);
    }).catch(() => {});
  }, []);

  // Latest-wins loading so slow responses never overwrite newer ones.
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [r, s, sem, free] = await Promise.all([
        api.rooms(debouncedQ),
        api.summary(),
        api.semesters(),
        slotActive ? api.availability(slot.date, slot.from, slot.to) : Promise.resolve(null),
      ]);
      if (mine !== seq.current) return;
      const freeIds = free && new Set(free.rooms.map((x) => x.id));
      setRooms(freeIds ? r.rooms.filter((x) => freeIds.has(x.id)) : r.rooms);
      setSummary(s);
      setSemesters(sem.semesters);
      setLoadError('');
    } catch (e) {
      if (mine === seq.current) setLoadError(e instanceof ApiFail ? e.message : 'Could not load rooms.');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [debouncedQ, slotActive, slot.date, slot.from, slot.to]);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  // Keep the page live: other users' changes appear without a manual reload.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') setVersion((v) => v + 1);
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  // Keep the booking form's semester pointing at the current semester until the user picks another.
  useEffect(() => {
    const cur = semesters.find((s) => s.isCurrent)?.id ?? '';
    setForm((f) => (f.semesterId && semesters.some((s) => s.id === f.semesterId) ? f : { ...f, semesterId: cur }));
  }, [semesters]);

  // Selection rules: pick the first room if none; when a slot filter hides the selection, move to the first free room.
  useEffect(() => {
    if (loading || !rooms.length) return;
    const present = rooms.some((r) => r.id === selectedId);
    if (!selectedId || (slotActive && !present)) setSelectedId(rooms[0]!.id);
  }, [rooms, selectedId, slotActive, loading]);

  useEffect(() => {
    if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId);
  }, [selectedId]);

  const changed = useCallback(() => setVersion((v) => v + 1), []);
  const onGone = useCallback(() => {
    localStorage.removeItem(SELECTED_KEY);
    setSelectedId(null);
    setVersion((v) => v + 1);
  }, []);

  async function logout() {
    await api.logout().catch(() => {});
    setAdmin(false);
    setUsername(null);
    setForm(defaultForm(semesters.find((s) => s.isCurrent)?.id ?? ''));
    toast.ok('Logged out.');
  }

  async function exportXlsx() {
    try {
      await download('/api/export', 'room-reservations.xlsx');
      toast.ok('Export downloaded.');
    } catch (e) {
      toast.error(e instanceof ApiFail ? e.message : 'Export failed.');
    }
  }

  async function clearAll() {
    const ok = await confirm({
      title: 'Clear all data?',
      message: (
        <p>
          All {summary?.rooms ?? 0} rooms and every booking ({(summary?.schedule ?? 0) + (summary?.events ?? 0)}) will be permanently deleted. Semesters are kept. This cannot be undone — consider exporting first.
        </p>
      ),
      confirmLabel: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.clearAll();
      toast.ok(`Cleared ${r.rooms} room(s) and ${r.reservations} booking(s).`);
      onGone();
    } catch (e) {
      toast.error(e instanceof ApiFail ? e.message : 'Could not clear data.');
    }
  }

  const slotFilter = slotActive ? { date: slot.date, start: from as number, end: to as number } : null;
  const stats = summary && summary.rooms ? `${summary.rooms} room${summary.rooms === 1 ? '' : 's'}, ${summary.schedule} schedule booking${summary.schedule === 1 ? '' : 's'}, ${summary.events} event${summary.events === 1 ? '' : 's'}` : 'No rooms loaded';

  return (
    <>
      <header>
        <div>
          <h1>Room Reservations</h1>
          <div className="sub" id="stats">
            {stats}
          </div>
        </div>
        <div className="actions">
          {admin ? (
            <>
              <button type="button" className="d" onClick={() => setDialog({ kind: 'rollover' })}>
                Begin new semester
              </button>
              <button type="button" onClick={() => setDialog({ kind: 'semesters' })}>
                Semesters
              </button>
              <button type="button" className="p" onClick={() => setDialog({ kind: 'import' })}>
                Import Excel sheet
              </button>
              <button type="button" onClick={exportXlsx}>
                Export to Excel
              </button>
              <button type="button" className="d" onClick={clearAll}>
                Clear all data
              </button>
              <button type="button" onClick={logout} title={username ? `Signed in as ${username}` : undefined}>
                Log out
              </button>
            </>
          ) : (
            <button type="button" className="p" onClick={() => setDialog({ kind: 'login' })}>
              Admin login
            </button>
          )}
        </div>
      </header>

      {loadError && <div className="banner" role="alert">{loadError}</div>}

      <main>
        <RoomList
          rooms={rooms}
          totalRooms={summary?.rooms ?? 0}
          selectedId={selectedId}
          onSelect={setSelectedId}
          q={q}
          setQ={setQ}
          slot={slot}
          setSlot={setSlot}
          slotActive={slotActive}
          loading={loading}
          isAdmin={admin}
          onAddRoom={() => setDialog({ kind: 'room', room: null })}
        />
        <section>
          {selectedId && (summary?.rooms ?? 0) > 0 ? (
            <RoomDetail
              roomId={selectedId}
              isAdmin={admin}
              semesters={semesters}
              version={version}
              form={form}
              setForm={setForm}
              slotFilter={slotFilter}
              onChanged={changed}
              onEditRoom={(room) => setDialog({ kind: 'room', room })}
              onGone={onGone}
            />
          ) : (
            !loading && (
              <div className="card">
                <h2>Get started</h2>
                {admin ? (
                  <p className="empty">
                    Import an Excel sheet (.xlsx or .csv) with one row per room or booking, or add rooms one by one. Create a semester before adding weekly bookings.
                  </p>
                ) : (
                  <p className="empty">No rooms have been set up yet. The registrar can log in to add them.</p>
                )}
              </div>
            )
          )}
        </section>
      </main>

      {dialog?.kind === 'login' && (
        <LoginDialog
          onClose={() => setDialog(null)}
          onSuccess={async () => {
            const m = await api.me();
            setAdmin(m.admin);
            setUsername(m.username);
            setDialog(null);
            toast.ok('Logged in.');
            changed();
          }}
        />
      )}
      {dialog?.kind === 'room' && (
        <RoomDialog
          room={dialog.room}
          onClose={() => setDialog(null)}
          onSaved={(id) => {
            setDialog(null);
            setSelectedId(id);
            changed();
          }}
        />
      )}
      {dialog?.kind === 'semesters' && <SemestersDialog semesters={semesters} onClose={() => setDialog(null)} onChanged={changed} />}
      {dialog?.kind === 'rollover' && (
        <RolloverDialog
          scheduleCount={summary?.schedule ?? 0}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            changed();
          }}
        />
      )}
      {dialog?.kind === 'import' && (
        <ImportDialog
          semesters={semesters}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setSelectedId(null);
            changed();
          }}
        />
      )}
    </>
  );
}
