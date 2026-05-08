# Console Error Bot

Minimal Node.js bot that uses Puppeteer to load websites and collect:

- browser console errors and warnings
- uncaught page errors
- failed network requests

The current setup checks a configured list of target URLs from `.env`.

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

The default `.env` is configured for a visible browser window on a local machine.

## Configuration

Environment variables:

- `TARGET_URLS`: comma-separated list of URLs
- `HEADLESS`: set to `false` to show the browser
- `NAVIGATION_TIMEOUT_MS`: page navigation timeout
- `WAIT_AFTER_LOAD_MS`: extra delay after initial load to catch late console errors
- `SLACK_ENABLED`: set to `true` to enable Slack alerts
- `SLACK_BOT_TOKEN`: bot token used for Slack API calls
- `SLACK_CHANNEL_ID`: Slack channel ID to receive alerts

## Cron

The repo includes [scripts/run-check.sh](/Users/tomroper/console-error-bot/scripts/run-check.sh), which:

- runs the checker from the repo root
- appends output to `logs/cron.log`
- prevents overlapping runs with a simple lock directory

Example local cron target:

```cron
*/10 * * * * /absolute/path/to/console-error-bot/scripts/run-check.sh
```

Note: a non-headless browser under `cron` can be unreliable on macOS because `cron` is not a GUI-first launcher. If you start seeing Chrome launch failures or invisible windows, the next step should be a `LaunchAgent` instead of `cron`.

## Slack Requirements

Current Slack setup:

- sends alerts only when a run has browser `console.error` entries
- posts to `SLACK_CHANNEL_ID` using `chat.postMessage`
- includes the report path and a short per-site summary

To test the real cron-to-Slack path without waiting for a real website issue:

```bash
npm run alert:test-once
```

That creates a one-shot marker file. The next cron run consumes it, injects a synthetic console error into the first checked site, and sends you the normal Slack alert format once.

Current required Slack scope:

- `chat:write`

Optional later scopes:

- `chat:write.public` if you want alerts posted into public channels
- `im:write` if you want the app to explicitly open or resume DM channels instead of posting directly to a user ID

## Current Behavior

Each run:

- visits each configured URL
- records console warnings and errors
- records uncaught page errors
- records failed requests
- writes a JSON report to `reports/`
- exits with code `1` when browser `console.error` entries are found

That non-zero exit code will be useful later for cron monitoring and alerting.
