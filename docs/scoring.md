# Scoring v3 (October 2026)

How Rankistan scores a developer, rebuilt from what the site promises, which is a ranking of
active Pakistani developers by their work. This file is the record of that rebuild. It covers what
was wrong with version 2, the rules the new model follows, the model itself, every decision and
the alternatives it beat, the attacks it was tested against, who it treats how, and where building
it proved the plan wrong.

The model was designed from the live board's own measurements. An adversarial review tested the
first draft against the real board before anything was built, and its findings are folded in.
Every figure below was measured, unless it says "about".

**Status.** Shipped as release v3.0.0. Measurement (#136), model (#137), Worker preview (#138,
#139) and the switch are merged.

## In plain words, before and after

|                                     | Version 2                                                                 | Version 3                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| What decides the order              | Stars and followers (rank correlation with the score 0.63 and 0.51)       | Days of public work, and work other people accepted                                                           |
| Where activity comes from           | The events feed, 200 events, so a busy month was measured over a few days | GitHub's contributions API, keyed on dates, the whole 30 days                                                 |
| A million commits in one day        | Capped per day, but still the most a day could earn                       | One working day, the same as one commit                                                                       |
| Work someone else merged            | Not measured                                                              | Up to 400 of 1,000 points, counted per project and per person                                                 |
| Stars                               | Up to 500 points for stars on any project, active or not                  | Up to 100 points, only for a project you own and worked on this month                                         |
| Followers, repository counts        | Up to 500 and 100 points                                                  | Nothing                                                                                                       |
| New accounts                        | Halved under 180 days                                                     | Ranked from 30 days, age changes nothing after                                                                |
| Equal scores                        | Ordered by username                                                       | Share a rank, order within the tie rotates daily                                                              |
| A painted graph or a bot committing | Counted                                                                   | Excluded when the dates or the committer prove it, moderated with public evidence when only a person can tell |
| Checking a score                    | Recompute from the row's own fields                                       | Every developer's file lists the evidence item by item, and Register measures any account live                |

## 01. What was broken

| #   | Problem                                 | Evidence                                                                                                                                                                                                          |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Popularity decided the order            | Activity supplied 40.5% of all points and almost none of the order. Its rank correlation with the score was 0.17, against 0.63 for stars and 0.51 for followers. 8 of the top 10 sat at or near both caps         |
| S2  | Busy developers were measured over days | The pipeline read 200 events. 199 of 1,000 board rows were cut short, one top-30 developer's month held 6 days                                                                                                    |
| S3  | Volume could be farmed                  | One account made 1,031,238 commits in 30 days to a repository nobody had starred, 1,028,906 on a single day. Another opened 1,107 pull requests in its own repositories, 27 seconds apart at the median           |
| S4  | Paid and scripted activity counted      | Two board accounts pay a "paint your graph" service whose commits carry author dates up to 21.8 hours after their commit dates. A GitHub Action commits daily in another account's name, 20 of 20 sampled commits |
| S5  | Work others accepted was invisible      | The events feed has no event for a pull request someone else merged. 146 board developers had pull requests merged by someone else in repositories they did not own, and none of it scored                        |
| S6  | The claim and the formula disagreed     | The site says "No vanity metrics. Just code." Stars and followers could add 1,000 points                                                                                                                          |
| S7  | Students were penalised for their age   | Accounts under 180 days had their whole score halved. The farms above are old accounts                                                                                                                            |

## 02. Principles

1. **Count what a person did, not how much they typed.** A day counts once.
2. **Weight what one account cannot produce alone.** Work another person accepted is the strongest
   evidence, and the only kind a script cannot make by itself.
3. **Bound everything a script can max.** Work is at most half the score.
4. **Exclude on proof, not on suspicion.** Impossible dates and bot committers are facts. Cadence is
   a suspicion, and only a person may act on it, in public.
5. **No rule an honest person pays for and a cheater skips.** A zero-star discount is defeated by one
   self-star and would only cost students.
6. **Every number explained.** Each constant carries its derivation in `score-config.json`, and
   the validator refuses one without.
7. **Pure and recomputable.** The score is a function of the measurement and the moderation list
   alone, with no clock, and the evidence is published with it.
8. **One model on the board.** Every run scores the whole board again from its measurements.

## 03. The model

```
score = 1000 × (0.5 × work + 0.4 × collaboration + 0.1 × appreciation)
```

The window is the 30 Pakistan dates (UTC+5) before the measurement. Commits keep GitHub's own date,
which is the commit's own time zone. Pull requests, issues, reviews and merges take the Pakistan
date of their instant. Recent days weigh more, yesterday 1 falling evenly to 0.5 for the oldest
day.

### Work, up to 500 points

A working day is a day with at least one of

- a commit to a repository that is not a fork and not a profile README repository, anyone's
- a pull request opened in someone else's repository, unless it was closed without merging
- an issue opened in someone else's repository
- a review of a pull request another user wrote

```
x    = Σ recency weights of working days / Σ recency weights of all 30 days
work = 1 − (1 − x)²
```

Working half the days earns 75%. A script that commits every day gains 56 points over an honest
developer working 20 of 30 days, where a straight line would give it 167.

### Collaboration, up to 400 points

```
collaboration = c / (c + 3)
c = f × accepted + reviews + maintained
```

- **Accepted.** Your pull requests merged into a repository you do not own, by a user who is not
  you and whose account was a year old on the day of the merge. Found by search on the merge
  time, so a pull request opened before the window still counts. Each is worth
  `starWeight × size × recency`, where `starWeight = min(1, 0.1 + 0.3 × log10(1 + stars))` and a
  change of one file and at most 5 lines counts half. The merges are grouped per owner and per
  merger, each group earns `min(4, log2(1 + its total))`, and the smaller of the two sums is taken.
- **f**, the rejection factor, is `min(1, 2(M + 2) / (M + X + 4))` over your pull requests to other
  people's repositories in the window, M merged and X closed unmerged.
- **Reviews.** Reviews of pull requests by another user a year old, one per pull request, at half a
  merge, grouped per owner and per author the same way.
- **Maintained.** Other users' pull requests, by accounts a year old and never bots, merged into
  your own repositories, at half a merge, grouped per author. Merging is not a contribution type
  on GitHub, and this is how maintainers are credited.

Three merges into well-known projects by three different people this week earn half the
collaboration points.

### Appreciation, up to 100 points

The best project you own, with commits this month, that is not a fork, a profile repository or
excluded. Nothing below 10 stars, then a third of the points for every tenfold, full at 10,000. It
counts in full once worked on for 4 days this month.

### What never counts

Commits from forks, from profile README repositories, from repositories holding commits dated two
or more days after the measurement, from repositories whose sampled author dates run more than 6
hours past their commit dates or past the moment they were read, from repositories where half the
sampled commits were committed by a bot in the developer's name, and from repositories on the
moderation list (`public/moderation.json`). Private contributions are recorded as context and
never scored.

### Eligibility and ranks

At least 4 working days in the window, and an account at least 30 days old. Followers and
repository counts are no longer checked for registered developers. The board ranks on the
unrounded score, equal scores share a rank, the order within a tie rotates daily by a hash of the
account id and the board's date, and a tie is never split at the 1,000 limit.

## 04. Decisions

| #   | Decision                                                                                      | Rejected                                                                                                                                                                                                                           | Why                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Count days, not commits                                                                       | Log volume per repository and day with caps, which rewards spreading over repositories. Commit volume as a tie-break, which would put the 11,201-commit painter first in its tie                                                   | Commit counts depend on workflow and cost nothing to inflate                                                                                                                                                       |
| D2  | A concave work curve                                                                          | A straight line                                                                                                                                                                                                                    | Automation can always max work, so perfect attendance must be worth little over regular work                                                                                                                       |
| D3  | Recency weights from 1 to 0.5                                                                 | A flat window, whose leaving day is a cliff and which leaves hundreds of ties. A triangle to 0, where one week off costs 41% of work                                                                                               | Smooth daily movement and an emphasis on now                                                                                                                                                                       |
| D4  | Stars at 10%, digit-scaled, from 10 stars, on active own projects only                        | 20% saturating, where 100 bought stars added 100 points. No stars at all                                                                                                                                                           | Stars are the only sign people value what you build, and fit the promise of top developers. Buying is harder in Pakistan, and digits from 10 make a ring of 20 worth about 10 points. Revisit with star-spike data |
| D5  | Acceptance needs another user a year old, weighted by stars, counted per owner and per merger | An age rule on the owner too, dropped while building because it cut a real 7-month-old project and stopped nothing a year-old merger did not. A hard 10-star gate, which the Digest showed discards the population worth reporting | Fresh second accounts and free organisations earn nothing                                                                                                                                                          |
| D6  | Merges keyed on the merge instant, by search                                                  | `pullRequestContributions`, keyed on when a pull request was opened                                                                                                                                                                | A known trap in this repository, a long-reviewed pull request would never count                                                                                                                                    |
| D7  | A rejection factor on closed unmerged pull requests                                           | Ignoring rejections. A timing rule, beaten with `sleep 61`, which also missed a known farm at 182 seconds                                                                                                                          | Shrinks in proportion, and a prior of 2 lets a few rejections cost nothing                                                                                                                                         |
| D8  | Reviews only of other users' pull requests, one per pull request                              | Every review contribution                                                                                                                                                                                                          | GitHub counts comment reviews on your own pull requests, all 122 reviews on one test batch were self reviews                                                                                                       |
| D9  | Credit for merges into your own projects                                                      | Nothing for maintainers                                                                                                                                                                                                            | Merging is not a contribution type, one search per developer bounded per author                                                                                                                                    |
| D10 | Exclusions on impossible dates, bot committers, profile repositories and forks                | Cadence or timing rules                                                                                                                                                                                                            | Logically impossible states and identity facts, not guesses                                                                                                                                                        |
| D11 | A public moderation list for scripts that commit as the developer, per repository             | Public automatic flags, which label an honest daily developer a bot. Ignoring it                                                                                                                                                   | Only a person can tell a script from a person, and excluding the repository keeps the developer's other work                                                                                                       |
| D12 | No new-account penalty, an age rule on the other party instead                                | Halving under 180 days                                                                                                                                                                                                             | An account's age says nothing about its work                                                                                                                                                                       |
| D13 | Private work recorded, never scored                                                           | Counting the calendar's private days                                                                                                                                                                                               | Unverifiable, opt-in, and impossible to check for farming                                                                                                                                                          |
| D14 | Shared ranks, a daily rotation within a tie, no tie split at the limit                        | The alphabet, account age                                                                                                                                                                                                          | Honest about equality, neutral within it                                                                                                                                                                           |
| D15 | Fixed references, not percentiles                                                             | Normalising against the cohort                                                                                                                                                                                                     | A score depends only on its own evidence and can be recomputed alone                                                                                                                                               |
| D16 | Screen on the contribution calendar, gate on public working days                              | The events screen, which misses developers whose work is all reviews                                                                                                                                                               | The calendar bounds public days from above, so 2 calendar days in 32 rejects nobody the 4-day gate would admit                                                                                                     |
| D17 | A first-seen day ledger deferred                                                              | Building it now                                                                                                                                                                                                                    | Local work pushed later arrives late too. Measure late arrival first, the integrity checks already catch the painter on the board                                                                                  |

## 05. Attacks and their bounds

| Attack                                                                             | Under version 3                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A million commits a day, self-merged pull request floods, own-repo issues          | One working day each                                                                             |
| A painted graph, author dates in the future                                        | The repository is excluded                                                                       |
| A GitHub Action committing in your name                                            | Excluded                                                                                         |
| A script committing as you every day                                               | At most the full work score of 500, and removable through the moderation list                    |
| Commits to someone else's profile repository                                       | Excluded                                                                                         |
| Commits dated in the future                                                        | The future probe excludes the repository                                                         |
| Organisations you made, a fresh second account or a bot merging your pull requests | Nothing, the merger must be another user a year old, and counted per merger                      |
| Friends merging into their unstarred repositories                                  | 0.1 per merge, bounded per person                                                                |
| Hacktoberfest or AI-generated pull request sprays                                  | Unmerged ones earn nothing, rejections shrink the credit, tiny ones count half, and it saturates |
| Listing and registry repositories                                                  | Tiny changes count half, bounded per owner                                                       |
| Reviewing your own, a bot's, or a fresh account's pull requests                    | Nothing                                                                                          |
| Star rings and bought stars                                                        | Nothing below 10, then about 33 points per tenfold to 100, only on projects you work on now      |
| Renames, re-registering                                                            | Measurement is keyed on the account id                                                           |

Accepted, because they cost more than they earn or only a person can judge them. A patient ring of
real year-old accounts. Maintainers merging AI-assisted micro pull requests, where the maintainers
are the filter. Co-author credit. A day either way at time-zone edges.

## 06. Fairness

- **Students working in their own repositories** are treated as anyone else. A day of work is a day
  of work, whether or not anyone has starred the repository.
- **Developers whose work is private** score lower, because nobody outside can check private work.
  The page says so plainly.
- **Maintainers of organisation projects** earn collaboration through reviews and merges.
  Appreciation counts only repositories owned by the developer's own account, a known limit.
- **Contributors with no repositories of their own** are measured on their work elsewhere, and a
  registered developer is no longer held to search's repository and follower qualifiers.
- **Commits from an email not linked to the account, and branch work until it is merged,** are not
  contributions on GitHub, so they are not here either.

## 07. Measured on the live board

Measured on 16 October 2026, the whole board in one sitting before the switch. 997 of the 1,000
rows were measured with 694 rate-limit points. The other three are two accounts GitHub no longer
finds and a stale duplicate of a developer who changed their login.

| Figure                                      | Measured                                               |
| ------------------------------------------- | ------------------------------------------------------ |
| Pass the gate of 4 working days             | 896 of 997                                             |
| Working days per developer                  | median 13, 90th percentile 25, 101 developers under 4  |
| Score                                       | median 364, 90th percentile 500, 99th 727, highest 815 |
| Distinct exact scores                       | 808 of 997                                             |
| Collaboration above zero                    | 208 developers                                         |
| Appreciation above zero                     | 107 developers                                         |
| Rank correlation with the version 2 score   | 0.126                                                  |
| Rank correlation with followers             | −0.056                                                 |
| Rank correlation with total stars           | −0.122                                                 |
| Rank correlation with private contributions | −0.059                                                 |

**Who moves.** 104 rows leave the board at the switch. 101 have fewer than 4 days of public work in
the window and 3 could not be measured. The board opens at about 896 rows and fills again as each
hourly batch admits the developers who now qualify.

- 3 of version 2's top 50 are in version 3's top 50, and 18 of its top 100 in the top 100. Among
  developers who stay, the median rank moves 255 places.
- Nine of version 2's top ten stay and land between 80 and 748. The tenth had one day of public
  commits in thirty. Its other days were commits an AI agent's account made on a schedule and a
  pull request with the same title opened in its own repository every morning, which version 2
  counted as 159 events.
- Of the other four from version 2's top 50 who leave, three had two or three public working days
  and one did the whole month's work in private repositories, which nobody outside can check.
- The top ten all worked on 15 or more of the 30 days and had between 7 and 66 pull requests merged
  by other people. Stars added nothing for eight of them.

**What the integrity rules caught.** 14 repositories across 10 developers, with nobody deciding
anything. 10 hold commits dated in the future, one of them 2,030 hours past the measurement. 2 are
committed by a bot in the developer's name, 20 of 20 and 16 of 16 sampled commits. 2 belong to the
graph-painting service, with author dates 21.8 hours after their commit dates.

**What is left to a person.** 18 repositories have commits on 20 or more days at a near-constant
rate. They are listed for a moderator to check against the commits, not excluded, and none belongs
to a developer in the top 50. `public/moderation.json` starts empty.

**Collaboration.** 4,586 merges went into repositories the developer does not own, for 252
developers. 3,525 of them the developer merged themselves, which counts for nothing. 1,046 were
merged by another person, for 145 developers, and 227 of those by an account under a year old, for
25 developers. Of the pull requests they opened in others' repositories in the window, 4,526 were
merged and 448 closed without merging. Of 1,195 reviews, 395 were on the reviewer's own pull
requests and 186 on a bot's.

**Not measured yet.** How far a rank moves from one day to the next needs consecutive days of these
measurements, and is measured after the first week.

## 08. What building it changed

| The plan said                                      | Building it found                                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner's account must be a year old             | A real 7-month-old project (36 stars) merged real pull requests. A year-old merger already blocks fresh accounts, so the owner rule was dropped                                 |
| 15 developers per contributions request            | The heavier documents came back as gateway timeouts at 12 and 6 top-board developers. 5 per request, 3 per search request, 15 repositories per sample, three requests in flight |
| 50 calendars per request                           | Resource limits at about the 34th. 25 per request                                                                                                                               |
| Commit and calendar days follow the query instants | GitHub bounds commit days and calendar days by the UTC dates of the range and everything else by the instants, so the query starts at 19:00Z the day before                     |
| Review contributions are reviews of others         | GitHub counts comment reviews on your own pull requests. Each review records its pull request's author                                                                          |
| The review rule was order-independent              | The test suite caught a deduplication that depended on input order before it shipped                                                                                            |
| The future probe could start tomorrow              | A developer's own date can be a day ahead of UTC, so it starts two days after the measurement                                                                                   |
| The preview could refuse any wait                  | A heavy account's measurement needs one retry after a gateway timeout, so it waits up to 6 seconds                                                                              |

## How to change the model

1. Change the number in `score-config.json` and its derivation beside it. The validator refuses a
   constant without one.
2. Bump `MODEL_VERSION`. Major when any score can change, minor when only published fields or the
   order change, patch when nothing published changes.
3. Run the tests, including the reference implementation in `src/model/__fixtures__/`, and
   `node scripts/shadow-report.js` on a pulled state to see what moves.
4. Add a dated entry to `src/pages/Evolution.jsx`. The scoring page reads every number from the
   config and needs no edit.
5. Merge. The next run scores the whole board again from its measurements. Publish a release named
   after the version.

## Operating it

- **Moderation.** `public/moderation.json` lists repositories whose commits do not count, each with
  a reason, a github.com link to the evidence and the date added. `node scripts/shadow-report.js`
  lists near-metronome repositories for a person to check against the commits. An entry is a
  commit, and an appeal is an issue.
- **Preview.** `GET /api/score-preview/<login>` on the Worker measures any account with the
  pipeline's own code, cached per login until the Pakistan date turns over.
- **A model change that drops rows.** On a version change the save is refused if more than 2% of
  rows are unscorable or more than half fail the gate when scored again. The repository variable
  `ALLOW_RESCORE_LOSS=1` publishes anyway, and should be removed after the run it was set for.
- **Rollback.** Revert the switch on `main`, then restore the last pre-switch state with
  `node scripts/state-store.js save <file>`. Opt-outs are applied again on every run.
