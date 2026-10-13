// Finds a site's cookie banner, accepts it, and reports whether the banner
// was there at all. Every site is visited in a fresh browser session, so the
// banner should appear on every run; if it doesn't, real first-time visitors
// aren't seeing it either.

const { setTimeout: delay } = require("node:timers/promises");

const POLL_INTERVAL_MS = 500;
const CLICK_ATTEMPTS = 3;
const DISMISS_TIMEOUT_MS = 2500;

// True when an element matching the selector is rendered inside the viewport.
// Banners that slide in start off-screen, and dismissed banners often stay in
// the DOM hidden or parked off-screen, so presence alone proves nothing.
async function isShowing(page, selector) {
  return page
    .evaluate((selectorArg) => {
      let elements = [];
      try {
        elements = [...document.querySelectorAll(selectorArg)];
      } catch {
        return false;
      }

      return elements.some((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          return false;
        }

        if (
          rect.bottom <= 0 ||
          rect.right <= 0 ||
          rect.top >= window.innerHeight ||
          rect.left >= window.innerWidth
        ) {
          return false;
        }

        return element.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        });
      });
    }, selector)
    .catch(() => false);
}

async function waitForBanner(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    for (const selector of selectors) {
      if (await isShowing(page, selector)) {
        return selector;
      }
    }

    if (Date.now() >= deadline) {
      return null;
    }

    await delay(POLL_INTERVAL_MS);
  }
}

async function waitUntilDismissed(page, selector) {
  const deadline = Date.now() + DISMISS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (!(await isShowing(page, selector))) {
      return true;
    }

    await delay(250);
  }

  return !(await isShowing(page, selector));
}

// Returns how the banner was accepted ("click" | "dom-click") or null if it
// would not go away.
async function acceptBanner(page, selector) {
  // Click straight away, like an impatient visitor: some tracking errors only
  // happen when consent arrives before the page's first analytics hit. A
  // click that misses a still-animating banner is simply retried.
  for (let attempt = 1; attempt <= CLICK_ATTEMPTS; attempt += 1) {
    try {
      await page.click(selector);
    } catch {
      // Still animating or covered; checked below and retried.
    }

    if (await waitUntilDismissed(page, selector)) {
      return "click";
    }
  }

  // Page preloaders and marketing pop-ups can sit on top of the banner and
  // swallow real mouse clicks, so fall back to clicking through the DOM.
  await page
    .evaluate((selectorArg) => {
      const button = document.querySelector(selectorArg);
      if (button) {
        button.click();
      }
    }, selector)
    .catch(() => {});

  return (await waitUntilDismissed(page, selector)) ? "dom-click" : null;
}

// status is "shown", "missing", or "not-configured" (no selectors for the
// site, so there is nothing to look for).
async function checkCookieBanner(page, selectors, timeoutMs) {
  if (!selectors || selectors.length === 0) {
    return { status: "not-configured", selectors: [], accepted: false };
  }

  const selector = await waitForBanner(page, selectors, timeoutMs);
  if (!selector) {
    return { status: "missing", selectors, accepted: false };
  }

  const acceptMethod = await acceptBanner(page, selector);
  return {
    status: "shown",
    selectors,
    selector,
    accepted: acceptMethod !== null,
    acceptMethod,
  };
}

module.exports = {
  checkCookieBanner,
};
