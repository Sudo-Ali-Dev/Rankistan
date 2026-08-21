# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability.

Use GitHub's private reporting: **Security → Report a vulnerability** on this
repository. If that is unavailable, open a normal issue containing only "I would
like to report a security issue privately" and no details, and a maintainer will
follow up.

Please include what you can: affected component, reproduction steps, and impact.
There is no bounty — this is a community project — but credit is given in the
fix's commit message unless you'd rather not be named.

## What is in scope

| Component | Notes |
|---|---|
| `cloudflare/worker.js` | Serves `/api/dev-summary`, `/api/badge/{user}`, `/api/heatmap/{user}`. Holds the Groq API keys. The most security-relevant code in the repo. |
| `scripts/` | The data pipeline. Runs in GitHub Actions with `contents: write`. |
| `.github/workflows/` | Anything that could lead to workflow or token compromise. |
| The published site | Stored XSS, content-injection, or leaked credentials. |

## What is not

- **Rate-limit precision.** `/api/dev-summary` is rate limited per Cloudflare
  location, not strictly globally. This is a known and accepted limit of the
  primitive; the leaderboard-membership check is what bounds abuse cost.
- **Third-party upstream availability.** `/api/heatmap` proxies
  `github-readme-activity-graph.vercel.app`. Its downtime is not a
  vulnerability, though a way to make it serve content that escapes our
  `Content-Type` and CSP pinning would be.
- **Data in `public/data.json`.** It is entirely public GitHub profile data.
- Missing security headers on GitHub Pages itself, which we do not control.

## Handling secrets

- `MY_GITHUB_PAT` belongs in a local, gitignored `.env`. It only ever needs
  read access to public data — never grant write scopes.
- `GROQ_API_KEY_1` … `GROQ_API_KEY_8` are Cloudflare Worker secrets and must
  never appear in the repo, in `wrangler.toml`, or in any `VITE_`-prefixed
  variable. **Anything prefixed `VITE_` is inlined into the public JS bundle.**
- If you believe a key has been exposed, rotate it first and report second.
