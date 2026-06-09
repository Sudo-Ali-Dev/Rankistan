import React, { useEffect, useState } from 'react';

export default function Digest() {
  const [digest, setDigest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;

    async function load() {
      setLoading(true);
      setError('');

      try {
        const res = await fetch('./digest.json', { cache: 'no-store' });
        if (!res.ok) {
          if (res.status === 404) {
            throw new Error('No digest has been published yet.');
          }
          throw new Error(`Failed to load digest (${res.status}).`);
        }
        const data = await res.json();
        if (!alive) return;
        setDigest(data);
      } catch (e) {
        if (!alive) return;
        setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    }

    load();
    return () => { alive = false; };
  }, []);

  if (loading) {
    return (
      <main className="min-h-screen relative overflow-hidden">
        <div className="absolute inset-0 grid-lines pointer-events-none"></div>
        <div className="flex items-center justify-center h-96 relative z-10">
          <span className="font-mono text-sm text-tertiary animate-pulse uppercase tracking-widest">Loading Digest Stream...</span>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen relative overflow-hidden">
        <div className="absolute inset-0 grid-lines pointer-events-none"></div>
        <div className="max-w-6xl mx-auto px-6 py-12 relative z-10">
          <div className="border-l-4 border-primary pl-6 mb-12">
            <div className="text-tertiary font-mono text-xs mb-2 tracking-widest flex items-center gap-2">
              <span className="w-2 h-2 bg-tertiary inline-block animate-pulse"></span>
              SYSTEM_STATUS: NO_DATA
            </div>
            <h1 className="font-headline text-4xl md:text-6xl font-bold tracking-tighter uppercase leading-none">
              Weekly <span className="text-primary italic">Digest</span>
            </h1>
          </div>
          <div className="border border-outline-variant bg-surface-container-lowest p-8 text-center">
            <span className="material-symbols-outlined text-outline-variant text-4xl mb-4">article</span>
            <p className="font-mono text-sm text-outline uppercase tracking-widest">{error}</p>
            <p className="font-mono text-[10px] text-outline-variant mt-4 uppercase tracking-wider">
              Digests are generated weekly. Check back later or view the <button onClick={() => window.location.hash = '#/'} className="text-primary hover:underline">Leaderboard</button>.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const hasRepos = Array.isArray(digest.repos) && digest.repos.length > 0;
  const generatedDate = digest.generated_at
    ? new Date(digest.generated_at).toLocaleString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
      })
    : null;
  const repoCount = hasRepos ? digest.repos.length : 0;

  return (
    <main className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 grid-lines pointer-events-none"></div>
      <div className="max-w-6xl mx-auto px-6 py-12 relative z-10">

        {/* Hero */}
        <div className="mb-12 border-l-4 border-primary pl-6">
          <div className="text-tertiary font-mono text-xs mb-2 tracking-widest flex items-center gap-2">
            <span className="w-2 h-2 bg-tertiary inline-block animate-pulse"></span>
            SYSTEM_STATUS: DIGEST_ACTIVE
          </div>
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <h1 className="font-headline text-4xl md:text-6xl font-bold tracking-tighter uppercase leading-none">
                Weekly <span className="text-primary italic">Digest</span>
              </h1>
              {digest.week_of && (
                <p className="font-mono text-sm text-tertiary mt-3 uppercase tracking-widest">
                  {digest.week_of}
                </p>
              )}
            </div>
            <div className="flex gap-6 shrink-0">
              <div className="text-right">
                <div className="font-mono text-[10px] text-outline uppercase tracking-widest">Generated</div>
                <div className="font-headline text-sm font-bold text-on-surface">{generatedDate || 'N/A'}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[10px] text-outline uppercase tracking-widest">Repos Analyzed</div>
                <div className="font-headline text-2xl font-bold text-primary">{repoCount}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Digest Body */}
        <div className="border border-outline-variant bg-surface-container-lowest p-8 mb-8">
          <div className="flex items-center gap-2 mb-6">
            <span className="material-symbols-outlined text-tertiary text-sm">auto_awesome</span>
            <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest">AI_Generated_Summary</span>
            <span className="font-mono text-[9px] text-outline border border-outline-variant px-2 py-0.5 ml-auto">Groq / llama-3.3-70b</span>
          </div>
          <div className="font-body text-sm text-on-surface-variant leading-relaxed whitespace-pre-wrap max-w-4xl">
            {digest.digest_text || 'No digest content available.'}
          </div>
        </div>

        {/* Repos Section */}
        {hasRepos && (
          <div className="border border-outline-variant overflow-hidden bg-surface-container-lowest mb-8">
            <div className="p-6 border-b border-outline-variant bg-surface-container-high flex items-center justify-between">
              <span className="font-mono text-xs uppercase tracking-widest flex items-center gap-2">
                <span className="w-2 h-2 bg-tertiary animate-pulse"></span>
                Repositories Tracked This Week
              </span>
              <span className="font-mono text-[10px] text-outline uppercase">{digest.repos.length} repos</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-container-high/50 border-b border-outline-variant">
                    <th className="text-left font-mono text-[10px] text-outline uppercase tracking-widest px-4 py-3 w-8">#</th>
                    <th className="text-left font-mono text-[10px] text-outline uppercase tracking-widest px-4 py-3">Repository</th>
                    <th className="text-left font-mono text-[10px] text-outline uppercase tracking-widest px-4 py-3 hidden md:table-cell">Description</th>
                    <th className="text-left font-mono text-[10px] text-outline uppercase tracking-widest px-4 py-3 hidden sm:table-cell">Language</th>
                    <th className="text-right font-mono text-[10px] text-outline uppercase tracking-widest px-4 py-3">Stars</th>
                  </tr>
                </thead>
                <tbody>
                  {digest.repos.map((repo, i) => (
                    <tr
                      key={`${repo.owner}/${repo.name}`}
                      className="border-b border-outline-variant/30 hover:bg-surface-container-low transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-[10px] text-outline">{i + 1}</td>
                      <td className="px-4 py-3">
                        <a
                          href={repo.url || `https://github.com/${repo.owner}/${repo.name}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-headline font-bold text-xs text-primary uppercase tracking-tight hover:underline"
                        >
                          {repo.owner}/{repo.name}
                        </a>
                      </td>
                      <td className="px-4 py-3 font-mono text-[10px] text-outline truncate max-w-xs hidden md:table-cell">
                        {repo.description || '—'}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <span className="font-mono text-[10px] text-tertiary bg-tertiary/10 px-2 py-0.5 uppercase tracking-tight">
                          {repo.language || 'N/A'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs font-bold text-on-surface">
                        {repo.stars > 0 ? repo.stars.toLocaleString() : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* CTA */}
        <div className="border border-outline-variant bg-surface-container-lowest p-6 text-center">
          <span className="material-symbols-outlined text-primary text-2xl mb-3">leaderboard</span>
          <h3 className="font-headline text-lg font-bold tracking-tighter uppercase mb-2">Full Leaderboard</h3>
          <p className="font-body text-xs text-outline leading-relaxed max-w-lg mx-auto mb-4">
            View the complete ranking of active Pakistani developers ranked by score.
          </p>
          <button
            onClick={() => window.location.hash = '#/'}
            className="inline-flex items-center gap-2 bg-primary text-on-primary font-headline font-bold py-2.5 px-5 hover:bg-primary-container transition-colors duration-50 active:scale-[0.98] uppercase tracking-widest text-xs"
          >
            Go to Leaderboard
          </button>
        </div>

      </div>
    </main>
  );
}
