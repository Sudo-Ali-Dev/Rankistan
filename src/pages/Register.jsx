import React, { useState, useEffect } from 'react';
import { CACHE_KEYS, cache } from '../utils/cache';

const PAK_LOCATIONS = ['pakistan', 'pk'];

const MEANINGFUL_EVENTS = new Set(['PushEvent', 'PullRequestEvent', 'IssuesEvent', 'ReleaseEvent']);

const CRITERIA = {
  MIN_REPOS: 4,
  MIN_FOLLOWERS: 2,
  MIN_ACCOUNT_AGE_DAYS: 30,
  MIN_CONTRIBUTIONS_60D: 30,
  MAX_INACTIVITY_GAP_DAYS: 30,
};

const RECENT_SYNC_LIMIT = 10;

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
  const [recentDevs, setRecentDevs] = useState([]);

  useEffect(() => {
    async function loadRecent() {
      let localRegs = [];
      try {
        const stored = localStorage.getItem('pakdev_pending_nodes');
        if (stored) localRegs = JSON.parse(stored);
      } catch (e) { /* ignored */ }

      let lb = [];
      try {
        let leaderboardPayload = cache.get(CACHE_KEYS.LEADERBOARD);
        if (!leaderboardPayload || cache.isStale(CACHE_KEYS.LEADERBOARD)) {
          const res = await fetch('./data.json', { cache: 'no-store' });
          if (res.ok) leaderboardPayload = await res.json();
        }
        lb = Array.isArray(leaderboardPayload?.leaderboard) ? leaderboardPayload.leaderboard : [];
      } catch (e) { /* ignored */ }

      const formattedLb = lb.slice(0, RECENT_SYNC_LIMIT).map((d, index) => ({
        avatar: d.avatar_url,
        username: d.username || d.login,
        role: d.bio || 'Systems Engineer',
        location: d.location || 'Pakistan',
        stack: d.top_languages?.[0] || (d.public_repos > 50 ? 'Senior' : 'Mid-Level'),
        timeAgo: `${(index + 1) * 14}m ago`,
        isNew: false,
      }));

      setRecentDevs([...localRegs, ...formattedLb].slice(0, RECENT_SYNC_LIMIT));
    }
    loadRecent();
  }, []);

  const handleRegister = async () => {
    if (!username.trim()) {
      setErrorMsg('SYSTEM_WARN: Please provide a valid GitHub identifier.');
      setStatus('error');
      return;
    }

    setStatus('loading');
    setErrorMsg('');
    setChecks({ exists: null, location: null, repos: null, followers: null, accountAge: null, contributions: null, noLongGaps: null });
    setProfileData(null);

    try {
      const res = await fetch(`https://api.github.com/users/${username.trim()}`);

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
      setProfileData(data);

      const loc = (data.location || '').toLowerCase();
      const isValidLocation = PAK_LOCATIONS.some((p) => loc.includes(p));
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
        if (!isValidLocation) reasons.push(`Location '${data.location || 'not set'}' must contain 'Pakistan' (e.g. 'Lahore, Pakistan')`);
        if (!hasEnoughRepos) reasons.push(`Only ${data.public_repos} public repos (need >3)`);
        if (!hasEnoughFollowers) reasons.push(`Only ${data.followers} followers (need >1)`);
        if (!isOldEnough) reasons.push(`Account is ${ageDays}d old (need >=${CRITERIA.MIN_ACCOUNT_AGE_DAYS}d)`);
        setChecks((c) => ({ ...c, contributions: false, noLongGaps: false }));
        setStatus('error');
        setErrorMsg(`SYSTEM_ERR: ${reasons.join('. ')}.`);
        return;
      }

      let allEvents = [];
      try {
        for (let page = 1; page <= 2; page++) {
          const evRes = await fetch(`https://api.github.com/users/${data.login}/events?per_page=100&page=${page}`);
          if (!evRes.ok) break;
          const pageEvents = await evRes.json();
          if (!Array.isArray(pageEvents)) break;
          allEvents.push(...pageEvents);
          if (pageEvents.length < 100) break;
        }
      } catch (e) { /* ignored */ }

      const { count, longestGap } = computeActivity(allEvents);
      const hasContributions = count >= CRITERIA.MIN_CONTRIBUTIONS_60D;
      const hasNoLongGaps = longestGap <= CRITERIA.MAX_INACTIVITY_GAP_DAYS;

      setChecks((c) => ({
        ...c,
        contributions: hasContributions,
        noLongGaps: hasNoLongGaps,
      }));

      if (!hasContributions || !hasNoLongGaps) {
        const reasons = [];
        if (!hasContributions) reasons.push(`${count} meaningful contributions in 60d (need >=${CRITERIA.MIN_CONTRIBUTIONS_60D})`);
        if (!hasNoLongGaps) reasons.push(`Longest inactivity gap: ${longestGap}d (max ${CRITERIA.MAX_INACTIVITY_GAP_DAYS}d)`);
        setStatus('error');
        setErrorMsg(`SYSTEM_ERR: Activity check failed. ${reasons.join('. ')}.`);
        return;
      }

      setStatus('complete');

      const newReg = {
        avatar: data.avatar_url,
        username: data.login,
        role: data.bio || 'Systems Engineer',
        location: data.location || 'Unknown',
        stack: data.public_repos > 50 ? 'Senior' : 'Mid-Level',
        timeAgo: 'Just Now',
        isNew: true,
      };

      try {
        const stored = JSON.parse(localStorage.getItem('pakdev_pending_nodes') || '[]');
        if (!stored.find((s) => s.username.toLowerCase() === newReg.username.toLowerCase())) {
          stored.unshift(newReg);
          localStorage.setItem('pakdev_pending_nodes', JSON.stringify(stored));
        }
        setRecentDevs((prev) => {
          if (prev.find((p) => p.username.toLowerCase() === newReg.username.toLowerCase())) return prev;
          return [newReg, ...prev].slice(0, RECENT_SYNC_LIMIT);
        });
      } catch (e) { /* ignored */ }
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
      <div className="max-w-6xl mx-auto px-6 py-12 relative z-10">

        <div className="mb-12 border-l-4 border-primary pl-6">
          <h1 className="font-headline text-5xl font-extrabold tracking-tighter uppercase text-on-surface mb-2">
            Initialize <span className="text-primary">Profile</span>
          </h1>
          <p className="font-mono text-sm text-outline max-w-xl uppercase tracking-widest">
            Entry point for the high-performance engineering cluster. Provide your GitHub identifier to synchronize.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-0 border border-outline-variant">

          <div className="lg:col-span-5 p-8 bg-surface-container-lowest border-r border-outline-variant flex flex-col justify-between">
            <div className="space-y-8">
              <div>
                <label className="font-mono text-xs text-tertiary uppercase tracking-tighter mb-4 block">System Input / User ID</label>
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
                  By proceeding, you authorize PakDev Index to fetch your public contributions and profile metadata.
                </p>
              </div>

              {status === 'idle' || status === 'error' ? (
                <button
                  onClick={handleRegister}
                  className="w-full bg-primary text-on-primary font-headline font-bold py-4 px-6 flex items-center justify-between hover:bg-primary-container transition-colors duration-50 active:scale-[0.98]"
                >
                  <span className="uppercase tracking-widest">Execute Registration</span>
                  <span className="material-symbols-outlined">arrow_forward</span>
                </button>
              ) : status === 'loading' ? (
                <button
                  disabled
                  className="w-full bg-surface-container-highest text-outline font-headline font-bold py-4 px-6 flex items-center justify-between transition-colors duration-50"
                >
                  <span className="uppercase tracking-widest flex items-center gap-2">
                    <span className="w-2 h-2 bg-tertiary animate-pulse inline-block"></span>
                    SYNCING_NODE...
                  </span>
                </button>
              ) : (
                <div className="w-full bg-tertiary-container/20 border border-tertiary text-tertiary font-headline font-bold py-4 px-6 flex items-center justify-between">
                  <span className="uppercase tracking-widest">NODE_ACCEPTED</span>
                  <span className="material-symbols-outlined">check_circle</span>
                </div>
              )}

              {errorMsg && (
                <div className="font-mono text-[10px] text-error uppercase tracking-widest p-3 bg-error-container/10 border-l-2 border-error">
                  {errorMsg}
                </div>
              )}

              <div className="pt-8 border-t border-outline-variant/30">
                <h3 className="font-mono text-xs text-outline-variant uppercase mb-4">Registration Requirements</h3>
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
                  Meaningful contributions: pushes, pull requests, issues, and releases. All checks are verified in real-time against the GitHub API.
                </p>
              </div>
            </div>

            {status === 'complete' && (
              <div className="mt-8 font-mono text-xs text-tertiary border border-tertiary/30 bg-tertiary/10 p-4 animate-pulse">
                &gt; Profile Validated.<br />
                &gt; All criteria passed.<br />
                &gt; Awaiting standard cron synchronization.<br />
                Your metrics will appear in the leaderboard shortly.
              </div>
            )}
          </div>

          <div className="lg:col-span-7 bg-surface p-0 flex flex-col">
            <div className="p-6 border-b border-outline-variant bg-surface-container-high flex justify-between items-center">
              <span className="font-mono text-xs uppercase tracking-widest flex items-center gap-2">
                <span className="w-2 h-2 bg-tertiary animate-pulse"></span>
                Recent Synchronizations
              </span>
              <span className="font-mono text-[10px] text-outline uppercase">Uptime: 99.9%</span>
            </div>

            <div className="overflow-y-auto max-h-[calc(7*4.75rem)] bg-surface-container-lowest pr-2 scrollbar-thin">
              {recentDevs.length === 0 && (
                <div className="p-8 text-center text-outline-variant font-mono text-xs uppercase animate-pulse">
                  Awaiting stream segments...
                </div>
              )}

              {recentDevs.map((dev, idx) => (
                <div key={dev.username + idx} className={`grid grid-cols-12 items-center border-b ${dev.isNew ? 'border-tertiary bg-tertiary/5' : 'border-outline-variant/50 hover:bg-surface-container-low'} transition-colors group cursor-default relative overflow-hidden`}>
                  {dev.isNew && (
                    <div className="absolute top-0 right-0 bg-tertiary text-on-tertiary font-mono text-[8px] px-2 py-1 tracking-widest z-10 font-bold uppercase">
                      New Node
                    </div>
                  )}
                  <div className="col-span-2 p-4 flex justify-center relative z-10">
                    <div className={`w-10 h-10 border ${dev.isNew ? 'border-tertiary shadow-[0_0_10px_rgba(80,184,94,0.4)]' : 'border-outline-variant grayscale group-hover:grayscale-0 transition-all'} overflow-hidden`}>
                      <img alt={`${dev.username} profile`} className="w-full h-full object-cover" src={dev.avatar} />
                    </div>
                  </div>
                  <div className="col-span-6 p-4 relative z-10">
                    <div className={`font-headline font-bold text-sm tracking-tight uppercase ${dev.isNew ? 'text-tertiary' : 'text-on-surface'}`}>{dev.username}</div>
                    <div className="font-mono text-[10px] text-outline uppercase tracking-tighter line-clamp-1">{dev.role} &bull; {dev.location}</div>
                  </div>
                  <div className="col-span-4 p-4 text-right relative z-10">
                    <div className={`inline-block px-2 py-1 font-mono text-[9px] uppercase ${dev.isNew ? 'bg-tertiary-container text-on-tertiary-container' : 'bg-secondary-container text-on-secondary-container'}`}>
                      {dev.stack}
                    </div>
                    <div className={`font-mono text-[9px] mt-1 uppercase ${dev.isNew ? 'text-tertiary' : 'text-outline-variant'}`}>{dev.timeAgo}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-auto p-4 bg-surface-container-highest border-t border-outline-variant text-center">
              <button onClick={() => onChangeTab?.('leaderboard')} className="font-mono text-[10px] text-primary uppercase tracking-widest hover:underline">View All Node Connections</button>
            </div>
          </div>
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-6 border border-outline-variant bg-surface-container-lowest">
            <span className="material-symbols-outlined text-primary mb-4">hub</span>
            <h4 className="font-headline font-bold uppercase text-on-surface mb-2">Global Routing</h4>
            <p className="font-body text-xs text-outline leading-relaxed">Your profile is indexed across our global edge network, making your skills discoverable by international tech recruiters.</p>
          </div>
          <div className="p-6 border border-outline-variant bg-surface-container-lowest">
            <span className="material-symbols-outlined text-tertiary mb-4">monitoring</span>
            <h4 className="font-headline font-bold uppercase text-on-surface mb-2">Realtime Stats</h4>
            <p className="font-body text-xs text-outline leading-relaxed">Track your ranking within the Pakistani developer ecosystem based on commit velocity, impact, and code quality.</p>
          </div>
          <div className="p-6 border border-outline-variant bg-surface-container-lowest">
            <span className="material-symbols-outlined text-secondary mb-4">lock_open</span>
            <h4 className="font-headline font-bold uppercase text-on-surface mb-2">Open Standard</h4>
            <p className="font-body text-xs text-outline leading-relaxed">Built for engineers, by engineers. Your data belongs to you, exported anytime via our public GraphQL API.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
