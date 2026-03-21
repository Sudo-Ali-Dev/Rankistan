# Module 3 — generate-digest.js

**Responsibility:** Read pre-built digest repo data from `data.json`, send it to Groq, validate the response, and write a clean AI-written weekly digest to `digest.json`.

**Runs on:** Separate weekly GitHub Actions schedule — every Sunday at midnight PKT. Does NOT re-run Module 1 or make any GitHub API calls.

**Critical rule:** If anything fails, the existing `digest.json` is never overwritten. Users always see the last successful digest rather than a broken or empty page.

---

## Step 1 — Read data.json

Read `public/data.json` from the repo. This file is written daily by the leaderboard workflow and always contains `digest_repos` per developer — full metadata of repos pushed in the last 7 days, pre-computed and cross-referenced by Module 1.

Flatten `digest_repos` from all developer entries into a single array:

```
allRepos = data.json.leaderboard
  .flatMap(dev => dev.digest_repos || [])
```

**Null safety:** If a developer entry has no `digest_repos` field or it is null, treat it as an empty array — do not crash.

---

## Step 2 — Deduplicate

Deduplicate the flattened array by the **`owner/name` combination** — not by `name` alone. Two different developers can both have a repo called `my-project`. These are different repos and must not be merged.

```
uniqueKey = `${repo.owner}/${repo.name}`
```

When a duplicate `owner/name` is found, keep the entry with the higher `stars` count.

---

## Step 3 — Filter and Cap

Apply in this exact order:

1. **Remove repos with no description** — `description` is null, undefined, or empty string. Groq cannot meaningfully summarize them.
2. **Remove repos with null language** — replace `null` language with the string `"Unknown"` before this step so repos are not removed, just labeled correctly.
3. **Sort by `stars` descending**
4. **Cap at 40 repos** — sending more will exceed Groq's context budget and degrade output quality. The top 40 by stars are the most representative of the week's activity.

---

## Step 4 — Calculate `week_of` Date Range

The `week_of` string is calculated at runtime from the workflow's execution date:

```
runDate    = today (Sunday, the day the workflow runs)
weekStart  = runDate minus 6 days (Monday)
weekEnd    = runDate (Sunday)

week_of = "Month DD - Month DD, YYYY"
example = "March 14 - March 20, 2026"
```

This is always a Monday-to-Sunday range ending on the day the digest runs.

---

## Step 5 — Format the Prompt

Build a structured prompt from the filtered, capped repo list:

**System prompt:**
```
You are a tech journalist covering Pakistan's open source developer community.
Write a 250-300 word weekly digest summarizing what Pakistani developers built
this week on GitHub. Be specific — mention project names and what they do.
Group related projects by theme where possible (e.g. AI/ML, Web Tools, DevOps).
Write in an engaging, readable tone. Do not use bullet points — write in prose.
```

**User message format:**
```
Here are the repos Pakistani developers pushed to this week:

1. {owner}/{name} ({language}, ⭐{stars})
   {description}

2. {owner}/{name} ({language}, ⭐{stars})
   {description}

...up to 40 repos
```

**Null language handling:** If a repo's language is `null` after Step 3, render it as `Unknown` in the prompt string — never pass the raw string `"null"` to Groq.

---

## Step 6 — Call Groq API

```
Model:       llama-3.3-70b-versatile
Max tokens:  600
Temperature: 0.7
API key:     GROQ_API_KEY (from GitHub Secrets — never exposed to browser)
Timeout:     30 seconds
```

**Unified retry policy:** The module gets **one retry attempt** per run — regardless of why the first call failed (timeout, network error, bad response, failed validation). If the retry also fails, abort and keep existing `digest.json` untouched.

```
attempt 1 → if fails for any reason → wait 10s → attempt 2
attempt 2 → if fails for any reason → abort, keep existing digest.json, log failure
```

This prevents cascading retry storms and keeps the workflow runtime predictable.

---

## Step 7 — Validate Response

Before accepting the Groq response:

- Must be a non-empty string
- Must be at least 100 characters (guards against truncated or garbage output)
- Must not start with an apology or refusal — check for leading phrases: `"I'm sorry"`, `"I cannot"`, `"As an AI"`

If validation fails — this counts as a failed attempt and triggers the retry policy from Step 6.

---

## Output

Writes `public/digest.json` to the repo. Structure:

```json
{
  "week_of": "March 14 - March 20, 2026",
  "generated_at": "2026-03-20T19:00:00Z",
  "digest_text": "This week, Pakistani developers shipped a diverse range of...",
  "repos": [
    { "owner": "dev1", "name": "repo1", "description": "...", "language": "Python", "stars": 45, "url": "..." },
    { "owner": "dev2", "name": "repo2", "description": "...", "language": "JavaScript", "stars": 12, "url": "..." }
  ]
}
```

`repos` is the exact filtered, capped list the digest was based on — displayed as repo cards below the digest text on the frontend.

---

## Error Handling Summary

| Scenario | Behaviour |
|---|---|
| `data.json` missing or unreadable | Abort — do not overwrite `digest.json`, log error |
| `digest_repos` missing on all devs | Treat as empty — proceed to empty digest (see below) |
| All repos have no description after dedup | Skip Groq call — write `digest_text: "No new repos with descriptions this week."` and `repos: []` |
| `digest_repos` empty across all devs | Skip Groq call — write `digest_text: "No new repos this week."` and `repos: []` |
| Groq attempt 1 fails (any reason) | Wait 10s — retry once |
| Groq attempt 2 fails (any reason) | Abort — keep existing `digest.json` untouched, log failure |
| Response fails validation | Counts as a failed attempt — triggers retry policy |
| `language` is null in a repo | Render as `"Unknown"` in prompt — do not remove repo |

---

## Important Notes

**Module 3 never calls the GitHub API.** All repo data it needs is pre-computed by Module 1 and stored in `data.json`. This keeps the weekly digest workflow lightweight — one file read and one Groq call.

**One retry total — not one per failure type.** The retry budget is global per run, not per error category. This prevents multiple retries compounding into long workflow runtimes.

**`digest.json` write is atomic.** Write to `digest.json.tmp` first, then rename to `digest.json` only on success. This prevents a mid-write crash from corrupting the file the frontend reads.