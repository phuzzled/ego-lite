/**
 * Run an extraction function in an isolated world of the page's main frame.
 *
 * The isolated world shares the DOM with the page but not its JavaScript
 * globals, so a page that overrides Array.prototype.map, JSON or
 * getComputedStyle cannot change what read(), tables() or structuredData()
 * return. When the browser refuses an isolated world (rare: some special
 * pages), the function runs in the page's main world instead.
 *
 * The function is sent as source text: it must be self-contained, with every
 * helper declared inside it, and take one JSON argument.
 */

export type IsolatedServices = {
  cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<any>;
};

const WORLD_NAME = "egoBrowserExtract";
const DEFAULT_TIMEOUT_MS = 15_000;

/** Attribute page.fillSecret puts on the field it typed a secret into. */
export const SECRET_FIELD_ATTRIBUTE = "data-ego-secret";
/** Attribute on <html> that says the document has such a field. */
export const SECRET_DOCUMENT_ATTRIBUTE = "data-ego-secrets";

/**
 * Runs in the page. Replace the current value of every field that
 * page.fillSecret typed into with [secret:<name>], everywhere in `result`,
 * so read(), tables() and structuredData() never return it (the host only
 * redacts its own snapshots). The values are read and replaced inside the
 * page; they never reach the script. Self-contained.
 */
export function redactFilledSecrets(result: unknown, doc: Document): unknown {
  const root = doc && doc.documentElement;
  if (!root || !root.hasAttribute("data-ego-secrets")) return result;
  const secrets: Array<{ name: string; value: string }> = [];
  const visit = (scope: Document | ShadowRoot | Element) => {
    for (const element of Array.from(scope.querySelectorAll("*"))) {
      if (element.hasAttribute("data-ego-secret")) {
        const field = element as HTMLInputElement;
        const value =
          typeof field.value === "string" && field.value
            ? field.value
            : element.textContent || "";
        if (value.length >= 4) {
          secrets.push({
            name: element.getAttribute("data-ego-secret") || "secret",
            value,
          });
        }
      }
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  try {
    visit(doc);
  } catch {
    // An exotic document: nothing found, nothing to replace.
  }
  if (secrets.length === 0) return result;
  // Every form an extractor may write the value in: as typed, with spaces
  // collapsed, and Markdown-escaped.
  const forms: Array<{ form: string; name: string }> = [];
  for (const { name, value } of secrets) {
    for (const form of new Set([
      value,
      value.replace(/\s+/g, " "),
      value.replace(/([*_`[\]])/g, "\\$1"),
    ])) {
      if (form.length >= 4) forms.push({ form, name });
    }
  }
  forms.sort((a, b) => b.form.length - a.form.length);
  const scrub = (text: string) => {
    let out = text;
    for (const { form, name } of forms) {
      if (out.includes(form)) out = out.split(form).join(`[secret:${name}]`);
    }
    return out;
  };
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return scrub(value);
    if (!value || typeof value !== "object" || depth > 64) return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = walk((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  };
  return walk(result, 0);
}

/** Build the expression that calls `fn(argument)`. */
export function isolatedCallExpression(
  fn: (argument: any) => unknown,
  argument: unknown,
): string {
  const json = JSON.stringify(argument ?? null);
  return `(async () => (${redactFilledSecrets.toString()})(await (${fn.toString()})(JSON.parse(${JSON.stringify(json)})), typeof document === "undefined" ? undefined : document))()`;
}

/** Evaluate `fn(argument)` in an isolated world and return its JSON value. */
export async function evaluateIsolated<T>(
  services: IsolatedServices,
  sessionId: string,
  fn: (argument: any) => unknown,
  argument: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const expression = isolatedCallExpression(fn, argument);
  let contextId: number | undefined;
  try {
    const tree = await services.cdp(
      "Page.getFrameTree",
      {},
      sessionId,
      timeoutMs,
    );
    const frameId = tree?.frameTree?.frame?.id;
    if (typeof frameId === "string") {
      const world = await services.cdp(
        "Page.createIsolatedWorld",
        { frameId, worldName: WORLD_NAME },
        sessionId,
        timeoutMs,
      );
      if (Number.isInteger(world?.executionContextId)) {
        contextId = world.executionContextId;
      }
    }
  } catch {
    // Fall back to the main world below.
  }
  const response = await services.cdp(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId === undefined ? {} : { contextId }),
    },
    sessionId,
    timeoutMs,
  );
  if (response?.exceptionDetails) {
    const details = response.exceptionDetails;
    const description =
      details.exception?.description ||
      details.exception?.value ||
      details.text ||
      "extraction failed in the page";
    throw new Error(String(description).split("\n")[0]);
  }
  return response?.result?.value as T;
}
