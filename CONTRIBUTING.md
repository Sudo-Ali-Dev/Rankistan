# Contributing to Rankistan

Thanks for helping out. This file exists because the repo had no contributor
docs at all, which is the main reason PRs here have tended to grow large and
sit unmerged.

## Setup

```bash
git clone https://github.com/Sudo-Ali-Dev/Rankistan.git
cd Rankistan
npm install
npm run dev
```

That is all you need for **frontend work**. The first `npm run dev` downloads
the latest board to `public/data.json` (`npm run state:pull` refreshes it), and
no token is required.

For **pipeline work** (`scripts/`), copy `.env.example` to `.env` and set
`MY_GITHUB_PAT`. Only public data is read, so a token with no scopes is enough —
never grant write scopes. To avoid needing a token at all, use the dry run:

```bash
node scripts/run-all.js --incremental 0 --dry-run
```

Node 20 is expected (`.nvmrc`, `engines` in `package.json`).

## Before you open a PR

```bash
npm run lint          # must pass with 0 errors
npm test              # must pass
npm run build         # must succeed
npm run verify:activity   # if you touched scoring helpers
```

CI runs all of these on every PR, plus a pipeline dry run.

## Formatting

Prettier config lives in `.prettierrc.json`, editor defaults in
`.editorconfig`. Format only the files you touch:

```bash
npx prettier --write path/to/file.jsx
```

**Do not run `npm run format` across the whole repo.** It would rewrite ~41
files and bury your actual change in noise. A repo-wide sweep is planned as its
own separate commit once the current PR queue is clear.

Lint rules to know about:

- `jsx-a11y` rules and `react-hooks/set-state-in-effect` are set to **warn**,
  not error. There is a pre-existing backlog of both; CI does not block on
  them. Please don't add new ones, and fixing nearby ones is welcome.
- `no-unused-vars` and the rest of `eslint:recommended` **are** errors.

## Scope your PR to one concern

This is the single most useful thing you can do. Two open PRs in this repo
bundle three to five unrelated features across 8–21 files, and both have been
unmergeable for over three months as a result. A small PR that does one thing
gets reviewed and merged quickly.

If you have several ideas, open several PRs. If a change turns out to need a
refactor first, say so in an issue before writing the code.

## Commit messages

Conventional Commits, as used in most of the history:

```
feat(leaderboard): add jump-to-page input
fix(worker): validate username before the leaderboard lookup
chore(deps): bump vite to 8.2.2
docs: document MY_GITHUB_PAT in the setup steps
```

Explain **why** in the body when it isn't obvious from the diff.

## Where things live

| Path | What it is |
|---|---|
| `src/` | React 19 + Vite frontend. `.jsx` components, `.js` utils, Tailwind classes inline. |
| `scripts/` | The Node data pipeline. `run-all.js` is the only entry point CI calls. |
| `cloudflare/` | Worker serving AI summaries, rank badges, and the heatmap proxy. |
| `score-config.json` | All scoring weights and caps, validated by `src/model/config.js`. Change it here, never inline. |
| `public/data.json` | Not in git. The board lives on the `pipeline-state` release; `npm run state:pull` downloads it here. |
| `fixtures/data.sample.json` | A 50-row sample of the board. CI builds, verifies and dry-runs against it, never against live data. |

## Things worth knowing before you touch them

- **The board is pipeline state, not a file in git.** Each pipeline run loads
  it from the `pipeline-state` release, merges one batch, saves it back, and
  dispatches `deploy.yml`, the only workflow that deploys Pages. See
  `scripts/state-store.js` and the README's "Where the Board Lives".
- **The scoring model exists once, in `src/model/`.** The pipeline, the board
  check and the Worker's score preview all call it, and none does any
  arithmetic of its own. Every constant in `score-config.json` carries its
  derivation, and the validator refuses one without. If a change can move any
  developer's score, bump the major `MODEL_VERSION` (the rule is written beside
  it) and add a dated entry to `src/pages/Evolution.jsx`. Every run scores the
  whole board again from its measurements, so the change reaches every row at
  once. The design record is `docs/scoring.md`.
- **Worker changes need a deploy.** `npm run cf:deploy` is a separate step from
  merging; a merged PR does not update the Worker.
- **`update-digest.yml` is dispatched by the Cloudflare Worker's cron** by filename
  (`cloudflare/scheduled.js`). Do
  not rename that workflow, and do not give it a `schedule`: GitHub disables a
  scheduled workflow after 60 days without repository activity, and a disabled
  workflow cannot be dispatched. The backup, `pipeline-backup.yml`, dispatches
  it at `:35` when no dispatched run covers the hour (`scripts/should-run.js`).

## Reporting bugs

Use the issue templates. For anything security-sensitive, see
[SECURITY.md](SECURITY.md) instead of opening a public issue.
