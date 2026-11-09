import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { loadBoard, loadDeveloperDetail } from '../utils/leaderboard-data';
import { similarDevelopers } from '../utils/similar-devs';
import { setProfileMeta } from '../utils/meta';
import { profileDescription } from '../utils/profile';
import ContributionHeatmap from '../components/ContributionHeatmap';
import RankHistoryPanel from '../components/RankHistoryPanel';
import ActivitySparkline from '../components/ActivitySparkline';
import Hero from '../components/profile/Hero';
import StatsBar from '../components/profile/StatsBar';
import AiSummary from '../components/profile/AiSummary';
import Breakdown from '../components/profile/Breakdown';
import TechStack from '../components/profile/TechStack';
import TopRepos from '../components/profile/TopRepos';
import Activity from '../components/profile/Activity';
import Similar from '../components/profile/Similar';
import BadgeEmbed from '../components/profile/BadgeEmbed';
import Section from '../components/profile/Section';
import Skeleton from '../components/profile/Skeleton';

/**
 * A developer's own page, at rankistan.dev/username.
 *
 * The board says who is on it; this page says who they are. It is the same page the badge link
 * opens, /#username, and the URL a developer can put in a bio, a resume or a tweet.
 *
 * Two files are read: the board, for the row and for the developers with the same tags, and the
 * developer's own file, for the bio, the repositories and the evidence behind the score. A
 * developer who is not on the board has no page: the board is the only list of who is.
 */
export default function DevProfile({ username, onBack, onOpenProfile, onBadge }) {
  // The answer is kept with the request it belongs to, so a retry or another developer shows the
  // waiting state rather than the last answer.
  const [state, setState] = useState({
    key: null,
    status: 'loading',
    row: null,
    rows: [],
    detail: null
  });
  const [attempt, setAttempt] = useState(0);

  const key = `${username}#${attempt}`;
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    loadBoard().then(
      ({ payload }) => {
        if (cancelled) return;
        const rows = Array.isArray(payload?.leaderboard) ? payload.leaderboard : [];
        const wanted = String(username || '').toLowerCase();
        const row = rows.find((r) => String(r?.username || '').toLowerCase() === wanted) ?? null;
        if (!row) {
          setState({ key, status: 'missing', row: null, rows: [], detail: null });
          return;
        }
        // The developer's own file: the bio, the repositories, the evidence behind the score.
        // When it cannot be read the page still shows what the board knows.
        loadDeveloperDetail(username).then(
          ({ developer }) => {
            if (!cancelled) setState({ key, status: 'ready', row, rows, detail: developer });
          },
          () => {
            if (!cancelled) setState({ key, status: 'ready', row, rows, detail: null });
          }
        );
      },
      () => {
        if (!cancelled) setState({ key, status: 'failed', row: null, rows: [], detail: null });
      }
    );

    return () => {
      cancelled = true;
    };
  }, [username, attempt, key]);

  const current =
    state.key === key ? state : { status: 'loading', row: null, rows: [], detail: null };
  const { status, row, rows, detail } = current;

  // The board row and the developer's own file are two views of the same row: the board carries
  // the list fields, the developer's file the rest - the biography, the repositories, the score's
  // evidence and the counts behind it. The board wins where both have a field, so the page
  // agrees with the row that was clicked.
  const dev = useMemo(() => (detail ? { ...detail, ...row } : row), [detail, row]);

  const sharedBy = useMemo(() => {
    if (!row) return 1;
    return rows.filter((r) => r.rank === row.rank).length || 1;
  }, [row, rows]);

  const neighbours = useMemo(
    () => (row ? similarDevelopers(rows, row.username, { limit: 4 }) : []),
    [rows, row]
  );

  useEffect(() => {
    if (!dev?.name) return;
    document.title = `${dev.name} (@${dev.username}) | Rankistan`;
  }, [dev]);

  // The page a link to this developer previews. The build writes these tags into the page
  // itself; they are set here as well for the page opened through the hash, which the server
  // cannot tell apart from the leaderboard.
  useEffect(() => {
    if (!dev) return;
    setProfileMeta({
      title: `${dev.name || dev.username} (@${dev.username}) | Rankistan`,
      description: profileDescription(dev, dev),
      url: `https://rankistan.dev/${dev.username}`,
      image: dev.avatar_url || 'https://rankistan.dev/favicon.svg'
    });
  }, [dev]);

  return (
    <main className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 grid-lines pointer-events-none"></div>
      <div className="max-w-7xl mx-auto p-4 md:p-8 relative z-10">
        <button
          type="button"
          onClick={onBack}
          className="mb-6 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-outline hover:text-primary transition-colors"
        >
          <span className="material-symbols-outlined text-sm" aria-hidden="true">
            arrow_back
          </span>
          The leaderboard
        </button>

        {status === 'loading' ? (
          <Skeleton />
        ) : status === 'missing' ? (
          <div className="border border-outline-variant bg-surface-container-lowest p-8 text-center">
            <div className="font-mono text-[10px] text-outline uppercase tracking-widest mb-3">
              404
            </div>
            <h1 className="font-headline text-2xl md:text-3xl font-bold tracking-tighter mb-3 break-words">
              Developer @{username} not found
            </h1>
            <p className="font-mono text-xs text-outline max-w-lg mx-auto leading-relaxed mb-6">
              A developer’s page is here while they are on the board. This one is not on it today.
            </p>
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-2 border border-outline-variant bg-surface-container-high px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-outline hover:border-primary hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-sm" aria-hidden="true">
                arrow_back
              </span>
              The leaderboard
            </button>
          </div>
        ) : status === 'failed' ? (
          <div className="border border-outline-variant bg-surface-container-lowest p-8 text-center">
            <h1 className="font-headline text-2xl font-bold tracking-tighter mb-3">
              The board could not be loaded just now.
            </h1>
            <p className="font-mono text-xs text-outline max-w-lg mx-auto leading-relaxed mb-6">
              Nothing was lost. Try again, and the page will open.
            </p>
            <button
              type="button"
              onClick={retry}
              className="inline-flex items-center gap-2 bg-tertiary text-on-tertiary px-4 py-2 font-mono text-[10px] uppercase tracking-widest font-bold hover:bg-tertiary-fixed transition-colors"
            >
              <span className="material-symbols-outlined text-sm" aria-hidden="true">
                refresh
              </span>
              Try again
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <Hero dev={dev} sharedBy={sharedBy} onBadge={onBadge} />

            <StatsBar dev={dev} />

            <AiSummary dev={dev} />

            <Section title="Contribution_Activity" icon="calendar_month">
              <div className="p-3 md:p-4 h-[220px] md:h-[280px] bg-surface">
                <ContributionHeatmap username={dev.username} />
              </div>
            </Section>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Breakdown dev={dev} />
              <TechStack dev={dev} />
            </div>

            <Activity dev={dev} />

            <TopRepos dev={dev} />

            <Similar neighbours={neighbours} onOpen={onOpenProfile} />

            <RankHistoryPanel username={dev.username} />

            <ActivitySparkline username={dev.username} />

            <BadgeEmbed username={dev.username} />
          </div>
        )}
      </div>
    </main>
  );
}
