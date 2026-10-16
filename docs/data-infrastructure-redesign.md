# Data infrastructure redesign (October 2026)

How Rankistan finds, measures, scores and publishes Pakistani developers, redesigned from what the
system has to do. The redesign was planned and shipped on 13–14 October 2026, in order, one pull
request per step. This file is its record: what was broken, the rules the design follows, what was
built, the decisions taken, and where building it proved the plan wrong.

It was drawn from twelve investigations of the live repository, 90 days of Actions history and all
3,928 versions of `data.json`, then attacked by a separate review before any of it was built. Every
figure below was measured, unless it says "about".

**Status, 16 October 2026.** Every step is shipped. Step 7B became scoring v3, recorded in
[scoring.md](scoring.md).

## In plain words: before and after

|                                       | Before                                                                                 | After                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Who starts each hourly run            | cron-job.org, with a personal token, and nothing behind it                             | A Cloudflare Worker cron at `:00`, plus a backup at `:35` that starts the run only if `:00` was missed     |
| Who notices if it stops               | Nobody: the pipeline stalled for eight days unnoticed                                  | A watchdog that opens an issue, and cron-job.org checking `/api/health` (no token) and emailing the owner  |
| Where the board lives                 | `public/data.json`, committed to `main` every hour (98.4% of the repository)           | A gzipped snapshot per run on the `pipeline-state` release; nothing in git                                 |
| Who can find you                      | People whose location says "Pakistan", up to 1,000 per search                          | Everyone whose location says Pakistan or one of 15 cities, with no cap, plus anyone who registers by issue |
| What happens when a search misses you | You were deleted                                                                       | You are kept; removal needs two misses at least 20 hours apart, and a short search removes nobody          |
| How API calls are spent               | 4 calls per candidate, 94% on people who fail again                                    | One cheap events check first; the full fetch only for the ~6–12% who pass                                  |
| How scores are computed               | Two copies of the formula that disagreed; no published score could be recomputed       | One model in `src/model/`, versioned; CI recomputes every published score                                  |
| What a visitor downloads              | 400 KB on every tab switch                                                             | 47 KB once (`board.json`), detail files on demand                                                          |
| Batch sizes                           | Hand-tuned for the old search cap: 1,087 to 3,724 candidates                           | Cut from measured counts: 1,240 to 1,640 (915 for the newest)                                              |
| The activity window                   | The events feed, capped at 300 events: a busy developer is judged on days, not a month | Unchanged for now; the next model's inputs are measured on every row, scored by nothing, until 7B          |

## 01. What was broken

Most failures shared one cause: a single hourly script searched, fetched, filtered, scored and
committed a 1.6 MB file to `main`, 24 times a day, and each job inherited the others' failures.

| #   | Failure                                                 | Evidence                                                                                                                                                             | Fixed by                           |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| F1  | The pipeline stalled for eight days and nobody was told | Run 37313510144, stuck at the `github-pages` environment gate, held the concurrency lock; 190 later runs were displaced as `cancelled`, which GitHub does not report | #106, #107                         |
| F2  | Missing from search meant deleted from the board        | 914 wrongful removals in 91 days, 11 from the top 10, including rank 1                                                                                               | #108, #119                         |
| F3  | Discovery could not see everyone                        | 13 of 26 search queries hit GitHub's 1,000-result cap: 1,172 people unreachable, all at the low-follower end                                                         | #115                               |
| F4  | City-only profiles were invisible                       | `location:pakistan` matches whole words; 9,939 people named only a Pakistani city or region                                                                          | #123                               |
| F5  | Busy developers are measured over days, not a month     | The events feed stops at 300 events; for one top-30 developer that covered 6 of 30 days                                                                              | 7A measures it (#129); 7B fixes it |
| F6  | Raw totals are easy to farm                             | 1,031,007 commits in 30 days to an own zero-star repo (ranked #91); 1,080 self-merged PRs in 30 days                                                                 | 7B                                 |
| F7  | Almost all API spend was wasted                         | 4.04 REST calls per candidate; 94% on people who fail the gate again                                                                                                 | #112                               |
| F8  | Complete discovery did not fit the budget               | 26,002 candidates needed about 105k REST calls a day                                                                                                                 | #112, #115                         |
| F9  | No published score could be recomputed                  | 0 of 1,000 rows reproduced; no model version; 824 ties ordered by an unspecified comparison                                                                          | #113                               |
| F10 | The browser downloaded the same file repeatedly         | 400 KB per fetch, again on every tab switch                                                                                                                          | #109, #114                         |
| F11 | Git was used as a database                              | `data.json` was 98.4% of the repository; clones 295 MB, growing 60–86 MB a month                                                                                     | #117, #121                         |
| F12 | The site showed invented facts                          | Job titles, "14m ago" times, "Uptime 99.9%", a GraphQL API that does not exist, `LIVE_SYNC` through the outage                                                       | #109, #110                         |
| F13 | Registration had done nothing since March               | It saved to the visitor's browser and said `NODE_ACCEPTED`                                                                                                           | #110, #124                         |
| F14 | The working notes described code that does not exist    | Of 116 claims in the local notes, 24 held                                                                                                                            | Local note only                    |

## 02. Principles

Each rule is the opposite of a failure above.

1. **Absence is not evidence** (F2). Not appearing in a search, a failed fetch or a degraded page
   changes nobody's membership. Only a successful direct observation can.
2. **Look before you fetch** (F3, F7, F8). Check a candidate with one cheap request before spending
   four.
3. **A measurement is a dated fact** (F5, F9). Every row says when it was measured and under which
   model. A failed measurement keeps its date and is never replaced by a different source.
4. **One model, one place, versioned** (F9). Pipeline and browser read the same module; every
   published score recomputes from published inputs.
5. **Publish the whole board at once** (F2). One deployer publishes the full board, rebuilt from saved
   state on every run.
6. **Generated data is not source code** (F10, F11). It does not live in `main`'s history, and visitors
   download only what the page shows.
7. **Nothing claims what it does not check** (F1, F12). Freshness and health are computed, never
   asserted.
8. **Volume is not work** (F6). No raw count is scored without limits per repository and per day.
   Automation is published as a flag, never scored on a timing rule.

## 03. The design as built

Measurement stays in 24 hourly slices: a full sweep costs about 28k REST calls and the token allows
5,000 an hour. What changed is everything around the slice.

```
 Worker cron :00 ──▶ update-digest.yml ─┬─ load board from the pipeline-state release
 Worker cron :35 ──▶ pipeline-backup.yml│  read registrations and opt-outs (issues)
   (starts the pipeline only if no run  │  discover this batch's range (main search + city twin)
    covered the hour) and watchdog.yml  │  screen on events page 1; fetch in full only who passes
                                        │  score with src/model/; record shadow inputs
                                        │  merge by row owner; guard; save a new state asset
                                        └─ dispatch deploy.yml (the only Pages deployer) + watchdog
 cron-job.org ──▶ GET /api/health (no token) ──▶ email the owner when the board is over 4 h old
```

### Discover (#115, #119, #123, #124, #128)

- GraphQL `search` counts and lists on GraphQL points, never the 30-a-minute REST search limit.
- Each batch's `created:` range splits itself until every leaf lists in one request, sorted by join
  date (a total order). A leaf counts only if provably complete, and the leaves must add up to the
  range's count. A short sum counts as incomplete discovery: miss counters freeze and nobody is
  removed.
- Each range is searched twice: `location:pakistan`, and its **city twin** naming 15 unambiguous
  Pakistani cities with `-location:pakistan`. City-found developers whose fetched location also
  names a foreign place are rejected.
- The 24 ranges are cut from measured counts by `scripts/discovery/rebalance.js` (1,240–1,640
  candidates each on 13 October). Every row's owning batch is re-derived from its `created_at` on
  load, so the table can be recut at any time.
- Registration and opt-out are GitHub issues keyed on the author's numeric account id. Opt-outs
  apply on every run; a run that cannot read them publishes nothing.

### Screen and measure (#112, #129)

- Events page 1 first. A feed under 100 events is complete, so the gate's answer is exact; a full
  first page is always forwarded. On a real batch 806 of 829 candidates were rejected on that page,
  none wrongly. REST spend fell from about 100k a day to about 31k.
- Every published row also carries `shadow_contributions` (the 60-day calendar, per-repository
  per-day commits, PRs merged by others, private counts as context, a PR-timing signal as context)
  and `events_window`. They score nothing, live in the state, and are stripped from everything the
  site serves.

### Score (#113)

- `src/model/` is the only implementation; config is validated and throws on a missing key.
- Every row records `model_version`, `score_exact`, `activity_score` and `scored_at`;
  `npm run verify:published` recomputes them all in CI and before every save.
- Order: `score_exact`, then the username by code point.

### Merge, guard and publish (#108, #117, #119, #121)

- A row is removed only when this run fetched that developer and they failed the gate, after two
  misses at least 20 hours apart, after 7 days unmeasured, below the 1,000 cap, or on opt-out. Every
  removal is logged with its reason; the guard refuses a board that loses more than 5% without one.
- State: one gzipped snapshot per run on the `pipeline-state` release (about 400 KB), the newest 72
  kept, read back byte for byte after every save. Each run also records `batch_runs`, when each batch
  last ran.
- `deploy.yml` is the only workflow that deploys Pages. It builds `board.json` (47 KB gzipped),
  `dev/<login>.json` and `digest.json`, and serves `data.json` without the pipeline-only fields.

### Clock and watch (#107, #116, #118, #120, #122, #125, #127)

- **Clock:** the Cloudflare Worker's crons. GitHub's own scheduler is not relied on: no `schedule`
  trigger fired in this repository from 2026-04-03 until 19:52 UTC on 2026-10-13, when the
  watchdog's `:17` slot ran 35 minutes late. The Worker holds the only dispatch token, a
  fine-grained one for this repository with Actions read and write.
- **Watchdog:** checks the live site's age, every batch's last run, stuck and cancelled runs, and
  that the pipeline and backup workflows are enabled. It keeps one self-closing issue; only new
  trouble comments on it or fails the run.
- **Outside monitor:** cron-job.org requests `/api/health` hourly. It answers 503 once the board is
  more than 4 hours old, and cron-job.org emails the owner. It holds no credentials.

## 04. Order of work

Each step left the site working and shipped on its own.

| Step | What                                                                                                  | PRs                                |
| ---- | ----------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 0    | Unwedge the lock, add the watchdog, stop deleting the missed, load data once, remove invented content | #106 #107 #108 #109 #110           |
| 1    | Screen on events page 1 inside the existing loop                                                      | #112                               |
| 2    | One scoring model, versioned and recomputable                                                         | #113                               |
| 3    | Complete discovery on GraphQL, self-splitting ranges                                                  | #115 #119                          |
| 4    | State on a release; rebuild and deploy the whole board each run; `data.json` off `main`               | #117 #121                          |
| 5    | Small files for the browser                                                                           | #114                               |
| 6    | City-only profiles; registration and opt-out by issue                                                 | #123 #124                          |
| 7A   | Shadow measurement of the next model's inputs                                                         | #129                               |
| 7B   | Contributions-based scoring, as scoring v3 ([scoring.md](scoring.md))                                 | #136 #137 #138 #139 and the switch |
| Ops  | Backup trigger, Worker clock and health, rebalanced batches, watchdog wording                         | #116 #118 #120 #122 #125 #127 #128 |

## 05. Budget, before and after

The Actions token's allowance, read from GitHub's response headers, is 5,000 REST calls and 5,000
GraphQL points an hour.

| Measure                     | Before                       | After                                                                            |
| --------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| REST calls a day            | ~102–105k (85–88%)           | ~31k measured before cities; about 41k with them                                 |
| REST search calls a day     | ~250, with rate-limit stalls | 0                                                                                |
| GraphQL points a day        | ~1–1.5k                      | about 1k: 20–75 a batch for both searches' discovery, plus 3–5 for shadow inputs |
| Pipeline run                | 25–95 min                    | ~10–16 min (the old 2025+ batch took 61 min before #128)                         |
| Data per visit              | 400.8 KB per tab switch      | 47 KB first load                                                                 |
| Repository growth from data | 60–86 MB a month             | 0                                                                                |

## 06. Decisions

The owner handed these over on 13 October 2026.

| #   | Decision                                 | Taken                                                                                             |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| D1  | Merge #108 and #107                      | Merged; #119 later required misses at least 20 hours apart                                        |
| D2  | Merge #109, then #110                    | Merged                                                                                            |
| D3  | Merge #105 (a shard split)               | Closed with thanks, superseded by #115                                                            |
| D4  | Build the screen first                   | #112                                                                                              |
| D5  | Revoke the token pasted on 2026-09-27    | Revoked; it returns 401                                                                           |
| D6  | Accept city-only profiles                | 15 unambiguous cities; Hyderabad, Punjab, Kashmir, Mirpur and Gujrat stay out (#123)              |
| D7  | Keep the `repos>3 followers>1` prefilter | Kept; dropping it multiplies candidates 4.6 times                                                 |
| D8  | How volume scores                        | Limits per repository and per day, chosen in 7B from the shadow data                              |
| D9  | Private contributions                    | Context only, never scored                                                                        |
| D10 | Automated activity                       | A published flag only, never scored                                                               |
| D11 | Registration and opt-out                 | Self-filed issues keyed on the author's id; a public "Remove me" issue, no private address (#124) |
| D12 | How often to publish                     | Hourly slices stay; the whole board is rebuilt from state and redeployed every run                |
| D13 | The scheduler                            | The Cloudflare Worker's crons (#125, #127); cron-job.org no longer triggers anything              |
| D14 | The outside heartbeat                    | cron-job.org polls `/api/health` with no token and emails on failure                              |
| D15 | Repository settings                      | Default workflow permission read-only; Actions cannot approve PRs                                 |
| D16 | Zero-star own-repo discount              | Measured in the shadow data before 7B decides                                                     |
| D17 | The local working notes                  | Marked as history locally, never committed                                                        |

## 07. What the review and building changed

The review checked the draft against the evidence before anything was built:

| Draft said                                                    | Corrected                                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 999 of 1,000 rows cannot be recomputed                        | 1,000 of 1,000                                                                               |
| A 60-second PR-gap rule flags 3 farms with no false positives | 4 accounts fall under it, and a known farm sits at 182 s, so timing is a flag, never a score |
| 34.4k candidates with cities                                  | 35,941                                                                                       |
| The events screen has no false negatives                      | Only for feeds under 100 events; full first pages are forwarded                              |
| A seven-day shadow run beside the old pipeline is safe        | It would exceed the shared token's daily limit; the screen went into the old loop first      |

Building it then corrected the design itself, each found in a production run or a test:

| Design said                                           | Found while building                                                                                                                                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One or two full runs a day                            | A full sweep costs about 28k REST calls against 5,000 an hour; slices stay hourly                                                                                                                                                   |
| State on a protected `data` branch                    | A branch only moves the clone bloat; state is a release asset                                                                                                                                                                       |
| A range's leaves always sum to its count              | Production batch 19 listed 945 of 1,026 under the Actions token; a short sum now freezes counters (#119)                                                                                                                            |
| Two consecutive misses remove someone                 | Two runs can be minutes apart; misses must be 20 hours apart (#119)                                                                                                                                                                 |
| Nothing else used the leaked token                    | cron-job.org did; its dispatches stopped when it was revoked                                                                                                                                                                        |
| GitHub schedules can back up an external trigger      | None fired from April to the evening of 13 October; the clock moved to Cloudflare (#125, #127)                                                                                                                                      |
| Cancelling a stuck deploy is safe                     | It released an old-code deploy queued behind it, which republished an older board; always redeploy and check `last_updated` after                                                                                                   |
| Hand-tuned batch ranges are fine once the cap is gone | The 2025+ batch grew to 3,724 candidates and took an hour; ranges are now cut from counts (#128)                                                                                                                                    |
| The shadow blocks can ride in `data.json`             | They would add 41% to a file the Worker parses on a per-request CPU budget; they stay in state (#129)                                                                                                                               |
| A watchdog that fails on every alarm is enough        | During a day-long recovery it would email twice an hour; only new trouble fails it now                                                                                                                                              |
| A new Cloudflare cron starts within 15 minutes        | On 2026-10-13 a Cloudflare incident ("Workers - Cron Trigger Activation Issues", opened 15:18 UTC) kept the new `:00` trigger from firing at 19:00 and 20:00; the `:35` backup started the missed 19:00 batch at 19:35, as designed |

Designed but not built: keeping previous logins so `rankistan.dev/#oldname` badge links survive a
rename.

## Operating it

- **Board snapshot:** `npm run state:pull` downloads the latest board to `public/data.json`, no token
  needed.
- **Rollback:** revert #121, run `node scripts/state-store.js restore`, and commit `public/data.json`.
- **Recut the batches:** `MY_GITHUB_PAT=… node scripts/discovery/rebalance.js`, paste the printed
  `BATCH_RANGES` into `scripts/discovery/batches.js`.
- **Deploy the Worker:** from a clean checkout of `main`, run
  `npx wrangler deploy --config cloudflare/wrangler.toml`. New cron triggers take up to 15 minutes to
  start firing.
- **After cancelling a stuck run:** list every run that isn't completed, redeploy with
  `gh workflow run deploy.yml --ref main`, and check that `rankistan.dev/data.json`'s `last_updated`
  matches the newest state.
