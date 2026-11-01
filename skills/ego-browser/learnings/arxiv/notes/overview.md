# arXiv

## Fastest paths
- Search API: `https://export.arxiv.org/api/query?search_query=all:<words>&max_results=10`
  returns an Atom feed. Field prefixes: `ti:` title, `au:` author, `abs:`
  abstract, `cat:` category (`cat:cs.CL`), `id:` an arXiv id. Combine with
  `AND`, `OR`, `ANDNOT`. The `search` tool parses the feed.
- Abstract page: `https://arxiv.org/abs/<id>`; `await page.read()` gives the
  title, authors and abstract.
- PDF: `https://arxiv.org/pdf/<id>`; `await page.goto(pdfUrl)` then
  `await page.read()` returns the text page by page (`source: "pdf"`).

## Notes
- Keep to about one API request every three seconds (arXiv's request).
- Ids look like `1706.03762` or `1706.03762v7`; older ones like
  `hep-th/9901001`.
