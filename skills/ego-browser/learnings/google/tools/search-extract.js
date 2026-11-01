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
    throw new Error(
      `Google blocked the search and asked for a CAPTCHA (${blocked}). Hand the task space to the user to solve it, or use another search engine.`,
    );
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
