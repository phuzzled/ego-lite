# Hacker News

## Fastest paths
- Search: `https://hn.algolia.com/api/v1/search?query=<q>&tags=story`
  (relevance) or `/search_by_date` (newest first). JSON, open CORS. The
  `search` tool wraps it.
- One item with its comment tree: `https://hn.algolia.com/api/v1/items/<id>`.
- Front page: `https://news.ycombinator.com/` is plain HTML; each story row is
  `tr.athing` with the title link in `.titleline > a`; the score and comment
  count are in the next row's `.subline`.

## Notes
- Item pages: `https://news.ycombinator.com/item?id=<id>`.
- Algolia hit fields: `title`, `url` (missing for Ask HN), `points`,
  `num_comments`, `author`, `created_at`, `objectID`.
