# Rank History, a design for review

**Status.** Decided, and being built in the order at the end. Written on 16 October 2026 from three
design studies (the data, the look and place, and every edge case). The owner's decisions are in their
own section. Recording started on 17 October 2026 (#155, #156).

## In plain words

Every developer gets a history of where they stood on the board, one point a day. Visitors can see
where someone first appeared, how they moved, their best place, when they left the board and when
they came back. The history is honest about two things a rank on its own hides. Most of a rank's
daily movement comes from other developers, not from the developer. And ranks under different
scoring cannot be compared, so the history starts again at each scoring change instead of drawing a
line across it.

## What exists today

- **Git history of `public/data.json`.** 3,934 versions of the board from 22 March to 13 October
  2026, about 24 a day, 4,710 accounts. All of it is scoring v1 and v2. It has no model version, the
  formula changed at least four times inside it (and on 23 May one change rolled through the board
  batch by batch over a whole day, so every board that day mixes two formulas), ties were split by
  the alphabet, and most departures were pipeline bugs, not people leaving. Its ranks have a rank
  correlation of 0.163 with v3.
- **The release `pipeline-state`.** One state per hourly run. It used to keep only the newest 72,
  about three days. Since #151 it also keeps the last state of each Pakistan date for 400 days. That
  was the urgent part, because the first v3.1 boards would otherwise have been deleted around 20
  October.
- **Nothing else.** No durable history was recorded before #151.

## The unit, one point per developer per Pakistan date

A point is the developer's place on the last board saved that Pakistan date, the daily close.

- **Why daily, not every run.** Between two hourly runs, 97 to 99% of rank changes happen with the
  developer's own score identical. Each run re-measures about a twenty-fourth of the board, so an
  hourly rank mostly records the order in which other batches ran. Every developer is measured once a
  day, and the daily close holds that day's measurement for 998 to 1,000 of 1,000 rows.
- **Why the last board of the day.** It comes after all 24 batches of that date. A batch that ends
  after midnight belongs to the next date.
- **Rank, never position on the page.** The point stores the shared rank and how many share it, so
  the daily rotation inside a tie never looks like movement.
- **Keyed by account id.** Logins change and can be reclaimed by someone else. The login is only a
  label. (#152 fixed the merge so a renamed developer is one row, not two.)
- **Today is live.** Today's point always equals the rank on the board right now. It is frozen when
  the date turns.

## What a record holds

One line per day, oldest first, in one gzipped file per month.

```
{"v":1,"d":"2026-10-17","at":"<last_updated of the close>","state":"<state asset name>",
 "model":"3.1.0","moderation":104,"n":1000,"last_score":212.41,
 "batches":"111111111111111111111111",
 "cols":["id","login","rank","tie","score","work","collab","appr","days","age","flags"],
 "rows":[[1234567,"devone",1,0,773.15,495.2,267.9,10,27,0,0]],
 "out_cols":["id","login","reason","rank","score","days"],
 "out":[[123,"someone","cut",1004,211.3,9]]}
{"v":1,"d":"2026-10-25","gap":"no_state"}
```

- `rank` and `tie`, the shared rank and how many share it (0 when nobody does)
- `score`, the score before rounding to 2 decimals, and the three parts in points to 1 decimal
- `days`, active days, and `age`, days since the row was measured (0 means measured that date)
- `flags`, 1 when the row was carried after a search miss, 2 when its score changed because of
  moderation and not a new measurement
- `out`, the developers who left the board that day, with the reason and their last figures

**Reasons for leaving.**

| Reason       | When                          | What a visitor reads                    |
| ------------ | ----------------------------- | --------------------------------------- |
| `cut`        | below the 1,000 limit         | Below the top 1,000 from 3 November     |
| `below_gate` | fewer than 4 active days      | Not on the board from 3 November        |
| `moderated`  | a repository stopped counting | Not on the board from 3 November        |
| `rescored`   | a scoring change              | Left when scoring changed on 17 October |
| `not_found`  | search missed them twice      | Not on the board from 3 November        |
| `unmeasured` | not measured for 7 days       | Not measured from 3 November            |
| opted out    | asked to leave                | nothing, see below                      |

The pipeline knows each of these when it saves, with one change needed. Removals that come from
scoring the board again are labelled the same as removals judged in the batch today, so they need
their own label.

## Where it is stored

A separate release, `board-history`, a prerelease never marked latest, one asset per month,
`history-YYYY-MM-dDD-<run>-<attempt>.ndjson.gz` (DD the last day included, then the run that wrote
it). The newest two versions of each month are kept, and a read takes the newest that parses, the
same pattern the state store already uses. After an opt-out every older version of a changed month
is deleted, so no copy keeps that history.

- **Size.** About 24 KB a day gzipped, about 9 MB a year. The board, not the number of people who
  ever appeared, sets the size.
- **Writing.** The pipeline writes the day once, on the first run after the date ends, from that
  date's close. The state carries `history_through`, the last date written, so 23 of 24 runs make no
  history call at all. A failed write is retried on every later run while the close is still kept,
  and a history failure never blocks or fails the board's own save.
- **Reading.** Deploy builds one small file per developer, `history/<login>.json`, about 3.8 KB
  gzipped for a full year, fetched only when someone opens the history.
- **Rejected.** Inside `dev/<login>.json` (rebuilt from scratch every deploy, so it cannot be a
  store), one big `history.json` (one bad write loses everything), git commits (every clone grows),
  inside the state (moved 24 times a day and restoring an old state would rewind history).

## Movement

- **The arrow compares with this time yesterday**, the board saved closest to 24 hours earlier under
  the same scoring. Comparing with yesterday's final board would show almost nothing just after
  midnight and a whole day's movement by 11 at night. The chart and every summary use daily closes.
- **Every movement comes with its cause.** On real boards, a third of daily moves (and 69% in the
  top 100) happen with the developer's own score unchanged, and 12% of score rises came with a worse
  rank. So each move is split into the part the developer's own score explains (where yesterday's
  score would rank among today's other scores) and the part other developers explain. The two add up
  exactly.
- **No difference across a gap or a scoring change.** A move that spans days off the board is shown
  as two dated facts, "From 990 on 1 November to 600 today, 5 days off the board".

## Scoring changes

A new segment starts whenever the major or minor part of `model_version` changes. Nothing is
compared across a segment, no arrow, no line, no best rank, no score. On a day the scoring changed,
the board shows one line, "Scoring changed on 17 October. Ranks under different scoring cannot be
compared, so places moved show again from 18 October". The history feature itself must not bump
`MODEL_VERSION`, or it would mark a false scoring change in everyone's history. (The repository's
version rule is also inconsistent, because v3.1 changed 970 scores with a minor bump, so any change
of major or minor is treated as a cut.)

## Ties

A shared rank moving as a block is real movement, "Up 1. Shared rank 85 with 29 others". The order
inside a tie is never stored. The next rank after a tie follows competition ranking. A rank above
1,000 is never shown, because none is ever published, even when a tie at the cut makes the board
1,001 rows long.

## Leaving and coming back

Leaving and returning is common and mostly happens at the 1,000 line. In the old history half of
all developers left and came back, half of them within three days, and in the last three days of
states 75% of departures were the cut, with a median absence of about a day. So departures are
stated calmly, with the reason only when the pipeline recorded it, and a short dip at the line is
never shown as a dramatic drop. A developer who comes back is shown as back, with how long they were
away and where they were last.

## Opting out and privacy

- **Opting out deletes the history everywhere.** Every point of that account, in the monthly files,
  the per-developer files and any cache, rewritten on the next run. The release is public, so
  filtering at build time is not enough.
- **Re-registering starts a new history.** Deleted history never returns.
- **No bulk export.** A developer's history is served only in their own file, never in `data.json`,
  `board.json` or a CSV.
- **The Remove me form should say so honestly**, including that the old boards in the repository's
  git history before 13 October are outside the promise.
- **Retention.** Daily points are kept a year, and the history of someone off the board for 180 days
  is deleted. The owner left both numbers to the build on 17 October 2026, and neither can apply
  before April 2027, so their deletion is built before then.

## Moderation added or removed later

Published points stay as they were published. A marker on the date says "A repository stopped
counting here" or "It counts again from here". History is never rewritten per person, because that
would re-rank other people's past days with measurements that are not kept. The one allowed
correction is withdrawing a whole day for everyone, listed publicly with a reason, if a board should
never have been published.

## Pipeline irregularities

- **A day with no board** is a gap, "No board was published 6 to 12 October". It is not counted as
  time off the board.
- **A batch that ran twice.** The later board wins.
- **A batch that finished after midnight** belongs to the next date.
- **Dates** are Pakistan dates, labelled as such, never converted to the visitor's time zone.

## Gaming

- **Dropping off and coming back** gains nothing. Newcomers and returners never count as climbers,
  and no difference is taken across a gap.
- **Timing a burst** to set a best rank is limited. The best rank is the best daily close under the
  current scoring, never an intraday peak.
- **No lists of fallers or leavers**, anywhere.

## Where it shows

**The list row.** One quiet marker under the rank, in grey, never red or green.

```
 041       devone           Lahore      [WEB] [ML]           612.40
 ▲ 12      Dev One
 084       devthree         Islamabad   [DEVOPS]             500.00
 TIED ▲ 6
 212       devfour          Pakistan    [WEB]                471.20
 [NEW]
 377       devfive          Peshawar    [ML]                 430.05
 [BACK]
```

| Marker    | Means                                   |
| --------- | --------------------------------------- |
| ▲ 12      | Up 12 places since this time yesterday  |
| ▼ 3       | Down 3 places since this time yesterday |
| =         | Same rank as this time yesterday        |
| NEW       | First day on the board                  |
| BACK      | Back on the board after time away       |
| (nothing) | Scoring changed in the last day         |

**The expanded card.** A Rank_History panel above the activity chart, with four facts (now, best
under the current scoring, first on the board, days on the board), one sentence on what moved the
rank, and a rank line and a score line under the current scoring only.

```
 RANK_HISTORY                                   CURRENT SCORING · SINCE 17 OCT 2026
 NOW 41  ▲ 12 SINCE YESTERDAY   BEST 29 (21 OCT)   FIRST ON THE BOARD 17 OCT   DAYS 23 OF 30
 Up 12 places since this time yesterday. Your score rose 3.40 points, which accounts for 9 of them.
 The other 3 came from changes in other developers' scores.
 [ rank line, best to worst ]
 [ score line, green ]
```

**The developer page at `/#login`.** The badge already links there, but today the site ignores the
link. It would show the full record, the card's history at full width, and each spell on and off
the board under the current scoring. A developer not on today's board has no page.

**Register.** After a check, one short panel, "Rank 41 today, up 12 since yesterday. First on the
board 17 October. Best rank 29 under the current scoring".

**The Digest.** A weekly "this week on the board" section with new arrivals, returns and the biggest
climbs, comparing one Sunday's close with the next under the same scoring. No fallers. Big climbs
mostly start low on the board, where scores sit close together, and the section says so.

**The badge.** No movement. A README badge is a permanent public identity, and a daily arrow on it
would mostly report other developers.

## The sentences

| Case                       | Sentence                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Score up, rank up          | Up 12 places since this time yesterday. Your score rose 3.40 points, which accounts for 9 of them. The other 3 came from changes in other developers' scores. |
| Score unchanged, rank up   | Up 4 places since this time yesterday. Your score did not change. Some developers who were ahead of you now score lower, or left the board.                   |
| Score unchanged, rank down | Down 6 places since this time yesterday. Your score did not change. Other developers moved ahead of you.                                                      |
| Score up, rank down        | Down 2 places since this time yesterday. Your score rose 1.10 points, but other developers rose more.                                                         |
| Score down                 | Down 30 places since this time yesterday. Your score fell 2.40 points, which accounts for 26 of them.                                                         |
| Under any fall             | A score covers the last 30 days, so it can fall when older active days leave that window.                                                                     |
| Same rank                  | Same rank as this time yesterday.                                                                                                                             |
| New                        | First day on the board. Places moved show from tomorrow.                                                                                                      |
| Back                       | Back on the board after 6 days away. Last here on 9 October at rank 943.                                                                                      |
| Scoring changed            | Scoring changed on 17 October. Places moved show again from 18 October.                                                                                       |
| No board yesterday         | Compared with the board of 5 October, the last one before today.                                                                                              |

## Invariants the implementation must test

1. The rank shown for a date equals the rank on the last board saved that Pakistan date.
2. The latest point equals the current board's rank and score for that account.
3. At most one point per account per date, and one row per account on every board.
4. Every stored rank is between 1 and 1,000, and equal scores on one day share a rank.
5. Changing the tie order changes no stored point.
6. There is a point on a date exactly when the account is on that date's board.
7. No difference, best or range is computed across a scoring change or a missing day.
8. A patch version change leaves every score byte for byte the same.
9. After a run sees an opt-out, no file holds any point of that account.
10. History only shrinks by opt-out, retention or a public withdrawal, and a save that loses points
    for any other reason is refused.
11. A login is turned into an account only through the current board.
12. Lists of climbers never include newcomers, returners or the first day of a scoring.

## Already done, and still to fix first

- Done. The last board of each Pakistan date is kept (#151), for 400 days until Rank History had
  its own store and then for 14, so an opted-out developer's row leaves the public states within two
  weeks.
- Done. One row per account when a developer renames (#152).
- Done. Removals from scoring the board again have their own reasons, `rescored` and `moderated`,
  and every run logs who it removed and why in the state (#155).
- Done. `history_through`, the opt-outs already removed from the history and the departures stay out
  of `board.json` and `data.json` (#155, #156).

## Not doing

- Nothing from before scoring v3, not ranks, scores, lines, presence or first-listed dates.
- No points recorded per run, and no best rank from an intraday peak.
- No line, arrow or difference across a scoring change.
- No red for a fall, no fallers list, no movement on the badge.
- No rewriting of published days per person.
- No history keyed by login.
- No history in `data.json`, `board.json` or any bulk file.

## Decided by the owner, 16 October 2026

1. **Opting out deletes the history for good.** Every point of that account is removed everywhere,
   and re-registering starts a new history.
2. **Nothing from before scoring v3.** History starts on 17 October 2026 for everyone. No old ranks,
   scores, lines, presence or first-listed dates.
3. **History shows only while a developer is on the board.** Someone who leaves has no public
   history page. If they return within the retention period, their history comes back with them.
4. **The feature has its own name, Rank History.** Version numbers stay for scoring changes only, so
   this ships without changing `MODEL_VERSION` and is not called v3.3.

## Build order

1. Recording. Write the daily close to `board-history` from the pipeline, with the departure reasons
   and the opt-out rewrite (#156). No backfill, since history starts on 17 October.
2. The per-developer files at deploy.
3. The card panel and the row markers.
4. The developer page at `/#login`, and Register.
5. The weekly Digest section.
6. The About questions and answers, and the Remove me form.
