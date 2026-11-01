/**
 * Bing search with a v2 Page. Bing is the engine that answers automated
 * browsers on servers today; Google and DuckDuckGo usually show a bot check.
 * The result parsing lives in the SDK's page.search(), so this tool and the
 * helper stay in step.
 */
export async function search(page, args = {}) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("bing search: query is required");
  const max = Math.max(
    1,
    Math.min(50, Math.trunc(Number(args.maxResults) || 10)),
  );
  const result = await page.search(query, { engine: "bing", max });
  if (result.engine === null) {
    const block = result.blocked[0] || {};
    const error = new Error(
      `bing search was blocked: ${block.reason || "no results could be read"} (${block.url || "https://www.bing.com"})`,
    );
    error.error_code = "EGO_SITE_BLOCKED";
    error.hint =
      block.hint ||
      "Hand the task space to the user with await task.handOff(), or use another source. Do not try to bypass the check.";
    throw error;
  }
  return result.results;
}
