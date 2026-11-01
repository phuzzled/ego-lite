function decode(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(entry, name) {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
  return match ? decode(match[1]) : "";
}

/** Parse an arXiv Atom feed into paper records. Exported for tests. */
export function parseFeed(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
    const absUrl = tag(entry, "id");
    const pdf = /<link[^>]*title="pdf"[^>]*href="([^"]+)"/.exec(entry);
    return {
      id: absUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, ""),
      title: tag(entry, "title"),
      authors: [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map(
        (match) => decode(match[1]),
      ),
      summary: tag(entry, "summary"),
      published: tag(entry, "published"),
      absUrl,
      pdfUrl: pdf ? pdf[1] : absUrl.replace("/abs/", "/pdf/"),
    };
  });
}

/** Search arXiv. The API answers on export.arxiv.org, same origin as the page. */
export async function search(page, args = {}) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("arxiv search: query is required");
  const max = Math.max(
    1,
    Math.min(100, Math.trunc(Number(args.maxResults) || 10)),
  );
  const searchQuery = /^(all|ti|au|abs|cat|id):/.test(query)
    ? query
    : `all:${query}`;
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(searchQuery)}&start=0&max_results=${max}`;
  const origin = "https://export.arxiv.org/";
  if (!(await page.url()).startsWith(origin)) await page.goto(url);
  const response = await page.fetch(url);
  if (!response.ok) throw new Error(`arxiv search: HTTP ${response.status}`);
  return parseFeed(response.body);
}
