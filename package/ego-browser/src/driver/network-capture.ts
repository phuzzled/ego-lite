/**
 * Read the responses a Page loads, with parsed bodies.
 *
 * Many apps load their data as JSON. Reading that JSON is faster and more
 * exact than scraping the DOM, but raw CDP gives hundreds of events per load
 * and needs Network.getResponseBody per request. A ResponseCollector follows
 * one Page session's Network events, keeps the responses that match, and
 * fetches their bodies once loading finishes. Bodies are capped per response
 * and in total, and live only in this process (one round).
 */

import { urlGlobToRegExp } from "./page-waits.js";

/** What a response matcher sees. */
export type ResponseInfo = {
  url: string;
  status: number;
  method?: string;
  mimeType?: string;
  resourceType?: string;
};

export type ResponseMatcher =
  | string
  | RegExp
  | ((response: ResponseInfo) => boolean);

export type CapturedResponse = ResponseInfo & {
  statusText: string;
  headers: Record<string, string>;
  fromCache: boolean;
  /** The parsed body, when it is JSON. */
  json?: unknown;
  /** The body as text, when it is text and not JSON. */
  text?: string;
  /** Body size in bytes, when the body was read. */
  bodySize?: number;
  /** Why the body is missing: too large, binary, a cap, or a CDP error. */
  bodyOmitted?: string;
};

export type ResponseCollectorOptions = {
  match?: ResponseMatcher;
  maxBodyBytes?: number;
  maxTotalBytes?: number;
  maxBodies?: number;
  /** Called once per matched response after its body was read or skipped. */
  onResponse?: (response: CapturedResponse) => void;
  /** Called when a matcher function throws. */
  onMatchError?: (error: unknown) => void;
};

type CollectorServices = {
  cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<any>;
};

type PendingResponse = {
  response: CapturedResponse;
  order: number;
  graceTimer?: ReturnType<typeof setTimeout>;
};

export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_BODIES = 50;
/** Responses kept by one capture; later matches are counted but dropped. */
const MAX_RESPONSES = 1_000;
const BODY_TIMEOUT_MS = 10_000;
/**
 * Chromium never sends loadingFinished for a body the page does not read.
 * After this long without it, try to read the body anyway so a waiter still
 * resolves with the status and headers.
 */
export const BODY_GRACE_MS = 1_500;
const DATA_RESOURCE_TYPES = new Set(["Fetch", "XHR"]);
const TEXT_MIME =
  /json|text\/|javascript|xml|csv|graphql|x-www-form-urlencoded/i;

/**
 * Compile a matcher. A string matches as a URL glob (Playwright style) or as
 * a substring of the URL, a RegExp is tested against the URL, and a function
 * receives { url, status, method, mimeType, resourceType }. No matcher
 * matches fetch and XHR responses.
 */
export function compileResponseMatcher(
  matcher: ResponseMatcher | undefined,
  apiName: string,
): (response: ResponseInfo) => boolean {
  if (matcher === undefined) {
    return (response) => DATA_RESOURCE_TYPES.has(response.resourceType || "");
  }
  if (typeof matcher === "string") {
    if (matcher.length === 0) throw invalidMatcher(apiName);
    const glob = urlGlobToRegExp(matcher);
    return (response) =>
      response.url.includes(matcher) || glob.test(response.url);
  }
  if (matcher instanceof RegExp) {
    const pattern = new RegExp(matcher.source, matcher.flags);
    return (response) => {
      pattern.lastIndex = 0;
      return pattern.test(response.url);
    };
  }
  if (typeof matcher === "function") {
    return (response) => Boolean(matcher({ ...response }));
  }
  throw invalidMatcher(apiName);
}

function invalidMatcher(apiName: string): TypeError {
  return new TypeError(
    `${apiName} matcher must be a non-empty URL string, a RegExp, or a function receiving { url, status, method, mimeType, resourceType }`,
  );
}

/** Follow one Page session's Network events and keep matching responses. */
export class ResponseCollector {
  readonly #services: CollectorServices;
  readonly #sessionId: string;
  readonly #matches: (response: ResponseInfo) => boolean;
  readonly #maxBodyBytes: number;
  readonly #maxTotalBytes: number;
  readonly #maxBodies: number;
  readonly #onResponse?: (response: CapturedResponse) => void;
  readonly #onMatchError?: (error: unknown) => void;
  readonly #methods = new Map<string, string>();
  readonly #pending = new Map<string, PendingResponse>();
  readonly #bodyReads = new Set<Promise<void>>();
  readonly #done: Array<PendingResponse> = [];
  #order = 0;
  #bodies = 0;
  #totalBytes = 0;
  #stopped = false;

  constructor(
    services: CollectorServices,
    sessionId: string,
    options: ResponseCollectorOptions,
    apiName: string,
  ) {
    this.#services = services;
    this.#sessionId = sessionId;
    this.#matches = compileResponseMatcher(options.match, apiName);
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.#maxBodies = options.maxBodies ?? DEFAULT_MAX_BODIES;
    this.#onResponse = options.onResponse;
    this.#onMatchError = options.onMatchError;
  }

  /** Feed one raw CDP event from the Page's event stream. */
  handleEvent = (event: any): void => {
    if (this.#stopped || !event || typeof event.method !== "string") return;
    if (event.sessionId && event.sessionId !== this.#sessionId) return;
    const params = event.params || {};
    const requestId = params.requestId;
    if (typeof requestId !== "string") return;
    switch (event.method) {
      case "Network.requestWillBeSent":
        if (typeof params.request?.method === "string") {
          this.#methods.set(requestId, params.request.method);
        }
        return;
      case "Network.responseReceived":
        this.#onResponseReceived(requestId, params);
        return;
      case "Network.loadingFinished":
        this.#finish(requestId, Number(params.encodedDataLength));
        return;
      case "Network.loadingFailed": {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        clearTimeout(pending.graceTimer);
        pending.response.bodyOmitted = `loading failed: ${params.errorText || "unknown error"}`;
        this.#complete(pending);
        return;
      }
    }
  };

  /** Matched responses whose bodies are settled, in arrival order. */
  responses(): CapturedResponse[] {
    return this.#done
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.response);
  }

  /** Stop following events and wait for bodies already being read. */
  async stop(): Promise<CapturedResponse[]> {
    this.#stopped = true;
    await Promise.allSettled([...this.#bodyReads]);
    // Responses whose loading never finished keep their metadata.
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      clearTimeout(pending.graceTimer);
      pending.response.bodyOmitted ??= "loading had not finished";
      this.#done.push(pending);
    }
    return this.responses();
  }

  #onResponseReceived(requestId: string, params: any): void {
    const raw = params.response || {};
    const info: ResponseInfo = {
      url: String(raw.url || ""),
      status: Number(raw.status) || 0,
      ...(this.#methods.has(requestId)
        ? { method: this.#methods.get(requestId) }
        : {}),
      ...(typeof raw.mimeType === "string" ? { mimeType: raw.mimeType } : {}),
      ...(typeof params.type === "string" ? { resourceType: params.type } : {}),
    };
    let matched = false;
    try {
      matched = this.#matches(info);
    } catch (error) {
      this.#onMatchError?.(error);
      return;
    }
    if (!matched) return;
    if (this.#order >= MAX_RESPONSES) return;
    const pending: PendingResponse = {
      order: this.#order++,
      response: {
        ...info,
        statusText: String(raw.statusText || ""),
        headers: stringHeaders(raw.headers),
        fromCache: Boolean(
          raw.fromDiskCache || raw.fromPrefetchCache || raw.fromServiceWorker,
        ),
      },
    };
    pending.graceTimer = setTimeout(() => {
      if (this.#pending.get(requestId) === pending && !this.#stopped) {
        this.#finish(requestId, Number.NaN, true);
      }
    }, BODY_GRACE_MS);
    pending.graceTimer.unref?.();
    this.#pending.set(requestId, pending);
  }

  #finish(requestId: string, encodedLength: number, unfinished = false): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.graceTimer);
    const { response } = pending;
    if (response.status === 204 || response.status === 304) {
      this.#complete(pending);
      return;
    }
    const skip = this.#bodySkipReason(response, encodedLength);
    if (skip) {
      response.bodyOmitted = skip;
      this.#complete(pending);
      return;
    }
    this.#bodies += 1;
    const read = this.#readBody(requestId, pending, unfinished).finally(() => {
      this.#bodyReads.delete(read);
    });
    this.#bodyReads.add(read);
  }

  #bodySkipReason(
    response: CapturedResponse,
    encodedLength: number,
  ): string | undefined {
    if (response.mimeType && !TEXT_MIME.test(response.mimeType)) {
      return `binary body (${response.mimeType}); use page.fetch(url, { saveAs }) to save it`;
    }
    if (Number.isFinite(encodedLength) && encodedLength > this.#maxBodyBytes) {
      return `body larger than maxBodyBytes (${this.#maxBodyBytes})`;
    }
    if (this.#bodies >= this.#maxBodies) {
      return `maxBodies (${this.#maxBodies}) reached`;
    }
    if (this.#totalBytes >= this.#maxTotalBytes) {
      return `maxTotalBytes (${this.#maxTotalBytes}) reached`;
    }
    return undefined;
  }

  async #readBody(
    requestId: string,
    pending: PendingResponse,
    unfinished: boolean,
  ): Promise<void> {
    const { response } = pending;
    try {
      const result = await this.#services.cdp(
        "Network.getResponseBody",
        { requestId },
        this.#sessionId,
        BODY_TIMEOUT_MS,
      );
      const body = result?.result ?? result ?? {};
      const bytes =
        body.base64Encoded === true
          ? Buffer.from(String(body.body || ""), "base64")
          : Buffer.from(String(body.body ?? ""), "utf8");
      response.bodySize = bytes.length;
      if (bytes.length > this.#maxBodyBytes) {
        response.bodyOmitted = `body larger than maxBodyBytes (${this.#maxBodyBytes})`;
      } else if (this.#totalBytes + bytes.length > this.#maxTotalBytes) {
        response.bodyOmitted = `maxTotalBytes (${this.#maxTotalBytes}) reached`;
      } else {
        this.#totalBytes += bytes.length;
        Object.assign(response, decodeBody(bytes.toString("utf8"), response));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.bodyOmitted = unfinished
        ? `the body did not finish loading; the page may never read it (${message})`
        : `body unavailable: ${message}`;
    }
    this.#complete(pending);
  }

  #complete(pending: PendingResponse): void {
    this.#done.push(pending);
    this.#onResponse?.(pending.response);
  }
}

function decodeBody(
  text: string,
  response: CapturedResponse,
): { json?: unknown; text?: string } {
  const trimmed = text.trimStart();
  const looksJson =
    /json/i.test(response.mimeType || "") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");
  if (looksJson && trimmed.length > 0) {
    try {
      return { json: JSON.parse(text) };
    } catch {
      // Not JSON after all; keep the text.
    }
  }
  return { text };
}

function stringHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = String(value);
  }
  return out;
}
