import React, { useState, useEffect, useRef } from 'react';
import { loadBoard, loadDeveloperDetail } from '../utils/leaderboard-data';
import { isLikelyPakistaniLocation, normalizeLocationForDisplay } from '../utils/location';
import ScoreBreakdownPanel from '../components/ScoreBreakdownPanel';
import { computeDeveloperScoreBreakdown } from '../utils/score-breakdown.js';

const MEANINGFUL_EVENTS = new Set(['PushEvent', 'PullRequestEvent', 'IssuesEvent', 'ReleaseEvent']);

const CRITERIA = {
  MIN_REPOS: 4,
  MIN_FOLLOWERS: 2,
  MIN_ACCOUNT_AGE_DAYS: 30,
  MIN_CONTRIBUTIONS_60D: 30,
  MAX_INACTIVITY_GAP_DAYS: 30,
};

const RECENT_SYNC_LIMIT = 10;
const RECENT_SYNC_BASE_HEIGHT_CSS = 'calc(7 * 4.75rem)';

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

function computeActivity(events) {
  const now = Date.now();
  const cutoff = 60 * 24 * 60 * 60 * 1000;
  const meaningful = (events || []).filter((e) => MEANINGFUL_EVENTS.has(e.type));
  const timestamps = meaningful
    .map((e) => new Date(e.created_at).getTime())
    .filter((t) => t >= now - cutoff)
    .sort((a, b) => a - b);

  const count = timestamps.length;
  let longestGap = 60;

  if (timestamps.length > 0) {
    longestGap = 0;

    for (let i = 1; i < timestamps.length; i++) {
      const gap = Math.floor((timestamps[i] - timestamps[i - 1]) / (1000 * 60 * 60 * 24));
      if (gap > longestGap) longestGap = gap;
    }
    const gapToNow = Math.floor((now - timestamps[timestamps.length - 1]) / (1000 * 60 * 60 * 24));
    if (gapToNow > longestGap) longestGap = gapToNow;
  }

  return { count, longestGap };
}

export default function Register({ onChangeTab }) {
  const [username, setUsername] = useState('');
  const [status, setStatus] = useState('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [checks, setChecks] = useState({
    exists: null,
    location: null,
    repos: null,
    followers: null,
    accountAge: null,
    contributions: null,
    noLongGaps: null,
  });
  const [profileData, setProfileData] = useState(null);
  const [scoreBreakdown, setScoreBreakdown] = useState(null);
  const [gatesPassed, setGatesPassed] = useState(false);
  const requestIdRef = useRef(0);
  const [recentDevs, setRecentDevs] = useState([]);
  const statusPanelRef = useRef(null);
  const [statusPanelOffset, setStatusPanelOffset] = useState(0);

  useEffect(() => {
    if (status !== 'complete' || !statusPanelRef.current) {
      setStatusPanelOffset(0);
      return;
    }

    const node = statusPanelRef.current;

    const updateStatusPanelHeight = () => {
      const styles = window.getComputedStyle(node);
      const marginTop = Number.parseFloat(styles.marginTop || '0') || 0;
      const panelHeight = node.getBoundingClientRect().height;
      setStatusPanelOffset(Math.ceil(panelHeight + marginTop));
    };

    updateStatusPanelHeight();

    let resizeObserver;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(updateStatusPanelHeight);
      resizeObserver.observe(node);
    }

    window.addEventListener('resize', updateStatusPanelHeight);

    return () => {
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener('resize', updateStatusPanelHeight);
    };
  }, [status]);

  const recentSyncHeight = `calc(${RECENT_SYNC_BASE_HEIGHT_CSS} + ${statusPanelOffset}px)`;

  useEffect(() => {
    async function loadRecent() {
      // This list used to merge in "pending" entries from this browser's
      // localStorage and label them "Just Now", as if a check had submitted
      // anything. Nothing is submitted, so they are no longer shown or saved.

      let lb = [];
      try {
        const { payload: leaderboardPayload } = await loadBoard();
        lb = Array.isArray(leaderboardPayload?.leaderboard) ? leaderboardPayload.leaderboard : [];
      } catch { /* ignored */ }

      // The board carries no bios (they would nearly double it), so the ten
      // shown here come from each developer's own file. A row whose file
      // cannot be read shows its location alone, as a row without a bio does.
      const shown = lb.slice(0, RECENT_SYNC_LIMIT);
      const bios = await Promise.all(
        shown.map((d) =>
          loadDeveloperDetail(d.username)
            .then(({ developer }) => developer.bio || '')
            .catch(() => '')
        )
      );

      // Only what the published row actually says. These rows used to carry
      // an invented job title ('Systems Engineer' when there was no bio), a
      // seniority guessed from repo count ('Senior' / 'Mid-Level'), and a
      // fabricated "(index + 1) * 14m ago" sync time for real people.
      const formattedLb = shown.map((d, i) => ({
        avatar: d.avatar_url,
        username: d.username || d.login,
        role: bios[i],
        location: normalizeLocationForDisplay(d.location),
        score: d.score,
        rank: d.rank,
        isNew: false,
      }));

      setRecentDevs(formattedLb);
    }
    loadRecent();
  }, []);

  useEffect(() => {
    setStatus('idle');
    setErrorMsg('');

    setChecks({
      exists: null,
      location: null,
      repos: null,
      followers: null,
      accountAge: null,
      contributions: null,
      noLongGaps: null,
    });

    setProfileData(null);
    setScoreBreakdown(null);
    setGatesPassed(false);
    // Editing the field invalidates any submission still in flight, so a
    // late response cannot repopulate the panel for a handle the input no
    // longer shows.
    requestIdRef.current += 1;
  }, [username]);
  
  const handleRegister = async () => {
    if (!username.trim()) {
      setErrorMsg('SYSTEM_WARN: Please provide a valid GitHub identifier.');
      setStatus('error');
      return;
    }

    const reqId = (requestIdRef.current += 1);
    const stale = () => requestIdRef.current !== reqId;

    setStatus('loading');
    setErrorMsg('');
    setChecks({ exists: null, location: null, repos: null, followers: null, accountAge: null, contributions: null, noLongGaps: null });
    setProfileData(null);
    setScoreBreakdown(null);
    setGatesPassed(false);

    try {
      const res = await fetch(`https://api.github.com/users/${username.trim()}`);
      if (stale()) return;

      if (res.status === 404) {
        setChecks((c) => ({ ...c, exists: false }));
        setStatus('error');
        setErrorMsg('SYSTEM_ERR: GitHub profile not found in global registry.');
        return;
      }

      if (!res.ok) {
        throw new Error('SYSTEM_ERR: Edge network timeout. GitHub API rate limit exceeded.');
      }

      const data = await res.json();
      if (stale()) return;
      setProfileData(data);

      const isValidLocation = isLikelyPakistaniLocation(data.location);
      const hasEnoughRepos = (data.public_repos || 0) > 3;
      const hasEnoughFollowers = (data.followers || 0) > 1;
      const ageDays = daysSince(data.created_at);
      const isOldEnough = ageDays >= CRITERIA.MIN_ACCOUNT_AGE_DAYS;

      const partialChecks = {
        exists: true,
        location: isValidLocation,
        repos: hasEnoughRepos,
        followers: hasEnoughFollowers,
        accountAge: isOldEnough,
        contributions: null,
        noLongGaps: null,
      };
      setChecks(partialChecks);

      const profileFailed = !isValidLocation || !hasEnoughRepos || !hasEnoughFollowers || !isOldEnough;
      if (profileFailed) {
        const reasons = [];
        if (!isValidLocation) reasons.push(`Location '${data.location || 'not set'}' must include 'Pakistan'`);
        if (!hasEnoughRepos) reasons.push(`Only ${data.public_repos} public repos (need >3)`);
        if (!hasEnoughFollowers) reasons.push(`Only ${data.followers} followers (need >1)`);
        if (!isOldEnough) reasons.push(`Account is ${ageDays}d old (need >=${CRITERIA.MIN_ACCOUNT_AGE_DAYS}d)`);
        setChecks((c) => ({ ...c, contributions: false, noLongGaps: false }));
        setScoreBreakdown(null);
        setGatesPassed(false);
        setStatus('error');
        setErrorMsg(`SYSTEM_ERR: ${reasons.join('. ')}.`);
        return;
      }

      let allEvents = [];
      try {
        for (let page = 1; page <= 2; page++) {
          const evRes = await fetch(`https://api.github.com/users/${data.login}/events?per_page=100&page=${page}`);
          if (stale()) return;
          if (!evRes.ok) break;
          const pageEvents = await evRes.json();
          if (!Array.isArray(pageEvents)) break;
          allEvents.push(...pageEvents);
          if (pageEvents.length < 100) break;
        }
      } catch { /* ignored */ }

      let totalStars = 0;
      try {
        for (let page = 1; ; page++) {
          const repoRes = await fetch(`https://api.github.com/users/${data.login}/repos?per_page=100&page=${page}`);
          if (stale()) return;
          if (!repoRes.ok) break;
          const repos = await repoRes.json();
          if (!Array.isArray(repos) || repos.length === 0) break;
          repos.forEach(r => { totalStars += r.stargazers_count || 0; });
          if (repos.length < 100) break;
        }
      } catch { /* ignored */ }

      const { count, longestGap } = computeActivity(allEvents);
      const hasContributions = count >= CRITERIA.MIN_CONTRIBUTIONS_60D;
      const hasNoLongGaps = longestGap <= CRITERIA.MAX_INACTIVITY_GAP_DAYS;

      const breakdown = computeDeveloperScoreBreakdown({
        events: allEvents,
        totalStars,
        followers: data.followers,
        publicRepos: data.public_repos,
        createdAt: data.created_at,
        now: Date.now()
      });

      const calculatedScore = breakdown.finalScore;
      const activityPassed = hasContributions && hasNoLongGaps;

      setScoreBreakdown(breakdown);
      setChecks((c) => ({
        ...c,
        contributions: hasContributions,
        noLongGaps: hasNoLongGaps,
      }));

      if (!activityPassed) {
        const reasons = [];
        if (!hasContributions) reasons.push(`${count} meaningful contributions in 60d (need >=${CRITERIA.MIN_CONTRIBUTIONS_60D})`);
        if (!hasNoLongGaps) reasons.push(`Longest inactivity gap: ${longestGap}d (max ${CRITERIA.MAX_INACTIVITY_GAP_DAYS}d)`);
        setGatesPassed(false);
        setStatus('error');
        setErrorMsg(`SYSTEM_ERR: Activity check failed. ${reasons.join('. ')}.`);
        setProfileData({
          ...data,
          _calculatedScore: calculatedScore,
          _agePenaltyApplied: breakdown.agePenalty.applied
        });
        return;
      }

      setGatesPassed(true);
      setStatus('complete');

      // A passing check is an eligibility result, not a registration. This
      // used to save the profile to this browser's localStorage and show
      // NODE_ACCEPTED, which nobody downstream ever read
      // (public/registered_devs.json has been `[]` since 2026-03-20).
      setProfileData({
        ...data,
        _calculatedScore: calculatedScore,
        _agePenaltyApplied: breakdown.agePenalty.applied
      });
    } catch (e) {
      setStatus('error');
      setErrorMsg(e.message);
    }
  };

  const renderCheckIcon = (state) => {
    if (state === null) return <span className="text-outline-variant whitespace-nowrap">[--]</span>;
    if (state === true) return <span className="text-tertiary whitespace-nowrap">[OK]</span>;
    return <span className="text-error whitespace-nowrap">[XX]</span>;
  };

  return (
    <main className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 grid-lines pointer-events-none"></div>
      <div className="max-w-6xl mx-auto px-4 py-6 sm:px-6 sm:py-8 md:py-12 relative z-10">

        <div className="mb-8 border-l-4 border-primary pl-4 sm:mb-12 sm:pl-6">
          <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter uppercase text-on-surface mb-2">
            Check <span className="text-primary">Eligibility</span>
          </h1>
          <p className="font-mono text-xs sm:text-sm text-outline max-w-xl uppercase tracking-widest leading-relaxed">
            See whether a GitHub profile passes the leaderboard's gates. Nothing is submitted: developers join the board when the pipeline discovers them.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-0 border border-outline-variant">

          <div className="lg:col-span-5 p-4 sm:p-6 lg:p-8 bg-surface-container-lowest border-b lg:border-b-0 lg:border-r border-outline-variant flex flex-col justify-between">
            <div className="space-y-6 sm:space-y-8">
              <div>
                <label className="font-mono text-xs text-tertiary uppercase tracking-tighter mb-4 block">GitHub Username</label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <span className="font-mono text-primary">@</span>
                  </div>
                  <input
                    className="w-full bg-surface-container-low border-b-2 border-outline-variant focus:border-tertiary text-on-surface font-mono py-4 pl-10 pr-4 outline-none transition-all duration-75 placeholder:text-outline/30 uppercase tracking-widest disabled:opacity-50"
                    placeholder="GITHUB_USERNAME"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
                    disabled={status === 'loading'}
                  />
                </div>
                <p className="mt-4 font-mono text-[10px] text-outline leading-relaxed uppercase">
                  This check runs in your browser against public GitHub data. Nothing is stored or sent to Rankistan.
                </p>
              </div>

              {status === 'idle' || status === 'error' ? (
                <button
                  onClick={handleRegister}
                  className="w-full min-h-11 bg-primary text-on-primary font-headline font-bold py-4 px-6 flex items-center justify-between hover:bg-primary-container transition-colors duration-50 active:scale-[0.98]"
                >
                  <span className="uppercase tracking-widest text-sm sm:text-base">Check Eligibility</span>
                  <span className="material-symbols-outlined">arrow_forward</span>
                </button>
              ) : status === 'loading' ? (
                <button
                  disabled
                  className="w-full min-h-11 bg-surface-container-highest text-outline font-headline font-bold py-4 px-6 flex items-center justify-between transition-colors duration-50"
                >
                  <span className="uppercase tracking-widest flex items-center gap-2">
                    <span className="w-2 h-2 bg-tertiary animate-pulse inline-block"></span>
                    CHECKING_PROFILE...
                  </span>
                </button>
              ) : (
                <div className="w-full min-h-11 bg-tertiary-container/20 border border-tertiary text-tertiary font-headline font-bold py-4 px-6 flex items-center justify-between">
                  <span className="uppercase tracking-widest text-sm sm:text-base">ELIGIBLE</span>
                  <span className="material-symbols-outlined">check_circle</span>
                </div>
              )}

              {errorMsg && (
                <div className="font-mono text-[10px] text-error uppercase tracking-widest p-3 bg-error-container/10 border-l-2 border-error break-words">
                  {errorMsg}
                </div>
              )}

              <div className="pt-6 sm:pt-8 border-t border-outline-variant/30">
                <h3 className="font-mono text-xs text-outline-variant uppercase mb-4">Eligibility Requirements</h3>
                <ul className="space-y-3">
                  <li className="flex items-start gap-3 text-xs font-mono text-outline">
                    {renderCheckIcon(checks.exists)} <span>Active GitHub account</span>
                  </li>
                  <li className="flex items-start gap-3 text-xs font-mono text-outline">
                    {renderCheckIcon(checks.location)} <span>Location includes Pakistan</span>
                  </li>
                  <li className="flex items-start gap-3 text-xs font-mono text-outline">
                    {renderCheckIcon(checks.repos)} <span>More than 3 public repositories</span>
                  </li>
                  <li className="flex items-start gap-3 text-xs font-mono text-outline">
                    {renderCheckIcon(checks.followers)} <span>More than 1 follower</span>
                  </li>
                  <li className="flex items-start gap-3 text-xs font-mono text-outline">
                    {renderCheckIcon(checks.accountAge)} <span>Account at least 30 days old</span>
                  </li>
                  <li className="flex items-start gap-3 text-xs font-mono text-outline">
                    {renderCheckIcon(checks.contributions)} <span>30 meaningful contributions in last 60 days</span>
                  </li>
                  <li className="flex items-start gap-3 text-xs font-mono text-outline">
                    {renderCheckIcon(checks.noLongGaps)} <span>No inactivity gap longer than 30 days</span>
                  </li>
                </ul>
                <p className="mt-4 font-mono text-[9px] text-outline/60 uppercase leading-relaxed">
                  Meaningful contributions: pushes, pull requests, issues, and releases. Checked live against the GitHub API; the pipeline's own check is the one that counts.
                </p>
              </div>
            </div>

            {status === 'complete' && (
              <div ref={statusPanelRef} className="mt-6 sm:mt-8 font-mono text-[11px] sm:text-xs text-tertiary border border-tertiary/30 bg-tertiary/10 p-3 sm:p-4 animate-pulse leading-relaxed">
                &gt; Profile Validated.<br />
                &gt; All criteria passed.<br />
                &gt; Estimated Score: {profileData?._calculatedScore} {profileData?._agePenaltyApplied && <span className="text-error">(0.5x New Account Penalty Applied)</span>}<br />
                <br />
                <span className="text-tertiary/80">
                  * Nothing has been submitted. Developers join the board when the pipeline discovers them, which needs the word "Pakistan" in your GitHub location, and the board shows the top 1,000 who pass every gate. Self-registration is being rebuilt.
                </span>
              </div>
            )}
          </div>

          <div className="lg:col-span-7 bg-surface p-0 flex flex-col min-h-0">
            <div className="p-4 sm:p-6 border-b border-outline-variant bg-surface-container-high flex flex-col gap-1 sm:flex-row sm:justify-between sm:items-center">
              <span className="font-mono text-xs uppercase tracking-widest flex items-center gap-2">
                Top of the Board
              </span>
            </div>

            <div
              className="overflow-y-auto bg-surface-container-lowest pr-1 sm:pr-2 transition-[height] duration-150 max-h-[70vh] sm:max-h-none"
              style={{ height: recentSyncHeight }}
            >
              {recentDevs.length === 0 && (
                <div className="p-6 sm:p-8 text-center text-outline-variant font-mono text-xs uppercase animate-pulse">
                  Awaiting stream segments...
                </div>
              )}

              {recentDevs.map((dev, idx) => (
                <div key={dev.username + idx} className={`flex items-center gap-3 border-b p-3 sm:grid sm:grid-cols-12 sm:items-center sm:gap-0 sm:p-0 ${dev.isNew ? 'border-tertiary bg-tertiary/5' : 'border-outline-variant/50 hover:bg-surface-container-low'} transition-colors group cursor-default relative overflow-hidden`}>
                  {dev.isNew && (
                    <div className="absolute top-0 right-0 bg-tertiary text-on-tertiary font-mono text-[8px] px-2 py-1 tracking-widest z-10 font-bold uppercase">
                      New Node
                    </div>
                  )}
                  <div className="shrink-0 sm:col-span-2 sm:p-4 sm:flex sm:justify-center relative z-10">
                    <div className={`w-10 h-10 border ${dev.isNew ? 'border-tertiary shadow-[0_0_10px_rgba(80,184,94,0.4)]' : 'border-outline-variant grayscale group-hover:grayscale-0 transition-all'} overflow-hidden`}>
                      <img alt={`${dev.username} profile`} className="w-full h-full object-cover" src={dev.avatar} />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 sm:col-span-6 sm:p-4 relative z-10">
                    <div className={`font-headline font-bold text-sm tracking-tight uppercase truncate ${dev.isNew ? 'text-tertiary' : 'text-on-surface'}`}>{dev.username}</div>
                    <div className="font-mono text-[10px] text-outline uppercase tracking-tighter line-clamp-1">{[dev.role, dev.location].filter(Boolean).join(' \u2022 ')}</div>
                  </div>
                  <div className="shrink-0 text-right sm:col-span-4 sm:p-4 relative z-10">
                    <div className={`inline-block px-2 py-1 font-mono text-[9px] uppercase ${dev.isNew ? 'bg-tertiary-container text-on-tertiary-container' : 'bg-secondary-container text-on-secondary-container'}`}>
                      {`Score: ${dev.score ?? '-'}`}
                    </div>
                    <div className={`font-mono text-[9px] mt-1 uppercase ${dev.isNew ? 'text-tertiary' : 'text-outline-variant'}`}>{dev.rank ? `Rank #${dev.rank}` : ''}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-3 sm:p-4 bg-surface-container-highest border-t border-outline-variant text-center">
              <button onClick={() => onChangeTab?.('leaderboard')} className="font-mono text-[10px] text-primary uppercase tracking-widest hover:underline min-h-11 sm:min-h-0 inline-flex items-center justify-center">View Full Leaderboard</button>
            </div>
          </div>
        </div>

        <ScoreBreakdownPanel breakdown={scoreBreakdown} gatesPassed={gatesPassed} />

        <div className="mt-8 sm:mt-12 grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
          <div className="p-4 sm:p-6 border border-outline-variant bg-surface-container-lowest">
            <span className="material-symbols-outlined text-primary mb-4">hub</span>
            <h4 className="font-headline font-bold uppercase text-on-surface mb-2">Public Data Only</h4>
            <p className="font-body text-xs text-outline leading-relaxed">Rankistan reads only what GitHub already shows publicly: your profile, your public repositories and your public activity.</p>
          </div>
          <div className="p-4 sm:p-6 border border-outline-variant bg-surface-container-lowest">
            <span className="material-symbols-outlined text-tertiary mb-4">monitoring</span>
            <h4 className="font-headline font-bold uppercase text-on-surface mb-2">Updated Daily</h4>
            <p className="font-body text-xs text-outline leading-relaxed">Each developer is re-measured once a day: public activity over the last 30 days, plus stars and followers. The About page shows the exact formula.</p>
          </div>
          <div className="p-4 sm:p-6 border border-outline-variant bg-surface-container-lowest">
            <span className="material-symbols-outlined text-secondary mb-4">lock_open</span>
            <h4 className="font-headline font-bold uppercase text-on-surface mb-2">Open Source</h4>
            <p className="font-body text-xs text-outline leading-relaxed">The pipeline and this site are MIT-licensed on GitHub, and the leaderboard can be exported as CSV from its own page.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
