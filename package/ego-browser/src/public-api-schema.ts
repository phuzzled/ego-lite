export type PublicApiOptionKind =
  | "boolean"
  | "clip"
  | "finiteNumber"
  | "nonNegativeNumber"
  | "nonNegativeInteger"
  | "nonEmptyString"
  | "pageRetention"
  | "positiveInteger"
  | "positiveMilliseconds"
  | "responseMatcher"
  | "settle"
  | "string"
  | "stringRecord"
  | "point";

export type PublicApiOption = {
  description: string;
  kind: PublicApiOptionKind;
  values?: readonly string[];
};

export type PublicApiEntry = {
  name: string;
  signature: string;
  /** What the call resolves to, shown by help() on its own line. */
  returns: string;
  summary: string;
  options?: Record<string, PublicApiOption>;
};

const option = (
  kind: PublicApiOptionKind,
  description: string,
  values?: readonly string[],
): PublicApiOption => ({ kind, description, values });

const timeout = option(
  "positiveMilliseconds",
  "Maximum duration in milliseconds.",
);
const actionTimeout = option(
  "positiveMilliseconds",
  "Maximum wait for the element to become usable in milliseconds; defaults to 3000.",
);
const delay = option("nonNegativeNumber", "Input delay in milliseconds.");
const button = option("string", "Mouse button.", ["left", "middle", "right"]);
const position = option(
  "point",
  "CSS-pixel offset from the element's top-left corner.",
);
const force = option("boolean", "Bypass pointer interception checks.");
const label = option(
  "nonEmptyString",
  "Concise user-visible action description shown with the native mouse highlight.",
);

/**
 * Single source of truth for the v2 surface shown to Agents. Runtime option
 * validation, default help, and the generated Markdown reference all consume
 * this schema. Legacy helpers intentionally remain outside it.
 */
export const PUBLIC_API_SCHEMA: readonly PublicApiEntry[] = [
  {
    name: "profiles",
    signature: "await profiles()",
    returns: "Promise<Array<{ id, name, isDefault, ephemeral? }>>",
    summary:
      'List browser profiles available for new task spaces. On hosts with throwaway profiles, { id: "ephemeral", ephemeral: true } gives a space its own empty cookie jar that finish() deletes.',
  },
  {
    name: "listTaskSpaces",
    signature: "await listTaskSpaces()",
    returns:
      "Promise<Array<{ id, name, ownership?, createdBy?, profileId?, profileName?, recentTabTitles?, secrets? }>>",
    summary:
      "List Agent-owned and user-owned spaces available to reuse or claim.",
  },
  {
    name: "taskSpace",
    signature:
      "await taskSpace(nameOrId, { profileId?, ttlMs?, restorePages? })",
    returns: "Promise<TaskSpace>",
    summary:
      "Reuse or create an Agent-owned task space; a name held by a user-owned space fails with EGO_TASK_SPACE_NAME_IN_USE. A new space starts with managed Page p1, and profileId and ttlMs apply only when creating it.",
    options: {
      profileId: option(
        "nonEmptyString",
        "Browser profile id returned by profiles(); new spaces only.",
      ),
      ttlMs: option(
        "positiveInteger",
        "Close the space after this long without use (hosts with a task-space TTL, such as Linux; ignored elsewhere); new spaces only.",
      ),
      restorePages: option(
        "boolean",
        "After a browser restart, reopen the space's lost Pages with their labels (task.restorePages(); hosts that support it).",
      ),
    },
  },
  {
    name: "claimTaskSpace",
    signature: "await claimTaskSpace(spaceId)",
    returns: "Promise<TaskSpace>",
    summary:
      "Claim a user-owned or inactive space after user approval and return TaskSpace.",
  },
  {
    name: "takeOverTaskSpace",
    signature: "await takeOverTaskSpace(spaceId)",
    returns: "Promise<TaskSpace>",
    summary:
      "Resume an Agent-owned space after user approval and return TaskSpace.",
  },
  {
    name: "TaskSpace.spaceId",
    signature: "task.spaceId",
    returns: "number",
    summary: "Stable numeric identifier for this task space.",
  },
  {
    name: "TaskSpace.name",
    signature: "task.name",
    returns: "string",
    summary: "Human-readable task-space name.",
  },
  {
    name: "TaskSpace.profileId",
    signature: "task.profileId",
    returns: 'string | undefined // such as "Default" or "ephemeral"',
    summary:
      "The space's browser profile when the host reports it. finish() deletes an ephemeral space and reports closedSpace: true.",
  },
  {
    name: "TaskSpace.ownership",
    signature: "task.ownership",
    returns: 'string // "agent" or "user"',
    summary: "Ownership state captured when this TaskSpace was created.",
  },
  {
    name: "TaskSpace.page",
    signature: "task.page(label)",
    returns: "Page // a lazy handle; no browser call",
    summary:
      "Create a lazy handle for an existing managed Page label; it neither creates a Page nor checks that the label exists.",
  },
  {
    name: "TaskSpace.userPage",
    signature: "task.userPage()",
    returns: "Page | UnmanagedPage | undefined",
    summary:
      "Return the tab active at the claim/takeover boundary, when one was captured.",
  },
  {
    name: "TaskSpace.pages",
    signature: "await task.pages()",
    returns: "Promise<Page[]>",
    summary: "List the managed Page handles in this space.",
  },
  {
    name: "TaskSpace.tabs",
    signature: "await task.tabs()",
    returns:
      "Promise<Array<{ targetId, label?, page, title, url, active, openedBy }>>",
    summary: "List managed Pages and unmanaged tabs in this space.",
  },
  {
    name: "TaskSpace.newPage",
    signature: "await task.newPage()",
    returns: "Promise<Page>",
    summary: "Create and durably label a blank Page.",
  },
  {
    name: "TaskSpace.adopt",
    signature: "await task.adopt(unmanagedPage, { as? })",
    returns: "Promise<Page>",
    summary: "Bring an unmanaged tab under the Page lifecycle.",
    options: { as: option("string", "Permanent Page label.") },
  },
  {
    name: "TaskSpace.release",
    signature: "await task.release(label)",
    returns: "Promise<UnmanagedPage>",
    summary: "Stop managing an unknown-origin Page without closing it.",
  },
  {
    name: "TaskSpace.waitForControl",
    signature: "await task.waitForControl({ interval?, timeout? })",
    returns: "Promise<void>",
    summary: "Wait for Agent control without taking it from the user.",
    options: {
      interval: option(
        "positiveMilliseconds",
        "Polling interval in milliseconds.",
      ),
      timeout,
    },
  },
  {
    name: "TaskSpace.handOff",
    signature: "await task.handOff({ relay? })",
    returns:
      "Promise<void> // with relay: Promise<{ relay: { dir, screenshot, snapshot, url, title } }>",
    summary:
      "Give control of this space to the user. With relay: true (hosts that support it, such as a headless Linux server) the agent keeps control and gets a screenshot and snapshot to show the user, then does what the user says.",
    options: {
      relay: option(
        "boolean",
        "Keep control and return screenshot and snapshot paths for the user instead of handing off.",
      ),
    },
  },
  {
    name: "TaskSpace.memo",
    signature: "await task.memo(key, value?)",
    returns:
      "Promise<any> // the stored value, or undefined when the key is not set",
    summary:
      "A small JSON store kept with this space by the host, so a re-run can skip finished steps: memo(key) reads, memo(key, value) writes, memo(key, null) deletes. finish() clears it. Hosts without it throw EGO_UNSUPPORTED_ON_HOST.",
  },
  {
    name: "TaskSpace.restorePages",
    signature: "await task.restorePages()",
    returns: "Promise<{ pages: Array<{ label, url }>, skipped: string[] }>",
    summary:
      "After a browser restart, reopen the space's lost http(s) tabs (GET only; form state is lost) and give them back their Page labels. Hosts without it throw EGO_UNSUPPORTED_ON_HOST.",
  },
  {
    name: "TaskSpace.map",
    signature:
      "await task.map(urls, async (page, url, index) => value, { concurrency?, navigate?, timeout?, waitUntil? })",
    returns:
      "Promise<Array<{ url, index, ok: true, value } | { url, index, ok: false, error, error_code? }>> // in input order",
    summary:
      "Run the same work on many URLs with up to concurrency Pages (default 3, within the Page budget) that are reused and closed afterwards. Each Page goes to its URL first unless navigate is false; one failure does not stop the others.",
    options: {
      concurrency: option(
        "positiveInteger",
        "Pages used at once; defaults to 3.",
      ),
      navigate: option(
        "boolean",
        "Go to each URL before calling fn; defaults to true.",
      ),
      timeout: option(
        "positiveMilliseconds",
        "Navigation timeout per URL in milliseconds.",
      ),
      waitUntil: option(
        "string",
        "Navigation completion state; defaults to load.",
        ["commit", "domcontentloaded", "load", "networkidle"],
      ),
    },
  },
  {
    name: "TaskSpace.finish",
    signature: "await task.finish({ keep? })",
    returns:
      "Promise<{ spaceId, closedSpace, keptManagedLabels, closedManagedLabels, preservedUnmanagedCount }>",
    summary:
      "Finish the task and return a receipt with retained and closed managed Page labels; an empty list closes the space when no protected tabs remain. With no argument it keeps nothing, like { keep: [] }.",
    options: {
      keep: option(
        "pageRetention",
        'Page retention policy: "all" or an array of managed Page labels. Required when an options object is passed; finish() with no argument means [].',
      ),
    },
  },
  {
    name: "TaskSpace.cdp",
    signature: "await task.cdp(method, params?, { timeout? })",
    returns: "Promise<object> // the CDP result",
    summary: "Send a Target or Browser domain CDP command.",
    options: { timeout },
  },
  {
    name: "Page.label",
    signature: "page.label",
    returns: "string",
    summary: "Durable Page label used to restore the tab across rounds.",
  },
  {
    name: "Page.spaceId",
    signature: "page.spaceId",
    returns: "number",
    summary: "Numeric identifier of the Page's task space.",
  },
  {
    name: "Page.openedBy",
    signature: "page.openedBy",
    returns: "object // origin attribution",
    summary: "Conservative origin attribution for this Page.",
  },
  {
    name: "Page.targetId",
    signature: "page.targetId",
    returns: "string | undefined",
    summary:
      "Internal browser target identifier for advanced Target-domain CDP only.",
  },
  {
    name: "Page.goto",
    signature: "await page.goto(url, { referer?, timeout?, waitUntil? })",
    returns:
      "Promise<ActionReceipt> // { popups?: { label, targetId }[], dialog? }. Not an HTTP response: no status().",
    summary:
      "Navigate this Page in place. Resolves to an action receipt { popups?, dialog? }, not an HTTP response: it has no status. Check the result with page.url(), page.title(), or a wait; use page.fetch() for an HTTP status. Timeout errors report whether the new document committed, plus its URL and readyState when available.",
    options: {
      referer: option(
        "nonEmptyString",
        "HTTP Referer header for the navigation.",
      ),
      timeout,
      waitUntil: option(
        "string",
        "Completion state; defaults to load. networkidle requires 500ms without network activity.",
        ["commit", "domcontentloaded", "load", "networkidle"],
      ),
    },
  },
  {
    name: "Page.reload",
    signature: "await page.reload({ timeout?, waitUntil? })",
    returns:
      "Promise<ActionReceipt> // { popups?, dialog? }. Not an HTTP response.",
    summary:
      "Reload this Page and wait for the selected navigation state. Resolves to an action receipt { popups?, dialog? }, not an HTTP response.",
    options: {
      timeout,
      waitUntil: option(
        "string",
        "Completion state; defaults to load. networkidle requires 500ms without network activity.",
        ["commit", "domcontentloaded", "load", "networkidle"],
      ),
    },
  },
  {
    name: "Page.snapshot",
    signature:
      "await page.snapshot({ scope?, root?, includeActionMarks?, includeStableLocator?, settle?, format? })",
    returns:
      'Promise<string> // header, a [stats ...] line, any [warning ...] lines, then the tree. With format: "object": Promise<{ text, stats?, warnings, settle? }>',
    summary:
      "Return a semantic snapshot of the current viewport, full Page, or one snapshot-ref subtree with Page provenance. A [warning page may still be rendering] line means the page looked unfinished: wait for the content, then snapshot again. Retries internally when the page changes during the snapshot.",
    options: {
      scope: option(
        "string",
        "Snapshot scope; defaults to only_within_viewport, including visible iframe content returned by the browser. Use subtree with an iframe root ref to focus on that frame.",
        ["full_page", "only_within_viewport", "subtree"],
      ),
      root: option(
        "nonEmptyString",
        "Valid Page snapshot ref such as @21; required only when scope is subtree. Partial snapshots preserve existing node identities.",
      ),
      includeActionMarks: option("boolean", "Include action marks."),
      includeStableLocator: option("boolean", "Include stable locators."),
      settle: option(
        "settle",
        "true, or { quietMs?, timeout?, until?, minCount? }: run page.waitForSettled() first.",
      ),
      format: option(
        "string",
        "text (default) returns the string; object returns { text, stats, warnings, settle }.",
        ["text", "object"],
      ),
    },
  },
  {
    name: "Page.waitForResponse",
    signature:
      "page.waitForResponse(urlOrRegExpOrPredicate, { timeout?, maxBodyBytes? })",
    returns:
      "Promise<{ url, status, statusText, headers, mimeType, method?, resourceType?, fromCache, json?, text?, bodySize?, bodyOmitted? }> // json when the body parses, text otherwise",
    summary:
      "Wait for the next response this Page loads whose URL matches (a string matches as a glob or a substring; a predicate receives { url, status, method, mimeType, resourceType }), and resolve after its body has loaded. Arm it before the triggering action: const r = page.waitForResponse(/api/); await page.click(...); console.log((await r).json).",
    options: {
      timeout: option(
        "positiveMilliseconds",
        "Maximum wait in milliseconds; defaults to 10000.",
      ),
      maxBodyBytes: option(
        "positiveInteger",
        "Largest body kept, in bytes; defaults to 2 MB. Larger bodies are omitted with a reason.",
      ),
    },
  },
  {
    name: "Page.captureResponses",
    signature:
      "await page.captureResponses({ match?, maxBodies?, maxBodyBytes?, maxTotalBytes? })",
    returns:
      "Promise<ResponseCapture> // call await capture.stop() for the responses",
    summary:
      "Start collecting the responses this Page loads, with parsed bodies, until capture.stop(). Without match it keeps fetch and XHR responses. Bodies stay in memory for this round only.",
    options: {
      match: option(
        "responseMatcher",
        "URL string (glob or substring), RegExp, or predicate receiving { url, status, method, mimeType, resourceType }.",
      ),
      maxBodies: option(
        "positiveInteger",
        "Bodies read before later responses keep only their metadata; defaults to 50.",
      ),
      maxBodyBytes: option(
        "positiveInteger",
        "Largest body kept, in bytes; defaults to 2 MB.",
      ),
      maxTotalBytes: option(
        "positiveInteger",
        "Total body bytes kept; defaults to 20 MB.",
      ),
    },
  },
  {
    name: "ResponseCapture.responses",
    signature: "capture.responses()",
    returns: "Array<{ url, status, headers, json?, text?, ... }>",
    summary: "Return the responses collected so far whose bodies are read.",
  },
  {
    name: "ResponseCapture.stop",
    signature: "await capture.stop()",
    returns:
      "Promise<Array<{ url, status, statusText, headers, mimeType, method?, resourceType?, fromCache, json?, text?, bodySize?, bodyOmitted? }>>",
    summary:
      "Stop collecting, wait for bodies still being read, and return every collected response in arrival order.",
  },
  {
    name: "Page.waitForSettled",
    signature:
      "await page.waitForSettled({ timeout?, quietMs?, until?, minCount? })",
    returns:
      'Promise<{ settled, waitedMs, mutationsSeen, pendingRequests, readyState?, matches?, reason? }> // reason is set when settled is false, such as "dom still changing"',
    summary:
      "Wait until a client-rendered Page has drawn: the document has loaded, the DOM has not changed for quietMs, no fetch/XHR it started is still waiting for its answer (long polls, WebSocket and EventSource are ignored), and until matches at least minCount elements. Does not throw on timeout; check settled. A content wait (waitForSelector) is still best when you know the selector.",
    options: {
      timeout: option(
        "positiveMilliseconds",
        "Maximum wait in milliseconds; defaults to 10000.",
      ),
      quietMs: option(
        "positiveMilliseconds",
        "How long the DOM must stay unchanged; defaults to 500.",
      ),
      until: option(
        "nonEmptyString",
        "Selector, loc= locator, or ref that must also match.",
      ),
      minCount: option(
        "positiveInteger",
        "Matches required for until; defaults to 1.",
      ),
    },
  },
  {
    name: "Page.screenshot",
    signature:
      "await page.screenshot({ path?, fullPage?, maxHeight?, tiles?, clip?, scale?, raw? })",
    returns:
      "Promise<string> // the PNG file path. With tiles: Promise<string[]>",
    summary:
      "Capture this Page to a PNG file. fullPage stops at maxHeight (16000 CSS px by default, with a notice); tiles: true splits the full page into several images of maxHeight (default 4000) each.",
    options: {
      maxHeight: option(
        "positiveInteger",
        "With fullPage: the tallest image in CSS pixels (default 16000), or each tile's height with tiles (default 4000).",
      ),
      tiles: option(
        "boolean",
        "With fullPage: return several images that together cover the page.",
      ),
      path: option(
        "string",
        "Absolute output path; missing parent directories are created.",
      ),
      fullPage: option("boolean", "Capture the full scrollable page."),
      clip: option("clip", "CSS-pixel clipping rectangle."),
      scale: option(
        "string",
        "Output scale mode; css uses CSS-pixel sizing and is the default.",
        ["css"],
      ),
      raw: option("boolean", "Bypass device-pixel-ratio correction."),
    },
  },
  {
    name: "Page.fillSecret",
    signature:
      "await page.fillSecret(target, secretName, { clear?, timeout? })",
    returns: "Promise<{ filled, secret, origin }> // never the value",
    summary:
      "Type a secret the user stored with the host (ego-browser secret set) into a field: focuses target, then the host types the value only if this Page's origin is one the secret is registered for. The value never reaches the script, and snapshots redact it. Errors: EGO_SECRET_NOT_FOUND, EGO_SECRET_ORIGIN_MISMATCH, EGO_SECRET_NO_FIELD, EGO_SECRET_STORE_UNAVAILABLE; hosts without secrets throw EGO_UNSUPPORTED_ON_HOST.",
    options: {
      clear: option("boolean", "Clear the field first; defaults to true."),
      timeout: actionTimeout,
    },
  },
  {
    name: "Page.read",
    signature: "await page.read({ mode?, selector?, maxChars?, timeout? })",
    returns:
      'Promise<{ url, title, byline?, published?, lang?, markdown, links: [{ text, href }], words, truncated, source, pages?, warning? }> // source: "article" | "main" | "body" | "selector" | "pdf"',
    summary:
      "Read this Page as Markdown: the main article without navigation, ads or footers, with absolute links. Far smaller than a snapshot; use it to read, and a snapshot to act. A PDF (in the viewer or at a .pdf URL) returns its text with pages: [{ n, text }]. A warning is set when the page has very little text.",
    options: {
      mode: option(
        "string",
        "article (default) picks the main content; full reads the whole body.",
        ["article", "full"],
      ),
      selector: option(
        "nonEmptyString",
        "CSS selector of the element to read.",
      ),
      maxChars: option(
        "positiveInteger",
        "Cut the Markdown at a heading or paragraph before this many characters and set truncated; defaults to 100000.",
      ),
      timeout: option(
        "positiveMilliseconds",
        "Maximum extraction time in milliseconds; defaults to 20000.",
      ),
    },
  },
  {
    name: "Page.tables",
    signature:
      "await page.tables({ selector?, index?, csv?, saveAs?, includeHidden? })",
    returns:
      "Promise<Array<{ index, caption?, selector, kind, headers: string[], rows: Array<Record<header, string>>, rowCount, csv? }>>",
    summary:
      'Read the tables (and ARIA grids) on this Page as rows keyed by header. rowspan and colspan are expanded, multi-row headers joined with " / ", spacer rows and footnote markers dropped; values stay text as shown. Layout and hidden tables are skipped unless selector names them.',
    options: {
      selector: option(
        "nonEmptyString",
        "CSS selector of a table, or of an element whose tables to read.",
      ),
      index: option(
        "nonNegativeInteger",
        "Return only the table at this index in the result.",
      ),
      csv: option("boolean", "Add a csv string to each table."),
      saveAs: option(
        "nonEmptyString",
        "Absolute path to write one table as CSV; needs exactly one table (use index).",
      ),
      includeHidden: option("boolean", "Also read hidden tables."),
    },
  },
  {
    name: "Page.structuredData",
    signature: "await page.structuredData()",
    returns:
      "Promise<{ url, title, description?, canonical?, lang?, jsonLd: object[], openGraph: object, twitter: object, microdata: object[], errors? }>",
    summary:
      "Read what this Page declares about itself: JSON-LD (with @graph flattened), OpenGraph and Twitter card tags, the meta description, the canonical URL and schema.org microdata.",
  },
  {
    name: "Page.search",
    signature: "await page.search(query, { engine?, max?, timeout? })",
    returns:
      "Promise<{ engine, query, url?, results: [{ rank, title, url, snippet }], blocked: [{ engine, url, reason, hint }], noResults?, warning? }> // engine is null when every engine was blocked; warning when no result mentions the query",
    summary:
      "Search the web in this Page and read the results. An engine that shows a bot check or an unreadable page is listed in blocked, never returned as empty results; with engine auto the next engine is tried. Bing usually works from servers; Google and DuckDuckGo often block automated browsers. Never try to bypass a check.",
    options: {
      engine: option(
        "string",
        "Engine to use; auto (default) tries bing, then duckduckgo, then google (EGO_BROWSER_SEARCH_ENGINE picks the first).",
        ["auto", "bing", "duckduckgo", "google"],
      ),
      max: option("positiveInteger", "Most results to return; defaults to 10."),
      timeout: option(
        "positiveMilliseconds",
        "Navigation timeout per engine in milliseconds; defaults to 15000.",
      ),
    },
  },
  {
    name: "Page.dismissConsent",
    signature: "await page.dismissConsent({ prefer?, timeout? })",
    returns:
      'Promise<{ found, action: "reject" | "accept" | "none", framework?, clicked?, frame?, dismissed?, reason? }>',
    summary:
      "Close a cookie or consent banner, choosing Reject all or Necessary only. Known platforms (OneTrust, Cookiebot, Didomi, Quantcast, TrustArc, Usercentrics, Sourcepoint and more) first, then a text match inside a dialog. When a banner offers only Accept, nothing is clicked unless prefer is accept; use accept only when the user asked for it.",
    options: {
      prefer: option(
        "string",
        "reject (default) never accepts; accept clicks Accept all.",
        ["reject", "accept"],
      ),
      timeout: option(
        "positiveMilliseconds",
        "How long to wait for a late banner, in milliseconds; defaults to 1000.",
      ),
    },
  },
  {
    name: "Page.scrollToLoad",
    signature:
      "await page.scrollToLoad({ itemSelector?, maxItems?, maxScrolls?, idleMs?, timeout? })",
    returns:
      "Promise<{ items?, scrolls, height, stoppedBecause, ms }> // stoppedBecause: maxItems reached, no new items, maxScrolls reached, timeout",
    summary:
      "Scroll an infinite list until it stops growing: stops at maxItems matches of itemSelector, when nothing new appears for idleMs, after maxScrolls, or at the timeout.",
    options: {
      itemSelector: option(
        "nonEmptyString",
        "Selector, loc= locator or CSS for one list item; counts progress.",
      ),
      maxItems: option("positiveInteger", "Stop once this many items match."),
      maxScrolls: option(
        "positiveInteger",
        "Most scroll steps; defaults to 30.",
      ),
      idleMs: option(
        "positiveMilliseconds",
        "Stop when nothing new appears for this long; defaults to 1500.",
      ),
      timeout: option(
        "positiveMilliseconds",
        "Total time limit in milliseconds; defaults to 60000.",
      ),
    },
  },
  {
    name: "Page.paginate",
    signature:
      "for await (const p of page.paginate({ next, maxPages?, timeout? })) { ... }",
    returns: "AsyncGenerator<Page> // yields this Page once per result page",
    summary:
      "Visit this page and each next page: yields this Page, then clicks next, waits until the content changes and settles, and yields again. Stops after maxPages, when next is missing or disabled, or when a click changes nothing.",
    options: {
      next: option(
        "nonEmptyString",
        "Selector or loc= locator of the Next link or button.",
      ),
      maxPages: option(
        "positiveInteger",
        "Most pages to yield, the first included; defaults to 10.",
      ),
      timeout: option(
        "positiveMilliseconds",
        "Wait for each next page in milliseconds; defaults to 15000.",
      ),
    },
  },
  {
    name: "Page.site",
    signature: "page.site(siteId)",
    returns: "SiteTools // { id, tools(), notes(), run(name, args) }",
    summary:
      "Use a site's learned tools with this Page. List sites and tools with siteTools(url or id).",
  },
  {
    name: "SiteTools.tools",
    signature: "await page.site(siteId).tools()",
    returns:
      'Promise<Array<{ name, kind: "node" | "browser", api, description, args, returns? }>>',
    summary: "List the site's tools with their arguments.",
  },
  {
    name: "SiteTools.notes",
    signature: "await page.site(siteId).notes()",
    returns: "Promise<Array<{ file, content }>>",
    summary: "Read the site's notes (Markdown) on how the site works.",
  },
  {
    name: "SiteTools.run",
    signature: "await page.site(siteId).run(toolName, args?)",
    returns: "Promise<any> // the tool's result",
    summary:
      'Run a site tool with this Page: a Node tool declared with "api": 2 receives (page, args); a browser tool runs inside this Page. A v1 tool explains how to run it with runSiteTool.',
  },
  {
    name: "siteTools",
    signature: "await siteTools(urlOrSiteId?)",
    returns:
      "Promise<Array<{ site, name, kind, api, description, args, returns?, usage }>>",
    summary:
      "List learned site tools: for one URL or domain, one site id, or every site when called with no argument. usage shows how to call each.",
  },
  {
    name: "readPdf",
    signature: "await readPdf(absolutePath, { maxChars? })",
    returns:
      'Promise<{ url, title, markdown, pages: [{ n, text }], words, truncated, source: "pdf", warning? }>',
    summary:
      "Read the text of a PDF file already on disk (from a download or page.fetch(url, { saveAs })). Text-based PDFs only; a scanned or encrypted PDF returns a warning.",
    options: {
      maxChars: option(
        "positiveInteger",
        "Cut the Markdown before this many characters; defaults to 100000.",
      ),
    },
  },
  {
    name: "Page.url",
    signature: "await page.url()",
    returns: "Promise<string>",
    summary: "Read this Page's current URL.",
  },
  {
    name: "Page.waitForURL",
    signature: "await page.waitForURL(urlMatcher, { timeout? })",
    returns: "Promise<void>",
    summary:
      "Wait for an exact URL, Playwright-style glob, RegExp, or synchronous predicate receiving a URL object.",
    options: { timeout },
  },
  {
    name: "Page.waitForEvent",
    signature: "await page.waitForEvent(event, { timeout? })",
    returns: 'Promise<Page> for "popup", Promise<Download> for "download"',
    summary:
      'Wait for this Page\'s next "popup" or "download"; arm the promise before the triggering action.',
    options: { timeout },
  },
  {
    name: "Download.page",
    signature: "download.page()",
    returns: "Page",
    summary: "Return the Page that started this download.",
  },
  {
    name: "Download.url",
    signature: "download.url()",
    returns: "string",
    summary: "Return the download URL.",
  },
  {
    name: "Download.suggestedFilename",
    signature: "download.suggestedFilename()",
    returns: "string",
    summary: "Return Chromium's suggested file name.",
  },
  {
    name: "Download.saveAs",
    signature: "await download.saveAs(absolutePath)",
    returns: "Promise<void>",
    summary:
      "Wait for completion and copy the download to an absolute path, creating missing parent directories.",
  },
  {
    name: "Download.path",
    signature: "await download.path()",
    returns: "Promise<string>",
    summary:
      "Wait for completion and return the round-local temporary file path.",
  },
  {
    name: "Download.failure",
    signature: "await download.failure()",
    returns: "Promise<string | null>",
    summary: "Wait for completion and return null or the failure reason.",
  },
  {
    name: "Download.cancel",
    signature: "await download.cancel()",
    returns: "Promise<void>",
    summary: "Cancel this download by its Chromium download identifier.",
  },
  {
    name: "Download.delete",
    signature: "await download.delete()",
    returns: "Promise<void>",
    summary: "Delete this download's round-local temporary files.",
  },
  {
    name: "Page.waitForTimeout",
    signature: "await page.waitForTimeout(timeout)",
    returns: "Promise<void>",
    summary:
      "Wait a fixed number of milliseconds without activating this Page.",
  },
  {
    name: "Page.title",
    signature: "await page.title()",
    returns: "Promise<string>",
    summary: "Read this Page's current title.",
  },
  {
    name: "Page.info",
    signature: "await page.info()",
    returns: "Promise<{ url, title, w, h, sx, sy, pw, ph } | { dialog }>",
    summary: "Read URL, title, viewport, scroll, and dialog state.",
  },
  {
    name: "Page.acceptDialog",
    signature: "await page.acceptDialog(promptText?)",
    returns: "Promise<boolean> // false when no dialog was open",
    summary:
      "Accept this Page's JavaScript dialog, optionally supplying prompt text; return false when none is open.",
  },
  {
    name: "Page.dismissDialog",
    signature: "await page.dismissDialog()",
    returns: "Promise<boolean> // false when no dialog was open",
    summary:
      "Dismiss this Page's JavaScript dialog; return false when none is open.",
  },
  {
    name: "Page.evaluate",
    signature: "await page.evaluate(fnOrString, argument?)",
    returns: "Promise<any> // the JSON-serializable result",
    summary:
      "Run JavaScript in this Page; callbacks receive JSON data but cannot capture Node.js variables. Safety-timeout errors report executionStopped, pageResponsive, and mayHaveLateEffects.",
  },
  {
    name: "Page.waitForFunction",
    signature:
      "await page.waitForFunction(fnOrString, argument?, { timeout?, polling? })",
    returns: "Promise<true>",
    summary: "Wait until a Page function or expression returns a truthy value.",
    options: {
      timeout,
      polling: option(
        "positiveMilliseconds",
        "Polling interval in milliseconds; defaults to 100.",
      ),
    },
  },
  {
    name: "Page.fetch",
    signature: "await page.fetch(url, options?)",
    returns:
      "Promise<{ ok, status, statusText, url, headers, body?, savedPath? }>",
    summary:
      "Run window.fetch in this Page, obey browser CORS, and return a structured response.",
    options: {
      timeout,
      saveAs: option(
        "nonEmptyString",
        "Write the response body to this absolute path without text conversion.",
      ),
      method: option("string", "HTTP method."),
      headers: option("stringRecord", "Request headers."),
      body: option("string", "Request body."),
      cache: option("string", "Fetch cache mode.", [
        "default",
        "no-store",
        "reload",
        "no-cache",
        "force-cache",
        "only-if-cached",
      ]),
      credentials: option("string", "Fetch credentials mode.", [
        "omit",
        "same-origin",
        "include",
      ]),
      integrity: option("string", "Subresource integrity value."),
      keepalive: option("boolean", "Allow the request to outlive the page."),
      mode: option("string", "Fetch request mode.", [
        "cors",
        "no-cors",
        "same-origin",
      ]),
      redirect: option("string", "Redirect handling mode.", [
        "follow",
        "error",
        "manual",
      ]),
      referrer: option("string", "Request referrer."),
      referrerPolicy: option("string", "Request referrer policy."),
    },
  },
  {
    name: "Page.cdp",
    signature: "await page.cdp(method, params?, { timeout? })",
    returns: "Promise<object> // the CDP result",
    summary: "Send a CDP command through this Page's target session.",
    options: { timeout },
  },
  {
    name: "Page.waitForSelector",
    signature: "await page.waitForSelector(selector, { timeout?, state? })",
    returns: "Promise<true>",
    summary: "Wait for an element state in this Page.",
    options: {
      timeout,
      state: option("string", "Required element state.", [
        "attached",
        "detached",
        "visible",
        "hidden",
      ]),
    },
  },
  {
    name: "Page.waitForLoadState",
    signature: "await page.waitForLoadState(state?, { timeout?, idleMs? })",
    returns: "Promise<void>",
    summary:
      "Wait for DOM content, load, or network-idle state; no state defaults to load.",
    options: {
      timeout,
      idleMs: option(
        "positiveMilliseconds",
        "Required network-idle window in milliseconds.",
      ),
    },
  },
  {
    name: "Page.events",
    signature: "await page.events()",
    returns: "Promise<object[]> // raw CDP events, cleared after reading",
    summary: "Read and clear CDP events buffered for this Page.",
  },
  {
    name: "Page.click",
    signature:
      "await page.click(selector, { button?, clickCount?, delay?, position?, force?, timeout?, label? })",
    returns: "Promise<ActionReceipt> // { popups?, dialog? }",
    summary:
      "Click an element with native CDP input. Retries while the element is not ready; never repeats input that reached the page. A timeout error has mayHaveLateEffects: true when input was already sent.",
    options: {
      button,
      clickCount: option("positiveInteger", "Number of clicks."),
      delay,
      position,
      force,
      timeout: actionTimeout,
      label,
    },
  },
  {
    name: "Page.dblclick",
    signature:
      "await page.dblclick(selector, { button?, delay?, position?, force?, timeout?, label? })",
    returns: "Promise<ActionReceipt> // { popups?, dialog? }",
    summary:
      "Double-click an element with native CDP input. Retries while the element is not ready; never repeats input that reached the page. A timeout error has mayHaveLateEffects: true when input was already sent.",
    options: { button, delay, position, force, timeout: actionTimeout, label },
  },
  {
    name: "Page.hover",
    signature:
      "await page.hover(selector, { position?, force?, timeout?, label? })",
    returns: "Promise<ActionReceipt> // { popups?, dialog? }",
    summary: "Move the mouse over an element.",
    options: { position, force, timeout: actionTimeout, label },
  },
  {
    name: "Page.dragAndDrop",
    signature:
      "await page.dragAndDrop(source, target, { button?, sourcePosition?, targetPosition?, force?, timeout?, label? })",
    returns: "Promise<ActionReceipt> // { popups?, dialog? }",
    summary:
      "Drag from one element to another. Retries while the element is not ready; never repeats input that reached the page. A timeout error has mayHaveLateEffects: true when input was already sent.",
    options: {
      button,
      sourcePosition: position,
      targetPosition: position,
      force,
      timeout: actionTimeout,
      label,
    },
  },
  {
    name: "Page.fill",
    signature: "await page.fill(selector, value, { clearFirst?, timeout? })",
    returns: "Promise<ActionReceipt> // { popups?, dialog? }",
    summary:
      "Fill the selected field, its editing host, or its unique fillable descendant, then confirm editing took effect. Retries while the element is not ready; never repeats input that reached the page. A timeout error has mayHaveLateEffects: true when input was already sent.",
    options: {
      clearFirst: option("boolean", "Clear the current value before filling."),
      timeout: actionTimeout,
    },
  },
  {
    name: "Page.selectOption",
    signature: "await page.selectOption(selector, valueOrValues, { timeout? })",
    returns: "Promise<string[]> // the selected option values",
    summary:
      "Select by a value-or-label string or { value?, label?, index? }; arrays select multiple options, while null or [] clears the selection. The select must be enabled, but disabled options remain programmatically selectable.",
    options: { timeout: actionTimeout },
  },
  {
    name: "Page.focus",
    signature: "await page.focus(selector, { timeout? })",
    returns: "Promise<ActionReceipt> // { popups?, dialog? }",
    summary:
      "Focus the element, its nearest interactive ancestor, or its unique editable descendant.",
    options: { timeout: actionTimeout },
  },
  {
    name: "Page.press",
    signature: "await page.press(selector, chord, { delay?, timeout? })",
    returns: "Promise<ActionReceipt> // { popups?, dialog? }",
    summary:
      "Focus one element and press a key or shortcut chord. Named keys are case-insensitive; single-character keys preserve case. Retries while the element is not ready; never repeats input that reached the page. A timeout error has mayHaveLateEffects: true when input was already sent.",
    options: { delay, timeout: actionTimeout },
  },
  {
    name: "Page.setInputFiles",
    signature: "await page.setInputFiles(selector, pathOrPaths)",
    returns: "Promise<ActionReceipt> // { popups?, dialog? }",
    summary:
      "Set files on a file input resolved from the input, its label, or a unique descendant.",
  },
  {
    name: "Page.waitForFileChooser",
    signature: "page.waitForFileChooser({ timeout? })",
    returns: "Promise<FileChooser>",
    summary: "Wait for a dynamically created file chooser.",
    options: { timeout },
  },
  {
    name: "FileChooser.isMultiple",
    signature: "fileChooser.isMultiple()",
    returns: "boolean",
    summary: "Report whether the chooser accepts multiple files.",
  },
  {
    name: "FileChooser.setFiles",
    signature: "await fileChooser.setFiles(pathOrPaths)",
    returns: "Promise<ActionReceipt> // { popups?, dialog? }",
    summary:
      "Set files on an intercepted chooser and return any JavaScript dialog opened by the upload.",
  },
  {
    name: "Page.close",
    signature: "await page.close()",
    returns: "Promise<void>",
    summary: "Close this Page after confirming its tab disappeared.",
  },
  {
    name: "Page.mouse.click",
    signature:
      "await page.mouse.click(x, y, { button?, clickCount?, delay?, label? })",
    returns: "Promise<ActionReceipt> // { popups?, dialog? }",
    summary: "Click CSS-pixel coordinates with native CDP input.",
    options: {
      button,
      clickCount: option("positiveInteger", "Number of clicks."),
      delay,
      label,
    },
  },
  {
    name: "Page.mouse.move",
    signature: "await page.mouse.move(x, y, { steps?, label? })",
    returns: "Promise<void>",
    summary: "Move the mouse to CSS-pixel coordinates.",
    options: {
      steps: option("positiveInteger", "Number of movement steps."),
      label,
    },
  },
  {
    name: "Page.mouse.down",
    signature: "await page.mouse.down({ button?, clickCount? })",
    returns: "Promise<void>",
    summary: "Press a mouse button at the current Page position.",
    options: {
      button,
      clickCount: option(
        "positiveInteger",
        "Click count reported to the page.",
      ),
    },
  },
  {
    name: "Page.mouse.up",
    signature: "await page.mouse.up({ button?, clickCount? })",
    returns: "Promise<void>",
    summary: "Release a mouse button at the current Page position.",
    options: {
      button,
      clickCount: option(
        "positiveInteger",
        "Click count reported to the page.",
      ),
    },
  },
  {
    name: "Page.mouse.wheel",
    signature: "await page.mouse.wheel(deltaX, deltaY, { label? })",
    returns: "Promise<void>",
    summary:
      "Perform a short wheel-input motion at the current Page position; move or click over the intended scroll container first in each process.",
    options: { label },
  },
  {
    name: "Page.keyboard.down",
    signature: "await page.keyboard.down(key)",
    returns: "Promise<void>",
    summary: "Press and hold a keyboard key.",
  },
  {
    name: "Page.keyboard.up",
    signature: "await page.keyboard.up(key)",
    returns: "Promise<void>",
    summary: "Release a keyboard key.",
  },
  {
    name: "Page.keyboard.press",
    signature: "await page.keyboard.press(chord, { delay? })",
    returns: "Promise<ActionReceipt> // { popups?, dialog? }",
    summary:
      "Press and release a key or portable shortcut chord. Named keys are case-insensitive; single-character keys preserve case.",
    options: { delay },
  },
  {
    name: "Page.keyboard.type",
    signature: "await page.keyboard.type(text, { delay? })",
    returns: "Promise<void>",
    summary: "Type text using physical keys where possible.",
    options: { delay },
  },
  {
    name: "Page.keyboard.insertText",
    signature: "await page.keyboard.insertText(text)",
    returns: "Promise<void>",
    summary: "Insert text without synthesizing key presses.",
  },
  {
    name: "Page.keyboard.paste",
    signature: "await page.keyboard.paste(textOrContent)",
    returns: "Promise<ActionReceipt> // { popups?, dialog? }",
    summary:
      "Send native paste with a string or { text, html? }, then restore the clipboard.",
  },
] as const;

const entriesByName = new Map(
  PUBLIC_API_SCHEMA.map((entry) => [entry.name, entry]),
);

export function publicApiEntry(name: string): PublicApiEntry | undefined {
  return entriesByName.get(name);
}

/** Validate an option object using the same schema shown in help and docs. */
export function validatePublicApiOptions(name: string, value: unknown): void {
  const entry = publicApiEntry(name);
  if (!entry?.options) {
    throw new Error(`public API schema has no options for ${name}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      validationMessage(
        entry,
        `${displayName(name)} options must be an object`,
      ),
    );
  }
  for (const [key, optionValue] of Object.entries(value)) {
    const specification = entry.options[key];
    if (!specification) {
      throw new TypeError(
        validationMessage(
          entry,
          `${displayName(name)} received unknown option: ${key}`,
        ),
      );
    }
    if (optionValue === undefined) continue;
    try {
      validateOptionValue(displayName(name), key, optionValue, specification);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new TypeError(validationMessage(entry, error.message), {
          cause: error,
        });
      }
      throw error;
    }
  }
}

function validationMessage(entry: PublicApiEntry, message: string): string {
  return `${message}. Expected: ${entry.signature}`;
}

function displayName(name: string): string {
  return name
    .replace(/^TaskSpace/, "task")
    .replace(/^Page/, "page")
    .replace(/^Download/, "download")
    .replace(/^SiteTools/, "site")
    .replace(/^ResponseCapture/, "capture");
}

function validateOptionValue(
  apiName: string,
  optionName: string,
  value: unknown,
  specification: PublicApiOption,
): void {
  let valid = false;
  switch (specification.kind) {
    case "boolean":
      valid = typeof value === "boolean";
      break;
    case "clip":
      valid = isClip(value);
      break;
    case "finiteNumber":
      valid = typeof value === "number" && Number.isFinite(value);
      break;
    case "nonNegativeNumber":
      valid = typeof value === "number" && Number.isFinite(value) && value >= 0;
      break;
    case "nonEmptyString":
      valid = typeof value === "string" && value.length > 0;
      break;
    case "nonNegativeInteger":
      valid = Number.isInteger(value) && (value as number) >= 0;
      break;
    case "pageRetention":
      valid =
        value === "all" ||
        (Array.isArray(value) &&
          value.every((item) => typeof item === "string" && item.length > 0) &&
          new Set(value).size === value.length);
      break;
    case "positiveInteger":
      valid = Number.isInteger(value) && (value as number) > 0;
      break;
    case "positiveMilliseconds":
      valid = typeof value === "number" && Number.isFinite(value) && value > 0;
      break;
    case "responseMatcher":
      valid =
        (typeof value === "string" && value.length > 0) ||
        value instanceof RegExp ||
        typeof value === "function";
      break;
    case "settle":
      valid = typeof value === "boolean" || isPlainObject(value);
      break;
    case "string":
      valid = typeof value === "string";
      break;
    case "stringRecord":
      valid =
        isPlainObject(value) &&
        Object.values(value).every((item) => typeof item === "string");
      break;
    case "point":
      valid = isPoint(value);
      break;
  }
  if (!valid) {
    if (specification.kind === "positiveMilliseconds") {
      throw new TypeError(
        `${optionName} must be a positive number of milliseconds`,
      );
    }
    if (specification.kind === "nonNegativeNumber") {
      throw new TypeError(`${apiName} ${optionName} must be non-negative`);
    }
    if (specification.kind === "nonEmptyString") {
      throw new TypeError(
        `${apiName} ${optionName} must be a non-empty string`,
      );
    }
    if (specification.kind === "nonNegativeInteger") {
      throw new TypeError(
        `${apiName} ${optionName} must be a non-negative integer`,
      );
    }
    if (specification.kind === "positiveInteger") {
      throw new TypeError(
        `${apiName} ${optionName} must be a positive integer`,
      );
    }
    if (specification.kind === "pageRetention") {
      throw new TypeError(
        `${apiName} ${optionName} must be "all" or an array of unique non-empty Page labels`,
      );
    }
    if (specification.kind === "responseMatcher") {
      throw new TypeError(
        `${apiName} ${optionName} must be a non-empty URL string, a RegExp, or a function`,
      );
    }
    if (specification.kind === "settle") {
      throw new TypeError(
        `${apiName} ${optionName} must be true, false, or an options object`,
      );
    }
    if (specification.kind === "stringRecord") {
      throw new TypeError(
        `${apiName} ${optionName} must be an object with string values`,
      );
    }
    throw new TypeError(
      `${apiName} ${optionName} must be ${specification.kind}`,
    );
  }
  if (specification.values && !specification.values.includes(value as string)) {
    throw new TypeError(
      `${apiName} ${optionName} must be one of ${specification.values.join(", ")}`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPoint(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes("x") &&
    keys.includes("y") &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  );
}

function isClip(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["x", "y", "width", "height", "scale"]);
  return (
    keys.every((key) => allowed.has(key)) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height > 0 &&
    (value.scale === undefined ||
      (typeof value.scale === "number" &&
        Number.isFinite(value.scale) &&
        value.scale > 0))
  );
}
