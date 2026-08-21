// Fetches self-declared pronouns from GitHub profiles.
//
// Why this exists: the AI summaries used to infer gender from the developer's
// name, which misgendered real people on a public leaderboard (#73). The fix is
// not to guess more carefully, and not to dodge pronouns - it is to use what
// each person has declared about themselves. GitHub has a `pronouns` field on
// user profiles, and a good number of the ranked developers have set it.
//
// The REST API does not expose that field, so this uses GraphQL. Requests are
// batched with aliases (one query covers BATCH_SIZE users) and this runs only
// over the developers that already passed the activity filter - a few hundred
// per pipeline batch rather than the ~900 discovered - so the cost is a handful
// of requests, not one per developer.
//
// Failure is non-fatal by design: pronouns are an enhancement, and a GraphQL
// outage must not stop the leaderboard from updating. A developer with no
// declared pronouns, or one whose lookup failed, simply carries none, and the
// summary prompt then uses the name as the subject rather than guessing.

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_PRONOUNS_LENGTH = 40;

// GraphQL aliases must match /^[_A-Za-z][_0-9A-Za-z]*$/, and GitHub logins can
// contain hyphens, so aliases are positional rather than derived from the login.
function buildQuery(usernames) {
  const parts = usernames.map(
    (login, index) => `u${index}: user(login: ${JSON.stringify(login)}) { login pronouns }`
  );
  return `query { ${parts.join(' ')} }`;
}

function sanitizePronouns(value) {
  if (typeof value !== 'string') return '';
  // This string is written by the profile owner and ends up in an LLM prompt, so
  // strip control characters and collapse whitespace before it travels.
  return value
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PRONOUNS_LENGTH);
}

async function fetchPronounsBatch(usernames, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(GITHUB_GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'rankistan-fetch-pronouns'
      },
      body: JSON.stringify({ query: buildQuery(usernames) }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`GraphQL returned ${response.status}`);
    }

    const payload = await response.json();
    const found = new Map();

    // Partial success is normal: a deleted or renamed account yields a null
    // alias plus an entry in `errors`, and the rest of the batch is still good.
    for (const value of Object.values(payload?.data || {})) {
      const login = value?.login;
      const pronouns = sanitizePronouns(value?.pronouns);
      if (login && pronouns) {
        found.set(login.toLowerCase(), pronouns);
      }
    }

    return found;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPronouns(usernames, token) {
  const result = new Map();

  if (!token) {
    console.warn('Pronouns lookup skipped: no GitHub token available.');
    return result;
  }

  const unique = [...new Set((usernames || []).filter(Boolean).map(String))];

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const slice = unique.slice(i, i + BATCH_SIZE);
    try {
      const found = await fetchPronounsBatch(slice, token);
      for (const [login, pronouns] of found) {
        result.set(login, pronouns);
      }
    } catch (error) {
      console.warn(
        `Pronouns lookup failed for ${slice.length} users starting at ${i}: ${error.message}`
      );
    }
  }

  console.log(`Pronouns: ${result.size} of ${unique.length} developers have declared them.`);
  return result;
}

export function attachPronouns(developers, pronounsByLogin) {
  if (!Array.isArray(developers)) return [];

  return developers.map((dev) => {
    const key = String(dev?.username || '').toLowerCase();
    const pronouns = pronounsByLogin?.get(key);
    return pronouns ? { ...dev, pronouns } : dev;
  });
}

export { sanitizePronouns, buildQuery, BATCH_SIZE };
