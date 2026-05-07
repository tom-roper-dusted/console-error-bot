const config = require("./config");

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

function formatConsoleMessage(message) {
  const lines = [`• ${truncate(message.text, 180)}`];
  if (message.location) {
    lines.push(`  ↳ ${truncate(message.location, 180)}`);
  }

  return lines.join("\n");
}

function summarizeResult(result) {
  const consoleErrors = result.consoleMessages.filter((message) => message.type === "error");
  const lines = [`*${result.url}*`];

  if (result.finalUrl !== result.url) {
    lines.push(`↳ ${result.finalUrl}`);
  }

  if (consoleErrors.length > 0) {
    lines.push(`🚨 Console errors: ${consoleErrors.length}`);
    for (const message of consoleErrors.slice(0, 5)) {
      lines.push(formatConsoleMessage(message));
    }

    if (consoleErrors.length > 5) {
      lines.push(`• ${consoleErrors.length - 5} more console error(s) not shown`);
    }
  }

  if (result.pageErrors.length > 0) {
    lines.push(`💥 Page errors: ${result.pageErrors.length}`);
    for (const pageError of result.pageErrors.slice(0, 3)) {
      lines.push(`• ${truncate(pageError.message, 180)}`);
    }

    if (result.pageErrors.length > 3) {
      lines.push(`• ${result.pageErrors.length - 3} more page error(s) not shown`);
    }
  }

  return lines.join("\n");
}

function buildAlertMessage(results, reportPath) {
  const failingResults = results.filter((result) => result.consoleErrorCount > 0);
  const textLines = [
    `Console Error Bot: errors found on ${failingResults.length} site(s).`,
    `Report: ${reportPath}`,
  ];
  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🚨 Console Error Bot: ${failingResults.length} site(s) failing`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Report: \`${reportPath}\``,
      },
    },
  ];

  for (const result of failingResults) {
    const summary = summarizeResult(result);
    textLines.push("");
    textLines.push(summary.replace(/\*/g, ""));
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: summary,
      },
    });
  }

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
