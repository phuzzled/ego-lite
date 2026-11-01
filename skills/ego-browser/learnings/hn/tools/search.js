/** Hacker News story search through the Algolia API (CORS is open). */
export async function search(page, args = {}) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("hn search: query is required");
  const max = Math.max(
    1,
    Math.min(100, Math.trunc(Number(args.maxResults) || 20)),
  );
  const endpoint = args.sort === "date" ? "search_by_date" : "search";
  const origin = "https://hn.algolia.com/";
  if (!(await page.url()).startsWith(origin)) await page.goto(origin);
  const response = await page.fetch(
    `https://hn.algolia.com/api/v1/${endpoint}?tags=story&hitsPerPage=${max}&query=${encodeURIComponent(query)}`,
  );
  if (!response.ok) {
    throw new Error(`hn search: HTTP ${response.status}`);
  }
  const data = JSON.parse(response.body);
  return (data.hits || []).map((hit) => ({
    title: hit.title || "",
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    points: hit.points ?? 0,
    comments: hit.num_comments ?? 0,
    author: hit.author || "",
    createdAt: hit.created_at || "",
  }));
}
