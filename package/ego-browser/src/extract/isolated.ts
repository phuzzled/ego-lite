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

/** Build the expression that calls `fn(argument)`. */
export function isolatedCallExpression(
  fn: (argument: any) => unknown,
  argument: unknown,
): string {
  const json = JSON.stringify(argument ?? null);
  return `(async () => (${fn.toString()})(JSON.parse(${JSON.stringify(json)})))()`;
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
