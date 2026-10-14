# Analytics

Rankistan uses [Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/): free,
cookieless, no personal data and no fingerprinting, so it needs no cookie banner. It adds one
deferred ~5 KB script, loaded only on `rankistan.dev`.

## Where to look

Cloudflare dashboard → **Analytics & Logs → Web Analytics → rankistan.dev**. It shows visits,
page views, countries, referrers (LinkedIn, GitHub, Google, Reddit…), paths, browsers and devices,
filterable by time range. Use **Country = Pakistan** for Pakistani visitors, and **Path** for
pages and campaigns.

## What each path means

| Path                                                             | What it is                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `/`                                                              | Leaderboard (also `/#username` developer links; the hash is not recorded) |
| `/map`, `/badge`, `/register`, `/digest`, `/about`, `/evolution` | The tabs                                                                  |
| `/from/<source>/<campaign>`                                      | A visit that arrived on a campaign link (below)                           |

Every tab change is a page view: the app moves between tabs with `history.pushState`, which the
beacon counts.

## Campaign links

Cloudflare Web Analytics never records query strings, so UTM parameters alone would be lost. The
boot script in `index.html` rewrites a UTM link that lands on `/` into a path, before the beacon
reads the URL:

```
https://rankistan.dev/?utm_source=linkedin&utm_campaign=infra-1
  is counted as  /from/linkedin/infra-1
```

Only `utm_source` and `utm_campaign` are read, lowercased and reduced to `a-z 0-9 - _` and 40
characters; the other `utm_*` parameters are dropped. Use a new `utm_campaign` per post, for
example:

| Post                                 | Link                                                              |
| ------------------------------------ | ----------------------------------------------------------------- |
| LinkedIn, data infrastructure part 1 | `https://rankistan.dev/?utm_source=linkedin&utm_campaign=infra-1` |
| GitHub README                        | `https://rankistan.dev/?utm_source=github&utm_campaign=readme`    |
| Reddit                               | `https://rankistan.dev/?utm_source=reddit&utm_campaign=<thread>`  |

In the dashboard, filter **Path** by `/from/linkedin/` to compare posts. The landing is counted once
under its campaign path; the tabs the visitor then opens are counted under their own paths.
LinkedIn's app often sends no referrer, which is why campaign links matter for it.

## What it cannot tell you

- **Clicks inside a page** (generating a badge, submitting Register): Web Analytics counts page
  views only. The tab paths are the closest it gets.
- **Individual people**: by design. "Visits" are counted without identifying anyone.

## Setup (done)

- Site `rankistan.dev` added in Web Analytics with the JavaScript snippet (not automatic setup:
  the domain's DNS is at name.com, not Cloudflare).
- Its token is `CF_WEB_ANALYTICS_TOKEN` in the boot script in `index.html`. It is public by
  design; it only identifies which site the data belongs to.
