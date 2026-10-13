## What does this PR do?

<!-- One or two sentences. If you need more than a short paragraph, it may be
     worth splitting into separate PRs - see CONTRIBUTING.md. -->

Closes #

## How was it verified?

<!-- Tick what you actually ran. -->

- [ ] `npm run lint` passes with 0 errors
- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] Checked in a browser (attach a screenshot for UI changes)
- [ ] `npm run verify:activity` (only if scoring helpers changed)

## Scope check

- [ ] This PR addresses **one** concern
- [ ] No generated data in the diff (the board lives on the `pipeline-state` release, not in git)
- [ ] No repo-wide reformatting mixed in with the change

## Anything reviewers should know?

<!-- Trade-offs, follow-ups, things you deliberately left out.
     If this changes the Worker, note that it needs `npm run cf:deploy`.
     If it changes scoring, say which part of MODEL_VERSION it bumps
     (the rule is beside it in score-config.json). -->
