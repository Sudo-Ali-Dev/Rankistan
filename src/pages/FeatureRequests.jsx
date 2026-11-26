import React, { useEffect, useState } from 'react';
import {
  ALL_REQUESTS_URL,
  FIELD_MAX,
  NEW_REQUEST_URL,
  REQUESTS_API_URL,
  TITLE_MAX,
  rankRequests,
  requestIssueUrl
} from '../utils/feature-requests';

const BUG_REPORT_URL = `${NEW_REQUEST_URL}?template=bug_report.yml`;
const LIST_LIMIT = 20;

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Field({ id, label, hint, children }) {
  return (
    <div>
      <label
        htmlFor={id}
        className="font-mono text-xs text-tertiary uppercase tracking-tighter mb-2 block"
      >
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-2 font-mono text-[10px] text-outline uppercase tracking-wider">{hint}</p>
      )}
    </div>
  );
}

const inputClass =
  'w-full bg-surface-container-low border-b-2 border-outline-variant focus:border-tertiary text-on-surface font-body text-sm py-3 px-3 outline-none transition-colors duration-75 placeholder:text-outline/40';

export default function FeatureRequests() {
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState('');
  const [proposal, setProposal] = useState('');
  const [requests, setRequests] = useState({ status: 'loading', items: [] });

  useEffect(() => {
    let cancelled = false;
    fetch(REQUESTS_API_URL, { headers: { Accept: 'application/vnd.github+json' } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((issues) => {
        if (!cancelled) setRequests({ status: 'ready', items: rankRequests(issues) });
      })
      .catch(() => {
        if (!cancelled) setRequests({ status: 'error', items: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ready = title.trim().length > 0 && problem.trim().length > 0;
  const issueUrl = requestIssueUrl({ title, problem, proposal });
  const shown = requests.items.slice(0, LIST_LIMIT);

  return (
    <main className="min-h-screen">
      <div className="max-w-6xl mx-auto px-4 py-6 sm:px-6 sm:py-8 md:py-12 relative z-10">
        <div className="mb-8 border-l-4 border-primary pl-4 sm:mb-12 sm:pl-6">
          <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter uppercase text-on-surface mb-2">
            Request a <span className="text-primary">feature</span>
          </h1>
          <p className="font-mono text-xs sm:text-sm text-outline max-w-xl uppercase tracking-widest leading-relaxed">
            Tell us what would make Rankistan more useful to you. Every request is a public GitHub
            issue, so anyone can read it, comment and vote for it.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-0 border border-outline-variant">
          <form
            className="lg:col-span-6 p-4 sm:p-6 lg:p-8 bg-surface-container-lowest border-b lg:border-b-0 lg:border-r border-outline-variant flex flex-col gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) window.open(issueUrl, '_blank', 'noopener,noreferrer');
            }}
          >
            <Field id="request-title" label="Your idea in a few words">
              <input
                id="request-title"
                className={inputClass}
                type="text"
                maxLength={TITLE_MAX}
                placeholder="For example, filter the board by city"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </Field>
            <Field
              id="request-problem"
              label="What problem does it solve?"
              hint="Describe what you are trying to do, not only the fix you have in mind."
            >
              <textarea
                id="request-problem"
                className={`${inputClass} min-h-28 resize-y`}
                maxLength={FIELD_MAX}
                value={problem}
                onChange={(e) => setProblem(e.target.value)}
                required
              />
            </Field>
            <Field id="request-proposal" label="What would you like to happen?" hint="Optional">
              <textarea
                id="request-proposal"
                className={`${inputClass} min-h-24 resize-y`}
                maxLength={FIELD_MAX}
                value={proposal}
                onChange={(e) => setProposal(e.target.value)}
              />
            </Field>

            <div className="flex flex-col gap-3">
              <button
                type="submit"
                disabled={!ready}
                className="w-full min-h-11 bg-primary text-on-primary font-headline font-bold py-4 px-6 flex items-center justify-between gap-4 hover:bg-primary-container transition-colors duration-50 active:translate-y-px disabled:bg-surface-container-highest disabled:text-outline disabled:cursor-not-allowed"
              >
                <span className="uppercase tracking-widest text-sm sm:text-base">
                  Continue on GitHub<span className="sr-only"> (opens in a new tab)</span>
                </span>
                <span className="material-symbols-outlined" aria-hidden="true">
                  open_in_new
                </span>
              </button>
              <p className="font-mono text-[10px] text-outline uppercase tracking-widest leading-relaxed">
                GitHub opens with your words filled in, and nothing is posted until you submit it
                there. You need a free GitHub account.
              </p>
            </div>

            <a
              href={BUG_REPORT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="self-start min-h-11 inline-flex items-center gap-2 font-mono text-[10px] text-outline uppercase tracking-widest hover:text-primary hover:underline transition-colors duration-50"
            >
              <span className="material-symbols-outlined text-base" aria-hidden="true">
                bug_report
              </span>
              Something broken? Report a bug instead
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </form>

          <section
            aria-labelledby="open-requests"
            className="lg:col-span-6 bg-surface flex flex-col min-h-0"
          >
            <div className="p-4 sm:p-6 border-b border-outline-variant bg-surface-container-high flex items-center justify-between gap-4">
              <h2
                id="open-requests"
                className="font-mono text-xs uppercase tracking-widest text-on-surface"
              >
                Open requests
              </h2>
              {requests.status === 'ready' && (
                <span className="font-mono text-[10px] text-outline uppercase tracking-widest">
                  {requests.items.length} open
                </span>
              )}
            </div>

            <div className="flex-1 bg-surface-container-lowest" aria-live="polite">
              {requests.status === 'loading' && (
                <p className="p-6 sm:p-8 text-center text-outline font-mono text-xs uppercase tracking-widest">
                  Loading requests from GitHub
                </p>
              )}
              {requests.status === 'error' && (
                <p className="p-6 sm:p-8 text-center text-outline font-mono text-xs uppercase tracking-widest leading-relaxed">
                  GitHub did not answer just now.{' '}
                  <a
                    href={ALL_REQUESTS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    See the requests on GitHub<span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </p>
              )}
              {requests.status === 'ready' && shown.length === 0 && (
                <p className="p-6 sm:p-8 text-center text-outline font-mono text-xs uppercase tracking-widest">
                  No open requests yet. Yours can be the first.
                </p>
              )}
              {shown.length > 0 && (
                <ul>
                  {shown.map((r) => (
                    <li key={r.number} className="border-b border-outline-variant/50">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-start gap-4 p-4 sm:px-6 hover:bg-surface-container-low transition-colors duration-50"
                      >
                        <span
                          className="shrink-0 w-12 flex flex-col items-center border border-outline-variant py-1 font-mono text-tertiary"
                          title={`${r.votes} thumbs up`}
                        >
                          <span className="material-symbols-outlined text-base" aria-hidden="true">
                            thumb_up
                          </span>
                          <span className="text-xs tabular-nums">{r.votes}</span>
                          <span className="sr-only"> votes</span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-headline font-bold text-sm text-on-surface break-words">
                            {r.title}
                          </span>
                          <span className="block mt-1 font-mono text-[10px] text-outline uppercase tracking-wider">
                            #{r.number} · {formatDate(r.createdAt)} · {r.comments}{' '}
                            {r.comments === 1 ? 'comment' : 'comments'}
                          </span>
                        </span>
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="p-4 bg-surface-container-highest border-t border-outline-variant flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="font-mono text-[10px] text-outline uppercase tracking-widest">
                To vote, give a request a thumbs up on GitHub
              </p>
              <a
                href={ALL_REQUESTS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[10px] text-primary uppercase tracking-widest hover:underline min-h-11 sm:min-h-0 inline-flex items-center"
              >
                All requests on GitHub<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
