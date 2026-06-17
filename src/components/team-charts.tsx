'use client';

/**
 * Interactive SVG charts for the per-team dashboard. Client components: hovering (or tapping)
 * a bar/point highlights it and shows a tooltip with that week's metadata; clicking pins the
 * tooltip (handy on touch). They still scale to their container via a fixed viewBox, so the
 * ExpandableChart modal just gives them more room.
 */
import { useState } from 'react';

import { cn } from '@/lib/utils';
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
const RESULT_WORD: Record<'W' | 'L' | 'T', string> = { W: 'Win', L: 'Loss', T: 'Tie' };

/** A floating tooltip positioned by percentage within the chart's relative wrapper. */
function Tooltip({ xPct, yPct, children }: { xPct: number; yPct: number; children: React.ReactNode }) {
  // Keep the tooltip on-screen near the edges.
  const tx = xPct < 16 ? '0' : xPct > 84 ? '-100%' : '-50%';
  return (
    <div
      className="pointer-events-none absolute z-20 -translate-y-[115%] rounded-lg border border-border-strong bg-elevated px-2.5 py-1.5 text-xs shadow-lg"
      style={{ left: `${xPct}%`, top: `${yPct}%`, transform: `translate(${tx}, -115%)` }}
      role="status"
    >
      {children}
    </div>
  );
}

/**
 * Weekly scores as bars (colored by W/L/T) with the per-week league-average drawn as an
 * accent line. Hover/tap a week to see its full result.
 */
export function WeeklyScoresChart({ weeks }: { weeks: TeamWeek[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const active = pinned ?? hover;

  const played = weeks.filter((w) => !w.isBye && w.points !== null);
  if (played.length === 0) {
    return <p className="text-sm text-muted">No scored weeks yet.</p>;
  }

  const maxVal = Math.max(...played.map((w) => w.points ?? 0), ...weeks.map((w) => w.leagueAvg ?? 0));
  const yMax = Math.ceil(maxVal / 25) * 25 || 25;

  const n = weeks.length;
  const slot = PLOT_W / n;
  const barW = Math.min(slot * 0.6, 26);
  const x = (i: number) => PAD.left + slot * i + slot / 2;
  const y = (v: number) => PAD.top + PLOT_H * (1 - v / yMax);

  const avgPts = weeks
    .map((w, i) => (w.leagueAvg !== null ? `${x(i)},${y(w.leagueAvg)}` : null))
    .filter(Boolean)
    .join(' ');

  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f));
  const activeWeek = active !== null ? weeks[active] : null;

  return (
    <figure className="flex flex-col gap-2">
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-none"
          role="img"
          aria-label="Weekly DraftKings scores versus the league average"
        >
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

          {weeks.map((w, i) =>
            w.points === null ? (
              <text
                key={w.week}
                x={x(i)}
                y={H - PAD.bottom + 16}
                textAnchor="middle"
                className={cn('text-[9px]', active === i ? 'fill-foreground' : 'fill-subtle')}
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
                  opacity={active === null || active === i ? 0.9 : 0.4}
                  stroke={active === i ? 'currentColor' : 'none'}
                  strokeWidth={active === i ? 1.5 : 0}
                />
                <text
                  x={x(i)}
                  y={H - PAD.bottom + 16}
                  textAnchor="middle"
                  className={cn('text-[9px]', active === i ? 'fill-foreground' : 'fill-subtle')}
                >
                  {w.week}
                </text>
              </g>
            ),
          )}

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

          {/* Full-height hit areas for easy hover/tap. */}
          {weeks.map((w, i) => (
            <rect
              key={`hit-${w.week}`}
              x={PAD.left + slot * i}
              y={PAD.top}
              width={slot}
              height={PLOT_H}
              fill="transparent"
              className="cursor-pointer"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => setPinned((p) => (p === i ? null : i))}
            />
          ))}
        </svg>

        {activeWeek ? (
          <Tooltip
            xPct={(x(active!) / W) * 100}
            yPct={(activeWeek.points !== null ? y(activeWeek.points) : PAD.top) / H * 100}
          >
            <p className="font-semibold text-foreground">Week {activeWeek.week}</p>
            {activeWeek.isBye ? (
              <p className="text-muted">Bye week</p>
            ) : activeWeek.points === null ? (
              <p className="text-muted">Not played yet</p>
            ) : (
              <div className="flex flex-col gap-0.5">
                <p className="tabular-nums text-foreground">
                  {activeWeek.points.toFixed(2)} pts
                  {activeWeek.result ? (
                    <span className={cn('ml-1 font-semibold', RESULT_CLASS[activeWeek.result])}>
                      {RESULT_WORD[activeWeek.result]}
                    </span>
                  ) : null}
                </p>
                {activeWeek.oppTeamKey ? (
                  <p className="text-muted">
                    vs {activeWeek.oppTeamKey}
                    {activeWeek.oppPoints !== null ? ` · ${activeWeek.oppPoints.toFixed(2)}` : ''}
                  </p>
                ) : null}
                {activeWeek.leagueAvg !== null ? (
                  <p className="text-subtle">Lg avg {activeWeek.leagueAvg.toFixed(1)}</p>
                ) : null}
                {activeWeek.thisForfeit ? (
                  <p className="font-medium text-loss">Missed lineup — auto-loss</p>
                ) : activeWeek.oppForfeit ? (
                  <p className="text-subtle">Opponent missed lineup</p>
                ) : null}
              </div>
            )}
          </Tooltip>
        ) : null}
      </div>

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
        <span className="text-subtle">· hover or tap a bar for detail</span>
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
 * A single-series line chart — rank-over-time (set `invert` so #1 sits at the top) or
 * playoff-odds % (0–100). Hover/tap a point for its value.
 */
export function TrendLineChart({
  data,
  min,
  max,
  invert = false,
  valuePrefix = '',
  valueSuffix = '',
  seriesLabel,
  ariaLabel,
}: {
  data: TrendPoint[];
  min: number;
  max: number;
  invert?: boolean;
  valuePrefix?: string;
  valueSuffix?: string;
  seriesLabel?: string;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const active = pinned ?? hover;

  const pts = data.filter((d) => d.value !== null);
  if (pts.length === 0) return <p className="text-sm text-muted">Not enough data yet.</p>;

  const n = data.length;
  const span = max - min || 1;
  const x = (i: number) => PAD.left + (n === 1 ? PLOT_W / 2 : (PLOT_W * i) / (n - 1));
  const y = (v: number) => {
    const t = (v - min) / span;
    const frac = invert ? t : 1 - t;
    return PAD.top + PLOT_H * frac;
  };

  const linePts = data
    .map((d, i) => (d.value !== null ? `${x(i)},${y(d.value)}` : null))
    .filter(Boolean)
    .join(' ');

  const ticks = [min, Math.round((min + max) / 2), max];
  const colW = n > 1 ? PLOT_W / (n - 1) : PLOT_W;
  const activePoint = active !== null ? data[active] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full touch-none" role="img" aria-label={ariaLabel}>
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
              {valuePrefix}
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
              <circle
                cx={x(i)}
                cy={y(d.value)}
                r={active === i ? 5 : 3}
                fill="currentColor"
                stroke={active === i ? 'var(--color-card)' : 'none'}
                strokeWidth={active === i ? 2 : 0}
              />
              <text
                x={x(i)}
                y={H - PAD.bottom + 16}
                textAnchor="middle"
                className={cn('text-[9px]', active === i ? 'fill-foreground' : 'fill-subtle')}
              >
                {d.label}
              </text>
            </g>
          ),
        )}

        {/* Column hit areas. */}
        {data.map((d, i) => (
          <rect
            key={`hit-${i}`}
            x={Math.max(PAD.left, x(i) - colW / 2)}
            y={PAD.top}
            width={colW}
            height={PLOT_H}
            fill="transparent"
            className="cursor-pointer"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onClick={() => setPinned((p) => (p === i ? null : i))}
          />
        ))}
      </svg>

      {activePoint && activePoint.value !== null ? (
        <Tooltip xPct={(x(active!) / W) * 100} yPct={(y(activePoint.value) / H) * 100}>
          <p className="font-semibold text-foreground">{activePoint.label}</p>
          <p className="tabular-nums text-muted">
            {seriesLabel ? `${seriesLabel}: ` : ''}
            {valuePrefix}
            {activePoint.value}
            {valueSuffix}
          </p>
        </Tooltip>
      ) : null}
    </div>
  );
}
