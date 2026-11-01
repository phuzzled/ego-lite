# Reddit

## Fastest paths
- Add `.json` to most Reddit URLs: `/r/<sub>/hot.json?limit=25`,
  `/r/<sub>/comments/<id>.json`, `/search.json?q=<q>`. Fetch them with
  `page.fetch()` from a `https://www.reddit.com/` page (same origin). The
  `listing` tool does this.
- A post's comments: `GET <permalink>.json` returns `[post, comments]`.

## Blocks
- Reddit often answers servers and headless browsers with HTTP 403 or 429,
  or an HTML human check instead of JSON. The tool throws `EGO_SITE_BLOCKED`
  then. Do not retry in a loop and do not try to bypass it: hand the task
  space to the user, or use another source.

## Notes
- `old.reddit.com` is plain HTML: posts are `div.thing`, titles `a.title`.
