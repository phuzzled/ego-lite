# Wikipedia

## Fastest paths
- Summary of an article: `GET https://en.wikipedia.org/api/rest_v1/page/summary/<Title>`
  returns `{ title, description, extract, content_urls }`. Use `page.fetch()`
  from a Wikipedia page (same origin) or the `summary` tool.
- Full article: `await page.read()` on `/wiki/<Title>` gives Markdown without
  navigation, edit links and navboxes (20 to 40 KB for a long article, against
  more than 130 KB for a full-page snapshot).
- Tables: `await page.tables()` reads `table.wikitable` with multi-row headers
  joined, footnote markers dropped, and collapsed rows included. Navboxes and
  message boxes are skipped. An infobox comes back as a two-column table.
- Search: `https://en.wikipedia.org/w/index.php?search=<q>` redirects to the
  article on an exact title match.

## Selectors
- Article body: `#mw-content-text .mw-parser-output`
- Infobox: `table.infobox`
- Data tables: `table.wikitable`
- Footnote markers: `sup.reference` (dropped by read() and tables())
