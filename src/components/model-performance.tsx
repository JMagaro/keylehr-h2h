/**
 * ModelPerformancePanel — a minimizable comparison of the three lineup models' real
 * performance. Uses a native <details>/<summary> so it collapses with no client JS (renders
 * in a Server Component). Shows an empty state until weeks have been graded.
 */
import { ChevronDown, LineChart } from 'lucide-react';

import { Badge } from '@/components/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/data-table';
import type { ModelPerformance } from '@/lib/players/performance';

function fmt(n: number | null, digits = 1): string {
  return n == null ? '—' : n.toFixed(digits);
}

export function ModelPerformancePanel({
  performance,
  defaultOpen = true,
}: {
  performance: ModelPerformance[];
  defaultOpen?: boolean;
}) {
  const hasData = performance.some((m) => m.weeksGraded > 0);

  return (
    <details open={defaultOpen} className="group min-w-0 rounded-lg border border-border bg-surface/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <LineChart className="size-4 text-accent" aria-hidden="true" />
          Model performance
          {hasData ? null : (
            <span className="text-xs font-normal text-subtle">— no graded weeks yet</span>
          )}
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-subtle transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>

      <div className="min-w-0 border-t border-border px-3 py-3">
        {hasData ? (
          <>
            <Table>
              <caption className="sr-only">Model performance comparison</caption>
              <THead>
                <TR>
                  <TH>Model</TH>
                  <TH align="center">Stage</TH>
                  <TH align="right">Wks</TH>
                  <TH align="right">Avg pts</TH>
                  <TH align="right">% opt</TH>
                  <TH align="right">vs chalk</TH>
                </TR>
              </THead>
              <TBody>
                {performance.map((m) => (
                  <TR key={m.risk}>
                    <TD>
                      <span className="font-semibold text-foreground">{m.codename}</span>{' '}
                      <span className="text-xs text-subtle">v{m.version}</span>
                    </TD>
                    <TD align="center">
                      <Badge variant={m.stage === 'trained' ? 'accent' : 'neutral'}>{m.stage}</Badge>
                    </TD>
                    <TD align="right" className="tabular-nums">{m.weeksGraded}</TD>
                    <TD align="right" className="tabular-nums font-semibold text-foreground">
                      {fmt(m.avgActual)}
                    </TD>
                    <TD align="right" className="tabular-nums">
                      {m.avgOptimalPct == null ? '—' : `${fmt(m.avgOptimalPct, 0)}%`}
                    </TD>
                    <TD align="right" className="tabular-nums">
                      {m.avgVsChalk == null ? '—' : (m.avgVsChalk >= 0 ? '+' : '') + fmt(m.avgVsChalk)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <p className="mt-2 text-xs text-subtle">
              Averaged over graded weeks. &ldquo;% opt&rdquo; = how close to the best possible lineup
              from the model&apos;s own considered players; &ldquo;vs chalk&rdquo; = points above a
              naive pay-up lineup (salary weeks only).
            </p>
          </>
        ) : (
          <p className="text-sm text-muted">
            These are versioned <strong>heuristic</strong> models today; once a season of results is
            collected they&apos;ll be trained on that data and graduate to <strong>v1.0</strong>.
            Tracking begins when the season&apos;s slates go live and a week is graded — each
            model&apos;s real scores will appear here.
          </p>
        )}
      </div>
    </details>
  );
}
