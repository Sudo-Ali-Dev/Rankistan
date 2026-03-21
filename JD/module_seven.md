# Module 7 — groq.js (Frontend)

**Responsibility:** Generate a short AI-written developer summary when a user clicks a dev profile card. Call Groq API in the browser with the developer's data, validate the response, and return the summary string. Cache the result in module-level session state so repeated profile opens do not trigger duplicate API calls.

**Runs in:** Browser only. Triggered lazily — only when a user clicks a dev profile card.

**Does not run on page load.** Does not block rendering. Does not interact with localStorage (Module 5 explicitly excludes dev summaries from persistent caching).

---

## When It Runs

```
User clicks dev profile card
     ↓
Calling React component sets isLoading: true
     ↓
Module 7 called with dev object
     ↓
Check session cache — has this username been summarised before?
     ↓ Yes                              ↓ No
Return cached value             Call Groq API
(string or "error")             Validate response
                                Store in session cache
                                Return summary string or "error"
     ↓
Calling React component sets isLoading: false
Renders based on returned value
```

**Loading state is managed by the calling React component** — not by Module 7. Module 7 is an async function that always resolves to either a valid summary string or the literal string `"error"`. It never returns `null` or manages UI state directly.

---

## API Key

```
Key:      REACT_APP_GROQ_KEY
Source:   Baked into React JS bundle at build time via GitHub Secrets
Risk:     Visible in browser DevTools — accepted risk because this is Groq free tier only
Limit:    Groq free tier rate limits apply — see rate limit handling below
```

**Accepted risk documentation:** The key is intentionally exposed client-side. It is Groq free tier — no billing risk. If the key is abused, rotate it via GitHub Secrets and redeploy. Do not use a paid Groq key here.

---

## Session Cache

Dev summaries are cached in a plain JavaScript `Map` object held in module-level scope. This persists for the lifetime of the browser session (page open) but is cleared on refresh — consistent with Module 5's explicit exclusion of summaries from localStorage.

```javascript
const summaryCache = new Map();
// key: username (string)
// value: summary string | "error"
```

Storing `"error"` as the value for a failed summary prevents re-calling Groq on every click for a dev whose summary failed. The UI shows a fallback message instead of retrying.

---

## Input

Receives a single developer object from the leaderboard. Only these fields are used to build the prompt:

```json
{
  "username": "example-dev",
  "name": "Ahmed Khan",
  "top_repos": [
    { "name": "llm-urdu-nlp", "description": "A language model for Urdu NLP tasks", "language": "Python" },
    { "name": "react-dashboard", "description": "Admin dashboard built with React", "language": "JavaScript" }
  ],
  "top_languages": ["Python", "JavaScript"],
  "total_stars": 890,
  "events_30d": 67,
  "followers": 340,
  "location": "Lahore"
}
```

All fields are confirmed present in `data.json` as written by Module 4.

---

## Step 1 — Guard: Validate Username

Before anything else, check that `dev.username` is a non-empty string:

```javascript
if (!dev.username || typeof dev.username !== "string") {
  console.warn("Module 7: dev.username is missing — aborting summary call");
  return "error";
}
```

If missing — return `"error"` immediately. Do not proceed. This prevents `summaryCache.has(undefined)` collisions where multiple devs with missing usernames share the same broken cache slot.

---

## Step 2 — Check Session Cache

```javascript
if (summaryCache.has(dev.username)) {
  return summaryCache.get(dev.username);
}
```

If found — return immediately. No Groq call made. The value is either a valid summary string or `"error"` from a previous failed attempt.

---

## Step 3 — Build Prompt

**System prompt:**
```
You are writing a brief developer profile summary.
Write exactly 2 sentences describing this developer based on their GitHub activity.
Be specific — mention their main technologies and what kind of projects they build.
Do not use bullet points. Do not start with "This developer". Write in third person.
```

**User message:**
```
Developer: {name} (@{username}) from {location}
Top languages: {top_languages joined by ", "}
Total stars: {total_stars}
Recent activity (last 30 days): {events_30d} events
Top projects:
{top_repos formatted as: "- repo_name: description (language)"}
```

**Null safety in prompt building:**
- If `name` is null → use `@{username}`
- If `location` is null → omit location line entirely
- If `top_languages` is empty or null → write `"Not specified"`
- If `top_repos` is empty or null → write `"No public repos"`
- If a repo `description` is null → show `"- repo_name (language)"` without description

---

## Step 4 — Call Groq API

```
Model:       llama-3.3-70b-versatile
Max tokens:  120
Temperature: 0.5
API key:     REACT_APP_GROQ_KEY
Timeout:     15 seconds
```

**Why max_tokens: 120:** A 2-sentence summary fits comfortably in 80-100 tokens. Capping at 120 prevents Groq from returning a paragraph while leaving a small buffer.

**Why temperature 0.5:** Lower than Module 3's 0.7 — dev summaries should be factual and consistent, not creative.

**Guard — missing API key:** Before calling, check `REACT_APP_GROQ_KEY` is present:
```javascript
if (!process.env.REACT_APP_GROQ_KEY) {
  console.warn("Module 7: REACT_APP_GROQ_KEY is missing from build");
  summaryCache.set(dev.username, "error");
  return "error";
}
```

**Unified retry policy:** One retry attempt per click — same policy as Module 3.

```
attempt 1 → if fails for any reason → wait 3s → attempt 2
attempt 2 → if fails for any reason → store "error" in session cache → return "error"
```

---

## Step 5 — Validate Response

Before accepting the Groq response:

- Must be a non-empty string
- Must be at least 30 characters
- Must not start with apology phrases: `"I'm sorry"`, `"I cannot"`, `"As an AI"`
- If longer than 400 characters → truncate using sentence boundary rule (see below)

If any check fails (except truncation) — counts as a failed attempt and triggers the retry policy from Step 4.

### Truncation Rule (>400 characters)

```
1. Take the substring up to and including character 400
2. Find the last occurrence of ". " (period + space) within that substring
3. If found → truncate at that position (keep the period, discard everything after)
4. If not found → truncate at character 400 and append "..."
```

This avoids splitting on periods inside URLs (`github.com/user/repo`), abbreviations (`e.g.`), or decimal numbers (`3.5`) since those are not followed by a space.

---

## Step 6 — Store in Session Cache and Return

```javascript
summaryCache.set(dev.username, validatedSummary);
return validatedSummary;
```

---

## Output

Module 7 always resolves to one of two values:

| Value | UI Behaviour |
|---|---|
| Summary string (30–400 chars) | Calling component renders summary text on profile card |
| `"error"` (literal string) | Calling component renders fallback: `"Summary unavailable"` — does not retry |

**Loading state** is managed entirely by the calling React component — set `isLoading: true` before calling Module 7, set `isLoading: false` in the `.then()` or `await` resolution. Module 7 never returns `null` and never manages loading state.

---

## Rate Limit Awareness

Groq free tier has per-minute rate limits on requests and tokens. Worst case: if multiple users open profile cards simultaneously, multiple Groq calls fire at once.

Mitigation: The session cache ensures each username is only called once per session. Repeated clicks on the same profile never trigger a new call.

If Groq returns a 429 (rate limit), the unified retry policy handles it — wait 3s then retry once. If still 429 on retry, store `"error"` and return error state.

---

## Error Handling Summary

| Scenario | Behaviour |
|---|---|
| `dev.username` is null or missing | Return `"error"` immediately — do not proceed |
| Username already in session cache | Return cached value immediately — no Groq call |
| `REACT_APP_GROQ_KEY` missing from build | Store `"error"` in cache, return `"error"` immediately |
| `top_repos` is null or empty | Build prompt with `"No public repos"` — still call Groq |
| `top_languages` is null or empty | Build prompt with `"Not specified"` — still call Groq |
| Groq attempt 1 fails (any reason) | Wait 3s — retry once |
| Groq attempt 2 fails (any reason) | Store `"error"` in session cache — return `"error"` |
| Response fails validation | Counts as failed attempt — triggers retry |
| Response exceeds 400 characters | Truncate at last `". "` boundary — store truncated string |
| No `". "` boundary found within 400 chars | Truncate at 400 chars and append `"..."` |
| Groq returns 429 rate limit | Handled by unified retry policy — wait 3s then retry once |