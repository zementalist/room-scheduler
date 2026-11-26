import { describeRange, scopesIntersect, type Slot } from '../../shared/conflict.ts';
import { fmt12, fmtTime, GRID_END, GRID_START } from '../../shared/time.ts';
import type { Reservation } from '../../shared/types.ts';

const SPAN = GRID_END - GRID_START;
const pct = (min: number) => ((Math.min(Math.max(min, GRID_START), GRID_END) - GRID_START) / SPAN) * 100;

function Bar({ from, to, cls }: { from: number; to: number; cls: string }) {
  if (to <= GRID_START || from >= GRID_END) return null;
  return <i className={cls} style={{ left: `${pct(from)}%`, width: `${pct(to) - pct(from)}%` }} />;
}

/**
 * Day strip 07:00-22:00. `scope` describes the pending day (a date, or a weekday within a term);
 * only existing bookings that fall on that day are drawn. A text summary mirrors the graphic.
 */
export function Timeline({
  reservations,
  scope,
  pending,
  ignoreId,
}: {
  reservations: Reservation[];
  scope: Slot | null;
  pending: { start: number; end: number } | null;
  ignoreId: string | null;
}) {
  const probe: Slot | null = scope && { ...scope, start: 0, end: 1440 };
  const onDay = probe ? reservations.filter((r) => r.id !== ignoreId && scopesIntersect(probe, r)) : [];
  const valid = pending && pending.end > pending.start ? pending : null;
  const overlapping = valid ? onDay.filter((r) => valid.start < r.end && r.start < valid.end) : [];

  const ticks: number[] = [];
  for (let m = 480; m <= 1200; m += 120) ticks.push(m);

  return (
    <div className="timeline">
      <div className="tl" aria-hidden="true">
        {onDay.map((r) => (
          <Bar key={r.id} from={r.start} to={r.end} cls="b" />
        ))}
        {valid && <Bar from={valid.start} to={valid.end} cls={overlapping.length ? 's bad' : 's'} />}
      </div>
      <div className="tlx" aria-hidden="true">
        {ticks.map((m) => (
          <span key={m} style={{ left: `${pct(m)}%` }}>
            {fmt12(m).replace(':00', '')}
          </span>
        ))}
      </div>
      <div className="sub legend">Red is already booked. Teal is your selection.</div>
      <p className="sub summary">
        {!scope
          ? 'Choose a date to see that day\u2019s bookings.'
          : onDay.length
            ? `Already booked that day: ${onDay.map((r) => `${fmtTime(r.start)} to ${fmtTime(r.end)}${r.course ? ` (${r.course})` : ''}`).join('; ')}.`
            : 'Nothing is booked in this room that day.'}
        {valid && ` Your selection: ${fmtTime(valid.start)} to ${fmtTime(valid.end)}.`}
        {overlapping.length > 0 && ` It overlaps ${describeRange(overlapping[0]!)}.`}
      </p>
    </div>
  );
}
