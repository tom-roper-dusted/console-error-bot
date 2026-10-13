const dotenv = require("dotenv");

dotenv.config();

const sitesFile = require("../sites.json");

function parseBoolean(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  return value.toLowerCase() !== "false";
}

function parseNumber(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

const sites = sitesFile.sites.filter((site) => site.enabled !== false);

module.exports = {
  headless: parseBoolean(process.env.HEADLESS, true),
  navigationTimeoutMs: parseNumber(process.env.NAVIGATION_TIMEOUT_MS, 30000),
  waitAfterLoadMs: parseNumber(process.env.WAIT_AFTER_LOAD_MS, 5000),
  cookieBannerTimeoutMs: parseNumber(process.env.COOKIE_BANNER_TIMEOUT_MS, 10000),
  concurrency: parseNumber(process.env.CONCURRENCY, 4),
  siteFilter: (process.env.SITE_FILTER || "").trim().toLowerCase(),
  outputDir: "reports",
  reportsToKeep: parseNumber(process.env.REPORTS_TO_KEEP, 60),
  userDataDir: ".chrome-profile",
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    channelId: process.env.SLACK_CHANNEL_ID,
    enabled: parseBoolean(process.env.SLACK_ENABLED, false),
  },
  testAlertMarkerPath: ".test-alert-once",
  sites,
  noisePatterns: (sitesFile.noisePatterns || []).map((pattern) => new RegExp(pattern, "i")),
};
