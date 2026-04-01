# PakDev Index

A weekly leaderboard and digest tracking active Pakistani developers on GitHub.

## How It Works

The pipeline discovers developers from GitHub's location search, fetches their recent activity, and ranks them by a weighted score. Only genuinely active developers make the cut.

### Pipeline Stages

| Stage | Script | Output |
|---|---|---|
| **Discover** | `scripts/fetch-devs.js` | Searches GitHub for developers in Lahore, split by account creation year to bypass the 1,000-result cap |
| **Fetch** | `scripts/fetch-devs.js` | Fetches profile, events (up to 2 pages / 200 events, last 60 days), and repos for each developer |
| **Score** | `scripts/score.js` | Calculates a weighted score based on stars, recent activity, followers, and repo count |
| **Leaderboard** | `scripts/write-leaderboard.js` | Writes the final ranked `data.json` with public-safe fields |
| **Digest** | `scripts/generate-digest.js` | Generates an AI-powered weekly summary of ecosystem trends |

### Activity Filter

Not everyone with a GitHub account qualifies. Developers must pass these thresholds:

| Criteria | Threshold |
|---|---|
| Meaningful contributions (pushes, PRs, issues, releases) | **>=30 in the last 60 days** |
| Longest inactivity gap | **<=30 days** |
| Account age | **>=30 days** |
| Public repos | **>3** |
| Followers | **>2** |

### Search Strategy

To maximize coverage within GitHub's API limits, the discovery phase splits searches by account creation year:

```
Lahore 2010-2017 → Lahore 2018-2019 → Lahore 2020 → ... → Lahore 2025-2026
```

Each batch runs as a separate GitHub Actions job, spaced 1 hour apart, to stay within rate limits. A final merge step combines all batches, deduplicates, filters, scores, and generates the digest. Rate limit tracking distinguishes between core and search API quotas to avoid unnecessary pauses.

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

# Run the full pipeline (requires GITHUB_TOKEN or MY_GITHUB_PAT in .env)
node scripts/run-all.js

# Run a single batch (0-7)
node scripts/run-all.js --batch 0

# Merge all batches + score + generate digest
node scripts/run-all.js --merge

# Start the frontend dev server
npm run dev
```

## GitHub Actions Schedule

The pipeline runs **every night** (PKT):

| PKT | Phase | Description |
|---|---|---|
| 12:00 AM | `batch-0` | Lahore accounts created 2010–2017 |
| 1:00 AM | `batch-1` | Lahore accounts created 2018–2019 |
| 2:00 AM | `batch-2` | Lahore accounts created 2020 |
| 3:00 AM | `batch-3` | Lahore accounts created 2021 |
| 4:00 AM | `batch-4` | Lahore accounts created 2022 |
| 5:00 AM | `batch-5` | Lahore accounts created 2023 |
| 6:00 AM | `batch-6` | Lahore accounts created 2024 |
| 7:00 AM | `batch-7` | Lahore accounts created 2025–2026 |
| 8:00 AM | `merge` | Merge all batches → filter → score → digest |

You can also trigger any phase manually via **Actions → "Update Weekly Digest" → Run workflow**.

## Project Structure

```
scripts/
  fetch-devs.js         # Developer discovery + activity fetching
  score.js              # Scoring algorithm
  write-leaderboard.js  # Final leaderboard output
  generate-digest.js    # AI-powered weekly digest
  run-all.js            # Pipeline orchestrator (--batch N / --merge / full)
public/
  data.json             # Final leaderboard (served to frontend)
  digest.json           # Weekly digest data
  raw.json              # Merged raw developer data
  scored.json           # Scored developer data
  registered_devs.json  # Manually registered developers
src/
  App.jsx               # Main app shell with tab routing
  pages/
    Leaderboard.jsx     # Developer rankings
    WeeklyDigest.jsx    # Current week's AI-generated digest
    Archives.jsx        # Previous weekly reports
    ReportDetail.jsx    # Detailed view of an archived report
```

## Secrets Required

| Secret | Purpose |
|---|---|
| `GITHUB_TOKEN` | Auto-provisioned by Actions for API access |
| `GROQ_API_KEY_PakDevIndex` | Groq API key for AI digest generation |
