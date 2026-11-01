function wikiUrl(lang, path, title = "") {
  const host = `https://${/^[a-z-]{2,12}$/.test(lang) ? lang : "en"}.wikipedia.org`;
  return `${host}${path}${encodeURIComponent(title.trim().replace(/ /g, "_"))}`;
}

/** The REST summary of one article, fetched from a Wikipedia page. */
export async function summary(page, args = {}) {
  const title = typeof args.title === "string" ? args.title : "";
  if (!title.trim()) throw new Error("wikipedia summary: title is required");
  const lang = args.lang || "en";
  // page.fetch obeys CORS, so fetch from a page on the same origin.
  const origin = wikiUrl(lang, "/");
  if (!(await page.url()).startsWith(origin)) {
    await page.goto(wikiUrl(lang, "/wiki/", "Special:BlankPage"));
  }
  const response = await page.fetch(
    wikiUrl(lang, "/api/rest_v1/page/summary/", title),
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(
      `wikipedia summary: HTTP ${response.status} for ${JSON.stringify(title)}`,
    );
  }
  const data = JSON.parse(response.body);
  return {
    title: data.title,
    description: data.description || "",
    extract: data.extract || "",
    url: data.content_urls?.desktop?.page || wikiUrl(lang, "/wiki/", title),
    lastModified: data.timestamp || "",
  };
}
