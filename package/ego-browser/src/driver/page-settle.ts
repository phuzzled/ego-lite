/**
 * "Is this page done drawing?" for client-rendered pages.
 *
 * `goto()` returns at `load`, and `networkidle` is not a content signal: a page
 * that renders after a slow fetch looks idle too early, and a page that polls
 * never looks idle. A page is settled here when its document has loaded, its
 * DOM has not changed for a quiet window, no fetch/XHR it started is still
 * waiting for its answer (long polls, WebSocket and EventSource are ignored),
 * and, when asked, a selector has enough matches. A request counts until its
 * response headers arrive, not until loadingFinished: Chromium never finishes
 * a body the page does not read.
 *
 * The DOM signal is a MutationObserver that the first probe installs in the
 * page under a Symbol key, so later probes and snapshots share it. Everything
 * runs through Runtime.evaluate and the existing network tracker; no new
 * browser binding is needed.
 */

export type PageSettleOptions = {
  timeout?: number;
  quietMs?: number;
  until?: string;
  minCount?: number;
};

export type PageSettleResult = {
  settled: boolean;
  waitedMs: number;
  mutationsSeen: number;
  pendingRequests: number;
  readyState?: string;
  matches?: number;
  reason?: string;
};

/** Page state read by one probe. */
export type PageSettleState = {
  url: string;
  readyState: string;
  /** Milliseconds since the last DOM change, or since the observer started. */
  quietMs: number;
  /** DOM changes seen since the observer started in this document. */
  mutations: number;
  /** Milliseconds since this document's time origin. */
  ageMs: number;
  nodes?: number;
  textChars?: number;
};

export type PageSettleServices = {
  cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<any>;
  ensureNetworkTracking?(
    sessionIds: string[],
    timeoutMs?: number,
  ): Promise<void>;
  inflightRequests?(
    sessionIds: string[],
  ): Array<{ type?: string; startedAt: number; responded?: boolean }>;
  now(): number;
  sleep(ms: number): Promise<void>;
};

export const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;
export const DEFAULT_QUIET_MS = 500;
const SETTLE_POLL_MS = 100;
const PROBE_TIMEOUT_MS = 1_000;
/** A fetch/XHR open this long is treated as a long poll, not as loading. */
export const LONG_POLL_MS = 5_000;
const DATA_REQUEST_TYPES = new Set(["Fetch", "XHR"]);

/**
 * Install the shared observer if this document has none, then report its
 * state. With `full`, also count elements and visible text, which costs a
 * layout pass and is only done once per snapshot.
 */
export function settleProbeExpression(full: boolean): string {
  return `(() => {
    const key = Symbol.for("egoBrowser.settle");
    const now = performance.now();
    let state = globalThis[key];
    if (!state || state.doc !== document) {
      state = { doc: document, last: now, count: 0 };
      try {
        new MutationObserver((records) => {
          state.count += records.length;
          state.last = performance.now();
        }).observe(document, { subtree: true, childList: true, characterData: true });
      } catch {}
      Object.defineProperty(globalThis, key, { value: state, configurable: true });
    }
    const result = {
      __egoSettleProbe: true,
      url: location.href,
      readyState: document.readyState,
      quietMs: now - state.last,
      mutations: state.count,
      ageMs: now,
    };
    ${
      full
        ? `result.nodes = document.getElementsByTagName("*").length;
    result.textChars = document.body ? (document.body.innerText || "").length : 0;`
        : ""
    }
    return result;
  })()`;
}

/** Read the page state, or undefined while the document is being replaced. */
export async function probePageState(
  services: PageSettleServices,
  sessionId: string,
  full = false,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<PageSettleState | undefined> {
  try {
    const response = await services.cdp(
      "Runtime.evaluate",
      { expression: settleProbeExpression(full), returnByValue: true },
      sessionId,
      timeoutMs,
    );
    const value = response?.result?.value;
    if (!value || typeof value !== "object" || !value.__egoSettleProbe) {
      return undefined;
    }
    const { __egoSettleProbe: _marker, ...state } = value;
    return state as PageSettleState;
  } catch {
    // A navigation can destroy the context mid-probe; the caller polls again.
    return undefined;
  }
}

/** Count fetch/XHR requests still waiting for an answer, ignoring long polls. */
export function pendingDataRequests(
  services: PageSettleServices,
  sessionIds: string[],
): number | undefined {
  if (typeof services.inflightRequests !== "function") return undefined;
  const now = services.now();
  return services.inflightRequests(sessionIds).filter(
    (request) =>
      request.type !== undefined &&
      DATA_REQUEST_TYPES.has(request.type) &&
      // Only a request still waiting for its answer holds the page back:
      // Chromium never finishes a body the page does not read.
      request.responded !== true &&
      now - request.startedAt < LONG_POLL_MS,
  ).length;
}

/**
 * Wait until the page is settled or the timeout passes. It does not throw on
 * timeout: it resolves `{ settled: false, reason }`, so a busy page still gets
 * its snapshot. `countMatches` counts the `until` selector when given.
 */
export async function waitForSettledInPage(
  services: PageSettleServices,
  sessionId: string,
  options: PageSettleOptions = {},
  countMatches?: (selector: string) => Promise<number>,
  networkSessions: () => Promise<string[]> = async () => [sessionId],
): Promise<PageSettleResult> {
  const timeoutMs = options.timeout ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const minCount = options.minCount ?? 1;
  const startedAt = services.now();
  const deadline = startedAt + timeoutMs;

  let sessionIds = [sessionId];
  let networkTracked = false;
  try {
    sessionIds = await networkSessions();
    if (typeof services.ensureNetworkTracking === "function") {
      await services.ensureNetworkTracking(
        sessionIds,
        Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - services.now())),
      );
      networkTracked = true;
    }
  } catch {
    // Without network tracking the DOM and readyState still decide.
  }

  let lastMutations: number | undefined;
  let mutationsSeen = 0;
  let pending = 0;
  let matches: number | undefined;
  let readyState: string | undefined;
  let reason = "the page did not answer";
  while (true) {
    const state = await probePageState(
      services,
      sessionId,
      false,
      Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - services.now())),
    );
    if (state) {
      readyState = state.readyState;
      // Count changes seen during this wait. A new document restarts its
      // observer count, so its whole count is new.
      if (lastMutations === undefined) {
        lastMutations = state.mutations;
      } else {
        mutationsSeen +=
          state.mutations >= lastMutations
            ? state.mutations - lastMutations
            : state.mutations;
        lastMutations = state.mutations;
      }
      pending = networkTracked
        ? (pendingDataRequests(services, sessionIds) ?? 0)
        : 0;
      if (options.until !== undefined && countMatches) {
        matches = await countMatches(options.until);
      }
      if (state.readyState !== "complete") {
        reason = `document is still ${state.readyState}`;
      } else if (state.quietMs < quietMs) {
        reason = "dom still changing";
      } else if (pending > 0) {
        reason = `${pending} fetch/XHR request${pending === 1 ? "" : "s"} still pending`;
      } else if (matches !== undefined && matches < minCount) {
        reason = `${options.until} matched ${matches} of ${minCount}`;
      } else {
        return result(true);
      }
    } else if (readyState === undefined) {
      // Keep the last real reason when only a late probe failed.
      reason = "the document is being replaced";
    }
    const remaining = deadline - services.now();
    if (remaining <= 0) return result(false);
    await services.sleep(Math.min(SETTLE_POLL_MS, remaining));
  }

  function result(settled: boolean): PageSettleResult {
    return {
      settled,
      waitedMs: Math.max(0, services.now() - startedAt),
      mutationsSeen,
      pendingRequests: pending,
      ...(readyState === undefined ? {} : { readyState }),
      ...(matches === undefined ? {} : { matches }),
      ...(settled ? {} : { reason }),
    };
  }
}

export type SnapshotStats = {
  nodes: number;
  refs: number;
  textChars: number;
  readyState: string;
  domChanging: boolean;
  pendingRequests?: number;
};

/** Below this much visible text a page probably has not drawn its content. */
export const LITTLE_TEXT_CHARS = 200;
/** A document younger than this with little text may still be rendering. */
export const YOUNG_DOCUMENT_MS = 3_000;
/** A DOM change within this window means the page is still changing. */
export const DOM_CHANGING_MS = 500;

/** Stats for a snapshot, from a full probe taken right after it. */
export function snapshotStats(
  state: PageSettleState,
  refs: number,
  pendingRequests?: number,
): SnapshotStats {
  return {
    nodes: state.nodes ?? 0,
    refs,
    textChars: state.textChars ?? 0,
    readyState: state.readyState,
    domChanging: state.mutations > 0 && state.quietMs < DOM_CHANGING_MS,
    ...(pendingRequests === undefined ? {} : { pendingRequests }),
  };
}

/**
 * Cheap signs that a snapshot caught a page before its content: the document
 * is still loading, or the page has little text and is either changing,
 * waiting on requests, or only just loaded. A false warning costs one wait.
 */
export function snapshotWarnings(
  stats: SnapshotStats,
  state: PageSettleState,
): string[] {
  if (/^about:(blank|srcdoc)$/.test(state.url)) return [];
  const reasons: string[] = [];
  if (stats.readyState !== "complete") {
    reasons.push(`the document is still ${stats.readyState}`);
  }
  if (stats.textChars < LITTLE_TEXT_CHARS) {
    if (stats.domChanging) {
      reasons.push(
        `the DOM changed in the last ${DOM_CHANGING_MS} ms and the page has little text`,
      );
    } else if ((stats.pendingRequests ?? 0) > 0) {
      reasons.push(
        `${stats.pendingRequests} request${stats.pendingRequests === 1 ? " is" : "s are"} still loading and the page has little text`,
      );
    } else if (state.ageMs < YOUNG_DOCUMENT_MS) {
      reasons.push(
        `the page loaded ${Math.round(state.ageMs)} ms ago and has little text`,
      );
    }
  }
  if (reasons.length === 0) return [];
  return [
    `page may still be rendering: ${reasons.join("; ")}. Wait for the content (page.waitForSelector or page.waitForSettled), then snapshot again.`,
  ];
}

/** The snapshot lines that follow the header. */
export function formatSnapshotStats(
  stats: SnapshotStats,
  warnings: string[],
): string {
  const parts = [
    `nodes=${stats.nodes}`,
    `refs=${stats.refs}`,
    `text=${stats.textChars}`,
    `readyState=${stats.readyState}`,
    ...(stats.pendingRequests === undefined
      ? []
      : [`pendingRequests=${stats.pendingRequests}`]),
    `domChanging=${stats.domChanging ? "yes" : "no"}`,
  ];
  return [
    `[stats ${parts.join(" ")}]`,
    ...warnings.map((warning) => `[warning ${warning}]`),
  ].join("\n");
}
