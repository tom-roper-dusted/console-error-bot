# Console Error Bot

Minimal Node.js bot that uses Puppeteer to load client websites and collect:

- browser console errors and warnings
- uncaught page errors
- failed network requests and HTTP 4xx/5xx responses
- Content Security Policy (CSP) violations, including ones that only appear
  after cookies are accepted
- whether the cookie banner appeared at all

Sites are checked concurrently, results are classified (real first-party
issues vs third-party/analytics noise vs "we got blocked by bot protection"),
compared against the previous run, and a plain-English + technical Slack alert
is sent when a site needs attention.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the example environment file:

```bash
cp .env.example .env
```

3. Run the checker:

```bash
npm run check
```

## Site list

The list of sites lives in [sites.json](sites.json). Each entry has:

- `name`: friendly name used in Slack and the console summary
- `url`: the URL to check
- `cookieSelectors`: selectors for the accept button on the cookie banner.
  The bot clicks it, and raises an alert if none of them appears. Leave it
  empty only for sites that genuinely have no banner
- `accessFlow`: optional pre-check step for gated sites — either
  `{"type": "residenceDisclaimer", ...}` (HICL/TRIG-style investor gates) or
  `{"type": "clickButton", "selector": ...}` (IRCP-style jurisdiction prompt)
- `enabled`: set to `false` to keep a site's config without checking it

Global `noisePatterns` (regexes) mark errors as third-party noise so they are
kept in the JSON report but excluded from alerts. CSP violations are never
treated as noise, even when the blocked URL is a third-party tracker, because
the policy doing the blocking belongs to the site.

## Cookie banners

Every site is loaded in its own throwaway browser session, so the bot sees
what a first-time visitor sees. For each site with `cookieSelectors` it:

- waits for the accept button to be visible inside the viewport
- clicks it (retrying, then clicking through the DOM if a pop-up or preloader
  is covering the button) and keeps listening for errors afterwards
- reports the banner as missing if it never appears, after one reload to rule
  out a slow page

A missing banner triggers a Slack alert. Banners that are present are not
mentioned in Slack. The banner check is skipped when the site blocked the
checker or when the checking machine itself had network/DNS failures. Each
site's result in the JSON report has a `cookieBanner` block.

Run the bot from a network without ad-blocking DNS or a filtering VPN:
blocked tracker and consent-tool domains hide exactly the errors this bot is
looking for.

## Configuration

Environment variables (`.env`):

- `HEADLESS`: set to `false` to show the browser
- `NAVIGATION_TIMEOUT_MS`: page navigation timeout
- `WAIT_AFTER_LOAD_MS`: extra delay after load to catch late console errors
- `COOKIE_BANNER_TIMEOUT_MS`: how long to wait for the cookie banner before
  calling it missing (default 10000)
- `CONCURRENCY`: how many pages to check in parallel (default 4)
- `REPORTS_TO_KEEP`: how many JSON reports to keep in `reports/` (default 60)
- `SITE_FILTER`: check only sites whose name/url contains this substring —
  handy for testing one site (`SITE_FILTER=wealthtime npm run check`)
- `SLACK_ENABLED`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`: Slack alerting

## Avoiding bot-protection (Cloudflare) blocks

The bot:

- keeps Cloudflare clearance cookies in a persistent Chrome profile in
  `.chrome-profile/` and copies them into each site's fresh session
  (nothing else, such as cookie-consent choices, survives between runs)
- uses a normal Chrome user agent and disables the automation fingerprint flag
- adds a small random delay between page loads
- runs hourly rather than every 10 minutes

If a specific site still blocks the checker regularly, the proper fix is to
ask the client to allowlist the office IP in their Cloudflare settings. Runs
where a site serves a challenge page are reported as "couldn't check" rather
than as site errors.

## Cron

The repo includes [scripts/run-check.sh](scripts/run-check.sh), which:

- runs the checker from the repo root
- appends output to `logs/cron.log`
- prevents overlapping runs with a lock directory (stale locks older than
  90 minutes are removed automatically)

Install/update the schedule with:

```bash
crontab cron/console-error-bot.crontab
```

The schedule is hourly (`0 * * * *`). Console errors on these sites don't
change minute-to-minute, and a slower cadence drastically reduces
Cloudflare blocks.

Note: a non-headless browser under `cron` can be unreliable on macOS because
`cron` is not a GUI-first launcher. If you start seeing Chrome launch failures
or invisible windows, the next step should be a `LaunchAgent` instead of cron.

## Slack alerts

An alert is sent when any site is down, has first-party console/page
errors or failed files, has requests blocked by its own CSP, or is missing
its cookie banner. The message has, per site:

- a plain-English line for non-technical readers ("3 files on the page failed
  to load — images, styling or content may be missing")
- a "For the devs" context block with exact URLs, HTTP statuses and JS errors
- a 🆕 badge on issues not seen on the previous run

Sites where the checker was blocked by bot protection are listed separately
as "couldn't check" and do not trigger alerts on their own. Third-party
analytics/ad errors are filtered out of the message (they stay in the JSON
report).

To test the cron-to-Slack path without waiting for a real issue:

```bash
npm run alert:test-once
```

That queues a one-shot marker; the next run injects a synthetic console error
into the first checked site and sends the normal alert format once.

Required Slack scope: `chat:write`.

## Reports

Each run writes a JSON report to `reports/` (pruned to the most recent
`REPORTS_TO_KEEP`). Each site's entry includes the raw captured signals plus
an `analysis` block with the classified issues, noise counts, and which
issues are new versus the previous run. The run exits non-zero when any site
needs attention, which is useful for cron monitoring.
