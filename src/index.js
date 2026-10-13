const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const puppeteer = require("puppeteer");
const config = require("./config");
const {
  BLOCKED_TITLE_PATTERN,
  buildPreviousFingerprints,
  classifyResult,
  markNewIssues,
} = require("./classify");
const { checkCookieBanner } = require("./cookie-banner");
const { buildAlertMessage, sendMessageToConfiguredChannel } = require("./slack");

const MAX_CAPTURED_ENTRIES = 200;
// Desktop-sized so sites render their desktop layout and banner.
const VIEWPORT = { width: 1366, height: 900 };
const CLEARANCE_COOKIE_PATTERN = /^(cf_|__cf)/i;
// Failures that come from the checker's own network (DNS, VPN, ad-blocking
// resolver) rather than from the site.
const LOCAL_NETWORK_FAILURE_PATTERN =
  /ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_PROXY|ERR_TUNNEL/;

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFilename(value) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function runResidenceDisclaimerFlow(page, flow) {
  await page.waitForSelector(flow.residenceSelector, {
    timeout: 8000,
    visible: true,
  });

  await page.evaluate((flowArg) => {
    for (const selector of [flowArg.residenceSelector, flowArg.locationSelector]) {
      const field = document.querySelector(selector);
      if (!field) {
        continue;
      }

      field.value = flowArg.value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const residence = document.querySelector(flowArg.residenceSelector);
    const form = residence ? residence.closest("form") : null;
    if (form) {
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.submit();
      }
    }
  }, flow);

  await delay(1500);
  await page.waitForSelector("a[href='./?disclaimer=accept']", {
    timeout: 8000,
    visible: true,
  });

  await page.evaluate(() => {
    const acceptLink = document.querySelector("a[href='./?disclaimer=accept']");
    if (acceptLink) {
      acceptLink.click();
    }
  });
  await delay(3000);
}

async function runAccessFlow(page, flow) {
  try {
    if (flow.type === "residenceDisclaimer") {
      await runResidenceDisclaimerFlow(page, flow);
    } else if (flow.type === "clickButton") {
      await page.waitForSelector(flow.selector, {
        timeout: 8000,
        visible: true,
      });
      await page.click(flow.selector);
      await delay(2000);
    }
  } catch {
    // Access flows are best-effort. If the prompt is absent or changes shape,
    // continue without turning it into a false site error.
  }
}

function looksBlocked(mainStatus, title) {
  return [403, 429, 503].includes(mainStatus) || BLOCKED_TITLE_PATTERN.test(title);
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

async function clearanceCookies(source) {
  const cookies = await source.cookies().catch(() => []);
  return cookies.filter((cookie) => CLEARANCE_COOKIE_PATTERN.test(cookie.name));
}

// Each site gets its own throwaway browser session so it is seen the way a
// first-time visitor sees it: no remembered cookie consent and no leftover
// tracking state, both of which hide the banner and the errors that follow
// accepting it. Only bot-protection clearance is carried over from the
// persistent profile, so Cloudflare doesn't have to be re-earned every run.
async function openFreshSession(browser) {
  const context = await browser.createBrowserContext();
  const clearance = await clearanceCookies(browser);
  if (clearance.length > 0) {
    await context.setCookie(...clearance).catch(() => {});
  }

  return context;
}

async function closeSession(browser, context) {
  const clearance = await clearanceCookies(context);
  if (clearance.length > 0) {
    await browser.setCookie(...clearance).catch(() => {});
  }

  await context.close().catch(() => {});
}

async function checkSite(browser, site, userAgent) {
  const context = await openFreshSession(browser);
  try {
    return await checkSiteInSession(context, site, userAgent);
  } finally {
    await closeSession(browser, context);
  }
}

async function checkSiteInSession(context, site, userAgent) {
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  const failedResponses = [];

  // Errors are tagged with the phase they appeared in, because some only
  // fire once consent is given and the tracking scripts start loading.
  let phase = "load";
  let cookieBanner = { status: "unknown", selectors: site.cookieSelectors || [], accepted: false };

  await page.setUserAgent(userAgent);
  await page.setViewport(VIEWPORT);
  // Pages checked in parallel must all behave as the visible tab, otherwise
  // animations and banners that wait for a visible page never run.
  await page.emulateFocusedPage(true).catch(() => {});

  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") {
      return;
    }

    if (consoleMessages.length >= MAX_CAPTURED_ENTRIES) {
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
      phase,
    });
  });

  page.on("pageerror", (error) => {
    if (pageErrors.length >= MAX_CAPTURED_ENTRIES) {
      return;
    }

    pageErrors.push({
      message: error.message,
      stack: error.stack || "",
      phase,
    });
  });

  page.on("requestfailed", (request) => {
    if (failedRequests.length >= MAX_CAPTURED_ENTRIES) {
      return;
    }

    failedRequests.push({
      url: request.url(),
      method: request.method(),
      failureText: request.failure()?.errorText || "unknown",
    });
  });

  page.on("response", (response) => {
    if (response.status() < 400 || failedResponses.length >= MAX_CAPTURED_ENTRIES) {
      return;
    }

    failedResponses.push({
      url: response.url(),
      status: response.status(),
      resourceType: response.request().resourceType(),
    });
  });

  const startedAt = nowIso();
  let navigationStatus = "ok";
  let finalUrl = site.url;
  let mainStatus = null;
  let title = "";

  try {
    const response = await page.goto(site.url, {
      waitUntil: "networkidle2",
      timeout: config.navigationTimeoutMs,
    });
    mainStatus = response ? response.status() : null;
    finalUrl = page.url();

    if (site.accessFlow) {
      await runAccessFlow(page, site.accessFlow);
    }

    title = await page.title().catch(() => "");

    // A bot-protection challenge page never has the banner, so don't look.
    if (!looksBlocked(mainStatus, title)) {
      cookieBanner = await checkCookieBanner(
        page,
        site.cookieSelectors,
        config.cookieBannerTimeoutMs,
      );

      if (cookieBanner.status === "missing") {
        // One slow load should not raise a false "banner missing" alert.
        await page.reload({
          waitUntil: "networkidle2",
          timeout: config.navigationTimeoutMs,
        });
        if (site.accessFlow) {
          await runAccessFlow(page, site.accessFlow);
        }

        cookieBanner = await checkCookieBanner(
          page,
          site.cookieSelectors,
          config.cookieBannerTimeoutMs,
        );
      }

      if (cookieBanner.accepted) {
        phase = "afterCookieAccept";
        await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }).catch(() => {});
      }

      title = await page.title().catch(() => title);
    }
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

  await page.close().catch(() => {});

  const blocked = navigationStatus === "ok" && looksBlocked(mainStatus, title);

  // A failed or blocked load says nothing about the banner either way.
  if (navigationStatus !== "ok" || blocked) {
    cookieBanner = { ...cookieBanner, status: "unknown", accepted: false };
  } else if (
    cookieBanner.status === "missing" &&
    failedRequests.some((request) => LOCAL_NETWORK_FAILURE_PATTERN.test(request.failureText))
  ) {
    // Banner scripts are often served from a third-party host; if our own
    // network couldn't reach things, the banner may be fine for real visitors.
    cookieBanner = {
      ...cookieBanner,
      status: "unknown",
      reason: "network failures on the checking machine",
    };
  }

  return {
    name: site.name,
    url: site.url,
    finalUrl,
    title,
    mainStatus,
    blocked,
    cookieBanner,
    startedAt,
    finishedAt: nowIso(),
    navigationStatus,
    consoleMessages,
    pageErrors,
    failedRequests,
    failedResponses,
    consoleErrorCount: consoleMessages.filter((entry) => entry.type === "error").length,
    pageErrorCount: pageErrors.length,
    warningCount: consoleMessages.filter((entry) => entry.type === "warning").length,
  };
}

function crashedResult(site, error) {
  return {
    name: site.name,
    url: site.url,
    finalUrl: site.url,
    title: "",
    mainStatus: null,
    blocked: false,
    cookieBanner: { status: "unknown", selectors: site.cookieSelectors || [], accepted: false },
    startedAt: nowIso(),
    finishedAt: nowIso(),
    navigationStatus: "failed",
    consoleMessages: [],
    pageErrors: [
      {
        message: `Navigation failed: checker crashed (${error.message})`,
        stack: error.stack || "",
      },
    ],
    failedRequests: [],
    failedResponses: [],
    consoleErrorCount: 0,
    pageErrorCount: 1,
    warningCount: 0,
  };
}

// Runs sites through a fixed-size pool of workers so several pages load
// concurrently, while keeping results in the original site order. A small
// random delay between navigations avoids a burst pattern that looks like a
// scraper to bot protection.
async function runPool(sites, worker, concurrency) {
  const results = new Array(sites.length);
  let nextIndex = 0;

  async function lane() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= sites.length) {
        return;
      }

      await delay(250 + Math.floor(Math.random() * 1750));
      results[index] = await worker(sites[index]);
    }
  }

  const laneCount = Math.max(1, Math.min(concurrency, sites.length));
  await Promise.all(Array.from({ length: laneCount }, () => lane()));
  return results;
}

async function loadPreviousReport() {
  try {
    const entries = await fs.readdir(config.outputDir);
    const reportFiles = entries.filter((name) => /^console-report-.*\.json$/.test(name)).sort();
    if (reportFiles.length === 0) {
      return null;
    }

    const latest = path.join(config.outputDir, reportFiles[reportFiles.length - 1]);
    return JSON.parse(await fs.readFile(latest, "utf8"));
  } catch {
    return null;
  }
}

async function writeReport(results) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(
    config.outputDir,
    `console-report-${sanitizeFilename(timestamp)}.json`,
  );

  await fs.mkdir(config.outputDir, { recursive: true });
  await fs.writeFile(
    reportPath,
    `${JSON.stringify({ generatedAt: nowIso(), results }, null, 2)}\n`,
    "utf8",
  );

  return reportPath;
}

async function pruneOldReports() {
  try {
    const entries = await fs.readdir(config.outputDir);
    const reportFiles = entries.filter((name) => /^console-report-.*\.json$/.test(name)).sort();
    const excess = reportFiles.slice(0, Math.max(0, reportFiles.length - config.reportsToKeep));
    await Promise.all(excess.map((name) => fs.unlink(path.join(config.outputDir, name))));
  } catch {
    // Pruning is housekeeping; never let it fail a run.
  }
}

function statusLabel(analysis) {
  switch (analysis.status) {
    case "down":
      return "DOWN";
    case "blocked":
      return "BLOCKED";
    case "errors":
      return "ERRORS";
    default:
      return "OK";
  }
}

function printSummary(results, reportPath) {
  console.log(`Checked ${results.length} site(s).`);
  console.log("");

  for (const result of results) {
    const analysis = result.analysis;
    const details = [];
    if (analysis.resourceIssues.length > 0) {
      details.push(`${analysis.resourceIssues.length} failed file(s)`);
    }

    if (analysis.jsIssues.length > 0) {
      details.push(`${analysis.jsIssues.length} JS error(s)`);
    }

    if (analysis.cspIssues.length > 0) {
      details.push(`${analysis.cspIssues.length} blocked by CSP`);
    }

    if (analysis.cookieBannerMissing) {
      details.push("cookie banner missing");
    } else if (result.cookieBanner.status === "shown" && !result.cookieBanner.accepted) {
      details.push("cookie banner shown but could not be accepted");
    } else if (result.cookieBanner.reason) {
      details.push(`cookie banner not checked (${result.cookieBanner.reason})`);
    }

    if (result.warningCount > 0) {
      details.push(`${result.warningCount} warning(s)`);
    }

    if (analysis.noiseCount > 0) {
      details.push(`${analysis.noiseCount} third-party/noise filtered`);
    }

    console.log(
      `[${statusLabel(analysis)}] ${result.name} (${result.url})${details.length > 0 ? ` — ${details.join(", ")}` : ""}`,
    );

    if (analysis.status === "down" && analysis.downReason) {
      console.log(`  ${analysis.downReason}`);
    }

    for (const issue of analysis.resourceIssues) {
      console.log(`  - ${issue.url} → ${issue.detail}${issue.isNew ? " [new]" : ""}`);
    }

    for (const issue of analysis.jsIssues) {
      const suffix = issue.location ? ` (${issue.location})` : "";
      console.log(`  - ${issue.text}${suffix}${issue.isNew ? " [new]" : ""}`);
    }

    for (const issue of analysis.cspIssues) {
      const when = issue.phase === "afterCookieAccept" ? " (after accepting cookies)" : "";
      console.log(`  - ${issue.text}${when}${issue.isNew ? " [new]" : ""}`);
    }

    if (analysis.cookieBannerMissing) {
      console.log(
        `  - Cookie banner did not appear (looked for ${result.cookieBanner.selectors.join(", ")})`,
      );
    }
  }

  console.log("");
  console.log(`Full JSON report: ${reportPath}`);
}

async function main() {
  const injectTestAlert = await consumeTestAlertMarker();

  let sites = config.sites;
  if (config.siteFilter) {
    sites = sites.filter(
      (site) =>
        site.url.toLowerCase().includes(config.siteFilter) ||
        site.name.toLowerCase().includes(config.siteFilter),
    );
    console.log(`SITE_FILTER=${config.siteFilter}: checking ${sites.length} matching site(s).`);
  }

  if (sites.length === 0) {
    console.log("No sites to check.");
    return;
  }

  const previousReport = await loadPreviousReport();

  const browser = await puppeteer.launch({
    headless: config.headless,
    userDataDir: config.userDataDir,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  try {
    const userAgent = (await browser.userAgent()).replace("HeadlessChrome", "Chrome");

    const results = await runPool(
      sites,
      (site) => checkSite(browser, site, userAgent).catch((error) => crashedResult(site, error)),
      config.concurrency,
    );

    if (injectTestAlert && results.length > 0) {
      results[0].consoleMessages.unshift({
        type: "error",
        text: "Synthetic test console error generated for cron/Slack verification.",
        location: "console-error-bot:test-alert",
      });
      results[0].consoleErrorCount += 1;
    }

    const previousFingerprints = buildPreviousFingerprints(previousReport);
    for (const result of results) {
      result.analysis = classifyResult(result, config.noisePatterns);
      markNewIssues(result, result.analysis, previousFingerprints);
    }

    const reportPath = await writeReport(results);
    await pruneOldReports();
    printSummary(results, reportPath);

    const failing = results.filter((result) =>
      ["down", "errors"].includes(result.analysis.status),
    );

    if (failing.length > 0 && config.slack.enabled) {
      await sendMessageToConfiguredChannel(buildAlertMessage(results, reportPath));
      console.log("Slack alert sent.");
    }

    process.exitCode = failing.length > 0 ? 1 : 0;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Bot run failed.");
  console.error(error);
  process.exitCode = 1;
});
