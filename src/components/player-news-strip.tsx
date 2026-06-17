/**
 * PlayerNewsStrip — the "around the league" section on My Team. Three panels:
 *   • In the spotlight — players with the strongest waiver buzz (healthy + relevant)
 *   • Fade risks      — relevant players who are injured-out or being dropped
 *   • Latest news     — a few ESPN NFL headlines
 *
 * Presentational Server Component; data comes from getSpotlightData(). Degrades to a
 * single honest note when the free signals are unavailable. Includes a CTA to the
 * lineup-builder wizard.
 */
import Link from 'next/link';
import { ArrowRight, Flame, Newspaper, TrendingDown, Wand2 } from 'lucide-react';

import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { PlayerCard } from '@/components/player-card';
import type { SpotlightData } from '@/lib/players/query';

function PanelHeader({
  icon: Icon,
  title,
  description,
  accent,
}: {
  icon: typeof Flame;
  title: string;
  description: string;
  accent: string;
}) {
  return (
    <CardHeader>
      <div className="flex items-center gap-3">
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${accent}`}>
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-0.5">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
      </div>
    </CardHeader>
  );
}

export function PlayerNewsStrip({ data }: { data: SpotlightData }) {
  const { spotlight, fadeRisks, news, signalsAvailable } = data;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold tracking-tight text-foreground">Around the league</h2>
          <p className="text-sm text-muted">
            Live availability &amp; waiver signals to inform your next DraftKings lineup. Built from
            free public sources (Sleeper trends + injury tags, ESPN news) — news and availability,
            not point projections.
          </p>
        </div>
        <Link
          href="/my-team/builder"
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-accent-fg shadow-sm transition-colors hover:bg-accent-strong"
        >
          <Wand2 className="size-4" aria-hidden="true" />
          Lineup builder
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>

      {!signalsAvailable ? (
        <Card>
          <CardBody>
            <p className="text-sm text-muted">
              Player signals are temporarily unavailable (the free Sleeper/ESPN feeds didn&apos;t
              respond). They&apos;ll reappear automatically on the next load.
            </p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Spotlight */}
          <Card className="min-w-0">
            <PanelHeader
              icon={Flame}
              title="In the spotlight"
              description="Most-added players across fantasy this week."
              accent="bg-win-soft text-win"
            />
            <CardBody className="flex flex-col divide-y divide-border pt-0">
              {spotlight.length ? (
                spotlight.map((p) => <PlayerCard key={p.id} data={p} />)
              ) : (
                <p className="py-3 text-sm text-muted">No trending adds right now.</p>
              )}
            </CardBody>
          </Card>

          {/* Fade risks */}
          <Card className="min-w-0">
            <PanelHeader
              icon={TrendingDown}
              title="Fade risks"
              description="Notable names who are hurt or being dropped."
              accent="bg-loss-soft text-loss"
            />
            <CardBody className="flex flex-col divide-y divide-border pt-0">
              {fadeRisks.length ? (
                fadeRisks.map((p) => <PlayerCard key={p.id} data={p} />)
              ) : (
                <p className="py-3 text-sm text-muted">No notable fade risks right now.</p>
              )}
            </CardBody>
          </Card>

          {/* News */}
          <Card className="min-w-0">
            <PanelHeader
              icon={Newspaper}
              title="Latest news"
              description="Headlines from around the NFL (ESPN)."
              accent="bg-accent/10 text-accent"
            />
            <CardBody className="flex flex-col gap-3 pt-0">
              {news.length ? (
                news.map((n, i) => (
                  <a
                    key={i}
                    href={n.link ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex flex-col gap-0.5"
                  >
                    <span className="text-sm font-semibold text-foreground group-hover:text-accent">
                      {n.headline}
                    </span>
                    {n.description ? (
                      <span className="line-clamp-2 text-xs text-muted">{n.description}</span>
                    ) : null}
                  </a>
                ))
              ) : (
                <p className="text-sm text-muted">No headlines available right now.</p>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </section>
  );
}
