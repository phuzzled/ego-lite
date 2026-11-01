/**
 * `ego-browser mcp`: a Model Context Protocol server on stdio.
 *
 * JSON-RPC 2.0, one message per line (the MCP stdio transport), with no
 * runtime dependencies. Each tool call runs as one SDK round through the
 * same runMain() path as `ego-browser nodejs`, one at a time.
 *
 * Task spaces: every tool takes an optional `task` name (default "main").
 * The first call for a name creates a task space owned by this MCP session;
 * later calls reuse it. When the client disconnects (stdin closes) or the
 * process gets SIGINT/SIGTERM/SIGHUP, the server closes every space it
 * created, except spaces handed off to the user, which stay with the user.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validate } from "./json-schema.mjs";
import { FULL_PAGE_MAX_HEIGHT, openPage } from "./oneshot.mjs";
import { errorDetails } from "./sdk-session.mjs";

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
export const DEFAULT_SPACE_TTL_MS = 30 * 60_000;
/** Largest text block a tool returns; longer text is cut with a note. */
export const MAX_TEXT_CHARS = 100_000;

const RPC = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
});

const INSTRUCTIONS = `ego-browser drives a real Chromium browser for you.
Workflow: browser_open a URL (returns a settled snapshot with @refs), then browser_act with a ref (@12) or a locator (loc=role:button "Sign in", or CSS) to click, fill, press or select. Refs last one page state: use the refs from the latest snapshot.
To read a page, browser_read is far smaller than a snapshot. browser_search searches the web. browser_tables reads data tables.
Logins: never ask the user for a password in chat; use browser_fill_secret with a secret the user stored, or browser_handoff so the user signs in, then browser_takeover when they say they are done.
Each tool takes an optional task name (default "main"); each task is its own task space. Call browser_finish when a task is done. Spaces close when this session ends.
Errors carry an error_code and a hint: follow the hint. Never try to bypass a bot check.`;

const TASK = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  description: 'Task name; each task has its own task space (default "main").',
};
const PAGE = {
  type: "string",
  minLength: 1,
  description: 'Page label in the task (default "p1").',
};
const TARGET = {
  type: "string",
  minLength: 1,
  description:
    'A ref from the latest snapshot (@12), a locator (loc=role:button "Search", loc=css:#q, loc=href:/about) or a CSS selector.',
};
const TIMEOUT = {
  type: "integer",
  minimum: 100,
  maximum: 600_000,
  description: "Maximum wait in milliseconds.",
};

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
  };
}

/** The tool list, as tools/list returns it. */
export const TOOL_DEFINITIONS = [
  tool(
    "browser_open",
    "Open a URL in a page of the task's space (created on first use), wait for it to settle, reject any cookie banner, and return a snapshot with @refs. Use newPage for a second tab.",
    {
      url: { type: "string", minLength: 1, description: "http(s) URL." },
      task: TASK,
      page: PAGE,
      newPage: {
        type: "boolean",
        description: "Open the URL in a new page (tab) of the task.",
      },
      profile: {
        type: "string",
        minLength: 1,
        description:
          'Browser profile for a new task space: "Default" (the user\'s logins, the default), "ephemeral" (an empty cookie jar) or a named profile.',
      },
      snapshot: {
        type: "boolean",
        description: "Return a snapshot (default true).",
      },
      timeout: TIMEOUT,
    },
    ["url"],
  ),
  tool(
    "browser_snapshot",
    "Return a semantic snapshot of a page with @refs to act on, after the page settles.",
    {
      task: TASK,
      page: PAGE,
      scope: {
        type: "string",
        enum: ["only_within_viewport", "full_page", "subtree"],
        description: "Default only_within_viewport.",
      },
      root: {
        type: "string",
        minLength: 1,
        description: "Ref of the subtree root with scope subtree.",
      },
      settle: {
        type: "boolean",
        description: "Wait for the page to settle first (default true).",
      },
    },
  ),
  tool(
    "browser_act",
    "Click, fill, press a key, select an option or hover, by ref or locator, then return the receipt and a new snapshot.",
    {
      action: {
        type: "string",
        enum: ["click", "fill", "press", "select", "hover"],
      },
      target: TARGET,
      value: {
        type: "string",
        description:
          "Text for fill, key chord for press (Enter, Control+A), option value or label for select.",
      },
      task: TASK,
      page: PAGE,
      snapshot: {
        type: "boolean",
        description: "Return a new snapshot afterwards (default true).",
      },
      timeout: TIMEOUT,
    },
    ["action"],
  ),
  tool(
    "browser_read",
    "Read a page as Markdown (article text, title, links): far smaller than a snapshot. With url, opens it first. Reads PDFs as text.",
    {
      url: { type: "string", minLength: 1 },
      task: TASK,
      page: PAGE,
      mode: { type: "string", enum: ["article", "full"] },
      selector: {
        type: "string",
        minLength: 1,
        description: "CSS selector of the element to read.",
      },
      maxChars: {
        type: "integer",
        minimum: 100,
        maximum: 500_000,
        description:
          "Cut the Markdown near this many characters (default 30000).",
      },
    },
  ),
  tool(
    "browser_tables",
    "Read the data tables of a page as rows keyed by header (JSON), or CSV. With url, opens it first.",
    {
      url: { type: "string", minLength: 1 },
      task: TASK,
      page: PAGE,
      index: { type: "integer", minimum: 0, description: "Only this table." },
      selector: { type: "string", minLength: 1 },
      csv: { type: "boolean", description: "Return CSV text instead of JSON." },
    },
  ),
  tool(
    "browser_search",
    "Search the web and return ranked results (title, url, snippet). An engine that shows a bot check is reported, never returned as empty results.",
    {
      query: { type: "string", minLength: 1 },
      engine: {
        type: "string",
        enum: ["auto", "bing", "duckduckgo", "google"],
      },
      max: { type: "integer", minimum: 1, maximum: 50 },
      task: TASK,
      page: PAGE,
    },
    ["query"],
  ),
  tool(
    "browser_screenshot",
    "Take a PNG screenshot of a page and return it as an image.",
    {
      task: TASK,
      page: PAGE,
      fullPage: {
        type: "boolean",
        description: `The whole scrollable page, cut at maxHeight (default ${FULL_PAGE_MAX_HEIGHT} CSS px).`,
      },
      maxHeight: { type: "integer", minimum: 100, maximum: 16_000 },
    },
  ),
  tool(
    "browser_evaluate",
    "Evaluate a JavaScript expression in the page and return its JSON result. A top-level return is allowed.",
    {
      expression: { type: "string", minLength: 1 },
      task: TASK,
      page: PAGE,
    },
    ["expression"],
  ),
  tool(
    "browser_wait_for",
    "Wait for a selector or locator, for the URL to match, or (with neither) for the page to settle.",
    {
      selector: TARGET,
      state: {
        type: "string",
        enum: ["attached", "detached", "visible", "hidden"],
        description: "With selector; default visible.",
      },
      url: {
        type: "string",
        minLength: 1,
        description: "URL glob or substring to wait for.",
      },
      task: TASK,
      page: PAGE,
      timeout: TIMEOUT,
    },
  ),
  tool(
    "browser_fill_secret",
    "Type a secret the user stored on this host (ego-browser secret set) into a field. The value never reaches you; it is typed only on the origins it was stored for.",
    {
      target: TARGET,
      secret: { type: "string", minLength: 1, description: "Secret name." },
      task: TASK,
      page: PAGE,
    },
    ["target", "secret"],
  ),
  tool(
    "browser_handoff",
    "Give control of the task's space to the user (to sign in, solve a check or decide). With relay, keep control and get a screenshot and snapshot to show the user instead. After a hand-off, wait until the user says they are done, then call browser_takeover.",
    {
      task: TASK,
      reason: {
        type: "string",
        description: "What the user should do; repeated in the answer.",
      },
      relay: { type: "boolean" },
    },
  ),
  tool(
    "browser_takeover",
    "Take control of the task's space back after the user said they are done.",
    { task: TASK },
  ),
  tool(
    "browser_spaces",
    "List the task spaces in the browser and the tasks of this session.",
    {},
  ),
  tool(
    "browser_close_space",
    "Close an agent-owned task space by id (spaces the user controls stay open).",
    { space: { type: "integer", minimum: 0 } },
    ["space"],
  ),
  tool(
    "browser_finish",
    "Finish a task: close its pages and its space (or keep some pages open).",
    {
      task: TASK,
      keep: {
        anyOf: [
          { type: "string", enum: ["all"] },
          { type: "array", items: { type: "string", minLength: 1 } },
        ],
        description: 'Page labels to keep open, or "all".',
      },
    },
  ),
  tool(
    "browser_run",
    "Run an ego-browser SDK script (the full API: taskSpace(), page.goto(), page.snapshot(), ...) as one round and return what it printed with console.log.",
    { script: { type: "string", minLength: 1 } },
    ["script"],
  ),
];

const TOOLS_BY_NAME = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));

function textContent(text) {
  const value = String(text ?? "");
  const clipped =
    value.length > MAX_TEXT_CHARS
      ? `${value.slice(0, MAX_TEXT_CHARS)}\n[cut at ${MAX_TEXT_CHARS} characters]`
      : value;
  return { type: "text", text: clipped };
}

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function invalidArgument(message, hint) {
  return Object.assign(new Error(message), {
    error_code: "EGO_INVALID_ARGUMENT",
    ...(hint ? { hint } : {}),
  });
}

/**
 * The server: protocol handling, the task registry and the tools. Transport
 * independent; runMcpStdio connects it to stdin and stdout.
 */
export class McpServer {
  /**
   * @param {object} deps
   * @param {() => Promise<object>} deps.openSession  an sdk-session, opened lazily
   * @param {string} deps.version
   * @param {string} [deps.profileId]  profile of new spaces (default: host default)
   * @param {number} [deps.toolTimeoutMs]
   * @param {number} [deps.ttlMs]      TTL of the spaces this session creates
   * @param {(line: string) => void} [deps.log]
   */
  constructor(deps) {
    this.deps = deps;
    this.toolTimeoutMs = deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.ttlMs = deps.ttlMs ?? DEFAULT_SPACE_TTL_MS;
    this.log = deps.log ?? (() => {});
    this.tag = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
    /** task name → { spaceId, name } */
    this.tasks = new Map();
    this.session = null;
    this.sessionPromise = null;
    this.queue = Promise.resolve();
    this.initialized = false;
    this.closed = false;
  }

  /** Handle one parsed JSON-RPC message; resolves to a response or null. */
  async handle(message) {
    if (Array.isArray(message)) {
      if (message.length === 0) {
        return rpcError(null, RPC.invalidRequest, "empty batch");
      }
      const responses = (
        await Promise.all(message.map((item) => this.handle(item)))
      ).filter(Boolean);
      return responses.length ? responses : null;
    }
    if (
      !message ||
      typeof message !== "object" ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string"
    ) {
      // A response from the client (we send no requests) is ignored.
      if (message && typeof message === "object" && !("method" in message)) {
        return null;
      }
      return rpcError(
        message?.id ?? null,
        RPC.invalidRequest,
        "not a JSON-RPC 2.0 request",
      );
    }
    const isNotification = !("id" in message);
    const { id, method, params } = message;
    try {
      const result = await this.dispatch(method, params ?? {});
      if (isNotification) return null;
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      if (isNotification) return null;
      if (error instanceof RpcError)
        return rpcError(id, error.code, error.message, error.data);
      return rpcError(id, RPC.internalError, String(error?.message || error));
    }
  }

  async dispatch(method, params) {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        this.initialized = true;
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "ego-browser",
            title: "ego lite browser",
            version: this.deps.version,
          },
          instructions: INSTRUCTIONS,
        };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        return {};
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOL_DEFINITIONS };
      case "tools/call":
        return this.callTool(params);
      case "resources/list":
        return { resources: [] };
      case "prompts/list":
        return { prompts: [] };
      default:
        throw new RpcError(RPC.methodNotFound, `Method not found: ${method}`);
    }
  }

  async callTool(params) {
    if (
      !params ||
      typeof params !== "object" ||
      typeof params.name !== "string"
    ) {
      throw new RpcError(RPC.invalidParams, "tools/call needs params.name");
    }
    const definition = TOOLS_BY_NAME.get(params.name);
    if (!definition) {
      throw new RpcError(RPC.invalidParams, `Unknown tool: ${params.name}`);
    }
    const args = params.arguments ?? {};
    const problems = validate(definition.inputSchema, args);
    if (problems.length > 0) {
      return toolError(
        invalidArgument(
          `Invalid arguments for ${params.name}: ${problems.join("; ")}`,
          "Fix the arguments to match the tool's input schema and call it again.",
        ),
      );
    }
    if (this.closed) {
      return toolError(invalidArgument("the MCP server is shutting down"));
    }
    return this.enqueue(() => this.runTool(params.name, args));
  }

  /** Tool calls run one at a time: rounds share the SDK's output sink. */
  enqueue(job) {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});
    return run;
  }

  async runTool(name, args) {
    let timer;
    const timeoutMs = Math.max(
      this.toolTimeoutMs,
      (args.timeout ?? 0) + 15_000,
    );
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(
              new Error(
                `${name} did not finish within ${Math.round(timeoutMs / 1000)}s`,
              ),
              {
                error_code: "EGO_TOOL_TIMEOUT",
                hint: "Take a browser_snapshot to see what the page shows, then retry once or try another way.",
              },
            ),
          ),
        timeoutMs,
      );
    });
    try {
      const work = this.execute(name, args);
      work.catch(() => {});
      return await Promise.race([work, timeout]);
    } catch (error) {
      return toolError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async getSession() {
    if (this.session) return this.session;
    if (!this.sessionPromise) {
      this.sessionPromise = this.deps.openSession().then(
        (session) => {
          this.session = session;
          return session;
        },
        (error) => {
          this.sessionPromise = null;
          throw error;
        },
      );
    }
    return this.sessionPromise;
  }

  async execute(name, args) {
    const session = await this.getSession();
    if (name === "browser_run") {
      try {
        const output = await session.runScript(args.script);
        return {
          content: [textContent(output || "(the script printed nothing)")],
        };
      } catch (error) {
        return toolError(error, error?.output);
      }
    }
    if (name === "browser_close_space")
      return this.closeSpace(session, args.space);
    if (name === "browser_spaces") return this.listSpaces(session);
    try {
      const { value, output } = await session.round((sdk) =>
        this.toolBody(name, args, sdk, session),
      );
      if (output?.trim()) value.content.push(textContent(output.trim()));
      return value;
    } catch (error) {
      if (error?.error_code === "EGO_TASK_SPACE_NOT_FOUND") {
        this.tasks.delete(args.task ?? "main");
      }
      const known = this.tasks.get(args.task ?? "main");
      if (
        (error?.error_code || error?.code) ===
          "EGO_TASK_SPACE_USER_IN_CONTROL" &&
        known &&
        !error.hint
      ) {
        return toolError(
          userInControlError(args.task ?? "main", known.spaceId, error),
          error?.output,
        );
      }
      return toolError(error, error?.output);
    }
  }

  /** The task's TaskSpace, created on first use. */
  async task(sdk, args, { profileId } = {}) {
    const taskName = args.task ?? "main";
    const known = this.tasks.get(taskName);
    if (known) {
      try {
        return await sdk.taskSpace(known.spaceId, { restorePages: true });
      } catch (error) {
        const code = error?.error_code || error?.code;
        if (code === "EGO_TASK_SPACE_NOT_FOUND") {
          this.tasks.delete(taskName);
        }
        if (code === "EGO_TASK_SPACE_USER_IN_CONTROL") {
          throw userInControlError(taskName, known.spaceId, error);
        }
        throw error;
      }
    }
    const spaceName = `mcp ${taskName} ${this.tag}`;
    const profile = profileId ?? this.deps.profileId;
    const created = await sdk.taskSpace(spaceName, {
      ...(profile ? { profileId: profile } : {}),
      ttlMs: this.ttlMs,
      restorePages: true,
    });
    this.tasks.set(taskName, { spaceId: created.spaceId, name: spaceName });
    return created;
  }

  async toolBody(name, args, sdk, session) {
    const deadline = Date.now() + (args.timeout ?? 30_000);
    switch (name) {
      case "browser_open": {
        const task = await this.task(sdk, args, { profileId: args.profile });
        const page = args.newPage
          ? await task.newPage()
          : task.page(args.page ?? "p1");
        const opened = await openPage(page, args.url, {
          deadline,
          strict: false,
        });
        const lines = [
          `space: ${task.spaceId} (task "${args.task ?? "main"}")`,
          `page: ${page.label}`,
          `url: ${await page.url().catch(() => args.url)}`,
          `title: ${await page.title().catch(() => "")}`,
        ];
        if (opened.status !== undefined) lines.push(`status: ${opened.status}`);
        if (opened.consent) {
          lines.push(
            `consent banner: ${opened.consent.action}${opened.consent.framework ? ` (${opened.consent.framework})` : ""}`,
          );
        }
        if (opened.blocked) {
          lines.push(
            `warning: the page shows a bot check (${opened.blocked}). Do not try to bypass it: use another source, or browser_handoff so the user can solve it.`,
          );
        }
        if (typeof opened.status === "number" && opened.status >= 400) {
          lines.push(`warning: the server answered HTTP ${opened.status}.`);
        }
        if (!opened.settled) {
          lines.push("note: the page did not settle; it may still be drawing.");
        }
        const content = [textContent(lines.join("\n"))];
        if (args.snapshot !== false) {
          content.push(
            textContent(await page.snapshot({ settle: { timeout: 3000 } })),
          );
        }
        return { content };
      }
      case "browser_snapshot": {
        const task = await this.task(sdk, args);
        const page = task.page(args.page ?? "p1");
        if (args.scope === "subtree" && !args.root) {
          throw invalidArgument("scope subtree needs root (a ref such as @21)");
        }
        const text = await page.snapshot({
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.root ? { root: args.root } : {}),
          ...(args.settle === false ? {} : { settle: { timeout: 5000 } }),
        });
        return { content: [textContent(text)] };
      }
      case "browser_act": {
        const task = await this.task(sdk, args);
        const page = task.page(args.page ?? "p1");
        const receipt = await act(page, args);
        const content = [
          textContent(`${args.action} done${receiptText(receipt)}`),
        ];
        if (args.snapshot !== false) {
          await page
            .waitForSettled({ timeout: 5000, quietMs: 300 })
            .catch(() => null);
          content.push(textContent(await page.snapshot()));
        }
        return { content };
      }
      case "browser_read": {
        const task = await this.task(sdk, args);
        const page = task.page(args.page ?? "p1");
        if (args.url)
          await openPage(page, args.url, { deadline, strict: false });
        const result = await page.read({
          ...(args.mode ? { mode: args.mode } : {}),
          ...(args.selector ? { selector: args.selector } : {}),
          maxChars: args.maxChars ?? 30_000,
        });
        const header = [
          `# ${result.title || "(untitled)"}`,
          `url: ${result.url}`,
          ...(result.byline ? [`byline: ${result.byline}`] : []),
          ...(result.published ? [`published: ${result.published}`] : []),
          `words: ${result.words}${result.truncated ? " (truncated; raise maxChars for more)" : ""}`,
          ...(result.warning ? [`warning: ${result.warning}`] : []),
        ];
        return {
          content: [textContent(`${header.join("\n")}\n\n${result.markdown}`)],
        };
      }
      case "browser_tables": {
        const task = await this.task(sdk, args);
        const page = task.page(args.page ?? "p1");
        if (args.url)
          await openPage(page, args.url, { deadline, strict: false });
        const tables = await page.tables({
          ...(args.selector ? { selector: args.selector } : {}),
          ...(args.index !== undefined ? { index: args.index } : {}),
          ...(args.csv ? { csv: true } : {}),
        });
        if (tables.length === 0) {
          return { content: [textContent("no data tables on this page")] };
        }
        if (args.csv) {
          return {
            content: tables.map((table) =>
              textContent(
                `# table ${table.index}${table.caption ? `: ${table.caption}` : ""} (${table.rowCount} rows)\n${table.csv ?? ""}`,
              ),
            ),
          };
        }
        return { content: [textContent(jsonText(tables))] };
      }
      case "browser_search": {
        const task = await this.task(sdk, args);
        const page = task.page(args.page ?? "p1");
        const result = await page.search(args.query, {
          ...(args.engine ? { engine: args.engine } : {}),
          ...(args.max ? { max: args.max } : {}),
        });
        if (!result.engine) {
          throw Object.assign(
            new Error(
              `every search engine showed a bot check: ${(result.blocked ?? []).map((b) => `${b.engine} (${b.reason})`).join(", ")}`,
            ),
            {
              error_code: "EGO_SITE_BLOCKED",
              hint:
                result.blocked?.[0]?.hint ??
                "Try again later or another engine. Do not try to bypass the check.",
            },
          );
        }
        return { content: [textContent(jsonText(result))] };
      }
      case "browser_screenshot": {
        const task = await this.task(sdk, args);
        const page = task.page(args.page ?? "p1");
        const dir = mkdtempSync(join(tmpdir(), "ego-mcp-shot-"));
        try {
          const path = await page.screenshot({
            path: join(dir, "shot.png"),
            ...(args.fullPage
              ? {
                  fullPage: true,
                  maxHeight: args.maxHeight ?? FULL_PAGE_MAX_HEIGHT,
                }
              : {}),
          });
          const data = readFileSync(path).toString("base64");
          return {
            content: [
              { type: "image", data, mimeType: "image/png" },
              textContent(`${await page.url().catch(() => "")}`),
            ],
          };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      case "browser_evaluate": {
        const task = await this.task(sdk, args);
        const page = task.page(args.page ?? "p1");
        const value = await page.evaluate(args.expression);
        return {
          content: [
            textContent(value === undefined ? "undefined" : jsonText(value)),
          ],
        };
      }
      case "browser_wait_for": {
        const task = await this.task(sdk, args);
        const page = task.page(args.page ?? "p1");
        const timeout = args.timeout ?? 10_000;
        if (args.selector && args.url) {
          throw invalidArgument("pass selector or url, not both");
        }
        if (args.selector) {
          await page.waitForSelector(args.selector, {
            timeout,
            ...(args.state ? { state: args.state } : {}),
          });
          return {
            content: [
              textContent(`${args.selector} is ${args.state ?? "visible"}`),
            ],
          };
        }
        if (args.url) {
          await page.waitForURL(args.url, { timeout });
          return { content: [textContent(`url: ${await page.url()}`)] };
        }
        const settled = await page.waitForSettled({ timeout });
        return { content: [textContent(jsonText(settled))] };
      }
      case "browser_fill_secret": {
        const task = await this.task(sdk, args);
        const page = task.page(args.page ?? "p1");
        const result = await page.fillSecret(args.target, args.secret);
        return {
          content: [
            textContent(
              `secret ${result.secret} typed on ${result.origin} (the value is not shown)`,
            ),
          ],
        };
      }
      case "browser_handoff": {
        const task = await this.task(sdk, args);
        const reason = args.reason ? `\nAsk the user to: ${args.reason}` : "";
        if (args.relay) {
          const { relay } = await task.handOff({ relay: true });
          const content = [
            textContent(
              `You keep control. Show the user this screenshot and snapshot, then do what they say.${reason}\nscreenshot: ${relay.screenshot}\nsnapshot: ${relay.snapshot}\npage: ${relay.title} ${relay.url}`,
            ),
          ];
          try {
            content.push({
              type: "image",
              data: readFileSync(relay.screenshot).toString("base64"),
              mimeType: "image/png",
            });
          } catch {
            // The paths are enough.
          }
          return { content };
        }
        await task.handOff();
        let viewer = "";
        if (session.hello?.display === "virtual") {
          const result = await session.control
            .call("startViewer", {})
            .catch(() => null);
          if (result?.url) {
            viewer = `\nThe user can watch and use the browser at ${result.url} after running on their computer: ${result.ssh}\n(the link works once).`;
          }
        } else if (session.hello?.display === "headless") {
          viewer =
            "\nwarning: the browser is headless, so the user cannot see or use this space. Prefer browser_handoff with relay: true, or ask the user to restart ego lite with: ego-browser stop && ego-browser start --display virtual";
        }
        return {
          content: [
            textContent(
              `Space ${task.spaceId} is now with the user.${reason}${viewer}\nWait until the user says they are done, then call browser_takeover. Browser tools on this task fail with EGO_TASK_SPACE_USER_IN_CONTROL until then.`,
            ),
          ],
        };
      }
      case "browser_takeover": {
        const taskName = args.task ?? "main";
        const known = this.tasks.get(taskName);
        if (!known) {
          throw invalidArgument(
            `this session has no task "${taskName}"`,
            "List the tasks with browser_spaces.",
          );
        }
        const task = await sdk.takeOverTaskSpace(known.spaceId);
        const pages = await task.pages().catch(() => []);
        return {
          content: [
            textContent(
              `You control space ${task.spaceId} again. Pages: ${pages.map((p) => p.label).join(", ") || "none"}. Take a browser_snapshot before acting: the user may have changed the page.`,
            ),
          ],
        };
      }
      case "browser_finish": {
        const taskName = args.task ?? "main";
        const known = this.tasks.get(taskName);
        if (!known) {
          return { content: [textContent(`no open task "${taskName}"`)] };
        }
        const task = await sdk.taskSpace(known.spaceId);
        const receipt = await task.finish({ keep: args.keep ?? [] });
        this.tasks.delete(taskName);
        return { content: [textContent(jsonText(receipt))] };
      }
      default:
        throw invalidArgument(`unknown tool ${name}`);
    }
  }

  async listSpaces(session) {
    const { taskSpaces = [] } = await session.control.call("listTaskSpaces");
    const mine = new Map(
      [...this.tasks].map(([taskName, entry]) => [entry.spaceId, taskName]),
    );
    const rows = taskSpaces.map((space) => ({
      id: space.id,
      name: space.name,
      ownership: space.ownership,
      ...(space.profileId ? { profileId: space.profileId } : {}),
      ...(mine.has(space.id) ? { task: mine.get(space.id) } : {}),
    }));
    return { content: [textContent(jsonText(rows))] };
  }

  async closeSpace(session, id) {
    const result = await session.control.call("closeTaskSpace", {
      id,
      force: false,
    });
    if (typeof result === "string") {
      for (const [taskName, entry] of this.tasks) {
        if (entry.spaceId === id) this.tasks.delete(taskName);
      }
      return { content: [textContent(result)] };
    }
    return toolError(
      Object.assign(new Error(result?.error || `space ${id} not closed`), {
        error_code: result?.error_code,
        hint:
          result?.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL"
            ? "The user controls this space; it stays open."
            : undefined,
      }),
    );
  }

  /**
   * Close every space this session created (not those the user controls)
   * and the SDK session. Safe to call more than once.
   */
  async shutdown() {
    if (this.closed) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = (async () => {
      const session = this.session;
      if (!session) return;
      for (const [taskName, entry] of this.tasks) {
        const result = await session.control
          .call("closeTaskSpace", { id: entry.spaceId, force: false }, 10_000)
          .catch((error) => ({ error: error?.message || String(error) }));
        if (typeof result === "string") {
          this.log(`closed task space ${entry.spaceId} (task "${taskName}")`);
        } else {
          this.log(
            `left task space ${entry.spaceId} (task "${taskName}") open: ${result?.error_code ?? ""} ${result?.error ?? ""}`.trim(),
          );
        }
      }
      this.tasks.clear();
      await session.close().catch(() => {});
    })();
    return this.shutdownPromise;
  }
}

async function act(page, args) {
  const { action, target, value } = args;
  const options = args.timeout ? { timeout: args.timeout } : {};
  const needTarget = () => {
    if (!target)
      throw invalidArgument(
        `${action} needs a target (a ref such as @12, or a locator)`,
      );
  };
  const needValue = () => {
    if (value === undefined) throw invalidArgument(`${action} needs a value`);
  };
  switch (action) {
    case "click":
      needTarget();
      return page.click(target, options);
    case "hover":
      needTarget();
      return page.hover(target, options);
    case "fill":
      needTarget();
      needValue();
      return page.fill(target, value, options);
    case "select":
      needTarget();
      needValue();
      return { selected: await page.selectOption(target, value, options) };
    case "press":
      needValue();
      if (target) return page.press(target, value, options);
      await page.keyboard.press(value);
      return {};
    default:
      throw invalidArgument(`unknown action ${action}`);
  }
}

function receiptText(receipt) {
  if (!receipt || typeof receipt !== "object") return "";
  const parts = [];
  if (receipt.popups?.length) {
    parts.push(
      `opened page(s): ${receipt.popups.map((p) => p.label).join(", ")} (use page: "${receipt.popups[0].label}")`,
    );
  }
  if (receipt.dialog) parts.push(`dialog: ${JSON.stringify(receipt.dialog)}`);
  if (receipt.selected) parts.push(`selected: ${receipt.selected.join(", ")}`);
  return parts.length ? `; ${parts.join("; ")}` : "";
}

/** A tool result that reports an error to the model, with the SDK hint. */
/**
 * A clean error for a task whose space the user controls. The SDK reports it
 * from whichever call hit it first (for example "task.restorePages:
 * manual_takeover"); the agent needs to know what to do instead.
 */
function userInControlError(taskName, spaceId, cause) {
  // The SDK's own message is written for scripts (it shows JavaScript to
  // run); keep only a short reason code such as manual_takeover.
  const raw = String(cause?.message || "")
    .replace(/^[\w.]+:\s*/, "")
    .trim();
  const reason = /^[\w-]{1,40}$/.test(raw) ? `, reason: ${raw}` : "";
  return Object.assign(
    new Error(
      `The user controls space ${spaceId} (task "${taskName}"${reason}). Browser tools on this task are paused until the user is done.`,
    ),
    {
      error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
      hint: "Wait until the user says they are done, then call browser_takeover. Use another task name to keep working meanwhile.",
    },
  );
}

export function toolError(error, output) {
  const details = errorDetails(error);
  const lines = [`Error: ${details.message}`];
  if (details.error_code) lines.push(`error_code: ${details.error_code}`);
  if (details.status !== undefined) lines.push(`status: ${details.status}`);
  if (details.hint) lines.push(`hint: ${details.hint}`);
  const content = [textContent(lines.join("\n"))];
  if (output?.trim()) content.push(textContent(`output:\n${output.trim()}`));
  return { content, isError: true };
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function rpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/**
 * Serve MCP on a pair of streams: newline-delimited JSON-RPC in, the same
 * out. Resolves when the input ends (the client disconnected) or `stop()` is
 * called, after the server has cleaned up.
 */
export function runMcpStdio(
  server,
  { input, write, log = () => {}, drainMs = DEFAULT_TOOL_TIMEOUT_MS },
) {
  let buffer = "";
  const inflight = new Set();
  let stopping = false;
  let writable = true;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  /**
   * Stop reading, let requests already received answer (up to drainMs; at
   * once with drain false), then clean up.
   */
  const finish = async ({ drain = false } = {}) => {
    if (stopping) return done;
    stopping = true;
    input.off?.("data", onData);
    if (drain && inflight.size > 0) {
      let timer;
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, drainMs);
        }),
      ]);
      clearTimeout(timer);
    }
    writable = false;
    await server.shutdown();
    resolveDone();
    return done;
  };

  const send = (response) => {
    if (!response || !writable) return;
    try {
      write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      log(`write failed: ${error?.message || error}`);
      void finish();
    }
  };

  const onLine = (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send(rpcError(null, RPC.parseError, "Parse error: not valid JSON"));
      return;
    }
    const job = server
      .handle(message)
      .then(send, (error) => log(`request failed: ${error?.message || error}`));
    inflight.add(job);
    job.finally(() => inflight.delete(job));
  };

  const onData = (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      onLine(line);
    }
  };

  input.setEncoding?.("utf8");
  input.on("data", onData);
  input.on("end", () => {
    if (buffer.trim()) onLine(buffer);
    buffer = "";
    void finish({ drain: true });
  });
  input.on("error", () => void finish());

  return { done, stop: finish };
}
