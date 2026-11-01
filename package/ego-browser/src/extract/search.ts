/**
 * page.search(): web search with an honest result.
 *
 * Big engines answer automated browsers with a bot check. This helper never
 * tries to solve or hide from one. It reads the results page, and when the
 * engine shows a check, an error page, or anything it cannot read, it says so
 * in `blocked` (with a hint) instead of returning an empty list as if the
 * search had found nothing. With engine "auto" it tries the next engine.
 * Bing works from servers today; Google and DuckDuckGo usually block a
 * headless browser.
 */

export type SearchEngine = "bing" | "duckduckgo" | "google";

export type SearchOptions = {
  engine?: SearchEngine | "auto";
  max?: number;
  timeout?: number;
};

export type SearchResultItem = {
  rank: number;
  title: string;
  url: string;
  snippet: string;
};

export type SearchBlock = {
  engine: SearchEngine;
  url: string;
  reason: string;
  hint: string;
};

export type SearchResult = {
  engine: SearchEngine | null;
  query: string;
  url?: string;
  results: SearchResultItem[];
  blocked: SearchBlock[];
  /** True when an engine answered and said it found nothing. */
  noResults?: boolean;
  /**
   * Set when the results look unrelated to the query, or the engine said it
   * found nothing: both can be a soft block. With engine "auto" the next
   * engine is tried first.
   */
  warning?: string;
};

/**
 * A warning when most results mention no word of the query. Engines that
 * distrust a browser sometimes answer with unrelated results instead of a
 * check (Bing does this from servers); this says so instead of passing them
 * off as an answer.
 */
export function relevanceWarning(
  query: string,
  results: Array<{ title: string; url: string; snippet: string }>,
): string | undefined {
  if (results.length === 0) return undefined;
  const terms = query
    .toLowerCase()
    .replace(/\b[a-z]+:\S*/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 3);
  if (terms.length === 0) return undefined;
  const related = results.filter((result) => {
    const text =
      `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
    return terms.some((term) => text.includes(term));
  }).length;
  if (related === 0) {
    return "no result mentions any word of the query; the engine may be answering an automated browser with unrelated results. Check them, try another engine, or hand off to the user.";
  }
  if (related * 2 < results.length) {
    return `only ${related} of ${results.length} results mention a word of the query; the engine may be mixing in unrelated results for an automated browser. Check them, or try another engine.`;
  }
  return undefined;
}

/** The warning for an engine that says it found nothing. */
export function noResultsWarning(engine: SearchEngine): string {
  return `${engine} says it found nothing. From an automated browser an engine sometimes says so for ordinary queries; try another engine before concluding that nothing exists.`;
}

export const SEARCH_ENGINES: readonly SearchEngine[] = [
  "bing",
  "duckduckgo",
  "google",
];

/** The engines tried, in order, for engine "auto". */
export function searchEngineOrder(
  engine: SearchEngine | "auto" | undefined,
  configured = process.env.EGO_BROWSER_SEARCH_ENGINE,
): SearchEngine[] {
  if (engine && engine !== "auto") return [engine];
  const first = SEARCH_ENGINES.find((name) => name === configured);
  return first
    ? [first, ...SEARCH_ENGINES.filter((name) => name !== first)]
    : [...SEARCH_ENGINES];
}

export function searchUrl(engine: SearchEngine, query: string): string {
  const q = encodeURIComponent(query);
  switch (engine) {
    case "bing":
      // form=QBLH marks a typed query; without it Bing often answers a
      // headless browser with unrelated or empty results.
      return `https://www.bing.com/search?q=${q}&form=QBLH&setlang=en&cc=US`;
    case "duckduckgo":
      return `https://html.duckduckgo.com/html/?q=${q}`;
    case "google":
      return `https://www.google.com/search?q=${q}&hl=en`;
  }
}

export const BLOCK_HINT =
  'This engine asked for a human check or could not be read. Try engine: "bing" (or "auto"), or hand the task space to the user with await task.handOff() to solve it. Do not try to bypass the check.';

/**
 * Turn an engine's tracking link into the target URL: Bing's /ck/a?u=a1...
 * (base64url), DuckDuckGo's /l/?uddg=..., Google's /url?q=...
 */
export function unwrapResultUrl(href: string): string {
  try {
    const url = new URL(href);
    if (/(^|\.)bing\.com$/.test(url.hostname) && url.pathname === "/ck/a") {
      const u = url.searchParams.get("u");
      if (u && u.startsWith("a1")) {
        const decoded = Buffer.from(
          u.slice(2).replace(/-/g, "+").replace(/_/g, "/"),
          "base64",
        ).toString("utf8");
        if (/^https?:\/\//.test(decoded)) return decoded;
      }
    }
    if (/duckduckgo\.com$/.test(url.hostname) && url.pathname === "/l/") {
      const target = url.searchParams.get("uddg");
      if (target) return target;
    }
    if (
      /(^|\.)google\.[a-z.]+$/.test(url.hostname) &&
      url.pathname === "/url"
    ) {
      const target = url.searchParams.get("q") || url.searchParams.get("url");
      if (target && /^https?:\/\//.test(target)) return target;
    }
  } catch {
    // Keep the original link.
  }
  return href;
}

/** What parseSearchPage returns from the page. */
export type ParsedSearchPage = {
  url: string;
  blocked?: string;
  noResults?: boolean;
  results: Array<{ title: string; url: string; snippet: string }>;
};

/** Runs in the page. Self-contained. Reads one engine's results page. */
export function parseSearchPage(options: { engine: string; max: number }): any {
  const doc = document;
  const href = location.href;
  const text = (doc.body?.innerText || "").slice(0, 5000);
  const clean = (value: string | null | undefined) =>
    (value || "").replace(/\s+/g, " ").trim();
  const result = (blocked?: string) => ({
    url: href,
    ...(blocked ? { blocked } : {}),
    results: [] as Array<{ title: string; url: string; snippet: string }>,
  });

  // Bot checks and interstitials first.
  if (options.engine === "google") {
    if (
      /\/sorry\//.test(href) ||
      doc.querySelector('#captcha-form, form[action*="sorry"], #recaptcha')
    ) {
      return result("Google showed its unusual-traffic check (/sorry/)");
    }
    if (/consent\.google\./.test(location.hostname)) {
      return result("Google showed its consent page instead of results");
    }
  }
  if (options.engine === "duckduckgo") {
    if (
      doc.querySelector(".anomaly-modal, #challenge-form, .challenge-form") ||
      /bots use DuckDuckGo too|unusual activity|confirm this search was made by a human/i.test(
        text,
      )
    ) {
      return result("DuckDuckGo showed its bot check");
    }
  }
  if (options.engine === "bing") {
    if (
      /\/(challenge|turing)\b/i.test(location.pathname) ||
      doc.querySelector(
        "#b_captcha, #turingcaptcha, iframe[src*='challenges.cloudflare.com']",
      ) ||
      /verify (that )?you are (a )?human|solve the challenge/i.test(text)
    ) {
      return result("Bing showed a human check");
    }
  }
  if (/captcha|are you a robot|unusual traffic/i.test(text.slice(0, 1500))) {
    const resultish = doc.querySelectorAll(
      "li.b_algo, .result__a, #search h3",
    ).length;
    if (resultish === 0) return result("the page asks for a human check");
  }

  const items: Array<{ title: string; url: string; snippet: string }> = [];
  const push = (title: string, url: string | null, snippet: string) => {
    if (!title || !url || !/^https?:\/\//.test(url)) return;
    if (items.some((item) => item.url === url)) return;
    items.push({ title, url, snippet });
  };
  if (options.engine === "bing") {
    for (const li of Array.from(
      doc.querySelectorAll("#b_results > li.b_algo, li.b_algo"),
    )) {
      const link = li.querySelector("h2 a") as HTMLAnchorElement | null;
      if (!link) continue;
      const snippet =
        li.querySelector(
          ".b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, .b_paractl, p",
        ) || null;
      push(clean(link.textContent), link.href, clean(snippet?.textContent));
    }
    const none =
      doc.querySelector(".b_no, #b_results .b_ans .b_no") ||
      /There are no results for|No results found for/i.test(text);
    return {
      url: href,
      results: items.slice(0, options.max),
      ...(none && items.length === 0 ? { noResults: true } : {}),
    };
  }
  if (options.engine === "duckduckgo") {
    for (const block of Array.from(doc.querySelectorAll(".result"))) {
      if (block.classList.contains("result--ad")) continue;
      const link = block.querySelector(
        "a.result__a",
      ) as HTMLAnchorElement | null;
      if (!link) continue;
      push(
        clean(link.textContent),
        link.href,
        clean(block.querySelector(".result__snippet")?.textContent),
      );
    }
    const none =
      doc.querySelector(".no-results") ||
      /No results\.|No  results found/i.test(text);
    return {
      url: href,
      results: items.slice(0, options.max),
      ...(none && items.length === 0 ? { noResults: true } : {}),
    };
  }
  // Google: organic results are an h3 inside a link.
  for (const heading of Array.from(
    doc.querySelectorAll("#search a h3, #rso a h3"),
  )) {
    const link = heading.closest("a") as HTMLAnchorElement | null;
    if (!link) continue;
    const container =
      link.closest("div.g, div[data-hveid], div.MjjYud") || link.parentElement;
    const snippet =
      container?.querySelector("[data-sncf], .VwiC3b, .IsZvec, span.aCOpRe") ||
      null;
    push(clean(heading.textContent), link.href, clean(snippet?.textContent));
  }
  const none = /did not match any documents|No results found for/i.test(text);
  return {
    url: href,
    results: items.slice(0, options.max),
    ...(none && items.length === 0 ? { noResults: true } : {}),
  };
}

/**
 * Turn one parsed page into either results or a block. A page that is not a
 * bot check but yields no results and no "nothing found" marker is reported
 * as unreadable, never as an empty success.
 */
export function judgeSearchPage(
  engine: SearchEngine,
  page: ParsedSearchPage,
):
  | { ok: true; results: SearchResultItem[]; noResults?: boolean }
  | { ok: false; block: SearchBlock } {
  if (page.blocked) {
    return {
      ok: false,
      block: { engine, url: page.url, reason: page.blocked, hint: BLOCK_HINT },
    };
  }
  if (page.results.length === 0 && !page.noResults) {
    return {
      ok: false,
      block: {
        engine,
        url: page.url,
        reason:
          "no results could be read from the page; it may be a bot check, a consent page, or a changed layout",
        hint: BLOCK_HINT,
      },
    };
  }
  return {
    ok: true,
    results: page.results.map((item, i) => ({
      rank: i + 1,
      title: item.title,
      url: unwrapResultUrl(item.url),
      snippet: item.snippet,
    })),
    ...(page.noResults ? { noResults: true } : {}),
  };
}
