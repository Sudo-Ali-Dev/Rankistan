# Rankistan

**Current release: [v2.0.0](https://github.com/Sudo-Ali-Dev/Rankistan/releases/tag/v2.0.0)** — Scoring v2 (diminishing returns, daily caps, Evolution tab, Register breakdown).

An AI-powered daily leaderboard tracking active Pakistani developers on GitHub. The site includes a searchable **Leaderboard**, a **Developer Map** that groups developers by normalized profile locations on an interactive map of Pakistan, a **Badge Generator** for README rank badges, **Register** for profile checks with a live score breakdown and the links to register or opt out by GitHub issue, **Evolution** for how the scoring formula changed over time, and **About** documentation for pipeline logic, filters, and scheduling.

> **Note:** The frontend is currently optimized for desktop. Mobile design is still under development but usable.

## Contents

- [Frontend](#frontend)
- [How It Works](#how-it-works)
- [Running Locally](#running-locally)
- [Scheduling](#scheduling)
- [Project Structure](#project-structure)
- [Cloudflare Worker API](#cloudflare-worker-api)
- [Groq Key Security](#groq-key-security)
- [Contributing](#contributing)
- [TODO](#todo)

## Frontend

| Tab | Description |
|---|---|
| **Leaderboard** | Ranked list from `public/data.json` with search, filters, sort, CSV export, and pagination |
| **Map** | Pakistan outline with per-place counts; place breakdown; hover a node to sync-highlight and auto-scroll that place in the list; click a place to list developers for that bucket |
| **Badge** | Generate a dynamic Shields.io rank badge for your GitHub README (Markdown, HTML, or reST snippets) |
| **Register** | Validate a GitHub profile against pipeline criteria; shows an estimated score breakdown (stars, activity by type, followers, repos) before batch sync; links to the Register and Remove me issue forms |
| **Evolution** | Plain-language history of scoring changes (oldest to newest), current formula, and why rules were tightened |
| **About** | How the index works: scoring summary, activity filters, hourly batches, and FAQs |

The map assigns each developer to a canonical place key using a deterministic normalization strategy in `src/utils/location.js`. It does token-aware country detection, alias-based city matching (including common spellings and local variants), and safe fallback handling for unresolved locations.

## How It Works

The pipeline discovers developers from GitHub's location search (profiles that say Pakistan, or name one of 15 Pakistani cities without it), fetches their recent activity, and ranks them by a weighted score. Only genuinely active developers make the cut. The leaderboard is updated incrementally — each batch refreshes its slice of the leaderboard every day.

### Daily Scanner Layer

Rankistan operates as a rolling daily scanner rather than a one-shot leaderboard rebuild.

1. Search 34,838 GitHub accounts spanning account creation years from 2000 to present: 26,002 whose location says Pakistan and 8,836 that name only a Pakistani city (counted on 13 October 2026).
2. Screen every one on its first page of public events, and fetch in full only those that page does not settle.
3. Apply strict ranking criteria and publish only developers who pass all gates.

The scanner is distributed across 24 hourly batches, so the full ecosystem is refreshed continuously while keeping API usage within platform limits.

### Pipeline Stages

| Stage | Script | Output |
|---|---|---|
| **Discover** | `scripts/fetch-devs.js`, [`scripts/discovery/`](scripts/discovery/), [`scripts/registry.js`](scripts/registry.js) | Searches GitHub for developers whose location says Pakistan or names one of 15 Pakistani cities, by account-creation date, each range cut into slices that list whole in one request; adds developers registered by GitHub issue and drops those who opted out |
| **Fetch** | `scripts/fetch-devs.js` | Fetches profile, events (up to 2 pages / 200 events, last 60 days), repos, and linked social accounts (for LinkedIn) for each developer |
| **Score** | [`score-config.json`](score-config.json), [`src/model/`](src/model/), [`scripts/score.js`](scripts/score.js) | Weighted score from stars, 30-day activity (diminishing returns per UTC day), followers, and public repo count; Register runs the same code |
| **Leaderboard** | `scripts/write-leaderboard.js` | Writes the final ranked `data.json` with public-safe fields |

During **Fetch**, each developer is assigned category tags (AI/ML, Web, DevOps, etc.) by matching bio, repos, and languages against [`src/utils/tag-keywords.json`](src/utils/tag-keywords.json) via [`src/utils/tag-matcher.js`](src/utils/tag-matcher.js). Tags flow through scoring into `public/data.json`. The leaderboard UI uses those tags when present and only recomputes them for older rows missing tags. Re-run the pipeline to refresh tags after keyword changes.

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

Discovery searches GitHub for `location:pakistan type:user repos:>3 followers:>1`, split into 24 batches by account creation date:

```
PK 2000-Dec2014 → PK Jan2015-Aug2016 → ... → PK Jun2025-Nov2025 → PK Dec2025+
```

The ranges are cut by measured size, not by hand, so each batch screens about the same number of candidates: 1,240 to 1,640 on 13 October 2026, with the newest batch held to 915 so it can absorb the accounts that join each month ([`scripts/discovery/batches.js`](scripts/discovery/batches.js)). Until that day they were tuned to stay under GitHub's 1,000-result search cap, and once discovery lifted the cap the 2025-onward batch grew to 3,724 candidates, an hourly run that took most of its hour. A row belongs to the batch whose range holds its `created_at`, re-derived on every run, so [`scripts/discovery/rebalance.js`](scripts/discovery/rebalance.js) can recut the table whenever the counts drift, without stranding anyone.

One batch runs per hour, dispatched at :00 by the Cloudflare Worker's cron via `workflow_dispatch`, completing a full cycle every 24 hours. At :35 the same cron dispatches a backup trigger, which starts the pipeline only when no run covered that hour (`scripts/should-run.js`), and the watchdog, so a missed dispatch costs at most half an hour. Each batch immediately merges its results into the live leaderboard using per-batch replacement — only that batch's old entries are replaced with fresh data.

GitHub returns at most 1,000 results for any one search, and most batches match more than that (`PK Dec2019-May2020` matched 1,233 on 2026-10-13). So a batch's range is never listed as a single query. [`scripts/discovery/`](scripts/discovery/) bisects it by creation date — whole days, then seconds — until every slice holds fewer than 30 developers, packs neighbouring slices back together up to 95, and lists each resulting leaf in one GraphQL request. A single request has no page boundary for a follower tie to straddle and no cursor for a rate-limit wait to invalidate.

A leaf counts only when its listing is provably complete: an error-free response holding as many distinct accounts as GitHub says match. The leaves are also checked to add up to the batch's own count, and a mismatch is reported. A leaf that fails is named in a workflow warning and contributes nobody that run, so the merge carries its developers' existing rows forward rather than reading their absence as a departure. Measured on 2026-10-13, discovery costs 20–25 GraphQL points per batch and none of the REST search budget.

#### City names without "Pakistan"

GitHub matches the location field by whole word, so `location:pakistan` never finds a profile that says only "Lahore". Each batch therefore runs a second search over the same `created:` range, its **city twin**:

```
location:lahore location:karachi ... location:mardan -location:pakistan type:user repos:>3 followers:>1 created:...
```

Repeated `location:` qualifiers OR together and the negation excludes everyone the main search already lists. The 15 cities, and the names left out, are in [`scripts/discovery/locations.js`](scripts/discovery/locations.js): Lahore, Karachi, Islamabad, Rawalpindi, Peshawar, Faisalabad, Multan, Quetta, Sialkot, Gujranwala, Abbottabad, Bahawalpur, Sargodha, Sukkur and Mardan. Each was kept only after a sample of 30 of its matches was 30 Pakistani developers. Hyderabad (mostly India), Mirpur (mostly Dhaka), Gujrat (mostly a misspelling of Gujarat), Punjab, Kashmir and Hub are left out as ambiguous.

On 13 October 2026 the twins matched 8,836 accounts across all 24 batches, against 26,002 for `location:pakistan`, 368 a batch on average; under the rebalanced table each batch's twin holds 214 to 443. The twin is discovered separately, with its own completeness check, and its candidates are united with the main search's by `databaseId`. A developer it found whose fetched location also names a place outside Pakistan (India, Bangladesh, Iran and a few others) is counted as evaluated and ineligible. If either search is incomplete, the batch's miss counters freeze. If the twin cannot be measured at all, the batch is still published from the main search, with a workflow warning. Every row measured from then on records `discovery_source`: `pakistan`, `city`, or `registered`.

Measured live on 13 October 2026, under the earlier table, the twin cost 9, 12 and 23 GraphQL points for the May–Sep 2019, Aug–Dec 2024 and 2025-onward batches, and it adds 368 candidates to screen per batch on average. A live run of the May–Sep 2019 batch spent 1.14 REST calls per candidate, 1.19 on its city candidates, so the twin adds roughly 400–450 REST calls a batch, against 5,000 an hour. In that run 9 of the 255 city candidates passed the activity gates and none was rejected on location.

### Registration and Opt-out

Search finds developers whose GitHub location says Pakistan or names one of the 15 cities above, so it cannot find a Pakistani developer whose profile names somewhere else, an unsearched city, or nothing. They can register instead, and anyone can take themselves off the board. Both are GitHub issues, opened from the forms in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/), and [`scripts/registry.js`](scripts/registry.js) reads them on every run:

- **Register** (`register.yml`, label `registration`) registers the account that opened the issue. Nothing typed into the issue is read, so nobody can register anyone else. Registering replaces only the location search: the developer is evaluated in the batch whose `created:` range holds their account, must meet that search's `repos:>3 followers:>1`, and then passes the same account-age and activity gates as everyone else.
- **Remove me** (`remove-me.yml`, label `opt-out`) removes the account that opened the issue at the next run, whichever batch holds its row, and that account is not fetched again while the opt-out stands. The removal is recorded with the reason `opted_out`.
- Each author's latest issue wins, so a later Register issue reverses an opt-out. A registration a maintainer closes as `not_planned` is rejected; an opt-out counts however it is closed. Pull requests and accounts that are not users are ignored.
- Everything is keyed on the numeric account id, never the login, which can be renamed and then claimed by someone else. Rows record it as `github_id`; rows from before that are matched on the id in their `avatar_url`. Registered accounts are resolved to their current login and creation date with one GraphQL `nodes` query per 100 (1 point, measured on 2026-10-13), and their rows carry `discovery_source: "registered"`. One `location:pakistan` also found keeps `pakistan`; one only the city twin found is recorded as `registered`, so the twin's location re-check never rules out someone who registered.
- **Opt-outs fail closed.** A run that cannot read the issues saves and publishes nothing, with a `REGISTRY_UNREADABLE` error. Reading them costs one REST request per label (100 issues a page): 2 a run today.

[`.github/workflows/registration.yml`](.github/workflows/registration.yml) answers each new issue once and closes it as completed, which does not change how the pipeline reads it. Both labels must exist in the repository for the forms to apply them.

### Incremental Per-Batch Updates

Every developer entry in `data.json` is tagged with a `batch_index`. When batch N runs:

1. Fetch and score developers for batch N
2. Remove only entries where `batch_index === N` from the existing leaderboard
3. Insert freshly scored batch N developers (tagged with `batch_index: N`)
4. Deduplicate by username (latest batch wins), re-sort, re-rank, and cap

This means developers from batch 23 stay on the leaderboard all day until batch 23 re-runs and refreshes them. No downtime, no daily wipe.

### Where the Board Lives

The board is pipeline state, not a file in git. Each run of `update-digest.yml` loads the newest state from the [`pipeline-state`](https://github.com/Sudo-Ali-Dev/Rankistan/releases/tag/pipeline-state) release, merges its batch in, and saves the whole board back as a new asset, `state-<run_id>-<run_attempt>.json.gz` (the shape of `data.json`, gzipped). The newest 72 are kept. See [`scripts/state-store.js`](scripts/state-store.js).

Before saving, the run refuses a board that fails `verify:published`, or that loses more than 5% of its developers without a recorded reason. Every removal is logged by name with its reason: ineligible, missed twice, unmeasured for 7 days, displaced below the 1,000 cap, or opted out. It then dispatches `deploy.yml`, the only workflow that deploys Pages, which downloads the latest state into `public/data.json` before building. A code push and a data update therefore both deploy the latest of each.

`public/data.json` used to be committed every hour, and was 98.4% of the repository's packed size.

- `npm run state:pull` downloads the latest board to `public/data.json`. No token needed.
- `node scripts/state-store.js list` shows the saved states.
- **Rollback.** Revert the change that moved state off main, run `node scripts/state-store.js restore`, which writes the latest state to `public/data.json` only if it verifies, then commit that file. The previous pipeline resumes from it.

### On-Demand AI Summary System

AI summaries are generated only when a user expands a developer card.

1. Card expansion triggers summary generation if the username is not already cached in memory.
2. Frontend sends sanitized developer metadata to the Cloudflare Worker endpoint (`/api/dev-summary`) with timeout and retry controls.
3. Worker enforces CORS and per-IP rate limits, sanitizes input again, and calls Groq using server-side secrets.
4. Returned summary text is validated (minimum length and refusal checks), trimmed to display limits, and returned to the UI.
5. Frontend caches the final summary by username so repeated expansions are instant.

This design keeps summaries accurate and interactive while avoiding expensive bulk generation across the entire leaderboard.

### README Rank Badges

Ranked developers can embed a live badge in their GitHub README via the **Badge** tab.

1. Enter a GitHub username — the UI looks up rank from `public/data.json`.
2. Pick a Shields.io style (Flat, For The Badge, Flat Square, or Plastic).
3. Copy the generated snippet (Markdown, HTML, or reST).

Badges are rendered by [Shields.io](https://shields.io) using the dynamic endpoint pattern. Shields fetches JSON from the Cloudflare Worker at `/api/badge/{username}`, which reads the current leaderboard and returns a Shields-compatible payload (for example `rank #247`). The badge updates automatically when the leaderboard changes.

Example badge URL (used inside copied snippets):

```
https://img.shields.io/endpoint?url=https%3A%2F%2Frankistan-summary-api.academics-ali.workers.dev%2Fapi%2Fbadge%2F{username}&style=flat
```

The badge API runs on the same Worker as dev summaries — not on `rankistan.dev`, which is static GitHub Pages and cannot serve API routes. Deploy Worker changes with:

```bash
npm run cf:deploy
```

### Location + Map Strategy

The frontend location system is deterministic and does not use AI for location inference.

1. Normalize raw profile text (case folding, punctuation cleanup, whitespace normalization).
2. Detect Pakistani locations using exact country tokens (for example `pakistan`, `pk`) and a curated city alias dictionary.
3. Map aliases to canonical city keys (for example `lahore`, `rawalpindi`, `dera_ghazi_khan`) so display/search/map all use one source of truth.
4. Use conservative fallback behavior:
  - If country is present but city is unknown, display **Pakistan - Place Unspecified**.
  - If no country token exists, infer only a minimal cleaned candidate for display; otherwise fall back to **Pakistan - Place Unspecified**.
5. Plot map nodes from geocoded city coordinates projected onto the Pakistan SVG viewbox, then clamp hover cards inside map bounds and render hovered cards on top of nearby nodes for readability.

### Scoring Formula

All weights and caps live in [`score-config.json`](score-config.json), which [`src/model/config.js`](src/model/config.js) validates: a missing or malformed key throws, naming it. The formula itself exists once, in [`src/model/`](src/model/); the pipeline ([`scripts/score.js`](scripts/score.js)) and the Register preview ([`src/utils/score-breakdown.js`](src/utils/score-breakdown.js)) both call it.

Every published row records the `model_version` it was scored with, plus `score_exact`, `activity_score` and `scored_at`, so its score can be recomputed from the row alone; `npm run verify:published` does that for the whole board. The board is ordered by `score_exact`, then by username compared by code point, so the order does not depend on the machine that built it.

```
base_score = (min(stars, 250) × 2) + activity_score + (min(followers, 500) × 1) + (min(public_repos, 200) × 0.5)
final_score = round(base_score × (account_age < 6 months ? 0.5 : 1.0))
```

> **Note on caps**
> - Stars are capped at **250** (max **500** star points).
> - Followers are capped at **500** (max **500** follower points).
- Public repos are capped at **200** (max **100** repo points).
> - Accounts younger than **6 months** receive a **0.5×** multiplier on the full base score.

**What counts (open source only)**

| Component | Source |
|-----------|--------|
| Stars | Sum of stars on **public** repositories (private repos excluded) |
| Activity | **Public** Push, Pull Request, Issue, and Release events in the last **30 days** |
| Followers / public repos | GitHub profile fields |

**What does not count:** watching, starring, forking, or commenting on repos (for score or contribution gates).

**Activity score (current)**

Recent meaningful events use diminishing returns **per UTC calendar day**, per type:

- Marginal points for the *n*th event of a type on a day: `base / log2(n + 1)`
- Daily total per type is capped, then summed across all days in the 30-day window

| Type | Base | Daily cap | Extra limit |
|------|------|-----------|-------------|
| Push | 2.0 | 15 pts | First 20 pushes/day counted |
| Issue | 1.5 | 15 pts | — |
| Pull Request | 4.0 | 25 pts | — |
| Release | 5.0 | 20 pts | — |

During scoring, the pipeline prefers `raw_events_60d` from fetch (then filters to 30 days). If only per-type totals exist, it uses `event_counts_30d` with a synthetic single-day curve. If only flat `events_30d` exists, it falls back to **3.125** points per event.

`events_30d` on the leaderboard is a **raw** event count and can be higher than the capped activity points used in score.

For a plain-language history of how the formula changed (and why), open the **Evolution** tab in the app or read [`src/pages/Evolution.jsx`](src/pages/Evolution.jsx).

### Shadow Measurement (not scored)

The activity term above reads the public events feed, which GitHub caps at 300 events, and the pipeline reads 200: the busier a developer, the fewer days that covers. The next model will read `contributionsCollection`, which is keyed on a date range instead, and will need limits per repository and per day so that it cannot be farmed. Those limits have to be chosen from the real distributions, so every row the pipeline measures now also carries them, scored by nothing:

- `shadow_contributions` ([`scripts/measure/contributions.js`](scripts/measure/contributions.js)): a dated block holding the 60-day contribution calendar, the 30-day totals (private `restricted` counts as context only), commits per repository per day with each repository's owner, fork flag and stars, pull requests per repository and how many someone else merged, and the median gap between pull request creations (an automation signal, published as context, never scored). One GraphQL request per 15 developers; a developer it cannot measure keeps their previous block.
- `events_window` ([`scripts/fetch-devs.js`](scripts/fetch-devs.js)): how many events the read behind `activity_score` held, whether it stopped at its page ceiling, and how many days back it reached.

Neither field affects a score: the block is attached after scoring, the model reads only its own inputs, and `npm run verify:published` recomputes every score without them. Both are kept in the pipeline's state (the `pipeline-state` release) and left out of everything the site serves: `board.json`, `dev/<login>.json`, `digest.json`, and the public `data.json` itself, which [`scripts/build-split-data.js`](scripts/build-split-data.js) writes without them. The Worker parses that file whole on Cloudflare's per-request CPU budget, and the blocks would add about 41% to it. `npm run state:pull` fetches the state, blocks included. `node scripts/shadow-report.js [board.json]` reports their coverage, distributions, and how candidate measures compare with today's `activity_score`.

## Running Locally

```bash
# Install dependencies
npm install

# Start the frontend dev server (no token needed - the first run downloads
# the latest board to public/data.json; `npm run state:pull` refreshes it)
npm run dev
```

Frontend work needs nothing else. For **pipeline** work, copy `.env.example` to
`.env` and set `MY_GITHUB_PAT`; `scripts/fetch-devs.js` exits with
`Missing GitHub token. Set MY_GITHUB_PAT in .env` without it. Only public data is
read, so a classic PAT with **no scopes** (or a fine-grained token with
`Public Repositories: Read`) is sufficient — never grant write scopes.

```bash
# Run a single batch incrementally (0-23) - requires MY_GITHUB_PAT
node scripts/run-all.js --incremental 0

# Dry-run: skip GitHub, test atomic write to public/data.dry-run.json (no PAT / rate limits)
node scripts/run-all.js --incremental 0 --dry-run
# Same as: SKIP_GITHUB=true node scripts/run-all.js --incremental 0

# Checks - all of these also run in CI on every PR
npm run lint          # ESLint across src/, scripts/ and cloudflare/
npm test              # Vitest
npm run build         # production build, plus the split data files the browser reads
npm run verify:activity   # activity-scoring invariants (log2 curve + daily caps)

# Formatting - see CONTRIBUTING.md before running repo-wide
npm run format:check
npm run format

# Deploy the Cloudflare Worker (badge + summary APIs) - not done by merging
npm run cf:deploy
```

Node 20 is expected (`.nvmrc`, `engines` in `package.json`). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor workflow.

The repo root is ESM (`"type": "module"` in `package.json`); pipeline scripts use `import`/`export` and import JSON with `with { type: 'json' }`.

Dry-run replays the batch's own rows from `public/data.json` as though they had just been measured, through the real merge and guards, and writes `public/data.dry-run.json` only. It does not fetch or score; use a real incremental run when testing those steps. CI dry-runs against the committed 50-row sample, `fixtures/data.sample.json`. A local run reads and writes `public/data.json` and never touches the published state; only `--state release`, which the workflow passes, does.

> Do not set `SKIP_GITHUB=true` in GitHub Actions; CI must run the full incremental pipeline.

## Scheduling

The pipeline runs **every hour, 24 batches per day**, dispatched through the GitHub Actions API by the Cloudflare Worker's cron triggers (`cloudflare/scheduled.js`). GitHub's own scheduler is not used for this: no `schedule` trigger has fired in this repository since 2026-04-03.

Nothing that runs the pipeline can report its own failure, so an outside monitor watches the result. [cron-job.org](https://cron-job.org) requests the Worker's `/api/health` every hour, holding no token, and emails the owner when it answers 503: the live board's `last_updated` is more than 4 hours old, or unreadable.

### Scheduler Flow

1. **The Worker's `:00` cron** sends a `POST` to the GitHub `workflow_dispatch` API every hour; its `:35` cron dispatches the backup trigger and the watchdog
2. The workflow auto-detects which batch to run from the current UTC hour: `batch = (UTC_HOUR + 5) % 24`
3. Batch 0 aligns with **12:00 AM PKT**, batch 1 with 1:00 AM PKT, and so on

### Batch Schedule (PKT)

| PKT | Batch | Accounts created | `location:pakistan` | City twin | Candidates |
|---|---|---|---:|---:|---:|
| 12:00 AM | `batch-0` | 2000–Dec 2014 | 1,222 | 307 | 1,529 |
| 1:00 AM | `batch-1` | Jan 2015–Aug 2016 | 1,156 | 340 | 1,496 |
| 2:00 AM | `batch-2` | Sep 2016–Oct 2017 | 1,226 | 345 | 1,571 |
| 3:00 AM | `batch-3` | Nov 2017–Sep 2018 | 1,134 | 350 | 1,484 |
| 4:00 AM | `batch-4` | Oct 2018–May 2019 | 1,131 | 339 | 1,470 |
| 5:00 AM | `batch-5` | Jun 2019–Nov 2019 | 1,161 | 375 | 1,536 |
| 6:00 AM | `batch-6` | Dec 2019–May 2020 | 1,233 | 386 | 1,619 |
| 7:00 AM | `batch-7` | Jun 2020–Nov 2020 | 1,214 | 394 | 1,608 |
| 8:00 AM | `batch-8` | Dec 2020–Apr 2021 | 1,123 | 377 | 1,500 |
| 9:00 AM | `batch-9` | May 2021–Sep 2021 | 1,067 | 334 | 1,401 |
| 10:00 AM | `batch-10` | Oct 2021–Jan 2022 | 973 | 365 | 1,338 |
| 11:00 AM | `batch-11` | Feb 2022–May 2022 | 981 | 350 | 1,331 |
| 12:00 PM | `batch-12` | Jun 2022–Sep 2022 | 1,197 | 443 | 1,640 |
| 1:00 PM | `batch-13` | Oct 2022–Dec 2022 | 871 | 369 | 1,240 |
| 2:00 PM | `batch-14` | Jan 2023–Mar 2023 | 1,013 | 361 | 1,374 |
| 3:00 PM | `batch-15` | Apr 2023–Jul 2023 | 1,104 | 420 | 1,524 |
| 4:00 PM | `batch-16` | Aug 2023–Oct 2023 | 1,027 | 394 | 1,421 |
| 5:00 PM | `batch-17` | Nov 2023–Jan 2024 | 1,020 | 405 | 1,425 |
| 6:00 PM | `batch-18` | Feb 2024–Apr 2024 | 1,153 | 440 | 1,593 |
| 7:00 PM | `batch-19` | May 2024–Aug 2024 | 1,185 | 396 | 1,581 |
| 8:00 PM | `batch-20` | Sep 2024–Dec 2024 | 1,029 | 420 | 1,449 |
| 9:00 PM | `batch-21` | Jan 2025–May 2025 | 962 | 371 | 1,333 |
| 10:00 PM | `batch-22` | Jun 2025–Nov 2025 | 1,128 | 348 | 1,476 |
| 11:00 PM | `batch-23` | Dec 2025 onward | 701 | 214 | 915 |

Candidate counts were measured on 13 October 2026 (34,854 in all), and the ranges were cut from them by [`scripts/discovery/rebalance.js`](scripts/discovery/rebalance.js) so every batch screens about the same number of people; see [`scripts/discovery/batches.js`](scripts/discovery/batches.js).

### Manual Trigger

You can trigger any batch manually via **Actions → "Update Leaderboard" → Run workflow** with a specific batch index, or leave it empty to auto-detect from the current hour.

## Project Structure

```
score-config.json       # Weights, caps, ACTIVITY_SCORING (single source of truth)
scripts/
  fetch-devs.js         # Developer discovery + activity fetching
  registry.js           # Registration and opt-out issues, keyed on the account id
  score.js              # Batch scoring (a thin wrapper over src/model/)
  verify-activity-score.js  # Sanity checks for activity curve
  verify-published.js   # Recomputes every versioned score on the published board
  write-leaderboard.js  # Final leaderboard output (strips internal fields)
  run-all.js            # Pipeline orchestrator (--incremental N [--dry-run])
  build-split-data.js   # After vite build: splits data.json into dist/board.json, digest.json, dev/<login>.json
  measure/
    contributions.js    # Shadow measurement of the next model's inputs (scored by nothing)
  shadow-report.js      # Coverage and distributions of the shadow measurement, as markdown
cloudflare/
  worker.js             # Cloudflare Worker (dev summaries + badge JSON API)
  wrangler.toml         # Worker deployment config
public/
  data.json             # Final leaderboard (published unchanged at the site root; the Worker reads it)
  data.dry-run.json     # Local dry-run output only (gitignored)
src/
  App.jsx               # Main app shell (Leaderboard / Map / Badge / Register / About / Evolution)
  model/
    config.js           # Validates score-config.json; exports MODEL_VERSION
    activity.js         # 30d activity curve
    score.js            # The score, and its recomputation from a published row
    order.js            # Board order: score_exact, then username by code point
  pages/
    Leaderboard.jsx     # Developer rankings
    DevMap.jsx          # Pakistan map + place breakdown + per-place table
    BadgeGenerator.jsx  # README rank badge generator
    Register.jsx        # Profile validation + live score breakdown
    Evolution.jsx       # Scoring formula changelog (user-facing)
    About.jsx           # Pipeline, scoring summary, filters, FAQs
  components/
    ScoreBreakdownPanel.jsx  # Register score bifurcation UI
  utils/
    score-breakdown.js    # src/model/ results shaped for the Register UI
    groq.js               # Worker API URL helpers (summary + badge endpoints)
```

## Cloudflare Worker API

The Worker (`cloudflare/worker.js`) backs three public endpoints:

| Route | Method | Purpose |
|---|---|---|
| `/api/dev-summary` | POST | On-demand AI developer summaries (Groq) |
| `/api/badge/{username}` | GET | Shields.io JSON for dynamic README badges |
| `/api/heatmap/{username}` | GET | Contribution-graph SVG, proxied and cached |

Summary generation runs behind the Worker so the Groq key is not exposed in the frontend bundle.

Worker changes only take effect after `npm run cf:deploy` — merging a PR does not update the Worker.

### Security Model

- Frontend sends developer metadata and receives summary text; badge snippets point Shields.io at `/api/badge/{username}`.
- `GROQ_API_KEY_1` … `GROQ_API_KEY_8` are stored only in Worker secrets.
- Frontend resolves Worker URLs via `VITE_SUMMARY_API_URL` (see `src/utils/groq.js`).
- `/api/dev-summary` requires the username to be a valid GitHub handle **and** to
  already exist on the leaderboard. That is what bounds the cost of abuse: the
  endpoint spends Groq credits per call and is otherwise unauthenticated.
- Rate limiting uses Cloudflare's Rate Limiting binding (`SUMMARY_RATE_LIMITER`
  in `cloudflare/wrangler.toml`), which is authoritative **per Cloudflare
  location** rather than strictly globally. A module-level counter was used
  before, which only ever limited per Worker isolate ([#65](https://github.com/Sudo-Ali-Dev/Rankistan/issues/65)).
- CORS reflects only origins listed in `SUMMARY_ALLOWED_ORIGIN`, and every
  response sets `Vary: Origin` so cached responses cannot leak one origin's
  `Access-Control-Allow-Origin` to another.
- `/api/heatmap` pins `Content-Type: image/svg+xml` with `nosniff` and a
  deny-all CSP rather than trusting the third-party upstream's own header.
- All developer fields are stripped of control characters before being
  interpolated into the LLM prompt, so a caller cannot inject prompt
  instructions through a name, location, or repo description.

### Trade-off

This setup meaningfully reduces key exposure risk for a static frontend, but it is not fully abuse-proof.

Configuration model:

- Set **`GROQ_API_KEY_1` through `GROQ_API_KEY_8`** (same key format for each slot). The Worker rotates through them on rate limits.
- `VITE_SUMMARY_API_URL`: public frontend pointer to Worker origin.
- `SUMMARY_ALLOWED_ORIGIN`: allowed frontend origin for Worker CORS.
- `scripts/generate-digest.js` uses the first available slot from `GROQ_API_KEY_1` … `GROQ_API_KEY_8`. Note it is **not currently wired into CI**: no workflow or npm script invokes it, and `public/digest.json` is not generated. The Repository Digest page reads a `digest.json` that `npm run build` derives from `public/data.json`, and the build refuses to run if a `public/digest.json` exists rather than overwrite it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks CI runs on every PR,
formatting rules, and PR scope guidance. Security reports go through
[SECURITY.md](SECURITY.md), not public issues.

## TODO

- [x] Leaderboard — Developer rankings with daily incremental updates
- [x] Developer Map — Place distribution and per-place developer list
- [x] Badge Generator — Dynamic README rank badges via Shields.io
- [x] Registration — Register or opt out by GitHub issue; profile validation against pipeline criteria
- [x] About — On-site documentation for scoring, filters, and scheduling
- [x] Evolution — Scoring formula history and plain-language rationale
- [x] Register score breakdown — Live estimate with per-component points before batch sync
- [ ] Weekly Digest — AI-powered weekly summary of ecosystem trends
- [ ] Archives — Browse previous weekly digest reports
- [ ] Report Detail — Detailed view of an archived weekly report
