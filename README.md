# Rankistan

A daily leaderboard tracking active Pakistani developers on GitHub. The site includes a searchable **Leaderboard**, a **Developer Map** that groups developers by city (parsed from profile locations) on a interactive map of Pakistan, **Register** for profile checks, and **About** explaining the pipeline, scoring, and scheduling.

## Frontend

| Tab | Description |
|---|---|
| **Leaderboard** | Ranked list from `public/data.json` with search, filters, sort, CSV export, and pagination |
| **Map** | Pakistan outline with per-city counts; city breakdown; click a city to list developers for that bucket |
| **Register** | Validate a GitHub profile against pipeline criteria |
| **About** | How the index works: scoring, activity filters, hourly batches, and FAQs |

The map assigns each developer to a city using substring matching on the `location` field (e.g. “Lahore, Pakistan”). Entries that do not match a known city are grouped under **Other / Unresolved**.

## How It Works

The pipeline discovers developers from GitHub's location search across all of Pakistan, fetches their recent activity, and ranks them by a weighted score. Only genuinely active developers make the cut. The leaderboard is updated incrementally — each batch refreshes its slice of the leaderboard every day.

### Pipeline Stages

| Stage | Script | Output |
|---|---|---|
| **Discover** | `scripts/fetch-devs.js` | Searches GitHub for developers in Pakistan, split into 24 date-range batches to bypass the 1,000-result cap |
| **Fetch** | `scripts/fetch-devs.js` | Fetches profile, events (up to 2 pages / 200 events, last 60 days), and repos for each developer |
| **Score** | `scripts/score.js` | Calculates a weighted score based on stars, recent activity, followers, and repo count |
| **Leaderboard** | `scripts/write-leaderboard.js` | Writes the final ranked `data.json` with public-safe fields |

### Activity Filter

Not everyone with a GitHub account qualifies. Developers must pass these thresholds:

| Criteria | Threshold |
|---|---|
| Meaningful contributions (pushes, PRs, issues, releases) | **>=30 in the last 60 days** |
| Longest inactivity gap (between events or since last event) | **<=30 days** |
| Account age | **>=30 days** |
| Public repos | **>3** |
| Followers | **>1** |

### Search Strategy

To maximize coverage within GitHub's API limits, the discovery phase splits searches into 24 flexible date-range batches based on account creation date:

```
PK 2000-Jun2014 → PK Jul2014-Jan2016 → ... → PK Aug2024-Dec2024 → PK 2025+
```

Each batch targets ~800-950 developers (under the 1,000-result API cap). One batch runs per hour (triggered by [cron-job.org](https://cron-job.org) via `workflow_dispatch`), completing a full cycle every 24 hours. Each batch immediately merges its results into the live leaderboard using per-batch replacement — only that batch's old entries are removed and replaced with fresh data.

### Incremental Per-Batch Updates

Every developer entry in `data.json` is tagged with a `batch_index`. When batch N runs:

1. Fetch and score developers for batch N
2. Remove only entries where `batch_index === N` from the existing leaderboard
3. Insert freshly scored batch N developers (tagged with `batch_index: N`)
4. Deduplicate by username (latest batch wins), re-sort, re-rank, and cap

This means developers from batch 23 stay on the leaderboard all day until batch 23 re-runs and refreshes them. No downtime, no daily wipe.

### Scoring Formula

```
base_score = (stars × 2) + (events_30d × 3) + (followers × 1) + (public_repos × 0.5)
```

- Stars are capped at 2,000 to prevent outlier dominance
- Accounts younger than 6 months receive a 0.5× penalty

## Running Locally

```bash
# Install dependencies
npm install

# Run a single batch incrementally (0-23)
node scripts/run-all.js --incremental 0

# Start the frontend dev server
npm run dev
```

## Scheduling

The pipeline runs **every hour, 24 batches per day**, triggered by an external cron service ([cron-job.org](https://cron-job.org)) that dispatches the GitHub Actions workflow via the API. This is more reliable than GitHub's built-in cron scheduler, which can delay or skip runs during peak load.

### How It Works

1. **cron-job.org** sends a `POST` to the GitHub `workflow_dispatch` API every hour
2. The workflow auto-detects which batch to run from the current UTC hour: `batch = (UTC_HOUR + 5) % 24`
3. Batch 0 aligns with **12:00 AM PKT**, batch 1 with 1:00 AM PKT, and so on

### Batch Schedule (PKT)

| PKT | Batch | Description |
|---|---|---|
| 12:00 AM | `batch-0` | PK accounts created 2000–Jun 2014 |
| 1:00 AM | `batch-1` | PK accounts created Jul 2014–Jan 2016 |
| 2:00 AM | `batch-2` | PK accounts created Feb 2016–Feb 2017 |
| 3:00 AM | `batch-3` | PK accounts created Mar 2017–Dec 2017 |
| 4:00 AM | `batch-4` | PK accounts created Jan 2018–Sep 2018 |
| 5:00 AM | `batch-5` | PK accounts created Oct 2018–Apr 2019 |
| 6:00 AM | `batch-6` | PK accounts created May 2019–Sep 2019 |
| 7:00 AM | `batch-7` | PK accounts created Oct 2019–Feb 2020 |
| 8:00 AM | `batch-8` | PK accounts created Mar 2020–Jun 2020 |
| 9:00 AM | `batch-9` | PK accounts created Jul 2020–Nov 2020 |
| 10:00 AM | `batch-10` | PK accounts created Dec 2020–Mar 2021 |
| 11:00 AM | `batch-11` | PK accounts created Apr 2021–Aug 2021 |
| 12:00 PM | `batch-12` | PK accounts created Sep 2021–Dec 2021 |
| 1:00 PM | `batch-13` | PK accounts created Jan 2022–Apr 2022 |
| 2:00 PM | `batch-14` | PK accounts created May 2022–Aug 2022 |
| 3:00 PM | `batch-15` | PK accounts created Sep 2022–Nov 2022 |
| 4:00 PM | `batch-16` | PK accounts created Dec 2022–Feb 2023 |
| 5:00 PM | `batch-17` | PK accounts created Mar 2023–Jun 2023 |
| 6:00 PM | `batch-18` | PK accounts created Jul 2023–Sep 2023 |
| 7:00 PM | `batch-19` | PK accounts created Oct 2023–Dec 2023 |
| 8:00 PM | `batch-20` | PK accounts created Jan 2024–Mar 2024 |
| 9:00 PM | `batch-21` | PK accounts created Apr 2024–Jul 2024 |
| 10:00 PM | `batch-22` | PK accounts created Aug 2024–Dec 2024 |
| 11:00 PM | `batch-23` | PK accounts created 2025+ |

### Manual Trigger

You can trigger any batch manually via **Actions → "Update Leaderboard" → Run workflow** with a specific batch index, or leave it empty to auto-detect from the current hour.

## Project Structure

```
scripts/
  fetch-devs.js         # Developer discovery + activity fetching
  score.js              # Scoring algorithm
  write-leaderboard.js  # Final leaderboard output
  run-all.js            # Pipeline orchestrator (--incremental N)
cloudflare/
  worker.js             # Cloudflare Worker summary API endpoint
  wrangler.toml         # Worker deployment config
public/
  data.json             # Final leaderboard (served to frontend)
src/
  App.jsx               # Main app shell (Leaderboard / Map / Register / About tabs)
  pages/
    Leaderboard.jsx     # Developer rankings
    DevMap.jsx          # Pakistan map + city breakdown + per-city table
    Register.jsx        # Profile validation
    About.jsx           # User-facing docs (pipeline, scoring, scheduling)
```

## Groq Key Security

I originally generated profile summaries in the browser. That meant the Groq key had to be embedded in client code, which makes it publicly visible.

To fix that, summary generation now runs behind a Cloudflare Worker (`cloudflare/worker.js`) at `/api/dev-summary`.

What changed:

- Frontend sends only developer metadata and receives summary text.
- Groq key is stored only in Worker secrets (never in client bundle).
- Worker adds CORS and basic rate limiting around the summary endpoint.

Why Cloudflare Worker:

- The frontend is static (GitHub Pages), so it needs a small server layer for secure secret handling.
- Worker keeps API key usage isolated from UI code.
- It reduces abuse risk while keeping the same user-facing summary feature.

Reality check:

- This is still not bulletproof security.
- Moving the key to a Worker hides it from browser source code, but it does not make abuse impossible.
- I know this trade-off and accept it for this project because I am using a free-quota key and doing this for fun.
- I do not want to redesign the whole architecture just to harden this one feature.

Configuration model:

- `GROQ_API_KEY`: Worker secret only.
- `VITE_SUMMARY_API_URL`: public frontend pointer to Worker origin.
- `SUMMARY_ALLOWED_ORIGIN`: allowed frontend origin for Worker CORS.
- `GROQ_API_KEY_PAKDEVINDEX`: still used by CI digest generation (`scripts/generate-digest.js`).

## TODO

- [x] Leaderboard — Developer rankings with daily incremental updates
- [x] Developer Map — City distribution and per-city developer list
- [x] Registration — Profile validation against pipeline criteria
- [x] About — On-site documentation for scoring, filters, and scheduling
- [ ] Weekly Digest — AI-powered weekly summary of ecosystem trends
- [ ] Archives — Browse previous weekly digest reports
- [ ] Report Detail — Detailed view of an archived weekly report
