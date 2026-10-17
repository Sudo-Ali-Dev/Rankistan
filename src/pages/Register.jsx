import React, { useState, useEffect, useRef } from 'react';
import { loadBoard, loadDeveloperDetail } from '../utils/leaderboard-data';
import { normalizeLocationForDisplay } from '../utils/location';
import {
  COUNTRY_TERM,
  CITY_TERMS,
  foreignMarker,
  locationTokens
} from '../../scripts/discovery/locations.js';
import ScoreBreakdownPanel from '../components/ScoreBreakdownPanel';
import BoardStanding from '../components/BoardStanding';
import { fetchScorePreview } from '../utils/score-preview.js';
import { SCORE_CONFIG } from '../model/config.js';

// The gate, from the model's config: the same numbers the pipeline applies.
const { MIN_ACCOUNT_AGE_DAYS } = SCORE_CONFIG;
const { GATE_MIN_DAYS } = SCORE_CONFIG.WORK;
const { WINDOW_DAYS } = SCORE_CONFIG;

// Registration and opt-out are GitHub issues, read by the pipeline on every run
// (scripts/registry.js). The issue's author is the account: nothing typed into
// it is read, so nobody can register or remove anyone else.
const NEW_ISSUE_URL = 'https://github.com/Sudo-Ali-Dev/Rankistan/issues/new';
const REGISTER_ISSUE_URL = `${NEW_ISSUE_URL}?template=register.yml`;
const REMOVE_ISSUE_URL = `${NEW_ISSUE_URL}?template=remove-me.yml`;

const RECENT_SYNC_LIMIT = 10;
const RECENT_SYNC_BASE_HEIGHT_CSS = 'calc(7 * 4.75rem)';

// Whether discovery's own two searches would find this location: it says
// Pakistan, or names a searched city and no place abroad
// (scripts/discovery/locations.js).
function foundByLocationSearch(location) {
  const tokens = new Set(locationTokens(location));
  if (tokens.has(COUNTRY_TERM)) return true;
  return CITY_TERMS.some((city) => tokens.has(city)) && !foreignMarker(location);
}

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

export default function Register({ onChangeTab }) {
  const [username, setUsername] = useState('');
  const [status, setStatus] = useState('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [checks, setChecks] = useState({
    exists: null,
    location: null,
    accountAge: null,
    workingDays: null,
  });
  const [profileData, setProfileData] = useState(null);
  const [scorePreview, setScorePreview] = useState(null);
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

    setChecks({ exists: null, location: null, accountAge: null, workingDays: null });

    setProfileData(null);
    setScorePreview(null);
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
    setChecks({ exists: null, location: null, accountAge: null, workingDays: null });
    setProfileData(null);
    setScorePreview(null);
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

      const isValidLocation = foundByLocationSearch(data.location);
      const ageDays = daysSince(data.created_at);
      const isOldEnough = ageDays >= MIN_ACCOUNT_AGE_DAYS;
      setChecks({ exists: true, location: isValidLocation, accountAge: isOldEnough, workingDays: null });

      // Location is the one gate a registration replaces, so failing it does
      // not end the check: the other gates still say whether registering would
      // put this profile on the board.
      const locationNote = isValidLocation
        ? null
        : `Location '${data.location || 'not set'}' says neither Pakistan nor a searched city. Registering by GitHub issue replaces this check`;

      // The working days and the score come from the Worker, which measures the account with the
      // pipeline's own code (cloudflare/score-preview.js).
      const measured = await fetchScorePreview(data.login);
      if (stale()) return;
      const preview = measured.ok ? measured.preview : null;
      const days = preview ? preview.gate.working_days : null;
      const hasDays = preview ? preview.gate.passes : null;
      setScorePreview(preview);
      setChecks((c) => ({ ...c, workingDays: hasDays }));
      setProfileData({ ...data, _score: preview ? preview.score : null });

      const reasons = [];
      if (!isOldEnough) reasons.push(`Account is ${ageDays}d old (need >=${MIN_ACCOUNT_AGE_DAYS}d)`);
      if (preview && !hasDays) reasons.push(`${days} active days in the last ${WINDOW_DAYS} (need >=${GATE_MIN_DAYS})`);
      if (!preview) reasons.push(`Active days could not be measured just now (${measured.reason}). The pipeline measures them within 24 hours`);

      const passes = isOldEnough && hasDays === true;
      setGatesPassed(passes);
      if (!passes) {
        if (locationNote) reasons.push(locationNote);
        setStatus('error');
        setErrorMsg(`SYSTEM_ERR: ${reasons.join('. ')}.`);
        return;
      }

      // Every gate a registration keeps has passed; only location has not.
      if (locationNote) {
        setStatus('error');
        setErrorMsg(`SYSTEM_WARN: Every other gate passes. ${locationNote}.`);
        return;
      }

      // A passing check is an eligibility result, not a registration. Registering is a GitHub
      // issue, linked below.
      setStatus('complete');
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
            See whether a GitHub profile passes the leaderboard's gates. Nothing is submitted from this page: developers join the board when the pipeline finds them by location, or when they register by GitHub issue.
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
                    {renderCheckIcon(checks.location)} <span>Location says Pakistan or a listed city, or registered by issue</span>
                  </li>
                  <li className="flex items-start gap-3 text-xs font-mono text-outline">
                    {renderCheckIcon(checks.accountAge)} <span>Account at least {MIN_ACCOUNT_AGE_DAYS} days old</span>
                  </li>
                  <li className="flex items-start gap-3 text-xs font-mono text-outline">
                    {renderCheckIcon(checks.workingDays)} <span>At least {GATE_MIN_DAYS} active days in the last {WINDOW_DAYS}</span>
                  </li>
                </ul>
                <p className="mt-4 font-mono text-[9px] text-outline/60 uppercase leading-relaxed">
                  An active day has a commit to a public repository, a pull request or issue on a repository you do not own, or a review of another developer's pull request. Measured live with the pipeline's own code, and the pipeline's daily measurement is the one that counts.
                </p>
              </div>
            </div>

            {status === 'complete' && (
              <div ref={statusPanelRef} className="mt-6 sm:mt-8 font-mono text-[11px] sm:text-xs text-tertiary border border-tertiary/30 bg-tertiary/10 p-3 sm:p-4 animate-pulse leading-relaxed">
                &gt; Profile Validated.<br />
                &gt; All criteria passed.<br />
                &gt; Score today: {profileData?._score ?? 'measured by the pipeline within 24 hours'}<br />
                <br />
                <span className="text-tertiary/80">
                  * Nothing has been submitted. The pipeline finds developers by their GitHub location. If yours does not say Pakistan or a listed city, register by GitHub issue below. The board shows the top 1,000 who pass every gate.
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

        <ScoreBreakdownPanel preview={scorePreview} gatesPassed={gatesPassed} />
        <BoardStanding login={profileData?.login ?? null} />

        <section
          aria-labelledby="register-by-issue"
          className="mt-8 sm:mt-12 grid grid-cols-1 lg:grid-cols-12 border border-outline-variant bg-surface-container-lowest"
        >
          <div className="lg:col-span-7 p-4 sm:p-6 lg:p-8 border-b lg:border-b-0 lg:border-r border-outline-variant">
            <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest block mb-3">
              Not found by location?
            </span>
            <h2
              id="register-by-issue"
              className="font-headline text-xl sm:text-2xl font-bold tracking-tighter uppercase text-on-surface mb-4"
            >
              Register by GitHub issue
            </h2>
            <ul className="space-y-3">
              <li className="flex items-start gap-3 font-body text-xs sm:text-sm text-outline leading-relaxed">
                <span className="text-primary shrink-0" aria-hidden="true">›</span>
                <span>For developers whose GitHub location doesn't say Pakistan or a listed city, so the pipeline's location search cannot find them.</span>
              </li>
              <li className="flex items-start gap-3 font-body text-xs sm:text-sm text-outline leading-relaxed">
                <span className="text-primary shrink-0" aria-hidden="true">›</span>
                <span>Every gate above still applies. Registering replaces only the location check.</span>
              </li>
              <li className="flex items-start gap-3 font-body text-xs sm:text-sm text-outline leading-relaxed">
                <span className="text-primary shrink-0" aria-hidden="true">›</span>
                <span>The author of the issue is the account registered. You can register only yourself, and nothing typed into the issue is read.</span>
              </li>
            </ul>
          </div>
          <div className="lg:col-span-5 p-4 sm:p-6 lg:p-8 flex flex-col justify-center gap-4">
            <a
              href={REGISTER_ISSUE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full min-h-11 border border-primary text-primary font-headline font-bold py-4 px-6 flex items-center justify-between gap-4 hover:bg-primary/10 transition-colors duration-50 active:translate-y-px"
            >
              <span className="uppercase tracking-widest text-sm sm:text-base">
                Register on GitHub<span className="sr-only"> (opens in a new tab)</span>
              </span>
              <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
            </a>
            <p className="font-mono text-[10px] text-outline uppercase tracking-widest leading-relaxed">
              Checked in the next pipeline run that covers accounts created when yours was: once a day while the pipeline runs on schedule.
            </p>
            <a
              href={REMOVE_ISSUE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="self-start min-h-11 inline-flex items-center gap-2 font-mono text-[10px] text-outline uppercase tracking-widest hover:text-primary hover:underline transition-colors duration-50"
            >
              <span className="material-symbols-outlined text-base" aria-hidden="true">person_remove</span>
              Remove me from the board<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </section>

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
