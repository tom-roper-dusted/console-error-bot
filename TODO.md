# TODO

## Next implementation steps

- Add URL metadata support so each site can have a name, tags, and custom wait rules.
- Decide whether console warnings should alert Slack or remain report-only.
- Add retries and optional screenshot capture when a page has errors.
- Add a threshold or deduplication layer so repeated known errors do not spam alerts.
- Add structured logging for easier ingestion by a scheduler or monitoring platform.

## Slack integration

- Add a Slack bot token and target channel configuration.
- Post a concise summary when any site has errors.
- Include top console errors, failed requests, and a link or attachment for the full JSON report.
- Decide whether to send one message per failing site or one rollup message per run.

## Scheduling

- Add a cron entry or deploy to a scheduler that runs hourly.
- Persist reports somewhere durable if this will run outside a local machine.
- Add health monitoring so failures of the bot itself are visible separately from website console errors.

## Testing and hardening

- Add smoke tests around config parsing and result formatting.
- Validate behavior on redirects, cookie banners, auth walls, and bot protection.
- Add support for custom user agent, viewport, and request headers if needed per site.
- Evaluate whether to block analytics requests or accept noisy third-party errors.
