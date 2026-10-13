// Turns the raw signals captured for a site (console messages, page errors,
// failed requests/responses) into a small set of actionable "issues", with
// third-party/analytics noise filtered out and a fingerprint per issue so
// consecutive runs can tell new problems from known ones.

const SECOND_LEVEL_TLDS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "net.uk",
  "eu.com",
  "us.com",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "org.nz",
]);

const BLOCKED_TITLE_PATTERN =
  /just a moment|attention required|access denied|verify you are|are you a robot|checking your browser|cloudflare/i;

function apexDomain(hostname) {
  const parts = hostname.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length <= 2) {
    return parts.join(".");
  }

  const lastTwo = parts.slice(-2).join(".");
  return SECOND_LEVEL_TLDS.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function extractFirstUrl(text) {
  const match = text.match(/https?:\/\/[^\s"'`)\]>,]+/i);
  return match ? match[0] : null;
}

function isThirdParty(resourceUrl, siteUrl) {
  const resourceHost = safeHostname(resourceUrl);
  const siteHost = safeHostname(siteUrl);
  if (!resourceHost || !siteHost) {
    return false;
  }

  return apexDomain(resourceHost) !== apexDomain(siteHost);
}

function stripQuery(url) {
  return url.replace(/[?#].*$/, "");
}

function fingerprint(siteUrl, text) {
  const normalized = text
    .toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, (url) => stripQuery(url))
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  return `${siteUrl}|${normalized}`;
}

const CSP_PATTERN = /content security policy/i;
const CSP_REPORT_ONLY_PATTERN = /report[- ]only/i;

// A CSP violation is the site's own policy blocking something, so it is the
// site's problem to fix even when the blocked URL is a third-party tracker.
function isCspViolation(text) {
  return CSP_PATTERN.test(text) && !CSP_REPORT_ONLY_PATTERN.test(text);
}

// Chrome logs the same blocked request more than once with different wording
// ("Connecting to X violates..." and "Fetch API cannot load X. Refused to
// connect..."), so violations are keyed by what was blocked.
function parseCspViolation(text) {
  const blockedUrl = extractFirstUrl(text.split(/violates|because it/i)[0]);
  const directiveMatch = text.match(/directive: "([a-z-]+)/i);
  const directive = directiveMatch ? directiveMatch[1] : "";
  const key = blockedUrl
    ? stripQuery(blockedUrl).replace(/[.,]+$/, "")
    : text.split(/violates|because it/i)[0].trim().slice(0, 120);

  return { key, directive, isUrl: Boolean(blockedUrl) };
}

function cspFingerprint(siteUrl, text) {
  return fingerprint(siteUrl, `csp ${parseCspViolation(text).key}`);
}

function isNoiseText(text, siteUrl, noisePatterns) {
  if (text.startsWith("%c")) {
    return true;
  }

  if (noisePatterns.some((pattern) => pattern.test(text))) {
    return true;
  }

  const embeddedUrl = extractFirstUrl(text);
  return Boolean(embeddedUrl && isThirdParty(embeddedUrl, siteUrl));
}

function describeHttpStatus(status) {
  if (status === 403) {
    return "HTTP 403 (access denied — possibly bot protection on this file)";
  }

  if (status === 404) {
    return "HTTP 404 (file not found)";
  }

  if (status >= 500) {
    return `HTTP ${status} (server error)`;
  }

  return `HTTP ${status}`;
}

function classifyResult(result, noisePatterns) {
  const siteUrl = result.finalUrl || result.url;
  const resourceIssues = [];
  const jsIssues = [];
  const seenResources = new Set();
  const jsIssuesByFingerprint = new Map();
  const cspIssues = [];
  const cspIssuesByFingerprint = new Map();
  let noiseCount = 0;

  const addCspIssue = (text, phase) => {
    const { key, directive, isUrl } = parseCspViolation(text);
    const issueFingerprint = cspFingerprint(result.url, text);
    const existing = cspIssuesByFingerprint.get(issueFingerprint);
    if (existing) {
      existing.count += 1;
      existing.directive = existing.directive || directive;
      return;
    }

    const issue = {
      blocked: key,
      isUrl,
      directive,
      phase: phase || "load",
      count: 1,
      fingerprint: issueFingerprint,
    };
    cspIssuesByFingerprint.set(issueFingerprint, issue);
    cspIssues.push(issue);
  };

  const addJsIssue = (text, location, source) => {
    const issueFingerprint = fingerprint(result.url, text);
    const existing = jsIssuesByFingerprint.get(issueFingerprint);
    if (existing) {
      existing.count += 1;
      return;
    }

    const issue = {
      text,
      location,
      source,
      count: 1,
      fingerprint: issueFingerprint,
    };
    jsIssuesByFingerprint.set(issueFingerprint, issue);
    jsIssues.push(issue);
  };

  const addResource = (url, detail) => {
    const cleanUrl = stripQuery(url);
    if (seenResources.has(cleanUrl)) {
      return;
    }

    seenResources.add(cleanUrl);
    if (isThirdParty(url, siteUrl) || noisePatterns.some((pattern) => pattern.test(url))) {
      noiseCount += 1;
      return;
    }

    resourceIssues.push({
      url: cleanUrl,
      detail,
      fingerprint: fingerprint(result.url, cleanUrl),
    });
  };

  for (const response of result.failedResponses || []) {
    addResource(response.url, describeHttpStatus(response.status));
  }

  for (const request of result.failedRequests || []) {
    if (request.failureText === "net::ERR_ABORTED") {
      continue;
    }

    addResource(request.url, request.failureText);
  }

  for (const message of result.consoleMessages || []) {
    if (message.type !== "error") {
      continue;
    }

    // "Failed to load resource" console errors duplicate what
    // failedResponses/failedRequests already capture with a proper URL.
    if (message.text.startsWith("Failed to load resource")) {
      continue;
    }

    if (isCspViolation(message.text)) {
      addCspIssue(message.text, message.phase);
      continue;
    }

    if (isNoiseText(message.text, siteUrl, noisePatterns)) {
      noiseCount += 1;
      continue;
    }

    addJsIssue(message.text, message.location || "", "console");
  }

  let downReason = "";
  for (const pageError of result.pageErrors || []) {
    if (pageError.message.startsWith("Navigation failed:")) {
      downReason = pageError.message;
      continue;
    }

    if (isNoiseText(pageError.message, siteUrl, noisePatterns)) {
      noiseCount += 1;
      continue;
    }

    addJsIssue(pageError.message, "", "pageerror");
  }

  // Text is built last because a duplicate may have supplied the directive.
  const finalCspIssues = cspIssues.map((issue) => ({
    ...issue,
    text: `Blocked by the site's Content Security Policy${
      issue.directive ? ` (${issue.directive})` : ""
    }: ${issue.blocked}`,
  }));

  const cookieBannerMissing = Boolean(result.cookieBanner && result.cookieBanner.status === "missing");

  let status = "ok";
  if (result.navigationStatus === "failed") {
    status = "down";
  } else if (result.blocked) {
    status = "blocked";
  } else if (
    resourceIssues.length > 0 ||
    jsIssues.length > 0 ||
    finalCspIssues.length > 0 ||
    cookieBannerMissing
  ) {
    status = "errors";
  }

  return {
    status,
    downReason,
    resourceIssues,
    jsIssues,
    cspIssues: finalCspIssues,
    cookieBannerMissing,
    cookieBannerIsNew: false,
    noiseCount,
    hasNewIssues: false,
  };
}

function cookieBannerFingerprint(siteUrl, state) {
  return `${siteUrl}|cookie-banner-${state}`;
}

// Builds site-url → Set(fingerprints) from a previous report so the current
// run can mark which issues are new. Works with both old- and new-format
// reports because it fingerprints the raw captured signals.
function buildPreviousFingerprints(previousReport) {
  const bySite = new Map();
  if (!previousReport || !Array.isArray(previousReport.results)) {
    return bySite;
  }

  for (const result of previousReport.results) {
    const fingerprints = new Set();

    for (const message of result.consoleMessages || []) {
      if (message.type === "error") {
        fingerprints.add(fingerprint(result.url, message.text));
        if (isCspViolation(message.text)) {
          fingerprints.add(cspFingerprint(result.url, message.text));
        }
      }
    }

    // Reports written before banner detection existed have no cookieBanner
    // entry, so a missing banner can't be called "new" against them.
    if (result.cookieBanner && result.cookieBanner.status !== "unknown") {
      fingerprints.add(cookieBannerFingerprint(result.url, "checked"));
      if (result.cookieBanner.status === "missing") {
        fingerprints.add(cookieBannerFingerprint(result.url, "missing"));
      }
    }

    for (const pageError of result.pageErrors || []) {
      fingerprints.add(fingerprint(result.url, pageError.message));
    }

    for (const request of result.failedRequests || []) {
      fingerprints.add(fingerprint(result.url, stripQuery(request.url)));
    }

    for (const response of result.failedResponses || []) {
      fingerprints.add(fingerprint(result.url, stripQuery(response.url)));
    }

    bySite.set(result.url, fingerprints);
  }

  return bySite;
}

function markNewIssues(result, analysis, previousFingerprints) {
  const previous = previousFingerprints.get(result.url);
  if (!previous) {
    // No previous data for this site: nothing to compare against, so do not
    // claim anything is "new".
    return;
  }

  for (const issue of [...analysis.resourceIssues, ...analysis.jsIssues, ...analysis.cspIssues]) {
    issue.isNew = !previous.has(issue.fingerprint);
    if (issue.isNew) {
      analysis.hasNewIssues = true;
    }
  }

  if (
    analysis.cookieBannerMissing &&
    previous.has(cookieBannerFingerprint(result.url, "checked")) &&
    !previous.has(cookieBannerFingerprint(result.url, "missing"))
  ) {
    analysis.cookieBannerIsNew = true;
    analysis.hasNewIssues = true;
  }
}

module.exports = {
  BLOCKED_TITLE_PATTERN,
  buildPreviousFingerprints,
  classifyResult,
  markNewIssues,
};
