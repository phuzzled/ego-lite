function blocked(message) {
  const error = new Error(message);
  error.error_code = "EGO_SITE_BLOCKED";
  error.hint =
    "Reddit refused this browser. Hand the task space to the user with await task.handOff(), or use another source. Do not try to bypass the check.";
  return error;
}

/** Read a subreddit or a search through Reddit's .json endpoints. */
export async function listing(page, args = {}) {
  const subreddit =
    typeof args.subreddit === "string"
      ? args.subreddit.replace(/^\/?r\//, "").trim()
      : "";
  if (subreddit && !/^[A-Za-z0-9_]{2,32}$/.test(subreddit)) {
    throw new Error(`reddit listing: invalid subreddit ${JSON.stringify(subreddit)}`);
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const sort = ["hot", "new", "top", "relevance"].includes(args.sort)
    ? args.sort
    : query
      ? "relevance"
      : "hot";
  const limit = Math.max(
    1,
    Math.min(100, Math.trunc(Number(args.maxResults) || 25)),
  );
  const base = "https://www.reddit.com";
  const path = query
    ? `${subreddit ? `/r/${subreddit}` : ""}/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=${limit}${subreddit ? "&restrict_sr=1" : ""}`
    : `/r/${subreddit || "all"}/${sort}.json?limit=${limit}`;
  // The .json endpoints are same-origin only: start from a Reddit page.
  if (!(await page.url()).startsWith(base)) await page.goto(`${base}/`);
  const response = await page.fetch(`${base}${path}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 403 || response.status === 429) {
    throw blocked(`reddit answered HTTP ${response.status} for ${path}`);
  }
  if (!response.ok) throw new Error(`reddit listing: HTTP ${response.status}`);
  let data;
  try {
    data = JSON.parse(response.body);
  } catch {
    throw blocked("reddit answered with a page instead of JSON (a human check?)");
  }
  return (data?.data?.children || []).map(({ data: post }) => ({
    title: post.title || "",
    url: post.url || "",
    permalink: `${base}${post.permalink || ""}`,
    subreddit: post.subreddit || "",
    author: post.author || "",
    score: post.score ?? 0,
    comments: post.num_comments ?? 0,
    createdAt: post.created_utc
      ? new Date(post.created_utc * 1000).toISOString()
      : "",
  }));
}
