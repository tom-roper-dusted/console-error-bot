const config = require("./config");

const MAX_SITES_IN_MESSAGE = 12;
const MAX_DETAILS_PER_SITE = 4;

async function callSlackApi(method, payload) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slack.botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = data.error || `HTTP ${response.status}`;
    throw new Error(`Slack API ${method} failed: ${error}`);
  }

  return data;
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function displayHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatRunTime(date) {
  return date.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  });
}

// One plain-English sentence per site describing what a visitor would
// experience, for readers who don't need the technical detail.
function plainEnglishSummary(result) {
  const analysis = result.analysis;

  if (analysis.status === "down") {
    return "The site didn't load at all — visitors may be seeing an error page. Needs urgent attention.";
  }

  const parts = [];
  if (analysis.resourceIssues.length > 0) {
    const count = analysis.resourceIssues.length;
    parts.push(
      `${count} file${count === 1 ? "" : "s"} on the page failed to load — images, styling or content may be missing or broken`,
    );
  }

  if (analysis.jsIssues.length > 0) {
    const count = analysis.jsIssues.length;
    parts.push(
      `${count} JavaScript error${count === 1 ? "" : "s"} — interactive parts of the page (menus, forms, widgets) may not work properly`,
    );
  }

  if (analysis.cspIssues.length > 0) {
    const count = analysis.cspIssues.length;
    parts.push(
      `${count} request${count === 1 ? " was" : "s were"} blocked by the site's own security policy (CSP) — tracking, analytics or embedded content may not be working`,
    );
  }

  if (analysis.cookieBannerMissing) {
    parts.push(
      "The cookie banner didn't appear — new visitors aren't being asked for cookie consent",
    );
  }

  return `${parts.join(". ")}.`;
}

// Technical bullets with the exact URL/error a developer needs to reproduce
// and fix the issue.
function technicalDetails(result) {
  const analysis = result.analysis;
  const lines = [];

  if (analysis.status === "down" && analysis.downReason) {
    lines.push(`• ${truncate(analysis.downReason, 220)}`);
  }

  for (const issue of analysis.resourceIssues) {
    lines.push(`• ${issue.isNew ? "🆕 " : ""}\`${truncate(issue.url, 160)}\` → ${issue.detail}`);
  }

  for (const issue of analysis.jsIssues) {
    const location = issue.location ? ` — at \`${truncate(issue.location, 120)}\`` : "";
    const repeat = issue.count > 1 ? ` (×${issue.count})` : "";
    lines.push(`• ${issue.isNew ? "🆕 " : ""}${truncate(issue.text, 220)}${location}${repeat}`);
  }

  for (const issue of analysis.cspIssues) {
    const target = issue.isUrl ? `\`${truncate(issue.blocked, 160)}\`` : truncate(issue.blocked, 160);
    const rule = issue.directive ? ` (\`${issue.directive}\`)` : "";
    const when = issue.phase === "afterCookieAccept" ? " — after accepting cookies" : "";
    const repeat = issue.count > 1 ? ` (×${issue.count})` : "";
    lines.push(`• ${issue.isNew ? "🆕 " : ""}CSP blocked ${target}${rule}${when}${repeat}`);
  }

  if (analysis.cookieBannerMissing) {
    const selectors = result.cookieBanner.selectors.map((selector) => `\`${selector}\``).join(", ");
    // Goes first so it is never cut off by the per-site detail limit.
    lines.unshift(
      `• ${analysis.cookieBannerIsNew ? "🆕 " : ""}Cookie banner not shown to a first-time visitor (looked for ${truncate(selectors, 160)})`,
    );
  }

  const shown = lines.slice(0, MAX_DETAILS_PER_SITE);
  const hidden = lines.length - shown.length;
  if (hidden > 0) {
    shown.push(`…and ${hidden} more (full details in the JSON report)`);
  }

  return shown.join("\n");
}

function siteEmoji(result) {
  return result.analysis.status === "down" ? "🔴" : "🟠";
}

function buildAlertMessage(results, reportPath) {
  const failing = results.filter((result) =>
    ["down", "errors"].includes(result.analysis.status),
  );
  const blocked = results.filter((result) => result.analysis.status === "blocked");
  const healthyCount = results.length - failing.length - blocked.length;
  const noiseCount = results.reduce((total, result) => total + result.analysis.noiseCount, 0);
  const newIssueCount = failing.filter((result) => result.analysis.hasNewIssues).length;
  const runTime = formatRunTime(new Date());

  const headerText = `🚨 Website check: ${failing.length} site${failing.length === 1 ? "" : "s"} need${failing.length === 1 ? "s" : ""} attention`;

  const contextParts = [
    `Checked ${results.length} sites at ${runTime}`,
    `${healthyCount} healthy ✅`,
  ];
  if (newIssueCount > 0) {
    contextParts.push(`${newIssueCount} with new issues 🆕`);
  }

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: headerText,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: contextParts.join(" • "),
        },
      ],
    },
    {
      type: "divider",
    },
  ];

  const textLines = [headerText];

  for (const result of failing.slice(0, MAX_SITES_IN_MESSAGE)) {
    const newBadge = result.analysis.hasNewIssues ? "  🆕 *new since last check*" : "";
    const summary = plainEnglishSummary(result);

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${siteEmoji(result)} *${result.name}* — <${result.url}|${displayHost(result.url)}>${newBadge}\n${summary}`,
      },
    });

    const details = technicalDetails(result);
    if (details) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*For the devs:*\n${truncate(details, 2900)}`,
          },
        ],
      });
    }

    textLines.push(`${result.name}: ${summary}`);
  }

  if (failing.length > MAX_SITES_IN_MESSAGE) {
    const remaining = failing
      .slice(MAX_SITES_IN_MESSAGE)
      .map((result) => result.name)
      .join(", ");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `…plus issues on: ${remaining} (see the JSON report)`,
      },
    });
    textLines.push(`…plus issues on: ${remaining}`);
  }

  if (blocked.length > 0) {
    const names = blocked.map((result) => result.name).join(", ");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🛡️ *Couldn't check:* ${names} — our checker was blocked by the site's bot protection. The site itself is probably fine; we'll try again on the next run.`,
      },
    });
    textLines.push(`Couldn't check (bot protection): ${names}`);
  }

  const footerParts = ["🆕 = not seen on the previous check"];
  if (noiseCount > 0) {
    footerParts.push(
      `${noiseCount} third-party/analytics error${noiseCount === 1 ? "" : "s"} filtered out as noise`,
    );
  }
  footerParts.push(`Full technical report: \`${reportPath}\` on the machine that runs the bot`);

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: footerParts.join(" • "),
      },
    ],
  });

  return {
    text: textLines.join("\n").trim(),
    blocks,
  };
}

function buildTestText() {
  return [
    "Console Error Bot Slack test message.",
    `Sent at ${new Date().toISOString()}.`,
  ].join("\n");
}

async function sendMessageToConfiguredChannel(message) {
  if (!config.slack.enabled) {
    return false;
  }

  if (!config.slack.botToken) {
    throw new Error("Slack is enabled but SLACK_BOT_TOKEN is missing.");
  }

  if (!config.slack.channelId) {
    throw new Error("Slack is enabled but SLACK_CHANNEL_ID is missing.");
  }

  const normalizedMessage = typeof message === "string" ? { text: message } : message;

  await callSlackApi("chat.postMessage", {
    channel: config.slack.channelId,
    ...normalizedMessage,
  });

  return true;
}

module.exports = {
  buildAlertMessage,
  buildTestText,
  sendMessageToConfiguredChannel,
};
