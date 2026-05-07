const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const puppeteer = require("puppeteer");
const config = require("./config");
const { buildAlertMessage, sendMessageToConfiguredChannel } = require("./slack");

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFilename(value) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function ensureOutputDir(outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
}

const cookieBannerRules = [
  {
    match: (url) => url.includes("wealthtime.com"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("natilik.com"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("atlantic-technologies.com"),
    selectors: [".iubenda-cs-accept-btn.iubenda-cs-btn-primary"],
  },
  {
    match: (url) =>
      url.includes("bii.co.uk/en/") ||
      url.includes("toolkit.bii.co.uk") ||
      url.includes("fintoolkit.bii.co.uk") ||
      url.includes("gendertoolkit.bii.co.uk"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("orgvue.com"),
    selectors: ["#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll"],
  },
  {
    match: (url) => url.includes("aecfafrica.org"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("antin-ip.com"),
    selectors: ["#ccc-notify-accept"],
  },
  {
    match: (url) => url.includes("esr.eu.com"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("atlasinfrastructure.com"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("autorek.com"),
    selectors: ["a.cl-consent__btn[data-role='b_agree']", ".cmplz-btn.cmplz-accept"],
  },
  {
    match: (url) => url.includes("beacontx.com"),
    selectors: [".cmplz-btn.cmplz-accept"],
  },
  {
    match: (url) => url.includes("cap10partners.com"),
    selectors: [".sc-8efb5a-0 button:last-of-type"],
  },
  {
    match: (url) => url.includes("equitix.com"),
    selectors: ["ul.options a[data-close]"],
  },
  {
    match: (url) => url.includes("hwfpartners.com"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("ircp.com"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("leathwaite.com"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("mecsia.com"),
    selectors: [".cmplz-btn.cmplz-accept"],
  },
  {
    match: (url) => url.includes("us.one.network"),
    selectors: ["#ccc-notify-accept"],
  },
  {
    match: (url) => url.includes("towerbrook.com"),
    selectors: [".cky-btn.cky-btn-accept[data-cky-tag='accept-button']"],
  },
  {
    match: (url) => url.includes("xiatech.io"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("harrisoncatering.co.uk"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("geoffreyharrisonfoundation.org.uk"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("kanipayments.com"),
    selectors: [".cmplz-btn.cmplz-accept"],
  },
  {
    match: (url) => url.includes("tyruscap.com"),
    selectors: [".cmplz-btn.cmplz-accept"],
  },
  {
    match: (url) => url.includes("cubic3.com"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("uk.one.network"),
    selectors: [".btn.btn-block.btn-orange.erw-gdpr-accept"],
  },
  {
    match: (url) => url.includes("slingsbypartners.com"),
    selectors: [".cookie-wrap .accept"],
  },
  {
    match: (url) => url.includes("syntura.io"),
    selectors: ["#cn-accept-cookie"],
  },
  {
    match: (url) => url.includes("fenwickelliott.com"),
    selectors: [".agree-button.eu-cookie-compliance-default-button"],
  },
  {
    match: (url) => url.includes("seitplc.com"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("somerston.com"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("somerston-am.com"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("somerstoncapital.com"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("ukinets.org"),
    selectors: [".moove-gdpr-button-holder .moove-gdpr-infobar-allow-all"],
  },
  {
    match: (url) => url.includes("re-circulate.org"),
    selectors: ["#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll"],
  },
  {
    match: (url) => url.includes("helloprima.com"),
    selectors: ["#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll"],
  },
  {
    match: (url) => url.includes("htb.co.uk"),
    selectors: ["#ccc-notify-accept"],
  },
  {
    match: (url) => url.includes("mymediset.net"),
    selectors: [".btn.btn-custom"],
  },
  {
    match: (url) => url.includes("pidg.org"),
    selectors: ["#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll"],
  },
];

async function handleKnownCookieBanner(page, url) {
  const rule = cookieBannerRules.find((entry) => entry.match(url));
  if (!rule) {
    return;
  }

  for (const selector of rule.selectors) {
    try {
      await page.waitForSelector(selector, {
        timeout: 5000,
        visible: true,
      });
    } catch {
      continue;
    }

    try {
      await page.click(selector);
      await delay(1500);
      return;
    } catch {
      // Cookie-banner interaction is best-effort. Do not treat a stale/non-clickable
      // button as a site error because it creates false alerts.
    }
  }
}

async function consumeTestAlertMarker() {
  try {
    await fs.access(config.testAlertMarkerPath);
    await fs.unlink(config.testAlertMarkerPath);
    return true;
  } catch {
    return false;
  }
}

async function checkUrl(browser, url) {
  const page = await browser.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on("console", async (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") {
      return;
    }

    let location = "";
    try {
      const stack = message.stackTrace();
      if (stack && stack.length > 0) {
        const topFrame = stack[0];
        location = `${topFrame.url || "unknown"}:${topFrame.lineNumber || 0}:${topFrame.columnNumber || 0}`;
      }
    } catch {
      location = "";
    }

    consoleMessages.push({
      type,
      text: message.text(),
      location,
    });
  });

  page.on("pageerror", (error) => {
    pageErrors.push({
      message: error.message,
      stack: error.stack || "",
    });
  });

  page.on("requestfailed", (request) => {
    failedRequests.push({
      url: request.url(),
      method: request.method(),
      failureText: request.failure()?.errorText || "unknown",
    });
  });

  const startedAt = nowIso();
  let navigationStatus = "ok";
  let finalUrl = url;

  try {
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: config.navigationTimeoutMs,
    });
    finalUrl = page.url();
    await handleKnownCookieBanner(page, finalUrl);
  } catch (error) {
    navigationStatus = "failed";
    pageErrors.push({
      message: `Navigation failed: ${error.message}`,
      stack: error.stack || "",
    });
  }

  if (navigationStatus === "ok" && config.waitAfterLoadMs > 0) {
    await delay(config.waitAfterLoadMs);
    finalUrl = page.url();
  }

  await page.close();

  return {
    url,
    finalUrl,
    startedAt,
    finishedAt: nowIso(),
    navigationStatus,
    consoleMessages,
    pageErrors,
    failedRequests,
    consoleErrorCount: consoleMessages.filter((entry) => entry.type === "error").length,
    pageErrorCount: pageErrors.length,
    warningCount: consoleMessages.filter((entry) => entry.type === "warning").length,
  };
}

async function writeReport(results) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(
    config.outputDir,
    `console-report-${sanitizeFilename(timestamp)}.json`,
  );

  await ensureOutputDir(config.outputDir);
  await fs.writeFile(
    reportPath,
    `${JSON.stringify({ generatedAt: nowIso(), results }, null, 2)}\n`,
    "utf8",
  );

  return reportPath;
}

function printSummary(results, reportPath) {
  console.log(`Checked ${results.length} URL(s).`);
  for (const result of results) {
    console.log("");
    console.log(`URL: ${result.url}`);
    console.log(`Final URL: ${result.finalUrl}`);
    console.log(`Navigation: ${result.navigationStatus}`);
    console.log(`Console warnings: ${result.warningCount}`);
    console.log(`Console errors: ${result.consoleErrorCount}`);
    console.log(`Page errors: ${result.pageErrorCount}`);
    console.log(`Failed requests: ${result.failedRequests.length}`);

    if (result.consoleMessages.length > 0) {
      console.log("Console messages:");
      for (const message of result.consoleMessages) {
        const suffix = message.location ? ` (${message.location})` : "";
        console.log(`- [${message.type}] ${message.text}${suffix}`);
      }
    }

    if (result.pageErrors.length > 0) {
      console.log("Page errors:");
      for (const pageError of result.pageErrors) {
        console.log(`- ${pageError.message}`);
      }
    }

    if (result.failedRequests.length > 0) {
      console.log("Failed requests:");
      for (const request of result.failedRequests) {
        console.log(`- ${request.method} ${request.url} (${request.failureText})`);
      }
    }
  }

  console.log("");
  console.log(`Full JSON report: ${reportPath}`);
}

async function main() {
  const injectTestAlert = await consumeTestAlertMarker();
  const browser = await puppeteer.launch({
    headless: config.headless,
  });

  try {
    const results = [];
    for (const url of config.targetUrls) {
      const result = await checkUrl(browser, url);
      if (injectTestAlert && results.length === 0) {
        result.consoleMessages.unshift({
          type: "error",
          text: "Synthetic test console error generated for cron/Slack verification.",
          location: "console-error-bot:test-alert",
        });
        result.consoleErrorCount += 1;
      }

      results.push(result);
    }

    const reportPath = await writeReport(results);
    printSummary(results, reportPath);

    const hasConsoleErrors = results.some((result) => result.consoleErrorCount > 0);
    if (hasConsoleErrors && config.slack.enabled) {
      await sendMessageToConfiguredChannel(buildAlertMessage(results, reportPath));
      console.log("Slack alert sent.");
    }

    process.exitCode = hasConsoleErrors ? 1 : 0;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Bot run failed.");
  console.error(error);
  process.exitCode = 1;
});
