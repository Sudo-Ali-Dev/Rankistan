import React from 'react';
import Section from './Section';

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : '0');

/** One figure, in the style of the expanded card's Followers and Repos cells. */
function Stat({ label, value, sub }) {
  return (
    <div className="border-l border-outline-variant pl-4 py-2 min-w-0">
      <div className="font-mono text-[10px] text-outline uppercase tracking-widest">{label}</div>
      <div className="font-headline font-bold text-xl md:text-2xl tabular-nums leading-tight">
        {value}
      </div>
      {sub ? (
        <div className="font-mono text-[10px] text-outline uppercase tracking-wider break-words">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The numbers behind the rank: the score, and the three things that are shown beside it. The
 * score is printed to two decimals, the way the board prints it, so two developers never read
 * the same number for two different ranks.
 */
export default function StatsBar({ dev }) {
  const shown = Number(dev?.score_shown);
  const exact = Number(dev?.score_exact);
  const score = Number.isFinite(shown)
    ? shown
    : Number.isFinite(exact)
      ? exact
      : Number(dev?.score) || 0;
  const scoreText = Number.isFinite(shown)
    ? `${Math.trunc(shown).toLocaleString()}.${shown.toFixed(2).split('.')[1]}`
    : Math.trunc(score).toLocaleString();

  return (
    <Section title="Stats" icon="query_stats">
      <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-5 md:p-6">
        <Stat label="Score" value={scoreText} sub={`out of ${fmt(1000)}`} />
        <Stat label="Followers" value={fmt(dev?.followers)} sub="on GitHub" />
        <Stat label="Repos" value={fmt(dev?.public_repos)} sub="public" />
        <Stat label="Stars" value={fmt(dev?.total_stars)} sub="on their repositories" />
        <Stat label="Activity" value={fmt(dev?.events_30d)} sub="events in 30 days" />
      </div>
    </Section>
  );
}
