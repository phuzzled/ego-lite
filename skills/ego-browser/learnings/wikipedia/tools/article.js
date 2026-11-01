/** Open a Wikipedia article and read it as Markdown plus its data tables. */
export async function article(page, args = {}) {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) throw new Error("wikipedia article: title is required");
  const lang = /^[a-z-]{2,12}$/.test(args.lang || "") ? args.lang : "en";
  const url = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  await page.goto(url);
  const doc = await page.read({ maxChars: Number(args.maxChars) || 50000 });
  const tables = await page
    .tables({ selector: "#mw-content-text" })
    .catch(() => []);
  return {
    url: doc.url,
    title: doc.title,
    markdown: doc.markdown,
    truncated: doc.truncated,
    tables: tables
      .filter((table) => table.rowCount > 0)
      .map(({ caption, headers, rows }) => ({ caption, headers, rows })),
  };
}
