import { useEffect, useState } from 'react';
import { isValidDate } from '../../shared/time.ts';
import type { Room, Semester } from '../../shared/types.ts';
import { api, ApiFail, download, type ImportPreview } from './api.ts';
import { Modal, useConfirm, useToast } from './ui.tsx';

const errText = (e: unknown, fallback: string) => (e instanceof ApiFail ? e.message : fallback);

// ---------- Login ----------

export function LoginDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(username, password);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiFail && err.status === 429 ? 'Too many attempts. Wait a minute and try again.' : errText(err, 'Login failed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Admin login" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <label htmlFor="lu">Username</label>
          <input id="lu" value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
          <label htmlFor="lp" style={{ marginTop: 8 }}>
            Password
          </label>
          <input id="lp" type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} autoFocus />
          <div className="err" role="alert">
            {error}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="p" disabled={busy || !password}>
            Log in
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Room add / edit ----------

export function RoomDialog({ room, onClose, onSaved }: { room: Room | null; onClose: () => void; onSaved: (id: string) => void }) {
  const [name, setName] = useState(room?.name ?? '');
  const [building, setBuilding] = useState(room?.building ?? '');
  const [capacity, setCapacity] = useState(room?.capacity?.toString() ?? '');
  const [type, setType] = useState(room?.type ?? '');
  const [error, setError] = useState('');
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const body = { name, building, capacity: capacity === '' ? null : capacity, type };
      const saved = room ? await api.updateRoom(room.id, body) : await api.createRoom(body);
      toast.ok(room ? 'Room updated.' : `Room ${saved.name} added.`);
      onSaved(saved.id);
    } catch (err) {
      setError(errText(err, 'Could not save the room.'));
    }
  }

  return (
    <Modal title={room ? `Edit room ${room.name}` : 'Add room'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <label htmlFor="rn">Room name</label>
          <input id="rn" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          <div className="row">
            <div>
              <label htmlFor="rb">Building</label>
              <input id="rb" value={building} maxLength={100} onChange={(e) => setBuilding(e.target.value)} />
            </div>
            <div>
              <label htmlFor="rc">Capacity (seats)</label>
              <input id="rc" inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            </div>
            <div className="full">
              <label htmlFor="rt">Type</label>
              <input id="rt" value={type} maxLength={100} placeholder="Lecture hall, Lab…" onChange={(e) => setType(e.target.value)} />
            </div>
          </div>
          <div className="err" role="alert">
            {error}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="p" disabled={!name.trim()}>
            Save room
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Semesters ----------

function SemesterFields({
  initial,
  submitLabel,
  extra,
  alwaysCurrent,
  onSubmit,
  onCancel,
}: {
  initial?: Semester;
  submitLabel: string;
  extra?: React.ReactNode;
  alwaysCurrent?: boolean;
  onSubmit: (b: { name: string; startDate: string; endDate: string; isCurrent: boolean }) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [startDate, setStart] = useState(initial?.startDate ?? '');
  const [endDate, setEnd] = useState(initial?.endDate ?? '');
  const [isCurrent, setCurrent] = useState(initial?.isCurrent ?? true);
  const [error, setError] = useState('');
  const valid = name.trim() && isValidDate(startDate) && isValidDate(endDate) && endDate >= startDate;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await onSubmit({ name, startDate, endDate, isCurrent });
    } catch (err) {
      setError(errText(err, 'Could not save the semester.'));
    }
  }
  return (
    <form onSubmit={submit}>
      <label htmlFor="sn">Name</label>
      <input id="sn" value={name} placeholder="e.g. Spring 2026" onChange={(e) => setName(e.target.value)} />
      <div className="row">
        <div>
          <label htmlFor="ss">First day</label>
          <input id="ss" type="date" value={startDate} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <label htmlFor="se">Last day</label>
          <input id="se" type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      {startDate && endDate && endDate < startDate && <div className="err">The last day must not be before the first day.</div>}
      {!initial?.isCurrent && !alwaysCurrent && (
        <label className="check">
          <input type="checkbox" checked={isCurrent} onChange={(e) => setCurrent(e.target.checked)} /> Make this the current semester
        </label>
      )}
      {extra}
      <div className="err" role="alert">
        {error}
      </div>
      <div className="form-actions">
        <button type="submit" className="p" disabled={!valid}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function SemestersDialog({ semesters, onClose, onChanged }: { semesters: Semester[]; onClose: () => void; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | 'new' | null>(semesters.length ? null : 'new');
  const confirm = useConfirm();
  const toast = useToast();

  async function remove(s: Semester) {
    const ok = await confirm({
      title: `Delete ${s.name}?`,
      message: <p>The semester definition and every weekly booking in it will be deleted. This cannot be undone.</p>,
      confirmLabel: 'Delete semester',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.deleteSemester(s.id, true);
      toast.ok(`Semester deleted (${r.bookingsDeleted} weekly booking(s) removed).`);
      onChanged();
    } catch (e) {
      toast.error(errText(e, 'Could not delete the semester.'));
    }
  }

  return (
    <Modal title="Semesters" onClose={onClose} wide>
      <div className="modal-body">
        <p className="sub">Weekly bookings repeat only between a semester’s first and last day, so different semesters never clash with each other.</p>
        {semesters.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Dates</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {semesters.map((s) =>
                editing === s.id ? (
                  <tr key={s.id}>
                    <td colSpan={3}>
                      <SemesterFields
                        initial={s}
                        submitLabel="Save semester"
                        onCancel={() => setEditing(null)}
                        onSubmit={async (b) => {
                          await api.updateSemester(s.id, b);
                          toast.ok('Semester updated.');
                          setEditing(null);
                          onChanged();
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={s.id}>
                    <td>
                      {s.name} {s.isCurrent && <span className="tag ev">Current</span>}
                    </td>
                    <td>
                      {s.startDate} to {s.endDate}
                    </td>
                    <td className="res-actions">
                      <button type="button" onClick={() => setEditing(s.id)}>
                        Edit
                      </button>
                      <button type="button" className="d" onClick={() => remove(s)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
        {editing === 'new' ? (
          <>
            <h3>New semester</h3>
            <SemesterFields
              submitLabel="Create semester"
              onCancel={semesters.length ? () => setEditing(null) : undefined}
              onSubmit={async (b) => {
                await api.createSemester(b);
                toast.ok('Semester created.');
                setEditing(null);
                onChanged();
              }}
            />
          </>
        ) : (
          <button type="button" onClick={() => setEditing('new')}>
            Add semester
          </button>
        )}
      </div>
    </Modal>
  );
}

export function RolloverDialog({ scheduleCount, onClose, onDone }: { scheduleCount: number; onClose: () => void; onDone: () => void }) {
  const [clear, setClear] = useState(true);
  const toast = useToast();
  return (
    <Modal title="Begin new semester" onClose={onClose}>
      <div className="modal-body">
        <p>
          Creates the new semester and makes it current. Rooms and one-off events are always kept.
        </p>
        <SemesterFields
          submitLabel={clear ? `Start semester and clear ${scheduleCount} schedule booking${scheduleCount === 1 ? '' : 's'}` : 'Start semester'}
          alwaysCurrent
          onCancel={onClose}
          extra={
            <label className="check">
              <input type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} /> Clear all {scheduleCount} schedule booking(s) from the previous term (cannot be undone)
            </label>
          }
          onSubmit={async (b) => {
            const r = await api.rollover({ name: b.name, startDate: b.startDate, endDate: b.endDate, clearSchedule: clear });
            toast.ok(`${r.semester.name} started${clear ? `; ${r.scheduleCleared} schedule booking(s) cleared` : ''}. Rooms and events kept.`);
            onDone();
          }}
        />
      </div>
    </Modal>
  );
}

// ---------- Import ----------

const FIELD_LABELS: Record<string, string> = {
  room: 'Room',
  building: 'Building',
  capacity: 'Capacity',
  type: 'Type',
  course: 'Course',
  date: 'Date / day',
  start: 'Start',
  end: 'End',
  category: 'Category',
  semester: 'Semester',
};

export function ImportDialog({ semesters, onClose, onDone }: { semesters: Semester[]; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [semesterId, setSemesterId] = useState(semesters.find((s) => s.isCurrent)?.id ?? '');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // Re-run the dry run whenever the file or options change; nothing is saved until "Import".
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setBusy(true);
    setError('');
    api
      .importPreview(file, mode, semesterId)
      .then((p) => !cancelled && setPreview(p))
      .catch((e) => {
        if (cancelled) return;
        setPreview(null);
        setError(errText(e, 'Could not read that file.'));
      })
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [file, mode, semesterId]);

  async function confirmImport() {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await api.importConfirm(preview.token);
      toast.ok(`Imported ${r.rooms.new} new room(s), ${r.rooms.updated} updated, ${r.reservations.valid} booking(s). ${r.reservations.skipped + r.reservations.conflicts} row(s) not imported.`);
      onDone();
    } catch (e) {
      setError(errText(e, 'Import failed.'));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  const p = preview;
  const nothing = p && !p.rooms.new && !p.rooms.updated && !p.reservations.valid;
  return (
    <Modal title="Import Excel sheet" onClose={onClose} wide>
      <div className="modal-body">
        <p className="sub">
          One row per booking (or per room). Recognised columns: Room, Building, Capacity, Type, Course, Category, Date (a date or a weekday such as Monday), Start, End, Semester.{' '}
          <a
            href="/api/template"
            onClick={(e) => {
              e.preventDefault();
              download('/api/template', 'room-reservations-template.xlsx').catch((err) => toast.error(errText(err, 'Download failed.')));
            }}
          >
            Download a template
          </a>
        </p>
        <label htmlFor="if">File (.xlsx, .xls or .csv)</label>
        <input id="if" type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} />

        <fieldset className="radio col">
          <legend className="sub">If rooms or bookings already exist</legend>
          <label>
            <input type="radio" name="mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
            <span><b>Merge</b> – add and update; never delete. Clashing rows are skipped and listed.</span>
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
            <span><b>Replace</b> – delete all current rooms and bookings first, then load this file.</span>
          </label>
        </fieldset>

        <label htmlFor="isem">Semester for weekly rows without a Semester column value</label>
        <select id="isem" value={semesterId} onChange={(e) => setSemesterId(e.target.value)}>
          <option value="">Current semester{semesters.find((s) => s.isCurrent) ? ` (${semesters.find((s) => s.isCurrent)!.name})` : ' (none set)'}</option>
          {semesters.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <div className="err" role="alert">
          {error}
        </div>
        {busy && !p && <p className="sub">Reading file…</p>}

        {p && (
          <div className="preview" aria-live="polite">
            <h3>Preview – nothing has been saved yet</h3>
            <ul className="stats">
              <li><b>{p.rooms.new}</b> new room(s), <b>{p.rooms.updated}</b> existing room(s) matched</li>
              <li><b>{p.reservations.valid}</b> booking(s) ready to import</li>
              {p.reservations.duplicates > 0 && <li><b>{p.reservations.duplicates}</b> identical booking(s) already exist (skipped)</li>}
              <li className={p.reservations.skipped ? 'bad' : ''}><b>{p.reservations.skipped}</b> row(s) skipped</li>
              <li className={p.reservations.conflicts ? 'bad' : ''}><b>{p.reservations.conflicts}</b> clash(es)</li>
            </ul>
            {p.mode === 'replace' && (p.removal.rooms > 0 || p.removal.reservations > 0) && (
              <div className="warn">
                Replace will permanently delete {p.removal.rooms} existing room(s) and {p.removal.reservations} booking(s).
              </div>
            )}
            <p className="sub">
              Columns used: {Object.entries(p.recognisedColumns).map(([f, h]) => `${FIELD_LABELS[f] ?? f} ← “${h}”`).join(', ') || 'none'}.
              {p.ignoredColumns.length > 0 && ` Ignored: ${p.ignoredColumns.map((c) => `“${c}”`).join(', ')}.`}
              {p.ignoredSheets.map((s) => ` Sheet “${s.sheet}” ignored: ${s.reason}.`)}
            </p>
            <Diagnostics title="Skipped rows" rows={p.skipped} />
            <Diagnostics title="Clashes (not imported)" rows={p.conflicts} />
            {p.truncated && <p className="sub">Only the first 200 entries of each list are shown.</p>}
          </div>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={mode === 'replace' ? 'd solid' : 'p'} disabled={!p || busy || !!nothing} onClick={confirmImport}>
          {mode === 'replace' ? 'Replace everything and import' : 'Import'}
        </button>
      </div>
    </Modal>
  );
}

function Diagnostics({ title, rows }: { title: string; rows: { sheet: string; row: number; reason: string }[] }) {
  if (!rows.length) return null;
  return (
    <details open={rows.length <= 10}>
      <summary>
        {title} ({rows.length})
      </summary>
      <div className="scroll diag">
        <table className="table">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="nowrap">
                  {r.sheet} row {r.row}
                </td>
                <td>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
