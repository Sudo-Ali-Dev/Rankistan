// Feature requests are GitHub issues opened from .github/ISSUE_TEMPLATE/feature_request.yml, which
// labels them `enhancement`. The Requests page prefills that form and lists the open ones, read
// live from GitHub's public API, so what it shows is exactly what is on GitHub.

export const REPO = 'Sudo-Ali-Dev/Rankistan';
export const REQUEST_LABEL = 'enhancement';
export const NEW_REQUEST_URL = `https://github.com/${REPO}/issues/new`;
export const ALL_REQUESTS_URL = `https://github.com/${REPO}/issues?q=${encodeURIComponent(
  `is:issue is:open label:${REQUEST_LABEL}`
)}`;
export const REQUESTS_API_URL = `https://api.github.com/repos/${REPO}/issues?state=open&labels=${REQUEST_LABEL}&per_page=100`;

// GitHub keeps the whole form in the URL. Long text is cut so the link stays well inside the
// length browsers and GitHub accept; the full text can still be edited on GitHub before submitting.
export const TITLE_MAX = 120;
export const FIELD_MAX = 2000;

function clip(value, max) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

/**
 * The link that opens the feature request form on GitHub with the visitor's words already in it.
 * Issue forms take a value per field id (`problem`, `proposal`) from the query string.
 */
export function requestIssueUrl({ title, problem, proposal } = {}) {
  const params = new URLSearchParams({ template: 'feature_request.yml' });
  const t = clip(title, TITLE_MAX);
  const p = clip(problem, FIELD_MAX);
  const s = clip(proposal, FIELD_MAX);
  if (t) params.set('title', t);
  if (p) params.set('problem', p);
  if (s) params.set('proposal', s);
  return `${NEW_REQUEST_URL}?${params.toString()}`;
}

/**
 * Open requests from the API response, most thumbs up first, then newest. Pull requests share the
 * issues endpoint and are dropped.
 */
export function rankRequests(issues) {
  if (!Array.isArray(issues)) return [];
  return issues
    .filter((issue) => issue && !issue.pull_request && issue.state === 'open')
    .map((issue) => ({
      number: issue.number,
      title: String(issue.title || '').trim(),
      url: issue.html_url,
      votes: Number(issue.reactions?.['+1']) || 0,
      comments: Number(issue.comments) || 0,
      createdAt: issue.created_at
    }))
    .sort(
      (a, b) =>
        b.votes - a.votes ||
        String(b.createdAt).localeCompare(String(a.createdAt)) ||
        b.number - a.number
    );
}
