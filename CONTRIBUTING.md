# Contributing to Rankistan

Thanks for contributing.

## Branch Strategy
- Create feature/fix branches from `main`.
- Keep PRs focused and small.
- Rebase/merge latest `main` before requesting review.

## Local Validation
```bash
npm ci
npm run lint
npm run build
```

## Coding Standards
- Follow existing React + utility style.
- Keep changes surgical and avoid unrelated refactors.
- Do not commit secrets or API keys.
- Prefer public-safe fields only in exported leaderboard data.

## Pull Request Checklist
- [ ] Problem statement is clearly described
- [ ] Changes are scoped to the problem
- [ ] Lint + build pass locally
- [ ] UI changes include screenshots (if applicable)
- [ ] Documentation is updated when behavior/config changed

## Required Checks Before Merge
Enable branch protection for `main` and require at least:
- `CI / quality`
- `Deploy to GitHub Pages / build-and-deploy` (or equivalent deploy check)
