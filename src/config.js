const dotenv = require("dotenv");

dotenv.config();

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

function parseTargetUrls(value) {
  if (!value) {
    return ["https://wealthtime.com"];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

module.exports = {
  headless: parseBoolean(process.env.HEADLESS, true),
  navigationTimeoutMs: parseNumber(process.env.NAVIGATION_TIMEOUT_MS, 30000),
  outputDir: "reports",
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    channelId: process.env.SLACK_CHANNEL_ID,
    enabled: parseBoolean(process.env.SLACK_ENABLED, false),
  },
  testAlertMarkerPath: ".test-alert-once",
  targetUrls: parseTargetUrls(process.env.TARGET_URLS),
  waitAfterLoadMs: parseNumber(process.env.WAIT_AFTER_LOAD_MS, 5000),
};
