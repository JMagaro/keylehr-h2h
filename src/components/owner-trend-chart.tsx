'use client';

/**
 * OwnerTrendChart / OwnerTrendsPanel — overlaid year-over-year line charts, one line per
 * owner, modeled directly on `PlayoffOddsChart`'s interaction pattern: all lines render
 * faint by default, and a shared searchable legend highlights one owner's line (in their
 * team color) across BOTH charts at once so you can compare their win trend against their
 * scoring trend side by side.
 *
 * Pure inline SVG (no charting dependency), scales responsively via `viewBox`.
 */
import { useId, useMemo, useState } from 'react';

import { TeamLogo } from '@/components/team-logo';
import { forDarkBackground, useIsDarkMode } from '@/lib/color';
import { cn } from '@/lib/utils';
import type { OwnerSeasonTrends } from '@/lib/history';

const VIEW_W = 1000;
const VIEW_H = 460;
const PAD = { top: 20, right: 20, bottom: 36, left: 48 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PLOT_H = VIEW_H - PAD.top - PAD.bottom;

/** Neutral fallback color for owners whose team has no brand color. */
const FALLBACK_COLOR = '#64748b';

interface ChartOwner {
  ownerId: number;
  ownerName: string;
  teamKey: string | null;
  teamName: string | null;
  logoEspn: string | null;
  color: string | null;
  series: (number | null)[];
}

interface Pt {
  x: number;
  y: number;
  idx: number;
  value: number;
}

function pointsFor(series: (number | null)[], xOf: (i: number) => number, yOf: (v: number) => number): Pt[] {
  const pts: Pt[] = [];
  series.forEach((v, i) => {
    if (v !== null) pts.push({ x: xOf(i), y: yOf(v), idx: i, value: v });
  });
  return pts;
}

/** A straight-segment polyline `d` from a point list — crisp + cheap, no curve fitting. */
function pathD(pts: Pt[]): string {
  if (pts.length === 0) return '';
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

interface OwnerTrendChartProps {
  years: number[];
  owners: ChartOwner[];
  activeOwnerId: number | null;
  title: string;
  ariaLabel: string;
  valueFormat?: (v: number) => string;
  yMin: number;
  yMax: number;
}

/** One metric's overlaid line chart. Highlight is CONTROLLED via `activeOwnerId` (set by the shared legend). */
export function OwnerTrendChart({
  years,
  owners,
  activeOwnerId,
  title,
  ariaLabel,
  valueFormat = (v) => `${v}`,
  yMin,
  yMax,
}: OwnerTrendChartProps) {
  const titleId = useId();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const isDark = useIsDarkMode();
  const lineColor = (c: string | null) => {
    const base = c ?? FALLBACK_COLOR;
    return isDark ? forDarkBackground(base) : base;
  };

  const xOf = (i: number) =>
    years.length <= 1 ? PAD.left + PLOT_W / 2 : PAD.left + (i / (years.length - 1)) * PLOT_W;
  const span = yMax - yMin || 1;
  const yOf = (v: number) => PAD.top + (1 - (v - yMin) / span) * PLOT_H;

  const activeOwner = activeOwnerId !== null ? owners.find((o) => o.ownerId === activeOwnerId) : null;
  const lastIdx = years.length - 1;

  const tooltip = useMemo(() => {
    if (!activeOwner || hoverIdx === null) return null;
    const v = activeOwner.series[hoverIdx];
    if (v === null || v === undefined) return null;
    return { x: xOf(hoverIdx), y: yOf(v), year: years[hoverIdx], value: v };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOwner, hoverIdx, years]);

  if (years.length === 0 || owners.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-xl border border-border bg-card p-8 text-sm text-muted">
        Not enough season data yet.
      </div>
    );
  }

  const TICK_COUNT = 6;
  const yTicks = Array.from({ length: TICK_COUNT }, (_, i) => yMin + ((yMax - yMin) * i) / (TICK_COUNT - 1));

  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption id={titleId} className="text-sm font-semibold text-foreground">
        {title}
      </figcaption>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="h-auto w-full select-none rounded-xl border border-border bg-card"
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHoverIdx(null)}
      >
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
                strokeDasharray={t === yMin || t === yMax ? undefined : '3 4'}
              />
              <text x={PAD.left - 8} y={y + 4} textAnchor="end" className="fill-muted text-[11px]">
                {valueFormat(t)}
              </text>
            </g>
          );
        })}

        {years.map((yr, i) => (
          <text
            key={yr}
            x={xOf(i)}
            y={VIEW_H - PAD.bottom + 22}
            textAnchor="middle"
            className="fill-muted text-[11px]"
          >
            {yr}
          </text>
        ))}

        {/* Faint baseline (non-active) lines. */}
        {owners.map((o) => {
          if (o.ownerId === activeOwnerId) return null;
          const pts = pointsFor(o.series, xOf, yOf);
          return (
            <path
              key={o.ownerId}
              d={pathD(pts)}
              fill="none"
              stroke={lineColor(o.color)}
              strokeWidth={1.5}
              strokeOpacity={activeOwnerId === null ? (isDark ? 0.4 : 0.28) : isDark ? 0.2 : 0.12}
              strokeLinejoin="round"
              strokeLinecap="round"
              className="transition-[stroke-opacity] duration-150"
            />
          );
        })}

        {/* Hover capture columns: one band per year sets hoverIdx. */}
        {years.map((yr, i) => {
          const bandW = years.length <= 1 ? PLOT_W : PLOT_W / (years.length - 1);
          const x = xOf(i) - bandW / 2;
          return (
            <rect
              key={yr}
              x={Math.max(PAD.left, x)}
              y={PAD.top}
              width={bandW}
              height={PLOT_H}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
            />
          );
        })}

        {/* The active (highlighted) owner's line + markers, drawn on top. */}
        {activeOwner &&
          (() => {
            const color = lineColor(activeOwner.color);
            const pts = pointsFor(activeOwner.series, xOf, yOf);
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
                    key={p.idx}
                    cx={p.x}
                    cy={p.y}
                    r={hoverIdx === p.idx ? 5 : 3}
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
              <rect width={150} height={40} rx={6} className="fill-elevated stroke-border-strong" strokeWidth={1} />
              <text x={10} y={16} className="fill-foreground text-[12px] font-semibold">
                {activeOwner?.teamKey ?? activeOwner?.ownerName} · {tooltip.year}
              </text>
              <text x={10} y={32} className="fill-muted text-[12px]">
                {valueFormat(tooltip.value)}
              </text>
            </g>
          </g>
        )}
      </svg>

      {/* Screen-reader data-table fallback: final-year value for every owner. */}
      <div className="sr-only">
        <table>
          <caption>{title} — final season ({years[lastIdx]}) value by owner</caption>
          <thead>
            <tr>
              <th scope="col">Owner</th>
              <th scope="col">Team</th>
              <th scope="col">{title}</th>
            </tr>
          </thead>
          <tbody>
            {owners.map((o) => {
              const v = o.series[lastIdx];
              return (
                <tr key={o.ownerId}>
                  <td>{o.ownerName}</td>
                  <td>{o.teamName}</td>
                  <td>{v === null || v === undefined ? 'n/a' : valueFormat(v)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/** Shared legend + both metric charts, with one synced highlighted owner. */
export function OwnerTrendsPanel({ trends }: { trends: OwnerSeasonTrends }) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const isDark = useIsDarkMode();
  const legendDotColor = (c: string | null) => {
    const base = c ?? FALLBACK_COLOR;
    return isDark ? forDarkBackground(base) : base;
  };

  const filteredLegend = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return trends.owners;
    return trends.owners.filter(
      (o) =>
        o.ownerName.toLowerCase().includes(q) ||
        (o.teamName ?? '').toLowerCase().includes(q) ||
        (o.teamKey ?? '').toLowerCase().includes(q),
    );
  }, [trends.owners, query]);

  const winsOwners: ChartOwner[] = trends.owners.map((o) => ({ ...o, series: o.wins }));
  const pfOwners: ChartOwner[] = trends.owners.map((o) => ({ ...o, series: o.avgPointsFor }));

  const allWins = trends.owners.flatMap((o) => o.wins.filter((v): v is number => v !== null));
  const winsYMax = allWins.length ? Math.max(2, Math.ceil((Math.max(...allWins) + 1) / 2) * 2) : 10;

  const allPf = trends.owners.flatMap((o) => o.avgPointsFor.filter((v): v is number => v !== null));
  const pfYMin = allPf.length ? Math.max(0, Math.floor((Math.min(...allPf) - 10) / 10) * 10) : 0;
  const pfYMax = allPf.length ? Math.ceil((Math.max(...allPf) + 10) / 10) * 10 : 100;

  if (trends.years.length === 0 || trends.owners.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-xl border border-border bg-card p-8 text-sm text-muted">
        Not enough completed seasons yet to chart owner trends.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-6 lg:grid-cols-2">
        <OwnerTrendChart
          years={trends.years}
          owners={winsOwners}
          activeOwnerId={activeId}
          title="Wins per season"
          ariaLabel="Regular-season wins per year, one line per owner"
          valueFormat={(v) => `${Math.round(v)}`}
          yMin={0}
          yMax={winsYMax}
        />
        <OwnerTrendChart
          years={trends.years}
          owners={pfOwners}
          activeOwnerId={activeId}
          title="Average Points For per season"
          ariaLabel="Average regular-season DraftKings points per game, one line per owner"
          valueFormat={(v) => v.toFixed(1)}
          yMin={pfYMin}
          yMax={pfYMax}
        />
      </div>

      {/* Shared searchable legend: click/hover to highlight an owner on BOTH charts. */}
      <div className="flex flex-col gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search owner or team…"
          aria-label="Search owner or team to highlight"
          className="w-full max-w-xs self-start rounded-lg border border-border-strong bg-card px-3 py-1.5 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
        />
        <ul
          className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3 lg:grid-cols-4"
          aria-label="Owners — select to highlight on both charts"
        >
          {filteredLegend.map((o) => {
            const isActive = o.ownerId === activeId;
            return (
              <li key={o.ownerId}>
                <button
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setActiveId(isActive ? null : o.ownerId)}
                  onMouseEnter={() => setActiveId(o.ownerId)}
                  onFocus={() => setActiveId(o.ownerId)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors',
                    isActive ? 'bg-surface' : 'hover:bg-surface',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: legendDotColor(o.color) }}
                  />
                  <TeamLogo src={o.logoEspn} alt={`${o.teamName ?? 'team'} logo`} size={18} />
                  <span className="truncate text-foreground">{o.ownerName}</span>
                </button>
              </li>
            );
          })}
          {filteredLegend.length === 0 && (
            <li className="col-span-full px-2 py-1 text-sm text-muted">No owners match &ldquo;{query}&rdquo;.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
