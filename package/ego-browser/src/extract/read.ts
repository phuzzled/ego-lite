/**
 * page.read(): the readable part of a page as Markdown.
 *
 * `extractReadable` runs inside the page (in an isolated world). It picks the
 * main content the way Readability does, in a smaller form: a semantic
 * container (article, main, role=main, a known content id) when it holds most
 * of the text, otherwise the block whose paragraphs carry the most text. It
 * then walks that block and writes Markdown, skipping navigation, asides,
 * footers, hidden elements, forms and ad or share widgets. No external
 * library: the SDK ships as one file.
 */

export type ReadOptions = {
  mode?: "article" | "full";
  selector?: string;
  maxChars?: number;
};

export type ReadLink = { text: string; href: string };

export type ReadResult = {
  url: string;
  title: string;
  byline?: string;
  published?: string;
  lang?: string;
  markdown: string;
  links: ReadLink[];
  words: number;
  truncated: boolean;
  source: "article" | "main" | "body" | "selector" | "pdf";
  pages?: Array<{ n: number; text: string }>;
  warning?: string;
};

/** What extractReadable returns before Node-side truncation. */
export type RawReadResult =
  | (Omit<ReadResult, "truncated" | "words"> & { error?: undefined })
  | { error: string };

export const DEFAULT_READ_MAX_CHARS = 100_000;

/**
 * Cut Markdown at the last heading (or else paragraph) boundary before
 * maxChars. Returns the text and whether it was cut.
 */
export function truncateMarkdown(
  markdown: string,
  maxChars: number,
): { markdown: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { markdown, truncated: false };
  const head = markdown.slice(0, maxChars);
  // Prefer the latest heading, then paragraph, line, and word boundary that
  // still keeps at least half of the allowed text.
  const half = maxChars * 0.5;
  let cut = maxChars;
  for (const boundary of ["\n#", "\n\n", "\n", " "]) {
    const at = head.lastIndexOf(boundary);
    if (at >= half) {
      cut = at;
      break;
    }
  }
  return { markdown: head.slice(0, cut).trimEnd(), truncated: true };
}

/** Count words in Markdown text, ignoring link targets and markup. */
export function countWords(markdown: string): number {
  const text = markdown
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/[#>*_`|\-[\]!]/g, " ");
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu);
  return words ? words.length : 0;
}

/** Finish a raw page result: truncate and count words. */
export function finishReadResult(
  raw: Exclude<RawReadResult, { error: string }>,
  maxChars: number,
): ReadResult {
  const { markdown, truncated } = truncateMarkdown(raw.markdown, maxChars);
  return {
    ...raw,
    markdown,
    words: countWords(markdown),
    truncated,
  };
}

/**
 * Runs in the page. Self-contained: every helper is declared inside.
 * @param options { mode, selector }
 */
export function extractReadable(options: {
  mode?: string;
  selector?: string;
}): any {
  const doc = document;
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "CANVAS",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "BUTTON",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "FORM",
    "NAV",
    "ASIDE",
    "FOOTER",
    "DIALOG",
    "MENU",
  ]);
  const SKIP_ROLES = new Set([
    "navigation",
    "banner",
    "contentinfo",
    "complementary",
    "search",
    "menu",
    "menubar",
    "dialog",
    "alertdialog",
    "toolbar",
  ]);
  const NOISE =
    /(^|[\s_-])(ad|ads|advert|advertisement|sponsor(ed)?|promo|share|sharing|social|cookie|consent|newsletter|subscribe|related|recommend(ed|ations)?|comments?|breadcrumbs?|pagination|pager|skip-link|sr-only|visually-hidden|mw-editsection|navbox|noprint|toc|reflist-hidden|metadata|printfooter|catlinks)($|[\s_-])/i;
  const SKIP_SELECTORS = "sup.reference, .mw-editsection, .mw-jump-link";

  function textLength(element: Element): number {
    return ((element as HTMLElement).innerText || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim().length;
  }

  function isHidden(element: Element): boolean {
    if (element.hasAttribute("hidden")) return true;
    if (element.getAttribute("aria-hidden") === "true") return true;
    const style = getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden";
  }

  function isNoise(element: Element, root: Element, rootText: number) {
    if (element === root) return false;
    if (SKIP_TAGS.has(element.tagName)) return true;
    const role = element.getAttribute("role");
    if (role && SKIP_ROLES.has(role)) return true;
    if (element.tagName === "HEADER" && element.querySelector("nav")) {
      return true;
    }
    if (element.matches(SKIP_SELECTORS)) return true;
    const label = `${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`;
    if (label.trim() && NOISE.test(label)) {
      // Never drop a block that holds most of the content.
      return textLength(element) < rootText * 0.3;
    }
    return false;
  }

  function pickRoot(): { root: Element; source: string } | { error: string } {
    if (options.selector) {
      let found: Element | null = null;
      try {
        found = doc.querySelector(options.selector);
      } catch {
        return { error: `invalid CSS selector: ${options.selector}` };
      }
      if (!found) {
        return { error: `selector matched no element: ${options.selector}` };
      }
      return { root: found, source: "selector" };
    }
    const body = doc.body || doc.documentElement;
    if (options.mode === "full") return { root: body, source: "body" };
    const bodyText = Math.max(1, textLength(body));
    const articles = [...doc.querySelectorAll("article")]
      .map((element) => ({ element, length: textLength(element) }))
      .sort((a, b) => b.length - a.length);
    if (articles[0] && articles[0].length >= 500) {
      return { root: articles[0].element, source: "article" };
    }
    for (const selector of [
      "main",
      "[role=main]",
      "#mw-content-text",
      "#content",
      ".post-content",
      ".entry-content",
      ".article-body",
    ]) {
      const element = doc.querySelector(selector);
      if (element && textLength(element) >= Math.min(500, bodyText * 0.3)) {
        return { root: element, source: "main" };
      }
    }
    // Readability-style: credit each paragraph's text to its parent and,
    // at half weight, its grandparent; the best-scored block wins.
    const scores = new Map<Element, number>();
    for (const paragraph of doc.querySelectorAll("p, pre, td, li")) {
      const length = textLength(paragraph);
      if (length < 25) continue;
      const links = [...paragraph.querySelectorAll("a")].reduce(
        (sum, link) => sum + textLength(link),
        0,
      );
      const score = length * (1 - Math.min(1, links / length));
      const parent = paragraph.parentElement;
      if (!parent) continue;
      scores.set(parent, (scores.get(parent) || 0) + score);
      const grand = parent.parentElement;
      if (grand) scores.set(grand, (scores.get(grand) || 0) + score / 2);
    }
    let best: Element | null = null;
    let bestScore = 0;
    for (const [element, score] of scores) {
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    if (best && bestScore >= 200 && best !== body) {
      return { root: best, source: "main" };
    }
    return { root: body, source: "body" };
  }

  const picked = pickRoot();
  if ("error" in picked) return picked;
  const { root, source } = picked;
  const rootText = textLength(root);
  const links: Array<{ text: string; href: string }> = [];
  const seenLinks = new Set<string>();

  function absolute(href: string | null): string | null {
    if (!href) return null;
    try {
      const url = new URL(href, doc.baseURI);
      if (!/^(https?|mailto|ftp):$/.test(url.protocol)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function clean(text: string): string {
    return text.replace(/[\s ]+/g, " ");
  }

  function escapeInline(text: string): string {
    return text.replace(/([*_`[\]])/g, "\\$1");
  }

  // Inline content of an element as one Markdown line.
  function inline(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeInline(clean(node.textContent || ""));
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node as Element;
    if (isNoise(element, root, rootText) || isHidden(element)) return "";
    const tag = element.tagName;
    const inner = () =>
      [...element.childNodes].map((child) => inline(child)).join("");
    switch (tag) {
      case "BR":
        return "\n";
      case "IMG": {
        const alt = clean(element.getAttribute("alt") || "").trim();
        const src = absolute(element.getAttribute("src"));
        // Icons and badges are not content.
        const image = element as HTMLImageElement;
        const width = image.width || image.naturalWidth || 0;
        const height = image.height || image.naturalHeight || 0;
        if (width > 0 && height > 0 && width < 48 && height < 48) return "";
        return alt && src ? `![${escapeInline(alt)}](${src})` : "";
      }
      case "A": {
        const text = inner().trim();
        const href = absolute(element.getAttribute("href"));
        if (!text) return "";
        if (!href) return text;
        if (!seenLinks.has(href)) {
          seenLinks.add(href);
          links.push({ text: clean(element.textContent || "").trim(), href });
        }
        return `[${text}](${href})`;
      }
      case "STRONG":
      case "B": {
        const text = inner().trim();
        return text ? `**${text}**` : "";
      }
      case "EM":
      case "I": {
        const text = inner().trim();
        return text ? `*${text}*` : "";
      }
      case "CODE":
      case "KBD":
      case "SAMP": {
        const text = clean(element.textContent || "").trim();
        return text ? `\`${text.replace(/`/g, "'")}\`` : "";
      }
      case "SUP":
        return inner();
      default:
        return inner();
    }
  }

  const BLOCK_TAGS = new Set([
    "P",
    "DIV",
    "SECTION",
    "ARTICLE",
    "MAIN",
    "HEADER",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "UL",
    "OL",
    "LI",
    "PRE",
    "BLOCKQUOTE",
    "TABLE",
    "FIGURE",
    "FIGCAPTION",
    "HR",
    "DL",
    "DT",
    "DD",
    "ADDRESS",
    "DETAILS",
    "SUMMARY",
    "CENTER",
  ]);

  function isBlock(node: Node): boolean {
    return (
      node.nodeType === Node.ELEMENT_NODE &&
      BLOCK_TAGS.has((node as Element).tagName)
    );
  }

  function tidy(text: string): string {
    return text
      .split("\n")
      .map((line) => line.replace(/ +/g, " ").trim())
      .join("\n")
      .trim();
  }

  function tableMarkdown(table: Element): string {
    const rows: string[][] = [];
    for (const row of (table as HTMLTableElement).rows || []) {
      const cells = [...row.cells].map((cell) =>
        tidy(inline(cell)).replace(/\n/g, " ").replace(/\|/g, "\\|"),
      );
      if (cells.some((cell) => cell)) rows.push(cells);
    }
    if (rows.length === 0) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row: string[]) =>
      `| ${[...row, ...Array(width - row.length).fill("")].join(" | ")} |`;
    return [
      pad(rows[0]),
      `| ${Array(width).fill("---").join(" | ")} |`,
      ...rows.slice(1).map(pad),
    ].join("\n");
  }

  // Block content as a list of Markdown blocks.
  function blocks(node: Node, depth = 0): string[] {
    const out: string[] = [];
    let run = "";
    const flush = () => {
      const text = tidy(run);
      if (text) out.push(text);
      run = "";
    };
    for (const child of node.childNodes) {
      if (!isBlock(child)) {
        run += inline(child);
        continue;
      }
      flush();
      const element = child as Element;
      if (isNoise(element, root, rootText) || isHidden(element)) continue;
      const tag = element.tagName;
      if (/^H[1-6]$/.test(tag)) {
        const text = tidy(inline(element)).replace(/\n/g, " ");
        if (text) out.push(`${"#".repeat(Number(tag[1]))} ${text}`);
      } else if (tag === "P" || tag === "SUMMARY" || tag === "ADDRESS") {
        const text = tidy(inline(element));
        if (text) out.push(text);
      } else if (tag === "UL" || tag === "OL") {
        const items: string[] = [];
        let n = 0;
        for (const item of element.children) {
          if (item.tagName !== "LI" || isHidden(item)) continue;
          n += 1;
          const marker = tag === "OL" ? `${n}.` : "-";
          const parts = blocks(item, depth + 1);
          if (parts.length === 0) continue;
          const indent = "  ".repeat(depth);
          const [first, ...rest] = parts;
          items.push(
            [
              `${indent}${marker} ${first.replace(/\n/g, `\n${indent}  `)}`,
              ...rest.map((part) =>
                part.startsWith(`${"  ".repeat(depth + 1)}`) ||
                /^\s*(-|\d+\.) /.test(part)
                  ? part
                  : `${indent}  ${part.replace(/\n/g, `\n${indent}  `)}`,
              ),
            ].join("\n"),
          );
        }
        if (items.length) out.push(items.join("\n"));
      } else if (tag === "PRE") {
        const text = (element.textContent || "").replace(/\n+$/, "");
        if (text.trim()) out.push(`\`\`\`\n${text}\n\`\`\``);
      } else if (tag === "BLOCKQUOTE") {
        const inner = blocks(element, depth).join("\n\n");
        if (inner) out.push(inner.replace(/^/gm, "> "));
      } else if (tag === "TABLE") {
        const text = tableMarkdown(element);
        if (text) out.push(text);
      } else if (tag === "HR") {
        out.push("---");
      } else if (tag === "FIGCAPTION") {
        const text = tidy(inline(element));
        if (text) out.push(`*${text}*`);
      } else if (tag === "DT") {
        const text = tidy(inline(element));
        if (text) out.push(`**${text}**`);
      } else {
        out.push(...blocks(element, depth));
      }
    }
    flush();
    return out;
  }

  function meta(...names: string[]): string | undefined {
    for (const name of names) {
      const element = doc.querySelector(
        `meta[name="${name}"], meta[property="${name}"], meta[itemprop="${name}"]`,
      );
      const content = element?.getAttribute("content")?.trim();
      if (content) return content;
    }
    return undefined;
  }

  const markdownBlocks = blocks(root);
  // The page's own h1 is the cleanest title when the document title holds
  // it ("Web browser" in "Web browser - Wikipedia").
  const heading = clean(doc.querySelector("h1")?.textContent || "").trim();
  const documentTitle = clean(doc.title || "").trim();
  const title =
    (heading && documentTitle.includes(heading) ? heading : "") ||
    meta("og:title") ||
    documentTitle ||
    heading;
  const byline =
    meta("author", "article:author", "byl") ||
    clean(
      doc.querySelector('[rel="author"], .byline, .author, [itemprop="author"]')
        ?.textContent || "",
    ).trim() ||
    undefined;
  const published =
    meta("article:published_time", "datePublished", "date", "pubdate") ||
    doc.querySelector("time[datetime]")?.getAttribute("datetime") ||
    undefined;
  const lang = doc.documentElement.getAttribute("lang") || undefined;
  // Start with the title when the content does not already.
  const hasTitleHeading = /^# /.test(markdownBlocks[0] || "");
  if (!hasTitleHeading && title && source !== "selector") {
    markdownBlocks.unshift(`# ${title}`);
  }
  return {
    url: location.href,
    title,
    ...(byline && byline.length < 200 ? { byline } : {}),
    ...(published ? { published } : {}),
    ...(lang ? { lang } : {}),
    markdown: markdownBlocks.join("\n\n"),
    links,
    source,
  };
}

/** Runs in the page: is this document Chrome's PDF viewer or a PDF? */
export function detectPdfDocument(): { pdf: boolean; url: string } {
  const type = document.contentType || "";
  const embed = document.querySelector(
    'embed[type="application/pdf"], embed[original-url]',
  );
  return {
    pdf: type === "application/pdf" || Boolean(embed),
    url: (embed && embed.getAttribute("original-url")) || location.href,
  };
}
