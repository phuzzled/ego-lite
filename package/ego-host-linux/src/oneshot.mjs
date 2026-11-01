/**
 * One-shot commands: read, shot, tables, snapshot and search.
 *
 * Each runs one SDK round in a throwaway task space (the `ephemeral` profile
 * unless --profile says otherwise), settles the page, rejects a consent
 * banner, prints clean output, and always finishes its space: on success,
 * on an error, on a timeout and on Ctrl-C.
 *
 * Exit codes: 0 ok, 1 error, 2 usage, 3 blocked by a bot check, 4 HTTP
 * error, 5 timeout.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { errorDetails } from "./sdk-session.mjs";

export const ONE_SHOT_COMMANDS = [
  "read",
  "shot",
  "tables",
  "snapshot",
  "search",
];

export const EXIT = Object.freeze({
  ok: 0,
  error: 1,
  usage: 2,
  blocked: 3,
  http: 4,
  timeout: 5,
});

export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Tallest full-page screenshot, in CSS px. The SDK's 16000 px default times
 * out in headless Chrome on long pages, and image models refuse images much
 * taller than 8000 px.
 */
export const FULL_PAGE_MAX_HEIGHT = 7_500;

export const ONE_SHOT_USAGE = `One-shot commands (a throwaway task space, always closed afterwards):
  ego-browser read <url> [--json] [--max-chars <n>] [--mode article|full]
                                     the page (or PDF) as Markdown
  ego-browser shot <url> [--full] [--out <file.png>] [--json]
                                     a screenshot; prints the PNG path
  ego-browser tables <url> [--csv] [--index <n>] [--out <dir>] [--json]
                                     the page's tables (Markdown, CSV or JSON)
  ego-browser snapshot <url> [--full] [--json]
                                     a settled snapshot with refs
  ego-browser search "<query>" [--engine auto|bing|duckduckgo|google]
                       [--max <n>] [--json]
                                     web search results
  Common options: --profile <id> (default: ephemeral; "Default" uses your
  logins), --timeout <30s|90000ms|2m> (default 60s), --sdk-path <index.js>
  Exit codes: 0 ok, 1 error, 2 usage, 3 blocked by a bot check,
  4 HTTP error, 5 timeout.
`;

/** A usage error: exit code 2. */
export class UsageError extends Error {}

/**
 * Parse a duration: "30" and "30s" are seconds, "500ms" milliseconds, "2m"
 * minutes, "1h" hours. Returns milliseconds.
 */
export function parseDuration(text, name = "--timeout", maxMs = 30 * 60_000) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(text).trim());
  if (!match) {
    throw new UsageError(
      `${name} needs a duration such as 30s, 90000ms or 2m (got "${text}")`,
    );
  }
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] || "s"];
  const ms = Math.round(Number(match[1]) * unit);
  if (!Number.isFinite(ms) || ms < 1000 || ms > maxMs) {
    throw new UsageError(
      `${name} must be between 1s and ${Math.round(maxMs / 60_000)}m`,
    );
  }
  return ms;
}

/** "example.com/x" → "https://example.com/x"; anything but http(s) fails. */
export function normalizeUrl(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new UsageError("a URL is required");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UsageError(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`only http and https URLs are supported: ${raw}`);
  }
  return url.href;
}

const VALUE_OPTIONS = {
  common: ["--profile", "--timeout", "--sdk-path"],
  read: ["--max-chars", "--mode"],
  shot: ["--out", "-o"],
  tables: ["--out", "-o", "--index"],
  snapshot: [],
  search: ["--engine", "--max"],
};
const FLAG_OPTIONS = {
  common: ["--json"],
  read: [],
  shot: ["--full"],
  tables: ["--csv"],
  snapshot: ["--full"],
  search: [],
};

/** Parse the arguments of one one-shot command. Throws UsageError. */
export function parseOneShotArgs(command, args) {
  if (!ONE_SHOT_COMMANDS.includes(command)) {
    throw new UsageError(`unknown command: ${command}`);
  }
  const valueOptions = [...VALUE_OPTIONS.common, ...VALUE_OPTIONS[command]];
  const flagOptions = [...FLAG_OPTIONS.common, ...FLAG_OPTIONS[command]];
  const values = {};
  const flags = new Set();
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (valueOptions.includes(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value === "") {
        throw new UsageError(`${name} needs a value`);
      }
      values[name === "-o" ? "--out" : name] = value;
    } else if (flagOptions.includes(arg)) {
      flags.add(arg);
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`unknown option for ${command}: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const options = {
    command,
    json: flags.has("--json"),
    profileId: values["--profile"] ?? "ephemeral",
    timeoutMs: values["--timeout"]
      ? parseDuration(values["--timeout"])
      : DEFAULT_TIMEOUT_MS,
    sdkPath: values["--sdk-path"],
  };

  if (command === "search") {
    const query = positional.join(" ").trim();
    if (!query)
      throw new UsageError(
        'search needs a query: ego-browser search "<query>"',
      );
    options.query = query;
    const engine = values["--engine"] ?? "auto";
    if (!["auto", "bing", "duckduckgo", "google"].includes(engine)) {
      throw new UsageError("--engine must be auto, bing, duckduckgo or google");
    }
    options.engine = engine;
    if (values["--max"] !== undefined) {
      options.max = positiveInteger(values["--max"], "--max");
    }
    return options;
  }

  if (positional.length !== 1) {
    throw new UsageError(
      positional.length === 0
        ? `${command} needs a URL: ego-browser ${command} <url>`
        : `${command} takes one URL (got ${positional.length} arguments)`,
    );
  }
  options.url = normalizeUrl(positional[0]);

  if (command === "read") {
    if (values["--max-chars"] !== undefined) {
      options.maxChars = positiveInteger(values["--max-chars"], "--max-chars");
    }
    const mode = values["--mode"] ?? "article";
    if (mode !== "article" && mode !== "full") {
      throw new UsageError("--mode must be article or full");
    }
    options.mode = mode;
  } else if (command === "shot") {
    options.fullPage = flags.has("--full");
    if (values["--out"]) options.out = resolve(values["--out"]);
  } else if (command === "tables") {
    options.csv = flags.has("--csv");
    if (values["--out"]) options.out = resolve(values["--out"]);
    if (values["--index"] !== undefined) {
      const index = Number(values["--index"]);
      if (!Number.isInteger(index) || index < 0) {
        throw new UsageError("--index needs a table index (0, 1, ...)");
      }
      options.index = index;
    }
    if (options.out && !options.csv) {
      throw new UsageError("tables --out <dir> writes CSV files; add --csv");
    }
  } else if (command === "snapshot") {
    options.fullPage = flags.has("--full");
  }
  return options;
}

function positiveInteger(text, name) {
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${name} needs a positive whole number`);
  }
  return value;
}

/** Map an SDK error to an exit code. */
export function exitCodeFor(error) {
  const code = error?.error_code || error?.code;
  if (code === "EGO_SITE_BLOCKED") return EXIT.blocked;
  if (code === "EGO_NAVIGATION_HTTP_ERROR") return EXIT.http;
  if (
    code === "EGO_NAVIGATION_TIMEOUT" ||
    code === "EGO_ONE_SHOT_TIMEOUT" ||
    code === "EGO_PAGE_EVALUATION_TIMED_OUT" ||
    code === "EGO_CDP_REQUEST_TIMEOUT"
  ) {
    return EXIT.timeout;
  }
  return EXIT.error;
}

function hinted(code, message, hint, details = {}) {
  return Object.assign(new Error(message), {
    error_code: code,
    hint,
    ...details,
  });
}

/**
 * Text of a bot check or human-verification page, judged from what the page
 * shows. Returns a short reason, or null.
 */
const BOT_CHECK_PROBE = `(() => {
  const title = document.title || "";
  const text = (document.body?.innerText || "").slice(0, 2000);
  if (document.querySelector("iframe[src*='challenges.cloudflare.com'], #challenge-form, #cf-challenge-running, .g-recaptcha, iframe[src*='recaptcha'], iframe[src*='hcaptcha.com']")) return "a captcha or challenge form";
  if (/^(just a moment|attention required|access denied|are you a robot|human verification)/i.test(title.trim())) return "the title: " + title.trim().slice(0, 80);
  if (/verify (that )?you are (a )?human|unusual traffic|are you a robot|enable javascript and cookies to continue|checking your browser before accessing/i.test(text)) return "a human-verification message";
  return null;
})()`;

const TRANSIENT_NET_ERROR =
  /net::ERR_(?:NETWORK_CHANGED|CONNECTION_RESET|CONNECTION_CLOSED)\b/;

async function botCheck(page) {
  try {
    return await page.evaluate(BOT_CHECK_PROBE);
  } catch {
    return null;
  }
}

/**
 * Open `url` in `page`: navigate, record the document's HTTP status, wait for
 * the page to settle and reject a consent banner. With strict (the default)
 * it throws for HTTP errors and bot checks; otherwise it reports them.
 */
export async function openPage(
  page,
  url,
  { deadline, now = Date.now, strict = true },
) {
  const left = () => Math.max(1000, deadline - now());
  let documentStatus;
  const statusWatch = page
    .waitForResponse((response) => response.resourceType === "Document", {
      timeout: left(),
      maxBodyBytes: 1,
    })
    .then((response) => {
      documentStatus = response?.status;
    })
    .catch(() => {});
  try {
    await page.goto(url, { timeout: left(), waitUntil: "load" });
  } catch (error) {
    // A network blip (the route changed, the connection reset) is worth one
    // more try; anything else is reported as it is.
    if (!TRANSIENT_NET_ERROR.test(String(error?.message))) throw error;
    await sleep(500);
    await page.goto(url, { timeout: left(), waitUntil: "load" });
  }
  await Promise.race([statusWatch, sleep(1000)]);
  const settle = await page
    .waitForSettled({ timeout: Math.min(10_000, left()) })
    .catch(() => null);
  const consent = await page
    .dismissConsent({ prefer: "reject", timeout: Math.min(1500, left()) })
    .catch(() => null);
  if (consent?.found && consent.action !== "none") {
    await page
      .waitForSettled({ timeout: Math.min(5000, left()), quietMs: 300 })
      .catch(() => null);
  }
  const blocked = await botCheck(page);
  if (blocked && strict) {
    throw hinted(
      "EGO_SITE_BLOCKED",
      `${url} shows a bot check (${blocked})`,
      "The site asked for a human check. Try another source, or run the task in a script and hand the space to the user with task.handOff(). Do not try to bypass the check.",
    );
  }
  if (strict && typeof documentStatus === "number" && documentStatus >= 400) {
    throw hinted(
      "EGO_NAVIGATION_HTTP_ERROR",
      `${url} answered HTTP ${documentStatus}`,
      `The server answered ${documentStatus}. Check the URL; a page that needs a login works with --profile <id> after you sign in there.`,
      { status: documentStatus },
    );
  }
  return {
    status: documentStatus,
    blocked: blocked ?? null,
    settled: settle?.settled ?? false,
    consent: consent?.found
      ? { action: consent.action, framework: consent.framework ?? null }
      : null,
  };
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms).unref?.());
}

/** The work of each command inside the round. Returns { text, json, exit? }. */
export const COMMANDS = {
  async read(page, options, context) {
    const opened = await openPage(page, options.url, context);
    const result = await page.read({
      mode: options.mode,
      ...(options.maxChars ? { maxChars: options.maxChars } : {}),
      timeout: Math.min(
        20_000,
        Math.max(1000, context.deadline - context.now()),
      ),
    });
    const notes = [];
    if (result.warning) notes.push(result.warning);
    if (result.truncated) {
      notes.push(
        `truncated at ${result.markdown.length} characters; raise it with --max-chars`,
      );
    }
    return {
      json: {
        ...result,
        status: opened.status ?? null,
        consent: opened.consent,
      },
      text: withNewline(result.markdown),
      notes,
    };
  },

  async shot(page, options, context) {
    const opened = await openPage(page, options.url, context);
    const path =
      options.out ??
      join(
        tmpdir(),
        "ego-browser-shots",
        `${new URL(options.url).hostname}-${context.now()}.png`,
      );
    const saved = await page.screenshot({
      path,
      ...(options.fullPage
        ? { fullPage: true, maxHeight: FULL_PAGE_MAX_HEIGHT }
        : {}),
    });
    const url = await page.url().catch(() => options.url);
    const title = await page.title().catch(() => "");
    return {
      json: {
        path: saved,
        url,
        title,
        fullPage: options.fullPage,
        consent: opened.consent,
      },
      text: `${saved}\n`,
      notes: [],
    };
  },

  async tables(page, options, context) {
    await openPage(page, options.url, context);
    const tables = await page.tables({
      csv: options.csv,
      ...(options.index !== undefined ? { index: options.index } : {}),
    });
    if (tables.length === 0) {
      return {
        json: [],
        text: "",
        notes: ["no data tables found on the page"],
      };
    }
    if (options.out) {
      mkdirSync(options.out, { recursive: true });
      const paths = tables.map((table) => {
        const file = join(options.out, `table-${table.index}.csv`);
        writeFileSync(file, withNewline(table.csv ?? ""));
        return file;
      });
      return {
        json: tables.map((table, i) => ({
          index: table.index,
          caption: table.caption ?? null,
          rowCount: table.rowCount,
          path: paths[i],
        })),
        text: `${paths.join("\n")}\n`,
        notes: [],
      };
    }
    if (options.csv) {
      const text =
        tables.length === 1
          ? withNewline(tables[0].csv ?? "")
          : tables
              .map(
                (table) =>
                  `# table ${table.index}${table.caption ? `: ${oneLine(table.caption)}` : ""}\n${withNewline(table.csv ?? "")}`,
              )
              .join("\n");
      return { json: tables, text, notes: [] };
    }
    return {
      json: tables,
      text: tables.map(markdownTable).join("\n"),
      notes: [],
    };
  },

  async snapshot(page, options, context) {
    await openPage(page, options.url, context);
    const snapshot = await page.snapshot({
      format: "object",
      settle: {
        timeout: Math.min(
          5000,
          Math.max(1000, context.deadline - context.now()),
        ),
      },
      ...(options.fullPage ? { scope: "full_page" } : {}),
    });
    const url = await page.url().catch(() => options.url);
    const title = await page.title().catch(() => "");
    return {
      json: { url, title, ...snapshot },
      text: withNewline(snapshot.text),
      notes: [],
    };
  },

  async search(page, options, context) {
    const result = await page.search(options.query, {
      engine: options.engine,
      ...(options.max ? { max: options.max } : {}),
      timeout: Math.min(
        15_000,
        Math.max(1000, context.deadline - context.now()),
      ),
    });
    if (!result.engine) {
      const reasons = (result.blocked ?? [])
        .map((block) => `${block.engine}: ${block.reason}`)
        .join("; ");
      throw hinted(
        "EGO_SITE_BLOCKED",
        `every search engine showed a bot check (${reasons || "no engine answered"})`,
        result.blocked?.[0]?.hint ??
          "Try again later or with --engine bing. Do not try to bypass the check.",
        { result },
      );
    }
    const notes = [];
    if (result.warning) notes.push(result.warning);
    if (result.noResults || result.results.length === 0) {
      notes.push(`no results for "${options.query}" on ${result.engine}`);
    }
    for (const block of result.blocked ?? []) {
      notes.push(
        `${block.engine} was blocked (${block.reason}); used ${result.engine}`,
      );
    }
    const text = result.results
      .map(
        (item) =>
          `${item.rank}. ${oneLine(item.title)}\n   ${item.url}${item.snippet ? `\n   ${oneLine(item.snippet)}` : ""}`,
      )
      .join("\n");
    return { json: result, text: text ? `${text}\n` : "", notes };
  },
};

function withNewline(text) {
  const value = String(text ?? "");
  return value.endsWith("\n") || value === "" ? value : `${value}\n`;
}

function oneLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function cell(text) {
  return oneLine(text).replace(/\|/g, "\\|");
}

/** One extracted table as a Markdown table. */
export function markdownTable(table) {
  const headers = table.headers?.length
    ? table.headers
    : Object.keys(table.rows?.[0] ?? {});
  const lines = [];
  lines.push(
    `### Table ${table.index}${table.caption ? `: ${oneLine(table.caption)}` : ""} (${table.rowCount ?? table.rows?.length ?? 0} rows)`,
  );
  lines.push("");
  if (headers.length > 0) {
    lines.push(`| ${headers.map(cell).join(" | ")} |`);
    lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
    for (const row of table.rows ?? []) {
      lines.push(`| ${headers.map((h) => cell(row[h] ?? "")).join(" | ")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Run one parsed one-shot command.
 *
 * @param {object} options          from parseOneShotArgs
 * @param {object} deps
 * @param {() => Promise<object>} deps.openSession   an sdk-session
 * @param {{write(s: string): unknown}} deps.stdout
 * @param {{write(s: string): unknown}} deps.stderr
 * @param {(fn: () => void) => () => void} [deps.onInterrupt]
 *        register a Ctrl-C handler; returns an unregister function
 * @returns {Promise<number>} the exit code
 */
export async function runOneShot(options, deps) {
  const { stdout, stderr } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = started + options.timeoutMs;

  let session;
  try {
    session = await deps.openSession(options);
  } catch (error) {
    return fail(error, options, { stdout, stderr });
  }

  const name = `ego-browser ${options.command} ${process.pid}-${started.toString(36)}`;
  const state = { spaceId: null, finished: false };

  /** Close the space from outside the round, when the round cannot. */
  const closeFromOutside = async () => {
    if (state.finished || state.spaceId === null) return;
    state.finished = true;
    await session.control
      .call("closeTaskSpace", { id: state.spaceId, force: false }, 10_000)
      .catch(() => {});
  };

  const work = session.round(async (sdk) => {
    const task = await sdk.taskSpace(name, {
      profileId: options.profileId,
      // A killed process leaves the space to the daemon's TTL collector.
      ttlMs: options.timeoutMs + 5 * 60_000,
    });
    state.spaceId = task.spaceId;
    try {
      return await COMMANDS[options.command](task.page("p1"), options, {
        deadline,
        now,
      });
    } finally {
      if (!state.finished) {
        state.finished = true;
        await task.finish().catch(() => {
          state.finished = false;
          return closeFromOutside();
        });
      }
    }
  });

  let timer;
  let interrupted;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          hinted(
            "EGO_ONE_SHOT_TIMEOUT",
            `${options.command} did not finish within ${Math.round(options.timeoutMs / 1000)}s`,
            "Retry once with a longer --timeout (such as --timeout 2m); a slow page may also be blocking the load.",
          ),
        ),
      // A little past the deadline: the steps inside keep to it themselves.
      options.timeoutMs + 2000,
    );
  });
  const interrupt = new Promise((_, reject) => {
    interrupted = deps.onInterrupt?.(() =>
      reject(
        Object.assign(new Error("interrupted"), {
          error_code: "EGO_INTERRUPTED",
        }),
      ),
    );
  });

  let code;
  try {
    const { value, output } = await Promise.race([work, timeout, interrupt]);
    // SDK notices (a cut screenshot, an unhandled popup) go to stderr.
    if (output?.trim()) stderr.write(withNewline(output.trim()));
    for (const note of value.notes ?? [])
      stderr.write(`[ego-browser] ${note}\n`);
    stdout.write(
      options.json ? `${JSON.stringify(value.json, null, 2)}\n` : value.text,
    );
    code = EXIT.ok;
  } catch (error) {
    await closeFromOutside();
    code =
      error?.error_code === "EGO_INTERRUPTED"
        ? 130
        : fail(error, options, { stdout, stderr });
  } finally {
    clearTimeout(timer);
    interrupted?.();
    work.catch(() => {});
    await session.close().catch(() => {});
  }
  return code;
}

function fail(error, options, { stdout, stderr }) {
  const details = errorDetails(error);
  if (details.error_code === "EGO_NAVIGATION_TIMEOUT") {
    details.hint =
      "The page did not finish loading in time. Retry once with a longer --timeout (such as --timeout 2m).";
  }
  const code = exitCodeFor(error);
  if (options.json) {
    stdout.write(`${JSON.stringify({ ok: false, ...details }, null, 2)}\n`);
  }
  stderr.write(
    `ego-browser ${options.command}: ${details.message.split("\n")[0]}\n` +
      (details.error_code ? `  error_code: ${details.error_code}\n` : "") +
      (details.hint ? `  hint: ${details.hint}\n` : ""),
  );
  return code;
}
