'use client';

/**
 * PlayoffOddsChart — a 538-style "playoff odds over time" multi-line chart.
 *
 * One line per owner: x = regular-season week, y = playoff probability (0–100%).
 * All lines render faint by default; hovering/focusing a line — or picking an
 * owner from the searchable legend — highlights that owner's line in their team
 * color and reveals a tooltip with the week + exact percentage. A conference
 * filter (All / AFC / NFC) trims the clutter of 32 lines.
 *
 * Implementation notes
 *  - Pure inline SVG with a `viewBox`, so it scales responsively with no
 *    charting dependency. Geometry is computed in a fixed 1000×460 coordinate
 *    space and the SVG stretches to its container width.
 *  - Accessible: an `aria`-labelled figure, plus a visually-hidden data table of
 *    every owner's final-week odds as a screen-reader fallback.
 *
 * Demo usage (e.g. from the server `/playoffs` page):
 *
 *   import { getOddsTrend } from '@/lib/odds/query';
 *   import { PlayoffOddsChart } from '@/components/playoff-odds-chart';
 *
 *   export default async function Page() {
 *     const trend = await getOddsTrend(seasonId); // server-side DB read
 *     return <PlayoffOddsChart trend={trend} />;   // client component
 *   }
 */
import { useId, useMemo, useState } from 'react';

import { TeamLogo } from '@/components/team-logo';
import { cn } from '@/lib/utils';
import type { OddsTrend, OddsTrendOwner } from '@/lib/odds/query';

export interface PlayoffOddsChartProps {
  trend: OddsTrend;
  className?: string;
}

type ConferenceFilter = 'All' | 'AFC' | 'NFC';

/* Fixed drawing space (the SVG scales to its container via viewBox). */
const VIEW_W = 1000;
const VIEW_H = 460;
const PAD = { top: 24, right: 24, bottom: 40, left: 44 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PLOT_H = VIEW_H - PAD.top - PAD.bottom;

/** Neutral fallback color for owners whose team has no brand color. */
const FALLBACK_COLOR = '#64748b';

interface Pt {
  x: number;
  y: number;
  week: number;
  pct: number;
}

/** Map an owner's nullable series to plotted points (skipping gap weeks). */
function pointsFor(
  owner: OddsTrendOwner,
  weeks: number[],
  xOf: (i: number) => number,
  yOf: (pct: number) => number,
): Pt[] {
  const pts: Pt[] = [];
  owner.series.forEach((pct, i) => {
    if (pct === null) return;
    pts.push({ x: xOf(i), y: yOf(pct), week: weeks[i], pct });
  });
  return pts;
}

/** A smooth-ish polyline `d` from a point list (straight segments; crisp + cheap). */
function pathD(pts: Pt[]): string {
  if (pts.length === 0) return '';
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

export function PlayoffOddsChart({ trend, className }: PlayoffOddsChartProps) {
  const titleId = useId();
  const descId = useId();
  const [conf, setConf] = useState<ConferenceFilter>('All');
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [hoverWeekIdx, setHoverWeekIdx] = useState<number | null>(null);

  const { weeks, owners } = trend;

  const visibleOwners = useMemo(
    () => owners.filter((o) => conf === 'All' || o.conference === conf),
    [owners, conf],
  );

  const filteredLegend = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visibleOwners;
    return visibleOwners.filter(
      (o) =>
        o.ownerName.toLowerCase().includes(q) ||
        o.teamName.toLowerCase().includes(q) ||
        o.teamKey.toLowerCase().includes(q),
    );
  }, [visibleOwners, query]);

  // Coordinate transforms. With a single week, center the lone point.
  const xOf = useMemo(() => {
    const n = weeks.length;
    return (i: number) => (n <= 1 ? PAD.left + PLOT_W / 2 : PAD.left + (i / (n - 1)) * PLOT_W);
  }, [weeks.length]);
  const yOf = (pct: number) => PAD.top + (1 - pct / 100) * PLOT_H;

  const lastIdx = weeks.length - 1;
  const activeOwner = activeId !== null ? owners.find((o) => o.ownerSeasonId === activeId) : null;

  // Tooltip data: the active owner's value at the hovered week.
  const tooltip = useMemo(() => {
    if (!activeOwner || hoverWeekIdx === null) return null;
    const pct = activeOwner.series[hoverWeekIdx];
    if (pct === null) return null;
    return { x: xOf(hoverWeekIdx), y: yOf(pct), week: weeks[hoverWeekIdx], pct, owner: activeOwner };
  }, [activeOwner, hoverWeekIdx, weeks, xOf]);

  if (weeks.length === 0 || owners.length === 0) {
    return (
      <div
        className={cn(
          'flex min-h-48 items-center justify-center rounded-xl border border-border bg-card p-8 text-sm text-muted',
          className,
        )}
      >
        No playoff-odds data yet. Run the odds compute once games have been scored.
      </div>
    );
  }

  const yTicks = [0, 25, 50, 75, 100];

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Controls: conference filter + searchable owner picker. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Filter by conference"
          className="inline-flex rounded-lg border border-border-strong bg-card p-0.5 text-sm font-semibold"
        >
          {(['All', 'AFC', 'NFC'] as ConferenceFilter[]).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={conf === c}
              onClick={() => {
                setConf(c);
                if (c !== 'All' && activeOwner && activeOwner.conference !== c) setActiveId(null);
              }}
              className={cn(
                'rounded-md px-3 py-1 transition-colors',
                conf === c
                  ? 'bg-accent text-accent-fg'
                  : 'text-muted hover:bg-surface hover:text-foreground',
              )}
            >
              {c}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search owner or team…"
          aria-label="Search owner or team to highlight"
          className="w-56 rounded-lg border border-border-strong bg-card px-3 py-1.5 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
        />
      </div>

      <figure className="m-0" aria-labelledby={titleId} aria-describedby={descId}>
        <figcaption id={titleId} className="sr-only">
          Playoff odds over time
        </figcaption>
        <p id={descId} className="sr-only">
          Line chart of each owner&apos;s probability of making the playoffs, plotted by
          regular-season week from week {weeks[0]} to week {weeks[lastIdx]}. A data table of
          final-week odds follows.
        </p>

        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="h-auto w-full select-none rounded-xl border border-border bg-card"
          role="img"
          aria-labelledby={titleId}
          preserveAspectRatio="xMidYMid meet"
          onMouseLeave={() => setHoverWeekIdx(null)}
        >
          {/* Horizontal gridlines + y-axis labels. */}
          {yTicks.map((t) => {
            const y = yOf(t);
            return (
              <g key={t}>
                <line
                  x1={PAD.left}
                  x2={VIEW_W - PAD.right}
                  y1={y}
                  y2={y}
                  className="stroke-border"
                  strokeWidth={1}
                  strokeDasharray={t === 0 || t === 100 ? undefined : '3 4'}
                />
                <text
                  x={PAD.left - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-muted text-[11px]"
                >
                  {t}%
                </text>
              </g>
            );
          })}

          {/* X-axis week labels (thinned to avoid crowding). */}
          {weeks.map((w, i) => {
            const showEvery = weeks.length > 12 ? 2 : 1;
            if (i % showEvery !== 0 && i !== lastIdx) return null;
            return (
              <text
                key={w}
                x={xOf(i)}
                y={VIEW_H - PAD.bottom + 22}
                textAnchor="middle"
                className="fill-muted text-[11px]"
              >
                {w}
              </text>
            );
          })}
          <text
            x={PAD.left + PLOT_W / 2}
            y={VIEW_H - 4}
            textAnchor="middle"
            className="fill-muted text-[11px] font-medium"
          >
            Week
          </text>

          {/* Faint baseline (non-active) lines. */}
          {visibleOwners.map((o) => {
            if (o.ownerSeasonId === activeId) return null;
            const pts = pointsFor(o, weeks, xOf, yOf);
            return (
              <path
                key={o.ownerSeasonId}
                d={pathD(pts)}
                fill="none"
                stroke={o.color ?? FALLBACK_COLOR}
                strokeWidth={1.5}
                strokeOpacity={activeId === null ? 0.28 : 0.12}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="transition-[stroke-opacity] duration-150"
              />
            );
          })}

          {/* Hover capture columns: one invisible band per week sets hoverWeekIdx. */}
          {weeks.map((w, i) => {
            const bandW = weeks.length <= 1 ? PLOT_W : PLOT_W / (weeks.length - 1);
            const x = xOf(i) - bandW / 2;
            return (
              <rect
                key={w}
                x={Math.max(PAD.left, x)}
                y={PAD.top}
                width={bandW}
                height={PLOT_H}
                fill="transparent"
                onMouseEnter={() => setHoverWeekIdx(i)}
              />
            );
          })}

          {/* The active (highlighted) owner's line + markers, drawn on top. */}
          {activeOwner &&
            visibleOwners.some((o) => o.ownerSeasonId === activeId) &&
            (() => {
              const color = activeOwner.color ?? FALLBACK_COLOR;
              const pts = pointsFor(activeOwner, weeks, xOf, yOf);
              return (
                <g>
                  <path
                    d={pathD(pts)}
                    fill="none"
                    stroke={color}
                    strokeWidth={3.25}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {pts.map((p) => (
                    <circle
                      key={p.week}
                      cx={p.x}
                      cy={p.y}
                      r={hoverWeekIdx !== null && weeks[hoverWeekIdx] === p.week ? 5 : 3}
                      fill={color}
                      stroke="var(--color-card)"
                      strokeWidth={1.5}
                    />
                  ))}
                </g>
              );
            })()}

          {/* Hover guide + tooltip for the active owner. */}
          {tooltip && (
            <g pointerEvents="none">
              <line
                x1={tooltip.x}
                x2={tooltip.x}
                y1={PAD.top}
                y2={VIEW_H - PAD.bottom}
                className="stroke-border-strong"
                strokeWidth={1}
                strokeDasharray="2 3"
              />
              <g
                transform={`translate(${Math.min(tooltip.x + 10, VIEW_W - PAD.right - 150)}, ${Math.max(tooltip.y - 44, PAD.top)})`}
              >
                <rect
                  width={150}
                  height={40}
                  rx={6}
                  className="fill-elevated stroke-border-strong"
                  strokeWidth={1}
                />
                <text x={10} y={16} className="fill-foreground text-[12px] font-semibold">
                  {tooltip.owner.teamKey} · Wk {tooltip.week}
                </text>
                <text x={10} y={32} className="fill-muted text-[12px]">
                  {tooltip.pct.toFixed(1)}% playoff odds
                </text>
              </g>
            </g>
          )}
        </svg>
      </figure>

      {/* Searchable legend: click to highlight an owner's line. */}
      <ul
        className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3 lg:grid-cols-4"
        aria-label="Owners — select to highlight"
      >
        {filteredLegend.map((o) => {
          const isActive = o.ownerSeasonId === activeId;
          const finalPct = o.series[lastIdx];
          return (
            <li key={o.ownerSeasonId}>
              <button
                type="button"
                aria-pressed={isActive}
                onClick={() => setActiveId(isActive ? null : o.ownerSeasonId)}
                onMouseEnter={() => setActiveId(o.ownerSeasonId)}
                onFocus={() => setActiveId(o.ownerSeasonId)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors',
                  isActive ? 'bg-surface' : 'hover:bg-surface',
                )}
              >
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: o.color ?? FALLBACK_COLOR }}
                />
                <TeamLogo src={o.logoEspn} alt={`${o.teamName} logo`} size={18} />
                <span className="truncate text-foreground">{o.ownerName}</span>
                <span className="ml-auto tabular-nums text-muted">
                  {finalPct === null ? '—' : `${Math.round(finalPct)}%`}
                </span>
              </button>
            </li>
          );
        })}
        {filteredLegend.length === 0 && (
          <li className="col-span-full px-2 py-1 text-sm text-muted">No owners match “{query}”.</li>
        )}
      </ul>

      {/* Screen-reader data-table fallback: final-week odds for every owner.
          Wrapped in an sr-only DIV (not on the table itself) — `sr-only`'s
          width:1px is ignored by <table>, which then expands to its content
          width and, being position:absolute, would extend the page's scroll
          region. The div clips it via overflow:hidden. */}
      <div className="sr-only">
      <table>
        <caption>Final-week playoff odds by owner (week {weeks[lastIdx]})</caption>
        <thead>
          <tr>
            <th scope="col">Owner</th>
            <th scope="col">Team</th>
            <th scope="col">Conference</th>
            <th scope="col">Playoff odds</th>
          </tr>
        </thead>
        <tbody>
          {owners.map((o) => (
            <tr key={o.ownerSeasonId}>
              <td>{o.ownerName}</td>
              <td>{o.teamName}</td>
              <td>{o.conference}</td>
              <td>{o.series[lastIdx] === null ? 'n/a' : `${o.series[lastIdx]!.toFixed(1)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
