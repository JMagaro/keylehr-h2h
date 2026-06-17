/**
 * Presentational SVG charts for the per-team dashboard. Server-rendered, no client
 * JS — pure SVG styled with the app's design tokens (win/loss/tie + accent). Each
 * chart scales to its container width via a fixed viewBox.
 */
import type { TeamWeek } from '@/lib/team/query';

const W = 760;
const H = 240;
const PAD = { top: 16, right: 16, bottom: 28, left: 36 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const RESULT_CLASS: Record<'W' | 'L' | 'T', string> = {
  W: 'text-win',
  L: 'text-loss',
  T: 'text-tie',
};

/**
 * Weekly scores as bars (colored by W/L/T) with the per-week league-average drawn
 * as an accent line, so you can read "above/below average" at a glance.
 */
export function WeeklyScoresChart({ weeks }: { weeks: TeamWeek[] }) {
  const played = weeks.filter((w) => !w.isBye && w.points !== null);
  if (played.length === 0) {
    return <p className="text-sm text-muted">No scored weeks yet.</p>;
  }

  const maxVal = Math.max(
    ...played.map((w) => w.points ?? 0),
    ...weeks.map((w) => w.leagueAvg ?? 0),
  );
  const yMax = Math.ceil(maxVal / 25) * 25 || 25;

  const n = weeks.length;
  const slot = PLOT_W / n;
  const barW = Math.min(slot * 0.6, 26);
  const x = (i: number) => PAD.left + slot * i + slot / 2;
  const y = (v: number) => PAD.top + PLOT_H * (1 - v / yMax);

  // League-average polyline across the weeks that have an average.
  const avgPts = weeks
    .map((w, i) => (w.leagueAvg !== null ? `${x(i)},${y(w.leagueAvg)}` : null))
    .filter(Boolean)
    .join(' ');

  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f));

  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Weekly DraftKings scores versus the league average"
      >
        {/* gridlines + y labels */}
        {gridVals.map((g) => (
          <g key={g}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(g)}
              y2={y(g)}
              className="text-border"
              stroke="currentColor"
              strokeWidth={1}
            />
            <text x={PAD.left - 6} y={y(g) + 3} textAnchor="end" className="fill-subtle text-[10px]">
              {g}
            </text>
          </g>
        ))}

        {/* bars */}
        {weeks.map((w, i) =>
          w.points === null ? (
            <text
              key={w.week}
              x={x(i)}
              y={H - PAD.bottom + 16}
              textAnchor="middle"
              className="fill-subtle text-[9px]"
            >
              {w.week}
            </text>
          ) : (
            <g key={w.week} className={w.result ? RESULT_CLASS[w.result] : 'text-muted'}>
              <rect
                x={x(i) - barW / 2}
                y={y(w.points)}
                width={barW}
                height={Math.max(0, PAD.top + PLOT_H - y(w.points))}
                rx={3}
                fill="currentColor"
                opacity={0.85}
              >
                <title>{`Wk ${w.week}: ${w.points.toFixed(2)}${w.result ? ` (${w.result})` : ''}`}</title>
              </rect>
              <text
                x={x(i)}
                y={H - PAD.bottom + 16}
                textAnchor="middle"
                className="fill-subtle text-[9px]"
              >
                {w.week}
              </text>
            </g>
          ),
        )}

        {/* league-average line */}
        {avgPts ? (
          <polyline
            points={avgPts}
            fill="none"
            className="text-accent"
            stroke="currentColor"
            strokeWidth={2}
            strokeDasharray="4 3"
          />
        ) : null}
      </svg>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-win" /> Win
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-loss" /> Loss
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-accent" /> League average
        </span>
      </figcaption>
    </figure>
  );
}

/** A point on a trend line: an x label and a value (null = gap / not yet known). */
export interface TrendPoint {
  label: string | number;
  value: number | null;
}

/**
 * A simple line chart for a single series — used for rank-over-time (set
 * `invert` so #1 sits at the top) and playoff-odds % (0–100).
 */
export function TrendLineChart({
  data,
  min,
  max,
  invert = false,
  valueSuffix = '',
  ariaLabel,
}: {
  data: TrendPoint[];
  min: number;
  max: number;
  invert?: boolean;
  valueSuffix?: string;
  ariaLabel: string;
}) {
  const pts = data.filter((d) => d.value !== null);
  if (pts.length === 0) return <p className="text-sm text-muted">Not enough data yet.</p>;

  const n = data.length;
  const span = max - min || 1;
  const x = (i: number) => PAD.left + (n === 1 ? PLOT_W / 2 : (PLOT_W * i) / (n - 1));
  const y = (v: number) => {
    const t = (v - min) / span; // 0 at min, 1 at max
    const frac = invert ? t : 1 - t; // invert → smaller value near the top
    return PAD.top + PLOT_H * frac;
  };

  const linePts = data
    .map((d, i) => (d.value !== null ? `${x(i)},${y(d.value)}` : null))
    .filter(Boolean)
    .join(' ');

  const ticks = [min, Math.round((min + max) / 2), max];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(t)}
            y2={y(t)}
            className="text-border"
            stroke="currentColor"
            strokeWidth={1}
          />
          <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" className="fill-subtle text-[10px]">
            {t}
            {valueSuffix}
          </text>
        </g>
      ))}

      <polyline
        points={linePts}
        fill="none"
        className="text-accent"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {data.map((d, i) =>
        d.value === null ? null : (
          <g key={i} className="text-accent">
            <circle cx={x(i)} cy={y(d.value)} r={3} fill="currentColor">
              <title>{`${d.label}: ${d.value}${valueSuffix}`}</title>
            </circle>
            <text
              x={x(i)}
              y={H - PAD.bottom + 16}
              textAnchor="middle"
              className="fill-subtle text-[9px]"
            >
              {d.label}
            </text>
          </g>
        ),
      )}
    </svg>
  );
}
