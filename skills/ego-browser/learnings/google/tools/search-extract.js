function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

export async function searchAndExtract(ctx, args = {}) {
  const query = args.query || "";
  const maxResults = boundedInteger(args.maxResults, 10, 100);
  if (!query) throw new Error("search query is required");

  await ctx.openOrReuseTab(`https://www.google.com/search?q=${encodeURIComponent(query)}`, { wait: true });
  await ctx.waitForLoad();

  // Google answers automated traffic with an interstitial at /sorry/, which
  // has no results. Report it instead of returning an empty list.
  const blocked = await ctx.js(String.raw`(() => {
    const url = location.href
    return url.includes('/sorry/') || !!document.querySelector('#captcha-form, form[action*="sorry"]') ? url : ''
  })()`);
  if (blocked) {
    const error = new Error(
      `Google blocked the search and asked for a CAPTCHA (${blocked}). Hand the task space to the user to solve it, or use another search engine.`,
    );
    error.error_code = "EGO_SITE_BLOCKED";
    error.hint =
      'Use page.search(query, { engine: "bing" }) or the bing site tool, or hand the task space to the user. Do not try to bypass the check.';
    throw error;
  }

  const results = await ctx.js(String.raw`(() => {
    const items = [...document.querySelectorAll('div.g')]
    return items.slice(0, ${maxResults}).map(el => ({
      title: el.querySelector('h3')?.innerText?.trim() || '',
      url: el.querySelector('a')?.getAttribute('href') || '',
      snippet: el.querySelector('[data-sncf]')?.innerText?.trim() || el.querySelector('span')?.innerText?.trim() || '',
    })).filter(r => r.title)
  })()`);

  return results;
}

/**
 * v2: Google search with a Page. Throws EGO_SITE_BLOCKED on the /sorry/
 * check, which headless browsers on servers usually get.
 */
export async function search(page, args = {}) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("google search: query is required");
  const max = boundedInteger(args.maxResults, 10, 50);
  const result = await page.search(query, { engine: "google", max });
  if (result.engine === null) {
    const block = result.blocked[0] || {};
    const error = new Error(
      `google search was blocked: ${block.reason || "no results could be read"} (${block.url || "https://www.google.com"})`,
    );
    error.error_code = "EGO_SITE_BLOCKED";
    error.hint =
      block.hint ||
      'Use engine "bing", or hand the task space to the user. Do not try to bypass the check.';
    throw error;
  }
  return result.results;
}
