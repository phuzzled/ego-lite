# Bing Search

## Why Bing
- On a headless server, Google answers with `/sorry/` and DuckDuckGo with a
  bot check. Bing returns normal results, so `engine: "auto"` in
  `page.search()` tries it first.
- Never try to get past a human check. If Bing shows one, `page.search()`
  lists it in `blocked` and the `search` tool throws `EGO_SITE_BLOCKED`; hand
  the task space to the user or use another source.

## Use
- `await page.search("query", { engine: "bing", max: 10 })` returns
  `{ engine, results: [{ rank, title, url, snippet }], blocked }`.
- Or: `await page.site("bing").run("search", { query, maxResults: 10 })`.
- Result links go through `https://www.bing.com/ck/a?...&u=a1<base64url>`;
  the SDK decodes `u` to the real target URL.

## Page structure
- Results list: `#b_results`; one organic result: `li.b_algo`
- Title and link: `li.b_algo h2 a`
- Snippet: `.b_caption p` or `.b_lineclamp2` to `.b_lineclamp4`
- No results: `.b_no` ("There are no results for ...")
- Next page: `a.sb_pagN`, or add `&first=11`, `&first=21` to the URL
- In the EU a cookie banner (`#bnp_container`) may cover the page; results
  still load underneath. `await page.dismissConsent()` rejects it.
