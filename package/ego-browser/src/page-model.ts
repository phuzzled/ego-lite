import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import {
  browserCdp,
  browserEgo,
  drainPageEvents,
  ensureNetworkTracking,
  ensureSession,
  ensureFrameSessions,
  inflightRequests,
  invalidateSession,
  isCdpRequestTimeoutError,
  isBrowserRuntime,
  isPageDialogOpenedError,
  isSessionLostError,
  networkActivity,
  pageNetworkSessions,
  pendingDialog,
  prepareFileChooser,
  setPreferredTarget,
  subscribeBrowserEvents,
  subscribePageEvents,
  type FileChooserInterception,
  type FileChooserOpenedEvent,
} from "./browser-runtime.js";
import { runtimeValue } from "./cdp-eval.js";
import { stitchPngsVertically } from "./png-stitch.js";
import { withTemporaryClipboardText } from "./clipboard.js";
import {
  captureScreenshotForSession,
  snapshotRaw,
  type CaptureScreenshotOptions,
  type SnapshotOptions,
} from "./driver/observe.js";
import {
  clickPointInPage,
  clickInPage,
  dragAndDropInPage,
  fillInPage,
  focusInPage,
  hoverInPage,
  mouseButtonInPage,
  mouseButtonMask,
  moveMouseInPage,
  selectOptionInPage,
  wheelInPage,
  type MouseButton,
  type PageClickOptions,
  type PageDragAndDropOptions,
  type PageFillOptions,
  type PageHoverOptions,
  type PageMouseButtonOptions,
  type PageMouseClickOptions,
  type PageMouseMoveOptions,
  type PageMouseWheelOptions,
  type PageSelectOption,
} from "./driver/page-actions.js";
import {
  normalizeFilePaths,
  setFilesOnBackendNode,
  setInputFilesInPage,
} from "./driver/page-input.js";
import {
  preparePageDownload,
  type DownloadArtifact,
  type DownloadInterception,
} from "./driver/downloads.js";
import {
  PageKeyboardController,
  type PageClipboardContent,
  type PageKeyboardPressOptions,
  type PageKeyboardTypeOptions,
} from "./driver/page-keyboard.js";
import {
  compileResponseMatcher,
  ResponseCollector,
  type CapturedResponse,
  type ResponseMatcher,
} from "./driver/network-capture.js";
import {
  formatSnapshotStats,
  probePageState,
  releasePageObserver,
  snapshotStats,
  snapshotWarnings,
  waitForSettledInPage,
  type PageSettleOptions,
  type PageSettleResult,
  type SnapshotStats,
} from "./driver/page-settle.js";
import {
  countSelectorMatchesInPage,
  isTransientElementError,
  navigateInPage,
  reloadInPage,
  waitForLoadStateInPage,
  waitForSelectorInPage,
  waitForURLInPage,
  type PageGotoWaitUntil,
  type PageURLMatcher,
  type PageWaitForLoadStateOptions,
  type PageWaitForSelectorOptions,
  type PageWaitForURLOptions,
} from "./driver/page-waits.js";
import { ElementResolutionError } from "./element-resolver.js";
import {
  attachHint,
  invokeEgo,
  probeAgentControl,
  withHint,
} from "./ego-errors.js";
import {
  withPage as defaultWithPage,
  withSpace as defaultWithSpace,
  type PageExecutionContext,
} from "./native-gate.js";
import {
  PageLedgerStore,
  runtimeInstanceId,
  type ManagedPage,
  type PageLedger,
  type PageOrigin,
} from "./page-ledger.js";
import {
  PageRefRegistry,
  pageRefDocumentId,
  type PageRefState,
  type SnapshotRef,
} from "./page-ref-registry.js";
import {
  preparePageSnapshotResult,
  rewriteSnapshotRefIds,
} from "./snapshot-result.js";
import {
  clearSpacePageNotices,
  forgetPageNotice,
  markPageObserved,
  peekUnhandledPageNotices,
  refreshUnhandledPageNotice,
  recordUnhandledPage,
  subscribeUnhandledPageNotices,
  type UnhandledPageNotice,
} from "./page-discovery.js";
import {
  publicApiEntry,
  validatePublicApiOptions,
} from "./public-api-schema.js";
import { parseRef, type RefMap } from "./ref-map.js";
import { state } from "./state.js";
import { bufferOutput } from "./output-sink.js";
import {
  hostCapabilities as readHostCapabilities,
  unsupportedOnHost,
  type HostCapabilities,
} from "./host-capabilities.js";
import {
  evaluateIsolated,
  SECRET_DOCUMENT_ATTRIBUTE,
  SECRET_FIELD_ATTRIBUTE,
} from "./extract/isolated.js";
import {
  DEFAULT_READ_MAX_CHARS,
  countWords,
  detectPdfDocument,
  extractReadable,
  finishReadResult,
  truncateMarkdown,
  type RawReadResult,
  type ReadResult,
} from "./extract/read.js";
import { extractPdfText, pdfMarkdown } from "./extract/pdf.js";
import {
  extractTables,
  gridToRows,
  tableToCsv,
  type ExtractedTable,
} from "./extract/tables.js";
import {
  extractStructuredData,
  type StructuredData,
} from "./extract/structured.js";
import {
  judgeSearchPage,
  parseSearchPage,
  noResultsWarning,
  relevanceWarning,
  searchEngineOrder,
  searchUrl,
  BLOCK_HINT,
  type ParsedSearchPage,
  type SearchBlock,
  type SearchEngine,
  type SearchResult,
} from "./extract/search.js";
import {
  ACCEPT_TEXT,
  CONSENT_RULES,
  REJECT_TEXT,
  consentStillVisible,
  dismissConsentInFrame,
  type ConsentResult,
} from "./extract/consent.js";
import {
  findSiteSkill,
  loadBrowserToolSource,
  wrapBrowserTool,
} from "./learning/index.js";
import { pathToFileURL } from "node:url";
import {
  isAbsolute as isAbsolutePath,
  relative,
  resolve as resolvePath,
} from "node:path";

type TaskSpaceDescriptor = {
  taskId?: string | number;
  id: number;
  name: string;
  createdBy?: string;
  ownership?: string;
  recentTabTitles?: string[];
  profileId?: string;
};

type PageFillSecretOptions = {
  clear?: boolean;
  timeout?: number;
};

/**
 * An action failed on element state after resolution (hidden, moving, covered)
 * and may simply be attempted again. Transport and session errors are not
 * included: input may already have reached the page.
 */
function isRetryableElementStateError(
  error: unknown,
): error is ElementResolutionError {
  return (
    error instanceof ElementResolutionError &&
    error.kind === "transient" &&
    !error.message.startsWith("Unknown ref:")
  );
}

/**
 * Resolution or frame discovery failed before any input was dispatched. On top
 * of the element-state cases above, a frame that vanished or an iframe session
 * that was lost is recovered by rediscovering frames; losing the Page's own
 * session is terminal.
 */
function isRetryableResolutionError(
  error: unknown,
  pageSessionId: string,
): error is Error {
  if (isTransientElementError(error)) {
    return !error.message.startsWith("Unknown ref:");
  }
  return (
    isSessionLostError(error) &&
    typeof error.sessionId === "string" &&
    error.sessionId !== pageSessionId
  );
}

type AdoptPageOptions = {
  as?: string;
};

type PageGotoOptions = {
  referer?: string;
  timeout?: number;
  waitUntil?: PageGotoWaitUntil;
};

type PageReloadOptions = Pick<PageGotoOptions, "timeout" | "waitUntil">;

type PageSnapshotOptions = Omit<SnapshotOptions, "root"> & {
  root?: string;
  format?: "text" | "object";
  settle?: boolean | PageSettleOptions;
};

type PageWaitForResponseOptions = {
  timeout?: number;
  maxBodyBytes?: number;
};

type PageCaptureResponsesOptions = {
  match?: ResponseMatcher;
  maxBodies?: number;
  maxBodyBytes?: number;
  maxTotalBytes?: number;
};

/** `page.snapshot({ format: "object" })`: the same text plus its parts. */
export type PageSnapshotObject = {
  text: string;
  stats?: SnapshotStats;
  warnings: string[];
  settle?: PageSettleResult;
};

type PageScreenshotOptions = Omit<CaptureScreenshotOptions, "full"> & {
  path?: string;
  fullPage?: boolean;
  maxHeight?: number;
  tiles?: boolean;
};

type PageReadOptions = {
  mode?: "article" | "full";
  selector?: string;
  maxChars?: number;
  timeout?: number;
};

type PageTablesOptions = {
  selector?: string;
  index?: number;
  saveAs?: string;
  csv?: boolean;
  includeHidden?: boolean;
};

type PageSearchOptions = {
  engine?: SearchEngine | "auto";
  max?: number;
  timeout?: number;
};

type PageDismissConsentOptions = {
  prefer?: "reject" | "accept";
  timeout?: number;
};

type PageScrollToLoadOptions = {
  itemSelector?: string;
  maxItems?: number;
  maxScrolls?: number;
  idleMs?: number;
  timeout?: number;
};

type PagePaginateOptions = {
  next: string;
  maxPages?: number;
  timeout?: number;
};

type HandOffOptions = {
  relay?: boolean;
};

type TaskMapOptions = {
  concurrency?: number;
  navigate?: boolean;
  timeout?: number;
  waitUntil?: PageGotoWaitUntil;
};

export type TaskMapResult<T> =
  | { url: string; index: number; ok: true; value: T }
  | {
      url: string;
      index: number;
      ok: false;
      error: string;
      error_code?: string;
    };

type CdpOptions = {
  timeout?: number;
};

type PagePressOptions = PageKeyboardPressOptions & {
  timeout?: number;
};

type WaitForControlOptions = {
  interval?: number;
  timeout?: number;
};

type FinishOptions = {
  keep: "all" | string[];
};

export type TaskFinishReceipt = {
  spaceId: number;
  closedSpace: boolean;
  keptManagedLabels: string[];
  closedManagedLabels: string[];
  preservedUnmanagedCount: number;
};

type PageWaitForFileChooserOptions = {
  timeout?: number;
};

type PageWaitForEventOptions = {
  timeout?: number;
};

type PageWaitForFunctionOptions = {
  timeout?: number;
  polling?: number;
};

export type PageFetchOptions = {
  timeout?: number;
  saveAs?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  cache?:
    | "default"
    | "no-store"
    | "reload"
    | "no-cache"
    | "force-cache"
    | "only-if-cached";
  credentials?: "omit" | "same-origin" | "include";
  integrity?: string;
  keepalive?: boolean;
  mode?: "cors" | "no-cors" | "same-origin";
  redirect?: "follow" | "error" | "manual";
  referrer?: string;
  referrerPolicy?: string;
};

export type PageFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  savedPath?: string;
};

type PageFetchPayload = {
  url: string;
  options: Record<string, unknown>;
  timeoutMs: number;
  responseType: "text" | "base64";
};

type PageFetchResult =
  | (PageFetchResponse & { bodyBase64?: string })
  | { fetchError: string };

type PageTarget = {
  spaceId: number;
  targetId: string;
};

type SpaceScope = {
  spaceId: number;
};

type OperationGate = {
  withSpace<T>(
    spaceId: number,
    operation: (scope: SpaceScope) => T | Promise<T>,
  ): Promise<T>;
  withPage<T>(
    page: PageTarget,
    operation: (context: PageExecutionContext) => T | Promise<T>,
  ): Promise<T>;
};

type LedgerPort = {
  read(spaceId: number): Promise<PageLedger>;
  discard(spaceId: number): Promise<void>;
  initializeCreatedSpace(
    spaceId: number,
    targetId: string,
  ): Promise<ManagedPage>;
  addPage(
    spaceId: number,
    targetId: string,
    options?: { as?: string; openedBy?: PageOrigin; reclaim?: boolean },
  ): Promise<ManagedPage>;
  getPage(spaceId: number, label: string): Promise<ManagedPage>;
  setPageRefs(
    spaceId: number,
    label: string,
    refs: PageRefState,
  ): Promise<void>;
  closePage(spaceId: number, label: string): Promise<ManagedPage>;
  releasePage(spaceId: number, label: string): Promise<ManagedPage>;
  keepUnmanaged(
    spaceId: number,
    targetId: string,
    openedBy?: PageOrigin,
  ): Promise<void>;
  beginUserControl(spaceId: number): Promise<void>;
  cancelUserControl(spaceId: number): Promise<void>;
  reconcile(
    spaceId: number,
    liveTargetIds: Iterable<string>,
    options?: { autoAdoptNew?: boolean; afterUserControl?: boolean },
  ): Promise<PageLedger>;
};

type RuntimeTab = {
  targetId: string;
  active?: boolean;
  title?: string;
  url?: string;
  openerId?: string;
};

type PageModelServices = {
  ledger: LedgerPort;
  pageRefs: PageRefRegistry;
  gate: OperationGate;
  createTab(url: string): Promise<string>;
  listTabs(): Promise<RuntimeTab[]>;
  probeAgentControl(): Promise<boolean>;
  handOffTaskSpace(): Promise<void>;
  completeTaskSpace(): Promise<void>;
  closeTaskSpace(): Promise<void>;
  cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<any>;
  showAgentMousePosition(x: number, y: number): Promise<void>;
  showAgentTaskState(state: string): Promise<void>;
  withTemporaryClipboardText<T>(
    content: PageClipboardContent,
    action: () => Promise<T>,
    sessionId?: string,
  ): Promise<T>;
  snapshot(options?: SnapshotOptions): Promise<any>;
  screenshot(
    path: string | undefined,
    options: CaptureScreenshotOptions,
    sessionId: string,
  ): Promise<string>;
  pendingDialog(sessionId: string): Record<string, unknown> | null;
  prepareFileChooser(
    sessionId: string,
    options: { timeoutMs: number; cancel: boolean },
  ): FileChooserInterception;
  drainEvents(sessionId: string): any[];
  ensureNetworkTracking(
    sessionIds: string[],
    timeoutMs?: number,
  ): Promise<void>;
  pageNetworkSessions(sessionId: string, timeoutMs?: number): Promise<string[]>;
  networkActivity(sessionIds: string[]): {
    tracking: boolean;
    inflight: number;
    lastActivityAt: number;
  };
  inflightRequests?(
    sessionIds: string[],
  ): Array<{ type?: string; startedAt: number }>;
  ensureSession(targetId: string): Promise<string>;
  ensureFrameSessions(
    targetId: string,
    timeoutMs?: number,
  ): Promise<Map<string, string>>;
  invalidateSession(targetId: string): void;
  setPreferredTarget(targetId: string): void;
  supportsBackgroundPageDiscovery(): boolean;
  subscribeBrowserEvents(listener: (event: any) => void): () => void;
  subscribePageEvents(
    targetId: string,
    listener: (event: any) => void,
  ): () => void;
  prepareDownload(
    targetId: string,
    options: { timeoutMs: number },
  ): DownloadInterception;
  now(): number;
  sleep(ms: number): Promise<void>;
  platform: string;
  pageBudget: number;
  /** Host extensions available now (each flag implies its binding exists). */
  hostCapabilities(): HostCapabilities;
  taskSpaceMemo(
    key: string,
    write?: { value: unknown },
  ): Promise<{ found: boolean; value?: unknown }>;
  restoreTaskSpaceTabs(): Promise<{
    tabs: Array<{ targetId: string; url: string }>;
    skipped: string[];
  }>;
  handOffRelay(): Promise<{ relay: Record<string, unknown> }>;
  fillSecret(
    name: string,
    options: { targetId: string; clear: boolean },
  ): Promise<{ filled: boolean; secret: string; origin: string }>;
  logEvent(entry: Record<string, unknown>): void;
  agentWorkspace(): string;
};

export type TabInventoryItem = {
  targetId: string;
  label?: string;
  page: Page | UnmanagedPage;
  title: string;
  url: string;
  active: boolean;
  openedBy: PageOrigin;
};

export type PageActionReceipt = {
  popups?: Array<{ label: string; targetId: string }>;
  dialog?: Record<string, unknown>;
};

export class PageEvaluationTimeoutError extends Error {
  readonly code = "EGO_PAGE_EVALUATION_TIMED_OUT";
  readonly timeoutMs: number;
  readonly executionStopped: boolean;
  readonly mayHaveLateEffects: boolean;
  readonly pageResponsive: boolean;

  constructor(
    message: string,
    {
      timeoutMs,
      executionStopped,
      mayHaveLateEffects,
      pageResponsive,
    }: {
      timeoutMs: number;
      executionStopped: boolean;
      mayHaveLateEffects: boolean;
      pageResponsive: boolean;
    },
  ) {
    super(message);
    this.name = "PageEvaluationTimeoutError";
    this.timeoutMs = timeoutMs;
    this.executionStopped = executionStopped;
    this.mayHaveLateEffects = mayHaveLateEffects;
    this.pageResponsive = pageResponsive;
  }
}

const SNAPSHOT_ATTEMPTS = 3;
/** Image tools reject very tall images; fullPage stops here by default. */
const DEFAULT_FULL_PAGE_MAX_HEIGHT = 16_000;
const DEFAULT_TILE_HEIGHT = 4_000;
/** Tallest single capture behind a full-page screenshot; taller ones stitch. */
const FULL_PAGE_REGION_HEIGHT = 4_000;
/** Per-attempt timeouts for one full-page region (a stall is retried). */
const FULL_PAGE_REGION_TIMEOUTS_MS = [5_000, 10_000, 20_000];
let stitchedShotSeq = 0;
const MAX_TILES = 50;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const DEFAULT_CONSENT_WAIT_MS = 1_000;
const PAGE_CLOSE_CONFIRM_TIMEOUT_MS = 2_000;
const PAGE_CLOSE_CONFIRM_INTERVAL_MS = 50;
const CREATED_SPACE_TAB_TIMEOUT_MS = 2_000;
const CREATED_SPACE_TAB_POLL_INTERVAL_MS = 50;
const DEFAULT_PAGE_ACTION_TIMEOUT_MS = 3_000;
const PAGE_ACTION_RESOLUTION_RETRY_MS = 500;
const CONTROL_POLL_INTERVAL_MS = 20_000;
const PAGE_EVALUATE_EXECUTION_TIMEOUT_MS = 14_000;
const PAGE_EVALUATE_TRANSPORT_TIMEOUT_MS = 15_000;
const PAGE_EVALUATE_HEALTH_TIMEOUT_MS = 250;
const PAGE_EVALUATE_HEALTH_EXECUTION_TIMEOUT_MS = 200;
const PAGE_EVALUATE_TERMINATE_TIMEOUT_MS = 1_000;
const WAIT_FOR_FUNCTION_TRANSPORT_GRACE_MS = 250;
const CONTROL_WAIT_TIMEOUT_MS = 600_000;

type RawActionRunner = (
  operation: (services: PageModelServices, sessionId: string) => Promise<void>,
) => Promise<void>;

type ObservedActionRunner = (
  operation: (services: PageModelServices, sessionId: string) => Promise<void>,
) => Promise<PageActionReceipt>;

/** Page-scoped mouse state and CDP Input primitives. */
class PageMouse {
  readonly #run: RawActionRunner;
  readonly #runObserved: ObservedActionRunner;
  readonly #modifierMask: () => number;
  #x = 0;
  #y = 0;
  #buttons = 0;
  #lastButton: MouseButton | "none" = "none";

  constructor(
    run: RawActionRunner,
    runObserved: ObservedActionRunner,
    modifierMask: () => number,
  ) {
    this.#run = run;
    this.#runObserved = runObserved;
    this.#modifierMask = modifierMask;
  }

  async click(
    x: number,
    y: number,
    options: PageMouseClickOptions = {},
  ): Promise<PageActionReceipt> {
    validatePublicApiOptions("Page.mouse.click", options);
    const receipt = await this.#runObserved((services, sessionId) =>
      clickPointInPage(
        services,
        sessionId,
        x,
        y,
        options,
        this.#modifierMask(),
        this.#buttons,
      ),
    );
    this.#x = x;
    this.#y = y;
    this.#lastButton = "none";
    return receipt;
  }

  async move(
    x: number,
    y: number,
    options: PageMouseMoveOptions = {},
  ): Promise<void> {
    validatePublicApiOptions("Page.mouse.move", options);
    await this.#run((services, sessionId) =>
      moveMouseInPage(services, sessionId, this.#x, this.#y, x, y, {
        ...options,
        button: this.#lastButton,
        buttons: this.#buttons,
        modifiers: this.#modifierMask(),
      }),
    );
    this.#x = x;
    this.#y = y;
  }

  async down(options: PageMouseButtonOptions = {}): Promise<void> {
    validatePublicApiOptions("Page.mouse.down", options);
    const button = options.button ?? "left";
    const nextButtons = this.#buttons | mouseButtonMask(button);
    await this.#run((services, sessionId) =>
      mouseButtonInPage(
        services,
        sessionId,
        "mousePressed",
        this.#x,
        this.#y,
        nextButtons,
        options,
        this.#modifierMask(),
      ).then(() => undefined),
    );
    this.#buttons = nextButtons;
    this.#lastButton = button;
  }

  async up(options: PageMouseButtonOptions = {}): Promise<void> {
    validatePublicApiOptions("Page.mouse.up", options);
    const button = options.button ?? "left";
    const nextButtons = this.#buttons & ~mouseButtonMask(button);
    await this.#run((services, sessionId) =>
      mouseButtonInPage(
        services,
        sessionId,
        "mouseReleased",
        this.#x,
        this.#y,
        nextButtons,
        options,
        this.#modifierMask(),
      ).then(() => undefined),
    );
    this.#buttons = nextButtons;
    this.#lastButton = "none";
  }

  async wheel(
    deltaX: number,
    deltaY: number,
    options: PageMouseWheelOptions = {},
  ): Promise<void> {
    validatePublicApiOptions("Page.mouse.wheel", options);
    return this.#run((services, sessionId) =>
      wheelInPage(
        services,
        sessionId,
        this.#x,
        this.#y,
        deltaX,
        deltaY,
        this.#modifierMask(),
        options,
      ),
    );
  }
}

/** Page-scoped keyboard input with Playwright-style key state. */
class PageKeyboard {
  readonly #controller: PageKeyboardController;

  constructor(
    services: PageModelServices,
    run: RawActionRunner,
    runObserved: ObservedActionRunner,
  ) {
    this.#controller = new PageKeyboardController(
      services,
      (operation) => run((_services, sessionId) => operation(sessionId)),
      (operation) =>
        runObserved((_services, sessionId) => operation(sessionId)),
    );
  }

  modifierMask(): number {
    return this.#controller.modifierMask();
  }

  async down(key: string): Promise<void> {
    await this.#controller.down(key);
  }

  async up(key: string): Promise<void> {
    await this.#controller.up(key);
  }

  async press(
    chord: string,
    options: PageKeyboardPressOptions = {},
  ): Promise<PageActionReceipt> {
    validatePublicApiOptions("Page.keyboard.press", options);
    return (await this.#controller.press(chord, options)) as PageActionReceipt;
  }

  async pressInSession(
    sessionId: string,
    chord: string,
    options: PageKeyboardPressOptions = {},
  ): Promise<void> {
    validatePublicApiOptions("Page.keyboard.press", options);
    await this.#controller.pressInSession(sessionId, chord, options);
  }

  async paste(content: PageClipboardContent): Promise<PageActionReceipt> {
    return (await this.#controller.paste(content)) as PageActionReceipt;
  }

  async insertText(text: string): Promise<void> {
    await this.#controller.insertText(text);
  }

  async type(
    text: string,
    options: PageKeyboardTypeOptions = {},
  ): Promise<void> {
    validatePublicApiOptions("Page.keyboard.type", options);
    await this.#controller.type(text, options);
  }
}

class PageBudgetError extends Error {
  readonly code = "EGO_PAGE_BUDGET_REACHED";
  readonly spaceId: number;
  readonly limit: number;

  constructor(spaceId: number, limit: number, message: string) {
    super(message);
    this.name = "PageBudgetError";
    this.spaceId = spaceId;
    this.limit = limit;
  }
}

let defaultLedger: PageLedgerStore | undefined;
const defaultPageRefs = new PageRefRegistry();
const unmanagedPageConstructorToken = Symbol("UnmanagedPage");
const captureUserBoundaryToken = Symbol("captureUserBoundary");
const initializeTaskSpaceToken = Symbol("initializeTaskSpace");
const initializeCreatedSpaceToken = Symbol("initializeCreatedSpace");
const rollbackCreatedTaskSpaceToken = Symbol("rollbackCreatedTaskSpace");
const describeMissingPageToken = Symbol("describeMissingPage");
/** Each Page's services, for the round-log wrapper below the class. */
const pageServices = new WeakMap<object, PageModelServices>();
const recordPageUrlToken = Symbol("recordPageUrl");
const withSpaceToken = Symbol("withSpace");
/** Memo key under which the SDK keeps each Page label's last URL. */
const PAGE_URLS_MEMO_KEY = "__ego.pageUrls";
const RESERVED_MEMO_PREFIX = "__ego.";
const DEFAULT_MAP_CONCURRENCY = 3;

const defaultGate: OperationGate = {
  withSpace: defaultWithSpace,
  withPage: defaultWithPage,
};

const baseDefaultServices: Omit<PageModelServices, "ledger" | "pageBudget"> = {
  gate: defaultGate,
  pageRefs: defaultPageRefs,
  async createTab(url) {
    const result = await invokeEgo("task.newPage", () =>
      browserEgo().createTab(url),
    );
    const targetId = result?.targetId || result?.result?.targetId;
    if (typeof targetId !== "string" || targetId.length === 0) {
      throw new Error("task.newPage returned no targetId");
    }
    return targetId;
  },
  async listTabs() {
    const result = await invokeEgo("task.listTabs", () =>
      browserEgo().listTabs(),
    );
    return result?.tabs || result?.targetInfos || [];
  },
  async probeAgentControl() {
    // Do not route this through invokeEgo: observing user control is the
    // expected waiting state, not a hard-stop signal.
    return probeAgentControl(() =>
      browserEgo().snapshot({ maxResultLength: 1 }),
    );
  },
  async handOffTaskSpace() {
    const ego = browserEgo();
    if (typeof ego.handOffTaskSpace !== "function") {
      throw new Error("task.handOff requires ego.handOffTaskSpace");
    }
    await invokeEgo("task.handOff", () => ego.handOffTaskSpace());
  },
  async completeTaskSpace() {
    const ego = browserEgo();
    if (typeof ego.completeTaskSpace !== "function") {
      throw new Error("task.finish requires ego.completeTaskSpace");
    }
    await invokeEgo("task.finish", () => ego.completeTaskSpace());
  },
  async closeTaskSpace() {
    const ego = browserEgo();
    if (typeof ego.closeTaskSpace !== "function") {
      throw new Error("task.close requires ego.closeTaskSpace");
    }
    await invokeEgo("task.close", () => ego.closeTaskSpace());
  },
  async cdp(method, params = {}, sessionId, timeoutMs) {
    const response = await browserCdp(method, params, sessionId, timeoutMs);
    return response?.result || {};
  },
  async showAgentMousePosition(x, y) {
    const ego = browserEgo();
    if (typeof ego.animationHighlightMouseToPosition !== "function") return;
    await invokeEgo("page.mouse.move", () =>
      ego.animationHighlightMouseToPosition(x, y),
    );
  },
  async showAgentTaskState(state) {
    const ego = browserEgo();
    if (typeof ego.setAgentTaskState !== "function") return;
    await invokeEgo("page.mouse.label", () => ego.setAgentTaskState(state));
  },
  withTemporaryClipboardText(content, action, sessionId) {
    return withTemporaryClipboardText(content, action, {
      page:
        sessionId === undefined
          ? undefined
          : {
              async cdp(method, params = {}) {
                const response = await browserCdp(method, params, sessionId);
                return response?.result || {};
              },
              async browserCdp(method, params = {}) {
                const response = await browserCdp(method, params);
                return response?.result || {};
              },
            },
    });
  },
  snapshot: snapshotRaw,
  screenshot: captureScreenshotForSession,
  pendingDialog,
  prepareFileChooser,
  drainEvents: drainPageEvents,
  ensureNetworkTracking,
  pageNetworkSessions,
  networkActivity,
  inflightRequests,
  ensureSession,
  ensureFrameSessions,
  invalidateSession,
  setPreferredTarget,
  supportsBackgroundPageDiscovery: isBrowserRuntime,
  subscribeBrowserEvents,
  subscribePageEvents,
  prepareDownload(targetId, options) {
    return preparePageDownload(
      {
        cdp: baseDefaultServices.cdp,
        subscribePageEvents,
      },
      targetId,
      options,
    );
  },
  now: () => state.now(),
  async sleep(ms) {
    await state.sleep(ms);
  },
  get platform() {
    return state.platform;
  },
  hostCapabilities() {
    const ego = (globalThis as any).ego;
    const caps = readHostCapabilities(ego);
    const has = (name: string) => typeof ego?.[name] === "function";
    return {
      ...caps,
      taskSpaceTtl: caps.taskSpaceTtl === true && has("createTaskSpace"),
      taskSpaceMemo: caps.taskSpaceMemo === true && has("taskSpaceMemo"),
      restoreTaskSpaceTabs:
        caps.restoreTaskSpaceTabs === true && has("restoreTaskSpaceTabs"),
      handOffRelay: caps.handOffRelay === true && has("handOffTaskSpace"),
      logEvent: caps.logEvent === true && has("logEvent"),
      fillSecret: caps.fillSecret === true && has("fillSecret"),
    };
  },
  async taskSpaceMemo(key, write) {
    const ego = browserEgo();
    return invokeEgo("task.memo", () =>
      write ? ego.taskSpaceMemo(key, write.value) : ego.taskSpaceMemo(key),
    );
  },
  async restoreTaskSpaceTabs() {
    const ego = browserEgo();
    const result = await invokeEgo("task.restorePages", () =>
      ego.restoreTaskSpaceTabs(),
    );
    return {
      tabs: Array.isArray(result?.tabs) ? result.tabs : [],
      skipped: Array.isArray(result?.skipped) ? result.skipped : [],
    };
  },
  async fillSecret(name, options) {
    const ego = browserEgo();
    return invokeEgo("page.fillSecret", () => ego.fillSecret(name, options));
  },
  async handOffRelay() {
    const ego = browserEgo();
    return invokeEgo("task.handOff", () =>
      ego.handOffTaskSpace({ relay: true }),
    );
  },
  logEvent(entry) {
    try {
      const result = browserEgo().logEvent(entry);
      // An async binding must not leave an unhandled rejection behind.
      if (result && typeof result.then === "function") {
        result.then(undefined, () => {});
      }
    } catch {
      // The round log is an aid; never fail an action over it.
    }
  },
  agentWorkspace: () => state.agentWorkspace(),
};

/**
 * Create a TaskSpace object around a resolved native task-space descriptor.
 * The helper layer owns name/id resolution; this layer owns page identity and
 * routes every browser operation through the native operation gate.
 */
export function createTaskSpaceHandle(
  descriptor: TaskSpaceDescriptor,
  overrides: Partial<PageModelServices> = {},
): TaskSpace {
  if (!descriptor || !Number.isInteger(descriptor.id)) {
    throw new TypeError("TaskSpace requires a numeric id");
  }
  // Ego Lite imports the SDK before it evaluates the submitted script. Resolve
  // environment-backed settings lazily so SDK callers can configure a round
  // before their first taskSpace() call.
  defaultLedger ||= new PageLedgerStore({
    browserInstanceId: runtimeInstanceId,
  });
  const services = {
    ...baseDefaultServices,
    ledger: defaultLedger,
    pageBudget: configuredPageBudget(),
    ...overrides,
  };
  if (!Number.isInteger(services.pageBudget) || services.pageBudget < 1) {
    throw new TypeError("pageBudget must be a positive integer");
  }
  return new TaskSpace(descriptor, services);
}

/**
 * Capture the active tab at a claim/takeover boundary before Agent actions can
 * change it. This is called by the helper layer and is not injected directly.
 */
export async function captureTaskSpaceUserBoundary(
  task: TaskSpace,
): Promise<void> {
  await task.captureUserBoundary(captureUserBoundaryToken);
}

/** Initialize Page state and round-local discovery before exposing a TaskSpace. */
export async function initializeTaskSpaceHandle(
  task: TaskSpace,
  options: { created?: boolean } = {},
): Promise<void> {
  if (options.created) {
    await task.initializeCreatedSpace(initializeCreatedSpaceToken);
  }
  await task.initializeBackgroundPageDiscovery(initializeTaskSpaceToken);
}

/** Close a newly created space whose Page-model initialization did not commit. */
export async function rollbackCreatedTaskSpace(task: TaskSpace): Promise<void> {
  await task[rollbackCreatedTaskSpaceToken]();
}

class TaskSpace {
  readonly taskId?: string | number;
  readonly id: number;
  readonly name: string;
  readonly createdBy?: string;
  readonly ownership?: string;
  readonly recentTabTitles?: string[];
  /** The browser profile of this space when the host reports it. */
  readonly profileId?: string;
  readonly #services: PageModelServices;
  #userPage?: Page | UnmanagedPage;
  #stopBrowserEvents?: () => void;
  #backgroundDiscoveryInitialized = false;
  #finished = false;

  constructor(descriptor: TaskSpaceDescriptor, services: PageModelServices) {
    this.taskId = descriptor.taskId;
    this.id = descriptor.id;
    this.name = descriptor.name;
    this.createdBy = descriptor.createdBy;
    this.ownership = descriptor.ownership;
    this.recentTabTitles = descriptor.recentTabTitles;
    this.profileId = descriptor.profileId;
    this.#services = services;
  }

  /** Stable task-space identifier. `id` remains as a compatibility alias. */
  get spaceId(): number {
    return this.id;
  }

  page(label: string): Page {
    return new Page(this, label, this.#services);
  }

  /** The tab active at the most recent claim/takeover boundary, if any. */
  userPage(): Page | UnmanagedPage | undefined {
    return this.#userPage;
  }

  async initializeCreatedSpace(token: symbol): Promise<void> {
    if (token !== initializeCreatedSpaceToken) {
      throw new TypeError("created-space initialization is internal");
    }
    if (this.ownership !== "agent") {
      throw new Error("only a newly created Agent TaskSpace can initialize p1");
    }
    await this.#services.gate.withSpace(this.id, async () => {
      const targetId = await this.#waitForCreatedSpaceTab();
      const page = await this.#services.ledger.initializeCreatedSpace(
        this.id,
        targetId,
      );
      this.#services.setPreferredTarget(page.targetId);
    });
  }

  async #waitForCreatedSpaceTab(): Promise<string> {
    const deadline = this.#services.now() + CREATED_SPACE_TAB_TIMEOUT_MS;
    while (true) {
      const tabs = await this.#services.listTabs();
      if (tabs.length > 1) {
        throw new Error(
          `new task space expected one default tab, found ${tabs.length}`,
        );
      }
      if (tabs.length === 1) {
        const targetId = tabs[0]?.targetId;
        if (typeof targetId !== "string" || targetId.length === 0) {
          throw new Error("new task space default tab returned no targetId");
        }
        return targetId;
      }

      const remainingMs = deadline - this.#services.now();
      if (remainingMs <= 0) {
        throw new Error(
          `new task space did not expose its default tab within ${CREATED_SPACE_TAB_TIMEOUT_MS}ms`,
        );
      }
      await this.#services.sleep(
        Math.min(CREATED_SPACE_TAB_POLL_INTERVAL_MS, remainingMs),
      );
    }
  }

  async initializeBackgroundPageDiscovery(token: symbol): Promise<void> {
    if (token !== initializeTaskSpaceToken) {
      throw new TypeError(
        "background page discovery is initialized internally",
      );
    }
    if (
      this.#backgroundDiscoveryInitialized ||
      this.ownership !== "agent" ||
      !this.#services.supportsBackgroundPageDiscovery()
    ) {
      return;
    }
    this.#backgroundDiscoveryInitialized = true;
    this.#stopBrowserEvents = this.#services.subscribeBrowserEvents((event) => {
      this.#handleBrowserEvent(event);
    });

    // Subscribe before enabling discovery so a target created during setup
    // cannot fall into the gap between the initial inventory and the callback.
    try {
      await this.#services.gate.withSpace(this.id, async () => {
        await this.#services.cdp("Target.setDiscoverTargets", {
          discover: true,
        });
        await this.#recoverExistingChildPages();
      });
    } catch {
      // Background discovery is an observation aid. Existing action receipts
      // and task.tabs() reconciliation remain the correctness fallback.
    }
  }

  async captureUserBoundary(token: symbol): Promise<void> {
    if (token !== captureUserBoundaryToken) {
      throw new TypeError(
        "the user-page boundary is captured automatically by claim/takeover",
      );
    }
    await this.#services.gate.withSpace(this.id, async () => {
      const tabs = await this.#services.listTabs();
      if (tabs.length === 0) {
        this.#userPage = undefined;
        return;
      }
      const ledger = await this.#services.ledger.reconcile(
        this.id,
        tabs.map((tab) => tab.targetId),
        { autoAdoptNew: false, afterUserControl: true },
      );
      const active = tabs.find((tab) => tab.active);
      this.#userPage = active
        ? tabInventory(this, this.#services, ledger, tabs).find(
            (item) => item.targetId === active.targetId,
          )?.page
        : undefined;
    });
  }

  /** Return managed Page handles after reconciling the browser tab list. */
  async pages(): Promise<Page[]> {
    const tabs = await this.tabs();
    return tabs
      .filter((item) => item.page instanceof Page)
      .map((item) => item.page as Page);
  }

  /** Return managed and unmanaged tabs after reconciling browser state. */
  async tabs(): Promise<TabInventoryItem[]> {
    return this.#services.gate.withSpace(this.id, async () => {
      const { ledger, tabs } = await this.#reconcilePages();
      return tabInventory(this, this.#services, ledger, tabs);
    });
  }

  /** Wait until this space is controllable without taking control from the user. */
  async waitForControl(options: WaitForControlOptions = {}): Promise<void> {
    validatePublicApiOptions("TaskSpace.waitForControl", options);
    const intervalMs = options.interval ?? CONTROL_POLL_INTERVAL_MS;
    const timeoutMs = options.timeout ?? CONTROL_WAIT_TIMEOUT_MS;
    const deadline = this.#services.now() + timeoutMs;

    while (true) {
      const available = await this.#services.gate.withSpace(this.id, () =>
        this.#services.probeAgentControl(),
      );
      if (available) return;

      const remainingMs = deadline - this.#services.now();
      if (remainingMs <= 0) {
        throw new Error(`task.waitForControl timed out after ${timeoutMs}ms`);
      }
      await this.#services.sleep(Math.min(intervalMs, remainingMs));
    }
  }

  /**
   * Give control of this task space to the user while keeping Page state.
   * With { relay: true } (hosts that support it), keep control instead and
   * return a screenshot and snapshot of the page to show the user.
   */
  async handOff(
    options: HandOffOptions = {},
  ): Promise<void | { relay: Record<string, unknown> }> {
    validatePublicApiOptions("TaskSpace.handOff", options);
    if (options.relay === true) {
      if (!this.#services.hostCapabilities().handOffRelay) {
        throw unsupportedOnHost(
          "task.handOff({ relay: true })",
          "use task.handOff() to give the user control, or take a screenshot with page.screenshot()",
        );
      }
      return this.#services.gate.withSpace(this.spaceId, async () => {
        const result = await this.#services.handOffRelay();
        return { relay: result?.relay ?? {} };
      });
    }
    await this.#services.gate.withSpace(this.spaceId, async () => {
      await this.#reconcilePages();
      await this.#services.ledger.beginUserControl(this.spaceId);
      try {
        await this.#services.handOffTaskSpace();
        this.#stopBackgroundPageDiscovery();
      } catch (error) {
        await this.#services.ledger.cancelUserControl(this.spaceId);
        throw error;
      }
    });
  }

  /**
   * Finish the task with a managed-Page retention policy. With no argument it
   * keeps nothing, like finish({ keep: [] }).
   */
  async finish(
    options: FinishOptions = { keep: [] },
  ): Promise<TaskFinishReceipt> {
    validatePublicApiOptions("TaskSpace.finish", options);
    if (!Object.hasOwn(options, "keep") || options.keep === undefined) {
      throw new TypeError(
        "task.finish requires the keep option. Expected: await task.finish({ keep })",
      );
    }
    return this.#services.gate.withSpace(this.spaceId, async () => {
      const { ledger, tabs } = await this.#reconcilePages();
      const keepLabels =
        options.keep === "all"
          ? new Set(Object.keys(ledger.pages))
          : new Set(options.keep);
      for (const label of keepLabels) {
        if (!ledger.pages[label]) {
          // Reuse the ledger's permanent-label diagnostics and validate every
          // requested label before closing any Page.
          await this.#services.ledger.getPage(this.spaceId, label);
        }
      }

      const managedByTarget = new Map(
        Object.values(ledger.pages).map((page) => [page.targetId, page]),
      );
      const labelsToClose = Object.entries(ledger.pages)
        .filter(
          ([label, page]) =>
            page.openedBy === "agent" && !keepLabels.has(label),
        )
        .map(([label]) => label);
      const closedManagedLabelSet = new Set(labelsToClose);
      const keptManagedLabels = Object.keys(ledger.pages).filter(
        (label) => !closedManagedLabelSet.has(label),
      );
      const preservedUnmanagedCount = tabs.filter(
        (tab) => !managedByTarget.has(tab.targetId),
      ).length;
      const hasProtectedTabs = tabs.some((tab) => {
        const managed = managedByTarget.get(tab.targetId);
        return !managed || managed.openedBy === "unknown";
      });

      if (
        options.keep !== "all" &&
        options.keep.length === 0 &&
        !hasProtectedTabs
      ) {
        await this.#services.closeTaskSpace();
        await this.#discardTerminalState();
        return {
          spaceId: this.spaceId,
          closedSpace: true,
          keptManagedLabels: [],
          closedManagedLabels: labelsToClose,
          preservedUnmanagedCount,
        };
      }

      if (this.profileId === "ephemeral") {
        // The host deletes an ephemeral space on finish, with every tab and
        // cookie: nobody can come back to a throwaway profile.
        await this.#services.completeTaskSpace();
        await this.#discardTerminalState();
        return {
          spaceId: this.spaceId,
          closedSpace: true,
          keptManagedLabels: [],
          closedManagedLabels: Object.keys(ledger.pages),
          preservedUnmanagedCount: 0,
        };
      }
      for (const label of labelsToClose) {
        await this.page(label).close();
      }
      await this.#services.completeTaskSpace();
      await this.#discardTerminalState();
      return {
        spaceId: this.spaceId,
        closedSpace: false,
        keptManagedLabels,
        closedManagedLabels: labelsToClose,
        preservedUnmanagedCount,
      };
    });
  }

  async [rollbackCreatedTaskSpaceToken](): Promise<void> {
    await this.#services.gate.withSpace(this.spaceId, async () => {
      await this.#services.closeTaskSpace();
      await this.#discardTerminalState();
    });
  }

  async #discardTerminalState(): Promise<void> {
    this.#finished = true;
    await this.#services.ledger.discard(this.spaceId);
    this.#stopBackgroundPageDiscovery();
    clearSpacePageNotices(this.spaceId);
  }

  /**
   * Explain an unknown Page label in task-lifecycle terms: the same ledger miss
   * means "never created" during a task but "already ended" after finish().
   */
  async [describeMissingPageToken](
    label: string,
    error: unknown,
  ): Promise<unknown> {
    if (
      !(error instanceof Error) ||
      error.message !== `page label not found: ${label}`
    ) {
      return error;
    }
    if (this.#finished) {
      return attachHint(
        new Error(
          `${error.message}. Task space ${this.id} already finished, which ended its Page labels; do not use Pages after task.finish()`,
          { cause: error },
        ),
        "Open a new task space with await taskSpace(name) for further work.",
      );
    }
    if (this.ownership !== "agent") {
      return attachHint(
        new Error(
          `${error.message}. Task space ${this.id} is owned by the user, so labels from a finished Agent task no longer exist; stop operating it unless the user asks you to continue`,
          { cause: error },
        ),
        "Stop. Ask the user before you work in this space again.",
      );
    }
    const labels = Object.keys(
      (await this.#services.ledger.read(this.id)).pages,
    );
    return attachHint(
      new Error(
        `${error.message}. Managed Pages in task space ${this.id}: ${labels.join(", ") || "none"}. task.page(label) only refers to an existing Page; create one with await task.newPage()`,
        { cause: error },
      ),
    );
  }

  /** Send a Target or Browser domain command within this selected space. */
  async cdp(
    method: string,
    params: Record<string, unknown> = {},
    options: CdpOptions = {},
  ): Promise<any> {
    assertCdpCall("TaskSpace.cdp", method, params, options);
    if (!method.startsWith("Target.") && !method.startsWith("Browser.")) {
      throw new TypeError(
        "task.cdp only supports Target. and Browser. commands",
      );
    }
    return this.#services.gate.withSpace(this.id, () =>
      this.#services.cdp(method, params, undefined, options.timeout),
    );
  }

  /**
   * Bring an untracked browser tab under the durable Page lifecycle.
   * Untracked handles intentionally cannot operate on the tab before adoption.
   */
  async adopt(
    page: UnmanagedPage,
    options: AdoptPageOptions = {},
  ): Promise<Page> {
    validatePublicApiOptions("TaskSpace.adopt", options);
    assertUnmanagedPage(page);
    if (page.spaceId !== this.id) {
      throw new Error(
        `untracked page ${page.targetId} belongs to space ${page.spaceId}, not space ${this.id}`,
      );
    }
    return this.#services.gate.withSpace(this.id, async () => {
      const { ledger, tabs } = await this.#reconcilePages();
      const live = tabs.some((tab) => tab.targetId === page.targetId);
      if (!live) {
        throw new Error(`untracked page ${page.targetId} is no longer open`);
      }
      const existing = Object.entries(ledger.pages).find(
        ([, entry]) => entry.targetId === page.targetId,
      );
      if (existing) {
        throw new Error(
          `target ${page.targetId} is already page ${existing[0]}`,
        );
      }
      if (Object.keys(ledger.pages).length >= this.#services.pageBudget) {
        throw pageBudgetError(this, this.#services.pageBudget, ledger, tabs);
      }
      const entry = await this.#services.ledger.addPage(
        this.id,
        page.targetId,
        {
          as: options.as,
          openedBy: page.openedBy,
        },
      );
      return new Page(this, entry.label, this.#services, entry);
    });
  }

  /**
   * Stop managing an unknown-origin page without closing its browser tab.
   * Agent-created pages must be closed so they cannot become untracked orphans.
   */
  async release(label: string): Promise<UnmanagedPage> {
    return this.#services.gate.withSpace(this.id, async () => {
      await this.#reconcilePages();
      const entry = await this.#services.ledger.getPage(this.id, label);
      if (entry.openedBy === "agent") {
        throw new Error(
          `page ${label} was created by the agent; close it instead of releasing it`,
        );
      }
      const released = await this.#services.ledger.releasePage(this.id, label);
      return new UnmanagedPage(
        this,
        released.targetId,
        released.openedBy,
        unmanagedPageConstructorToken,
      );
    });
  }

  async newPage(...args: unknown[]): Promise<Page> {
    if (args.length > 0) {
      throw new TypeError("task.newPage does not accept arguments");
    }
    return this.#services.gate.withSpace(this.id, async () => {
      const { ledger, tabs } = await this.#reconcilePages();
      const managedCount = Object.keys(ledger.pages).length;
      if (managedCount >= this.#services.pageBudget) {
        throw pageBudgetError(this, this.#services.pageBudget, ledger, tabs);
      }
      const targetId = await this.#services.createTab("about:blank");
      this.#services.setPreferredTarget(targetId);
      const existingManaged = Object.entries(ledger.pages).find(
        ([, page]) => page.targetId === targetId,
      );
      if (existingManaged) {
        throw new Error(
          `task.newPage did not create a distinct tab; target ${targetId} is already page ${existingManaged[0]}`,
        );
      }
      const existedBeforeCreate = tabs.some((tab) => tab.targetId === targetId);
      let entry: ManagedPage;
      try {
        entry = await this.#services.ledger.addPage(this.id, targetId, {
          openedBy: "agent",
        });
      } catch (error) {
        // A tab without a committed label cannot be returned safely. Close it
        // only when createTab produced a new target. Ego Lite may reuse a blank
        // anchor tab; closing a pre-existing target on a ledger error could
        // destroy a page the runtime does not own.
        if (!existedBeforeCreate) {
          await this.#services
            .cdp("Target.closeTarget", { targetId })
            .catch(() => {});
          this.#services.invalidateSession(targetId);
        }
        throw error;
      }
      await this.#services.ensureSession(targetId);
      return new Page(this, entry.label, this.#services, entry);
    });
  }

  /**
   * A small JSON store kept with this task space by the host, so a re-run
   * can skip finished steps. memo(key) resolves the value or undefined;
   * memo(key, value) stores it; memo(key, null) deletes it. finish() clears it.
   */
  async memo(key: string, ...rest: unknown[]): Promise<unknown> {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("task.memo(key) requires a non-empty string key");
    }
    if (rest.length > 1) {
      throw new TypeError(
        "task.memo accepts (key) to read or (key, value) to write",
      );
    }
    if (key.startsWith(RESERVED_MEMO_PREFIX)) {
      throw new TypeError(
        `task.memo keys starting with ${JSON.stringify(RESERVED_MEMO_PREFIX)} are reserved for the SDK`,
      );
    }
    const write = rest.length === 1;
    if (write) {
      const value = rest[0];
      let json: string | undefined;
      try {
        json = JSON.stringify(value);
      } catch {
        json = undefined;
      }
      if (json === undefined) {
        throw new TypeError(
          "task.memo value must be JSON-serializable; use null to delete",
        );
      }
    }
    if (!this.#services.hostCapabilities().taskSpaceMemo) {
      throw unsupportedOnHost(
        "task.memo",
        "keep progress in a file of your own instead",
      );
    }
    return this.#services.gate.withSpace(this.id, async () => {
      if (write) {
        await this.#services.taskSpaceMemo(key, { value: rest[0] });
        return rest[0] === null ? undefined : rest[0];
      }
      const result = await this.#services.taskSpaceMemo(key);
      return result?.found ? result.value : undefined;
    });
  }

  /**
   * After a browser restart, reopen the tabs this space lost (http(s) GET
   * only; form state is lost) and give them back their Page labels.
   */
  async restorePages(): Promise<{
    pages: Array<{ label: string; url: string }>;
    skipped: string[];
  }> {
    const capabilities = this.#services.hostCapabilities();
    if (!capabilities.restoreTaskSpaceTabs) {
      throw unsupportedOnHost(
        "task.restorePages",
        "open the Pages again with await task.newPage() and page.goto(url)",
      );
    }
    if (this.profileId === "ephemeral") {
      // An ephemeral space lives in a browser context that a restart
      // deletes, with the space: there is never anything to restore.
      throw withHint(
        "EGO_INVALID_ARGUMENT",
        "task.restorePages: an ephemeral task space does not outlive the browser, so it has no Pages to restore",
        'Use a persistent profile (taskSpace(name) or profileId: "Default") for work that must survive a browser restart; otherwise open the Pages again with task.newPage().',
      );
    }
    return this.#services.gate.withSpace(this.id, async () => {
      const saved = capabilities.taskSpaceMemo
        ? await this.#readPageUrls()
        : {};
      const result = await this.#services.restoreTaskSpaceTabs();
      const ledger = await this.#services.ledger.read(this.id);
      // Only labels of live Pages are taken. A label the restart retired
      // (still in usedLabels) goes back to the Page that had it.
      const taken = new Set(Object.keys(ledger.pages));
      const pages: Array<{ label: string; url: string }> = [];
      let lastTarget: string | undefined;
      for (const tab of result.tabs) {
        const label = Object.keys(saved).find(
          (candidate) => saved[candidate] === tab.url && !taken.has(candidate),
        );
        const entry = await this.#services.ledger.addPage(
          this.id,
          tab.targetId,
          { ...(label ? { as: label, reclaim: true } : {}), openedBy: "agent" },
        );
        taken.add(entry.label);
        pages.push({ label: entry.label, url: tab.url });
        lastTarget = tab.targetId;
      }
      if (lastTarget) this.#services.setPreferredTarget(lastTarget);
      if (pages.length > 0) {
        bufferOutput(
          `[ego-browser] browser restarted; reopened ${pages
            .map((page) => `${page.label} at ${page.url}`)
            .join(", ")} (form state is lost)\n`,
        );
        if (capabilities.taskSpaceMemo) {
          await this.#savePageUrls(
            Object.fromEntries(pages.map((page) => [page.label, page.url])),
          );
        }
      }
      return { pages, skipped: result.skipped };
    });
  }

  /**
   * Run fn(page, url, index) for each URL on up to `concurrency` Pages that
   * are reused and closed afterwards. Each Page goes to its URL first unless
   * navigate is false. One failure does not stop the others.
   */
  async map<T>(
    urls: string[],
    fn: (page: Page, url: string, index: number) => T | Promise<T>,
    options: TaskMapOptions = {},
  ): Promise<Array<TaskMapResult<Awaited<T>>>> {
    if (!Array.isArray(urls) || urls.some((url) => typeof url !== "string")) {
      throw new TypeError(
        "task.map(urls, fn) requires an array of URL strings",
      );
    }
    if (typeof fn !== "function") {
      throw new TypeError(
        "task.map(urls, fn) requires fn(page, url, index) to be a function",
      );
    }
    validatePublicApiOptions("TaskSpace.map", options);
    const results: Array<TaskMapResult<Awaited<T>>> = new Array(urls.length);
    if (urls.length === 0) return results;
    const managed = (await this.pages()).length;
    const room = Math.max(1, this.#services.pageBudget - managed);
    const workers = Math.min(
      options.concurrency ?? DEFAULT_MAP_CONCURRENCY,
      urls.length,
      room,
    );
    const pages: Page[] = [];
    let next = 0;
    try {
      for (let i = 0; i < workers; i += 1) {
        try {
          pages.push(await this.newPage());
        } catch (error) {
          // The host refuses more Pages (EGO_RESOURCE_LIMIT) or the Page
          // budget is used up: run with the Pages already open.
          if (pages.length > 0 && isPageCapacityError(error)) {
            bufferOutput(
              `[ego-browser] task.map: the browser host allowed ${pages.length} of ${workers} Pages (${(error as Error)?.message || error}); running ${pages.length} at a time.\n`,
            );
            break;
          }
          if (isPageCapacityError(error)) {
            const code = (error as { error_code?: string })?.error_code;
            throw attachHint(
              Object.assign(
                new Error(
                  `task.map could not open a Page: ${(error as Error)?.message || error}`,
                  { cause: error },
                ),
                { error_code: code ?? "EGO_PAGE_BUDGET_REACHED" },
              ),
              "Close Pages you no longer need (await page.close()) or finish old task spaces, then run task.map again; a lower concurrency does not help when no Page can open.",
            );
          }
          throw error;
        }
      }
      await Promise.all(
        pages.map(async (page) => {
          while (next < urls.length) {
            const index = next;
            next += 1;
            const url = urls[index];
            try {
              if (options.navigate !== false) {
                await page.goto(url, {
                  ...(options.timeout === undefined
                    ? {}
                    : { timeout: options.timeout }),
                  ...(options.waitUntil === undefined
                    ? {}
                    : { waitUntil: options.waitUntil }),
                });
              }
              const value = await fn(page, url, index);
              results[index] = { url, index, ok: true, value };
            } catch (error) {
              const code = (error as { error_code?: unknown })?.error_code;
              results[index] = {
                url,
                index,
                ok: false,
                error: (error as Error)?.message || String(error),
                ...(typeof code === "string" ? { error_code: code } : {}),
              };
            }
          }
        }),
      );
    } finally {
      for (const page of pages) {
        await page.close().catch(() => {});
      }
    }
    return results;
  }

  /** Remember a Page label's URL so restorePages() can relabel it. */
  async [recordPageUrlToken](label: string, url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return;
    if (!this.#services.hostCapabilities().taskSpaceMemo) return;
    try {
      await this.#services.gate.withSpace(this.id, async () => {
        const saved = await this.#readPageUrls();
        if (saved[label] === url) return;
        await this.#savePageUrls({ ...saved, [label]: url });
      });
    } catch {
      // Restore metadata is best effort.
    }
  }

  #pageUrls?: Record<string, string>;

  async #readPageUrls(): Promise<Record<string, string>> {
    if (this.#pageUrls) return this.#pageUrls;
    try {
      const result = await this.#services.taskSpaceMemo(PAGE_URLS_MEMO_KEY);
      const value = result?.found ? result.value : undefined;
      this.#pageUrls =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, string>)
          : {};
    } catch {
      this.#pageUrls = {};
    }
    return this.#pageUrls;
  }

  async #savePageUrls(next: Record<string, string>): Promise<void> {
    const before = await this.#readPageUrls();
    const merged = { ...before, ...next };
    if (JSON.stringify(merged) === JSON.stringify(before)) return;
    await this.#services.taskSpaceMemo(PAGE_URLS_MEMO_KEY, { value: merged });
    this.#pageUrls = merged;
  }

  /** Keep the label-to-URL record in step with the live tabs. */
  async #recordLiveUrls(ledger: PageLedger, tabs: RuntimeTab[]): Promise<void> {
    if (tabs.length === 0) return;
    if (!this.#services.hostCapabilities().taskSpaceMemo) return;
    const live: Record<string, string> = {};
    for (const [label, page] of Object.entries(ledger.pages)) {
      const url = tabs.find((tab) => tab.targetId === page.targetId)?.url;
      if (url && /^https?:\/\//i.test(url)) live[label] = url;
    }
    try {
      const before = await this.#readPageUrls();
      // Drop labels the ledger no longer has; keep the rest current.
      const next: Record<string, string> = {};
      for (const label of Object.keys(ledger.pages)) {
        if (live[label]) next[label] = live[label];
        else if (before[label]) next[label] = before[label];
      }
      if (JSON.stringify(next) === JSON.stringify(before)) return;
      await this.#services.taskSpaceMemo(PAGE_URLS_MEMO_KEY, { value: next });
      this.#pageUrls = next;
    } catch {
      // Restore metadata is best effort.
    }
  }

  async #reconcilePages(): Promise<{
    ledger: PageLedger;
    tabs: RuntimeTab[];
  }> {
    // Some embedders provide a minimal ledger port. Adoption still works
    // without the optional before-image; only the round notice is skipped.
    const before =
      typeof this.#services.ledger.read === "function"
        ? await this.#services.ledger.read(this.id)
        : undefined;
    const tabs = await this.#services.listTabs();
    const ledger = await this.#services.ledger.reconcile(
      this.id,
      tabs.map((tab) => tab.targetId),
      { autoAdoptNew: this.ownership === "agent" },
    );
    if (before) {
      const knownTargets = new Set(
        Object.values(before.pages).map((page) => page.targetId),
      );
      for (const [label, page] of Object.entries(ledger.pages)) {
        if (knownTargets.has(page.targetId)) continue;
        const tab = tabs.find(
          (candidate) => candidate.targetId === page.targetId,
        );
        recordDiscoveredPage(
          this.id,
          { label, ...page },
          labelForTarget(ledger, tab?.openerId),
          tab?.url,
        );
      }
    }
    await this.#recordLiveUrls(ledger, tabs);
    return { ledger, tabs };
  }

  async #adoptDiscoveredChildPage(
    ledger: PageLedger,
    tab: RuntimeTab,
  ): Promise<ManagedPage | undefined> {
    const openerLabel = labelForTarget(ledger, tab.openerId);
    if (
      !openerLabel ||
      labelForTarget(ledger, tab.targetId) ||
      Object.hasOwn(ledger.unmanagedTargets, tab.targetId)
    ) {
      return undefined;
    }

    try {
      const page = await this.#services.ledger.addPage(this.id, tab.targetId, {
        openedBy: "agent",
      });
      // Keep the current inventory usable while adopting a chain of child
      // pages from one listTabs() result.
      ledger.pages[page.label] = {
        targetId: page.targetId,
        openedBy: page.openedBy,
      };
      recordDiscoveredPage(this.id, page, openerLabel, tab.url);
      return page;
    } catch {
      // Another discovery path may have adopted the same target first.
      return undefined;
    }
  }

  #handleBrowserEvent(event: any): void {
    if (event?.method === "Target.targetDestroyed") {
      const targetId = event.params?.targetId;
      if (typeof targetId === "string") {
        forgetPageNotice(this.id, targetId);
      }
      return;
    }
    if (event?.method === "Target.targetInfoChanged") {
      const info = event.params?.targetInfo;
      if (
        info?.type === "page" &&
        typeof info.targetId === "string" &&
        typeof info.url === "string"
      ) {
        refreshUnhandledPageNotice(this.id, info.targetId, info.url);
      }
      return;
    }
    const info = event?.params?.targetInfo;
    if (
      event?.method !== "Target.targetCreated" ||
      info?.type !== "page" ||
      typeof info.targetId !== "string" ||
      typeof info.openerId !== "string"
    ) {
      return;
    }

    void this.#services.gate
      .withSpace(this.id, async () => {
        const before = await this.#services.ledger.read(this.id);
        const tabs = await this.#services.listTabs();
        const tab = tabs.find(
          (candidate) => candidate.targetId === info.targetId,
        );
        if (!tab) return;
        await this.#adoptDiscoveredChildPage(before, {
          ...tab,
          openerId: info.openerId,
          url: tab.url || info.url,
        });
      })
      .catch(() => {
        // The next task.tabs() reconciliation remains the fallback.
      });
  }

  async #recoverExistingChildPages(): Promise<void> {
    const ledger = await this.#services.ledger.read(this.id);
    const tabs = await this.#services.listTabs();
    for (const tab of tabs) {
      await this.#adoptDiscoveredChildPage(ledger, tab);
    }
  }

  #stopBackgroundPageDiscovery(): void {
    this.#stopBrowserEvents?.();
    this.#stopBrowserEvents = undefined;
  }
}

function labelForTarget(
  ledger: PageLedger,
  targetId: unknown,
): string | undefined {
  if (typeof targetId !== "string") return undefined;
  return Object.entries(ledger.pages).find(
    ([, page]) => page.targetId === targetId,
  )?.[0];
}

function recordDiscoveredPage(
  spaceId: number,
  page: ManagedPage,
  openerLabel?: string,
  url?: string,
): void {
  recordUnhandledPage({
    spaceId,
    targetId: page.targetId,
    label: page.label,
    openerLabel,
    url,
  });
}

/**
 * A read-only identity for a live tab that is not managed by the Page model.
 * Obtain one from TaskSpace.tabs(), then call TaskSpace.adopt() before
 * navigating, observing, or closing the tab.
 */
class UnmanagedPage {
  readonly spaceId: number;
  readonly targetId: string;
  readonly openedBy: PageOrigin;

  constructor(
    task: TaskSpace,
    targetId: string,
    openedBy: PageOrigin,
    token: symbol,
  ) {
    if (token !== unmanagedPageConstructorToken) {
      throw new TypeError(
        "UnmanagedPage handles can only be obtained from task.tabs()",
      );
    }
    this.spaceId = task.id;
    this.targetId = targetId;
    this.openedBy = openedBy;
    Object.freeze(this);
  }
}

type ArmedFileChooser = {
  page: PageTarget;
  interception: FileChooserInterception;
};

type PendingFileChooser = {
  arm: Promise<ArmedFileChooser>;
};

type ArmedDownload = {
  page: PageTarget;
  interception: DownloadInterception;
};

type PendingDownload = {
  arm: Promise<ArmedDownload>;
};

/** A file chooser intercepted before Chromium can open a native dialog. */
/** Responses collected by page.captureResponses() until stop(). */
class ResponseCapture {
  readonly #collector: ResponseCollector;
  readonly #unsubscribe: () => void;
  #stopped?: Promise<CapturedResponse[]>;

  constructor(collector: ResponseCollector, unsubscribe: () => void) {
    this.#collector = collector;
    this.#unsubscribe = unsubscribe;
  }

  /** The responses collected so far whose bodies are read. */
  responses(): CapturedResponse[] {
    return this.#collector.responses();
  }

  /** Stop collecting, wait for bodies being read, and return every response. */
  stop(): Promise<CapturedResponse[]> {
    this.#stopped ??= (async () => {
      this.#unsubscribe();
      return this.#collector.stop();
    })();
    return this.#stopped;
  }
}

class FileChooser {
  readonly #services: PageModelServices;
  readonly #page: PageTarget;
  readonly #event: FileChooserOpenedEvent;
  readonly #interception: FileChooserInterception;
  #handled = false;

  constructor(
    services: PageModelServices,
    armed: ArmedFileChooser,
    event: FileChooserOpenedEvent,
  ) {
    this.#services = services;
    this.#page = armed.page;
    this.#interception = armed.interception;
    this.#event = event;
  }

  isMultiple(): boolean {
    return this.#event.mode === "selectMultiple";
  }

  async setFiles(path: string | string[]): Promise<PageActionReceipt> {
    if (this.#handled) throw new Error("this file chooser was already handled");
    const files = normalizeFilePaths(path, "fileChooser.setFiles");
    this.#handled = true;
    try {
      await this.#services.gate.withPage(this.#page, async ({ sessionId }) => {
        await setFilesOnBackendNode(
          this.#services,
          sessionId,
          files,
          this.#event.backendNodeId,
        );
      });
      return {};
    } catch (error) {
      if (isPageDialogOpenedError(error)) {
        return { dialog: error.dialog };
      }
      throw error;
    } finally {
      await this.#interception.dispose();
    }
  }
}

/** A Page download backed by a round-local artifact. */
class Download {
  readonly #pageHandle: Page;
  readonly #artifact: DownloadArtifact;

  constructor(page: Page, artifact: DownloadArtifact) {
    this.#pageHandle = page;
    this.#artifact = artifact;
  }

  page(): Page {
    return this.#pageHandle;
  }

  url(): string {
    return this.#artifact.url;
  }

  suggestedFilename(): string {
    return this.#artifact.suggestedFilename;
  }

  saveAs(path: string): Promise<void> {
    return this.#artifact.saveAs(path);
  }

  path(): Promise<string> {
    return this.#artifact.path();
  }

  failure(): Promise<string | null> {
    return this.#artifact.failure();
  }

  cancel(): Promise<void> {
    // Browser.cancelDownload goes to the selected space's browser.
    return this.#pageHandle[withSpaceToken](() => this.#artifact.cancel());
  }

  delete(): Promise<void> {
    return this.#artifact.delete();
  }
}

class Page {
  readonly label: string;
  readonly spaceId: number;
  readonly mouse: PageMouse;
  readonly keyboard: PageKeyboard;
  readonly #task: TaskSpace;
  readonly #services: PageModelServices;
  readonly #spaceName: string;
  #targetId?: string;
  #openedBy?: PageOrigin;
  #pendingFileChooser?: PendingFileChooser;
  #pendingDownload?: PendingDownload;
  #activeDownload?: Promise<void>;
  /** Response and download waiters still arming; later Page calls wait for them. */
  readonly #waiterArms = new Set<Promise<unknown>>();

  constructor(
    task: TaskSpace,
    label: string,
    services: PageModelServices,
    entry?: ManagedPage,
  ) {
    this.label = label;
    this.spaceId = task.id;
    this.#task = task;
    this.#spaceName = task.name;
    this.#services = services;
    pageServices.set(this, services);
    this.#targetId = entry?.targetId;
    this.#openedBy = entry?.openedBy;
    this.keyboard = new PageKeyboard(
      this.#services,
      (operation) =>
        this.#runRawAction((sessionId) => operation(this.#services, sessionId)),
      (operation) =>
        this.#runObservedAction((sessionId) =>
          operation(this.#services, sessionId),
        ),
    );
    this.mouse = new PageMouse(
      (operation) =>
        this.#runRawAction((sessionId) => operation(this.#services, sessionId)),
      (operation) =>
        this.#runObservedAction((sessionId) =>
          operation(this.#services, sessionId),
        ),
      () => this.keyboard.modifierMask(),
    );
  }

  get targetId(): string | undefined {
    return this.#targetId;
  }

  get openedBy(): PageOrigin | undefined {
    return this.#openedBy;
  }

  async goto(
    url: string,
    options: PageGotoOptions = {},
  ): Promise<PageActionReceipt> {
    assertUrl(url);
    validatePublicApiOptions("Page.goto", options);
    const timeoutMs = options.timeout ?? 15_000;
    const waitUntil = options.waitUntil ?? "load";
    const page = await this.#resolve();
    const { receipt } = await this.#runActionBoundary(
      page,
      async (sessionId) => {
        await navigateInPage(this.#services, sessionId, url, {
          referer: options.referer,
          timeoutMs,
          waitUntil,
        });
      },
    );
    await this.#task[recordPageUrlToken](this.label, url);
    return receipt;
  }

  async reload(options: PageReloadOptions = {}): Promise<PageActionReceipt> {
    validatePublicApiOptions("Page.reload", options);
    const timeoutMs = options.timeout ?? 15_000;
    const waitUntil = options.waitUntil ?? "load";
    const page = await this.#resolve();
    const { receipt } = await this.#runActionBoundary(
      page,
      async (sessionId) => {
        await reloadInPage(this.#services, sessionId, {
          timeoutMs,
          waitUntil,
        });
      },
    );
    return receipt;
  }

  async snapshot(
    options: PageSnapshotOptions = {},
  ): Promise<string | PageSnapshotObject> {
    validatePublicApiOptions("Page.snapshot", options);
    const settleOptions = snapshotSettleOptions(options.settle);
    const rootRefId =
      options.scope === "subtree" && options.root !== undefined
        ? parseRef(options.root)
        : undefined;
    if (options.scope === "subtree" && options.root === undefined) {
      throw pageSnapshotOptionsError(
        "page.snapshot subtree scope requires root to be a snapshot ref such as @21",
      );
    }
    if (options.scope !== "subtree" && options.root !== undefined) {
      throw pageSnapshotOptionsError(
        "page.snapshot root is only supported when scope is subtree",
      );
    }
    if (options.root !== undefined && !rootRefId) {
      throw pageSnapshotOptionsError(
        "page.snapshot root must be a snapshot ref such as @21",
      );
    }
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      await this.#activate(page.targetId);
      const settle = settleOptions
        ? await this.#waitForSettled(page, sessionId, settleOptions)
        : undefined;
      // Start the shared DOM observer before the snapshot, so the stats taken
      // after it can tell whether the page changed meanwhile. The stats probe
      // removes it; a failed snapshot removes it here.
      await probePageState(this.#services, sessionId);
      try {
        return await this.#snapshotObserved(page, sessionId, options, {
          rootRefId,
          settle,
        });
      } catch (error) {
        await releasePageObserver(this.#services, sessionId);
        throw error;
      }
    });
  }

  async #snapshotObserved(
    page: PageTarget,
    sessionId: string,
    options: PageSnapshotOptions,
    { rootRefId, settle }: { rootRefId?: string; settle?: PageSettleResult },
  ): Promise<string | PageSnapshotObject> {
    {
      let root: number | undefined;
      let rootContext:
        | {
            frameId?: string;
            frameProvenance?: "page" | "frame" | "unknown";
          }
        | undefined;
      if (rootRefId) {
        const refs = await this.#refMapForAction(
          page,
          sessionId,
          options.root!,
        );
        const entry = refs.get(rootRefId);
        if (!entry) {
          throw new ElementResolutionError(
            `Unknown ref: ${options.root}`,
            "permanent",
          );
        }
        root = entry.backendNodeId;
        rootContext = {
          ...(entry.frameId ? { frameId: entry.frameId } : {}),
          ...(entry.frameProvenance
            ? { frameProvenance: entry.frameProvenance }
            : {}),
        };
      }
      const {
        root: _root,
        format: _format,
        settle: _settle,
        ...snapshotOptions
      } = options;
      const snapshotScope = options.scope ?? "only_within_viewport";
      let result: any;
      let documents = new Map<string, string>();
      // A frame that navigates while the snapshot runs (ads, consent
      // banners) invalidates its refs. Take the snapshot again a few times.
      for (let attempt = 1; ; attempt += 1) {
        const beforeDocuments = await this.#pageDocuments(page, sessionId);
        result = await this.#services.snapshot({
          ...snapshotOptions,
          ...(root === undefined ? {} : { root }),
          scope: snapshotScope,
          includeActionMarks: options.includeActionMarks ?? true,
          includeStableLocator: options.includeStableLocator ?? true,
        });
        const iframeSessions =
          Array.isArray(result?.refs) && result.refs.length > 0
            ? await this.#services.ensureFrameSessions(page.targetId)
            : new Map<string, string>();
        await preparePageSnapshotResult(
          this.#services,
          sessionId,
          iframeSessions,
          result,
          rootContext,
        );
        documents = await this.#pageDocuments(page, sessionId);
        const changed = (result?.refs || []).some((ref: SnapshotRef) => {
          const documentId = pageRefDocumentId(ref, documents);
          return (
            !documentId ||
            documentId !== pageRefDocumentId(ref, beforeDocuments)
          );
        });
        if (!changed) break;
        if (attempt >= SNAPSHOT_ATTEMPTS) {
          throw new ElementResolutionError(
            "Page changed during snapshot; take a new snapshot",
            "transient",
          );
        }
      }
      for (const ref of result?.refs || []) {
        ref.documentId = pageRefDocumentId(ref, documents);
      }
      await this.#loadRefs(page);
      this.#services.pageRefs.invalidateChangedDocuments(
        page.targetId,
        documents,
      );
      await this.#registerSnapshotRefs(
        page,
        result,
        snapshotScope === "full_page",
      );
      const content = result?.content || "";
      const header = await this.#snapshotHeader(page);
      const { stats, warnings } = await this.#snapshotStats(
        sessionId,
        Array.isArray(result?.refs) ? result.refs.length : 0,
      );
      const statsLines = stats
        ? `${formatSnapshotStats(stats, warnings)}\n`
        : "";
      const text = `${header}\n${statsLines}${content}`;
      if (options.format !== "object") return text;
      return {
        text,
        ...(stats ? { stats } : {}),
        warnings,
        ...(settle ? { settle } : {}),
      };
    }
  }

  /**
   * Wait for the next response this Page loads that matches a URL string,
   * RegExp, or predicate, and resolve with its status, headers and parsed
   * body. Arm it before the action that triggers the request.
   */
  waitForResponse(
    matcher: ResponseMatcher,
    options: PageWaitForResponseOptions = {},
  ): Promise<CapturedResponse> {
    validatePublicApiOptions("Page.waitForResponse", options);
    compileResponseMatcher(matcher, "page.waitForResponse");
    const timeoutMs = options.timeout ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle!: {
      resolve(response: CapturedResponse): void;
      reject(error: unknown): void;
    };
    const outcome = new Promise<CapturedResponse>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // A timeout can land while the waiter is still arming; it is reported
    // when the caller awaits, never as an unhandled rejection.
    outcome.catch(() => {});
    // The timeout starts now, like the Promise the caller is holding.
    timer = setTimeout(() => {
      settle.reject(
        new Error(
          `page.waitForResponse timed out after ${timeoutMs}ms waiting for ${describeResponseMatcher(matcher)}`,
        ),
      );
    }, timeoutMs);
    // Register the subscription before returning, so the action the caller
    // runs next waits in #resolve() until this waiter is listening.
    const arm = this.#followResponses({
      match: matcher,
      ...(options.maxBodyBytes === undefined
        ? {}
        : { maxBodyBytes: options.maxBodyBytes }),
      onResponse: (response) => settle.resolve(response),
      onMatchError: (error) => settle.reject(error),
    });
    this.#waiterArms.add(arm);
    const disarm = () => this.#waiterArms.delete(arm);
    arm.then(disarm, disarm);
    return (async () => {
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = await arm;
        return await outcome;
      } finally {
        if (timer) clearTimeout(timer);
        unsubscribe?.();
      }
    })();
  }

  /**
   * Start collecting the responses this Page loads, with parsed bodies, until
   * stop(). Without match it keeps fetch and XHR responses.
   */
  async captureResponses(
    options: PageCaptureResponsesOptions = {},
  ): Promise<ResponseCapture> {
    validatePublicApiOptions("Page.captureResponses", options);
    let collector!: ResponseCollector;
    const unsubscribe = await this.#followResponses(options, (created) => {
      collector = created;
    });
    return new ResponseCapture(collector, unsubscribe);
  }

  /** Subscribe a ResponseCollector to this Page and enable Network events. */
  async #followResponses(
    options: ConstructorParameters<typeof ResponseCollector>[2],
    created?: (collector: ResponseCollector) => void,
  ): Promise<() => void> {
    const page = await this.#resolveEntry();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      const apiName = created
        ? "page.captureResponses"
        : "page.waitForResponse";
      const collector = new ResponseCollector(
        this.#services,
        sessionId,
        options,
        apiName,
      );
      created?.(collector);
      const unsubscribe = this.#services.subscribePageEvents(
        page.targetId,
        collector.handleEvent,
      );
      try {
        await this.#services.ensureNetworkTracking([sessionId]);
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return unsubscribe;
    });
  }

  /**
   * Wait until a client-rendered Page has drawn: document loaded, DOM quiet
   * for quietMs, no fetch/XHR in flight, and `until` matched minCount times
   * when given. Resolves with what it saw and does not throw on timeout.
   */
  async waitForSettled(
    options: PageSettleOptions = {},
  ): Promise<PageSettleResult> {
    validatePublicApiOptions("Page.waitForSettled", options);
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      await this.#activate(page.targetId);
      return this.#waitForSettled(page, sessionId, options);
    });
  }

  async #waitForSettled(
    page: PageTarget,
    sessionId: string,
    options: PageSettleOptions,
  ): Promise<PageSettleResult> {
    return waitForSettledInPage(
      this.#services,
      sessionId,
      options,
      (selector) => this.#countMatches(page, sessionId, selector),
      () => this.#services.pageNetworkSessions(sessionId),
    );
  }

  /** How many elements a selector, loc= locator or ref matches now. */
  async #countMatches(
    page: PageTarget,
    sessionId: string,
    selector: string,
  ): Promise<number> {
    const refMap = await this.#refMapForAction(page, sessionId, selector);
    const iframeSessions = await this.#services.ensureFrameSessions(
      page.targetId,
    );
    return countSelectorMatchesInPage(
      this.#services,
      sessionId,
      refMap,
      selector,
      iframeSessions,
    );
  }

  /** Stats and warnings for the snapshot just taken; empty when unknown. */
  async #snapshotStats(
    sessionId: string,
    refs: number,
  ): Promise<{ stats?: SnapshotStats; warnings: string[] }> {
    // The last probe also removes the observer from the page.
    const state = await probePageState(
      this.#services,
      sessionId,
      true,
      undefined,
      true,
    );
    if (!state) {
      await releasePageObserver(this.#services, sessionId);
      return { warnings: [] };
    }
    let pendingRequests: number | undefined;
    try {
      const activity = this.#services.networkActivity([sessionId]);
      if (activity?.tracking) pendingRequests = activity.inflight;
    } catch {
      // Network tracking is optional for stats.
    }
    const stats = snapshotStats(state, refs, pendingRequests);
    return { stats, warnings: snapshotWarnings(stats, state) };
  }

  /**
   * Type a secret stored with the host into a field, without the value ever
   * reaching this script: focus the target, then the host types the secret
   * if this Page's origin is one the secret is registered for.
   */
  async fillSecret(
    target: string,
    name: string,
    options: PageFillSecretOptions = {},
  ): Promise<{ filled: boolean; secret: string; origin: string }> {
    if (typeof target !== "string" || !target) {
      throw new TypeError(
        "page.fillSecret(target, name) requires a target selector, loc= locator or ref",
      );
    }
    if (typeof name !== "string" || !name) {
      throw new TypeError(
        "page.fillSecret(target, name) requires the secret's name",
      );
    }
    validatePublicApiOptions("Page.fillSecret", options);
    if (!this.#services.hostCapabilities().fillSecret) {
      throw unsupportedOnHost(
        "page.fillSecret",
        "this host keeps no secrets; ask the user to type it after task.handOff()",
      );
    }
    try {
      await this.focus(
        target,
        options.timeout === undefined ? {} : { timeout: options.timeout },
      );
    } catch (error) {
      if (!(error instanceof ElementResolutionError)) throw error;
      // Name the real step that failed: the target was found but cannot
      // take focus, or it was not found, or it cannot receive input.
      const reason = error.message.replace(
        /^page\.focus (?:failed|timed out after \d+ms): /,
        "",
      );
      const wrapped = new ElementResolutionError(
        /element is not focusable|multiple editable targets/.test(reason)
          ? `page.fillSecret: ${target} is not a text field: ${reason}`
          : `page.fillSecret: could not focus ${target}: ${reason}`,
        error.kind,
      );
      (wrapped as Error & { cause?: unknown }).cause = error;
      throw wrapped;
    }
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      const result = await this.#services.fillSecret(name, {
        targetId: page.targetId,
        clear: options.clear !== false,
      });
      // Mark the field, so the extractors (read, tables, structuredData)
      // redact its value in the page. Snapshots are redacted by the host.
      await evaluateInSession(
        this.#services,
        sessionId,
        markSecretFieldExpression(name),
        false,
      ).catch(() => undefined);
      return result;
    });
  }

  /** Run a browser-level call with this Page's space selected. */
  [withSpaceToken]<T>(operation: () => Promise<T>): Promise<T> {
    return this.#services.gate.withSpace(this.spaceId, operation);
  }

  /**
   * The readable content of this Page as Markdown: the main article by
   * default, the whole body with mode "full", or one element with selector.
   * A PDF (opened in the viewer or at a .pdf URL) is read as text by page.
   */
  async read(options: PageReadOptions = {}): Promise<ReadResult> {
    validatePublicApiOptions("Page.read", options);
    if (options.mode !== undefined && options.selector !== undefined) {
      throw new TypeError("page.read takes mode or selector, not both");
    }
    const maxChars = options.maxChars ?? DEFAULT_READ_MAX_CHARS;
    const timeoutMs = options.timeout ?? 20_000;
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      if (options.selector === undefined) {
        const pdf = await evaluateIsolated<{ pdf: boolean; url: string }>(
          this.#services,
          sessionId,
          detectPdfDocument,
          null,
          5_000,
        ).catch(() => undefined);
        if (pdf?.pdf) return this.#readPdf(sessionId, pdf.url, maxChars);
      }
      const raw = await evaluateIsolated<RawReadResult>(
        this.#services,
        sessionId,
        extractReadable,
        { mode: options.mode, selector: options.selector },
        timeoutMs,
      );
      if (!raw || typeof raw !== "object") {
        throw new Error("page.read got no result from the page");
      }
      if ("error" in raw && raw.error) {
        throw attachHint(
          new Error(`page.read: ${raw.error}`),
          "Check the selector with a snapshot, or call page.read() without one.",
        );
      }
      const result = finishReadResult(
        raw as Exclude<RawReadResult, { error: string }>,
        maxChars,
      );
      if (result.words < 30) {
        result.warning =
          "the page has very little readable text: it may still be rendering, need a login, or keep its content in a frame. Wait (page.waitForSettled), then read again, or take a snapshot.";
      }
      return result;
    });
  }

  async #readPdf(
    sessionId: string,
    url: string,
    maxChars: number,
  ): Promise<ReadResult> {
    const response = await evaluateInSession<PageFetchResult>(
      this.#services,
      sessionId,
      fetchInPage,
      true,
      { url, options: {}, timeoutMs: 30_000, responseType: "base64" },
      31_000,
    );
    if ("fetchError" in response) {
      throw attachHint(
        new Error(
          `page.read could not download the PDF: ${response.fetchError}`,
        ),
        'Download it with page.waitForEvent("download") or page.fetch(url, { saveAs }), then call readPdf(path).',
      );
    }
    if (!response.ok) {
      throw attachHint(
        Object.assign(
          new Error(`page.read: the PDF answered HTTP ${response.status}`),
          { status: response.status },
        ),
        "Check the URL, or whether the PDF needs a login.",
      );
    }
    const bytes = Buffer.from(response.bodyBase64 || "", "base64");
    if (bytes.length > MAX_PDF_BYTES) {
      throw new Error(
        `page.read: the PDF is ${bytes.length} bytes, over the ${MAX_PDF_BYTES}-byte limit`,
      );
    }
    return pdfReadResult(bytes, response.url || url, maxChars);
  }

  /**
   * Tables on this Page (HTML tables and ARIA grids) as headers and rows
   * keyed by header. rowspan/colspan are expanded; spacer rows dropped.
   */
  async tables(options: PageTablesOptions = {}): Promise<ExtractedTable[]> {
    validatePublicApiOptions("Page.tables", options);
    if (
      options.index !== undefined &&
      !(Number.isInteger(options.index) && options.index >= 0)
    ) {
      throw new TypeError("page.tables index must be a non-negative integer");
    }
    if (options.saveAs !== undefined) {
      assertAbsoluteFilePath(options.saveAs, "page.tables saveAs");
    }
    const page = await this.#resolve();
    const raw = await this.#services.gate.withPage(page, ({ sessionId }) =>
      evaluateIsolated<any>(
        this.#services,
        sessionId,
        extractTables,
        { selector: options.selector, includeHidden: options.includeHidden },
        20_000,
      ),
    );
    if (raw?.error) {
      throw attachHint(
        new Error(`page.tables: ${raw.error}`),
        "Pass a CSS selector of a table or of an element that contains tables.",
      );
    }
    let tables: ExtractedTable[] = (raw?.tables || []).map(
      (table: any, index: number) => {
        const { headers, rows } = gridToRows(table.grid, table.headerRows);
        return {
          index,
          ...(table.caption ? { caption: table.caption } : {}),
          selector: table.selector,
          kind: table.kind,
          headers,
          rows,
          rowCount: rows.length,
        };
      },
    );
    if (options.index !== undefined) {
      const table = tables[options.index];
      if (!table) {
        throw attachHint(
          new Error(
            `page.tables index ${options.index} is out of range: found ${tables.length} table${tables.length === 1 ? "" : "s"}`,
          ),
          "Call await page.tables() without index to list them.",
        );
      }
      tables = [table];
    }
    if (options.csv || options.saveAs !== undefined) {
      for (const table of tables) table.csv = tableToCsv(table);
    }
    if (options.saveAs !== undefined) {
      if (tables.length !== 1) {
        throw new TypeError(
          `page.tables saveAs writes one table, but ${tables.length} matched; pass index`,
        );
      }
      await mkdir(dirname(options.saveAs), { recursive: true });
      await writeFile(options.saveAs, tables[0].csv!, "utf8");
    }
    return tables;
  }

  /** JSON-LD, OpenGraph, Twitter cards, description, canonical, microdata. */
  async structuredData(): Promise<StructuredData> {
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, ({ sessionId }) =>
      evaluateIsolated<StructuredData>(
        this.#services,
        sessionId,
        extractStructuredData,
        null,
        15_000,
      ),
    );
  }

  /**
   * Search the web in this Page and read the results. Reports engines that
   * show a bot check in `blocked` instead of returning empty results.
   */
  async search(
    query: string,
    options: PageSearchOptions = {},
  ): Promise<SearchResult> {
    if (typeof query !== "string" || !query.trim()) {
      throw new TypeError("page.search(query) requires a non-empty query");
    }
    validatePublicApiOptions("Page.search", options);
    const max = Math.min(options.max ?? 10, 50);
    const blocked: SearchBlock[] = [];
    let doubtful: SearchResult | undefined;
    for (const engine of searchEngineOrder(options.engine)) {
      const url = searchUrl(engine, query.trim());
      try {
        await this.goto(url, {
          timeout: options.timeout ?? 15_000,
          waitUntil: "load",
        });
      } catch (error) {
        blocked.push({
          engine,
          url,
          reason: `the results page did not load: ${(error as Error)?.message || error}`,
          hint: BLOCK_HINT,
        });
        continue;
      }
      const page = await this.#resolve();
      const parsed = await this.#services.gate.withPage(page, ({ sessionId }) =>
        evaluateIsolated<ParsedSearchPage>(
          this.#services,
          sessionId,
          parseSearchPage,
          { engine, max },
          10_000,
        ),
      );
      const verdict = judgeSearchPage(engine, {
        url: parsed?.url || url,
        results: Array.isArray(parsed?.results) ? parsed.results : [],
        ...(parsed?.blocked ? { blocked: parsed.blocked } : {}),
        ...(parsed?.noResults ? { noResults: true } : {}),
      });
      if (verdict.ok === true) {
        const warning = verdict.noResults
          ? noResultsWarning(engine)
          : relevanceWarning(query, verdict.results);
        const answer: SearchResult = {
          engine,
          query,
          url: parsed?.url || url,
          results: verdict.results,
          blocked,
          ...(verdict.noResults ? { noResults: true } : {}),
          ...(warning ? { warning } : {}),
        };
        if (!warning) return answer;
        // A doubtful answer (nothing found, or unrelated results) is kept,
        // but the next engine gets a chance to answer properly first.
        doubtful ??= answer;
        continue;
      }
      blocked.push(verdict.block);
    }
    if (doubtful) return { ...doubtful, blocked };
    return { engine: null, query, results: [], blocked };
  }

  /**
   * Close a cookie or consent banner. By default it picks "Reject all" or
   * "Necessary only" and never accepts unless prefer is "accept".
   */
  async dismissConsent(
    options: PageDismissConsentOptions = {},
  ): Promise<ConsentResult> {
    validatePublicApiOptions("Page.dismissConsent", options);
    const prefer = options.prefer ?? "reject";
    const waitMs = options.timeout ?? DEFAULT_CONSENT_WAIT_MS;
    const deadline = this.#services.now() + waitMs;
    const argument = {
      prefer,
      rules: CONSENT_RULES,
      rejectText: REJECT_TEXT.source,
      acceptText: ACCEPT_TEXT.source,
      generic: true,
    };
    const page = await this.#resolve();
    let settingsOpened = 0;
    let last: ConsentResult = { found: false, action: "none" };
    while (true) {
      const attempt = await this.#services.gate.withPage(
        page,
        async ({ sessionId }) => {
          const sessions: Array<[string, "main" | "iframe"]> = [
            [sessionId, "main"],
          ];
          try {
            const frames = await this.#services.ensureFrameSessions(
              page.targetId,
            );
            for (const frameSession of frames.values()) {
              if (frameSession !== sessionId) {
                sessions.push([frameSession, "iframe"]);
              }
            }
          } catch {
            // Out-of-process frames are optional; the main frame still runs.
          }
          let found: (ConsentResult & { retry?: boolean }) | undefined;
          for (const [frameSession, frame] of sessions) {
            const result = await evaluateIsolated<
              ConsentResult & { retry?: boolean }
            >(
              this.#services,
              frameSession,
              dismissConsentInFrame,
              argument,
              5_000,
            ).catch(() => undefined);
            if (!result?.found) continue;
            found = { ...result, frame };
            if (result.action !== "none" || result.retry) break;
          }
          return found;
        },
      );
      if (attempt) {
        last = attempt;
        if (attempt.retry && settingsOpened < 2) {
          // A settings panel opened; look for its reject button next.
          settingsOpened += 1;
          await this.#services.sleep(600);
          continue;
        }
        const { retry: _retry, ...result } = attempt;
        if (result.action === "none") return result;
        await this.#services.sleep(500);
        const rule = CONSENT_RULES.find(
          (candidate) => candidate.framework === result.framework,
        );
        if (rule && result.frame === "main") {
          const visible = await this.#services.gate.withPage(
            page,
            ({ sessionId }) =>
              evaluateIsolated<boolean>(
                this.#services,
                sessionId,
                consentStillVisible,
                { container: rule.container },
                5_000,
              ).catch(() => undefined),
          );
          if (typeof visible === "boolean") result.dismissed = !visible;
        }
        return result;
      }
      const remaining = deadline - this.#services.now();
      if (remaining <= 0) return last;
      await this.#services.sleep(Math.min(250, remaining));
    }
  }

  /**
   * Scroll an infinite list until it stops growing: until maxItems items
   * match itemSelector, no new items appear for idleMs, maxScrolls is
   * reached, or the timeout passes.
   */
  async scrollToLoad(options: PageScrollToLoadOptions = {}): Promise<{
    items?: number;
    scrolls: number;
    height: number;
    stoppedBecause: string;
    ms: number;
  }> {
    validatePublicApiOptions("Page.scrollToLoad", options);
    const maxScrolls = options.maxScrolls ?? 30;
    const idleMs = options.idleMs ?? 1_500;
    const timeoutMs = options.timeout ?? 60_000;
    const started = this.#services.now();
    const deadline = started + timeoutMs;
    const page = await this.#resolve();
    const measure = () =>
      this.#services.gate.withPage(page, async ({ sessionId }) => {
        const height = await evaluateInSession<number>(
          this.#services,
          sessionId,
          "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)",
          false,
        );
        const items =
          options.itemSelector === undefined
            ? undefined
            : await this.#countMatches(page, sessionId, options.itemSelector);
        return { height: Number(height) || 0, items };
      });
    let state = await measure();
    let scrolls = 0;
    const done = (stoppedBecause: string) => ({
      ...(state.items === undefined ? {} : { items: state.items }),
      scrolls,
      height: state.height,
      stoppedBecause,
      ms: this.#services.now() - started,
    });
    while (true) {
      if (
        options.maxItems !== undefined &&
        state.items !== undefined &&
        state.items >= options.maxItems
      ) {
        return done("maxItems reached");
      }
      if (scrolls >= maxScrolls) return done("maxScrolls reached");
      if (this.#services.now() >= deadline) return done("timeout");
      await this.#services.gate.withPage(page, async ({ sessionId }) => {
        await this.#activate(page.targetId);
        await evaluateInSession(this.#services, sessionId, scrollStep, true, {
          itemSelector: cssOnly(options.itemSelector),
        });
      });
      scrolls += 1;
      // Wait for growth, up to idleMs.
      const before = state;
      const idleDeadline = Math.min(deadline, this.#services.now() + idleMs);
      let grew = false;
      while (this.#services.now() < idleDeadline) {
        await this.#services.sleep(150);
        state = await measure();
        if (
          (state.items !== undefined &&
            before.items !== undefined &&
            state.items > before.items) ||
          state.height > before.height
        ) {
          grew = true;
          break;
        }
      }
      if (!grew) {
        state = await measure();
        return done(
          state.items === undefined
            ? "the page stopped growing"
            : "no new items",
        );
      }
    }
  }

  /**
   * Visit this Page and each next page: yields this Page, then clicks
   * `next`, waits for the page to change, and yields again, up to maxPages.
   * Stops when `next` is missing or a click does not change the page.
   */
  async *paginate(options: PagePaginateOptions): AsyncGenerator<Page> {
    if (!options || typeof options !== "object") {
      throw new TypeError(
        "page.paginate requires { next }, such as { next: \"loc=role:link[name='Next']\" }",
      );
    }
    validatePublicApiOptions("Page.paginate", options);
    if (typeof options.next !== "string" || !options.next) {
      throw new TypeError("page.paginate requires a next selector");
    }
    const maxPages = options.maxPages ?? 10;
    const timeoutMs = options.timeout ?? 15_000;
    for (let n = 1; ; n += 1) {
      yield this;
      if (n >= maxPages) return;
      const page = await this.#resolve();
      const before = await this.#services.gate.withPage(
        page,
        async ({ sessionId }) => ({
          count: await this.#countMatches(page, sessionId, options.next),
          signature: await pageSignature(this.#services, sessionId),
        }),
      );
      if (before.count === 0) return;
      try {
        await this.click(options.next, { timeout: Math.min(timeoutMs, 5_000) });
      } catch (error) {
        // A disabled or covered "next" means the last page.
        if (error instanceof ElementResolutionError) return;
        throw error;
      }
      const deadline = this.#services.now() + timeoutMs;
      let changed = false;
      while (this.#services.now() < deadline) {
        await this.#services.sleep(200);
        const after = await this.#services.gate
          .withPage(await this.#resolve(), ({ sessionId }) =>
            pageSignature(this.#services, sessionId),
          )
          .catch(() => undefined);
        if (after && after !== before.signature) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      await this.waitForSettled({
        timeout: Math.max(1, deadline - this.#services.now()),
      });
    }
  }

  /**
   * A site's learned tools for use in this Page: site(id).tools() lists them
   * and site(id).run(name, args) runs one with this Page.
   */
  site(siteId: string): SiteTools {
    if (typeof siteId !== "string" || !siteId) {
      throw new TypeError('page.site(id) requires a site id such as "bing"');
    }
    return new SiteTools(this, siteId, this.#services.agentWorkspace());
  }

  async url(): Promise<string> {
    return this.#evaluate("location.href", false);
  }

  async waitForURL(
    expected: PageURLMatcher,
    options: PageWaitForURLOptions = {},
  ): Promise<void> {
    validatePublicApiOptions("Page.waitForURL", options);
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, ({ sessionId }) =>
      waitForURLInPage(this.#services, sessionId, expected, options, {
        interrupt: (lastUrl, matches) =>
          matchingPopupWaitError(this.spaceId, this.label, lastUrl, matches),
      }),
    );
  }

  /** Wait for the next popup or download started by this Page. */
  waitForEvent(
    event: "popup" | "download",
    options: PageWaitForEventOptions = {},
  ): Promise<Page | Download> {
    if (event !== "popup" && event !== "download") {
      throw new TypeError(
        "page.waitForEvent only supports the popup and download events",
      );
    }
    validatePublicApiOptions("Page.waitForEvent", options);
    const timeoutMs = options.timeout ?? 10_000;
    if (event === "download") return this.#waitForDownload(timeoutMs);

    // Subscribe synchronously so the common `const pending = waitForEvent();
    // await click()` pattern cannot miss a popup created by the click.
    return new Promise<Page>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timer) clearTimeout(timer);
        operation();
      };
      const onNotice = (notice: UnhandledPageNotice) => {
        if (
          notice.spaceId !== this.spaceId ||
          notice.openerLabel !== this.label
        ) {
          return;
        }
        finish(() => {
          markPageObserved(notice.spaceId, notice.targetId);
          resolve(this.#task.page(notice.label));
        });
      };
      const unsubscribe = subscribeUnhandledPageNotices(onNotice);
      timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `page.waitForEvent("popup") timed out after ${timeoutMs}ms`,
            ),
          ),
        );
      }, timeoutMs);

      // Playwright-style event waits observe only future events. Replaying a
      // pending notice here can return a popup from an earlier action.

      // Resolve the source after arming the listener. A stale Page should fail
      // the waiter, but no popup may be lost while that validation is pending.
      if (!settled) {
        void this.#resolve().catch((error) => finish(() => reject(error)));
      }
    });
  }

  #waitForDownload(timeoutMs: number): Promise<Download> {
    if (this.#pendingDownload || this.#activeDownload) {
      throw new Error("this Page already has an active download wait");
    }
    const pending: PendingDownload = {
      arm: (async () => {
        // #resolveEntry, not #resolve: #resolve waits for this very arm.
        const page = await this.#resolveEntry();
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
          const interception = this.#services.prepareDownload(page.targetId, {
            timeoutMs,
          });
          try {
            await interception.ready(sessionId);
            return { page, interception };
          } catch (error) {
            await interception.dispose(asError(error));
            throw error;
          }
        });
      })(),
    };
    this.#pendingDownload = pending;
    // Any Page call made next (evaluate, goto, mouse, keyboard...) waits in
    // #resolve() until the download interception is listening, so a download
    // started by that call cannot be missed.
    this.#waiterArms.add(pending.arm);
    const disarm = () => this.#waiterArms.delete(pending.arm);
    pending.arm.then(disarm, disarm);
    return (async () => {
      let armed: ArmedDownload | undefined;
      try {
        armed = await pending.arm;
        const artifact = await armed.interception.event;
        const active = artifact.finished.finally(() => {
          if (this.#activeDownload === active) {
            this.#activeDownload = undefined;
          }
        });
        this.#activeDownload = active;
        void active.catch(() => {});
        return new Download(this, artifact);
      } catch (error) {
        if (armed) await armed.interception.dispose(asError(error));
        throw error;
      } finally {
        if (this.#pendingDownload === pending) {
          this.#pendingDownload = undefined;
        }
      }
    })();
  }

  /** Wait without activating this Page or occupying the native operation gate. */
  async waitForTimeout(timeout: number): Promise<void> {
    if (
      typeof timeout !== "number" ||
      !Number.isFinite(timeout) ||
      timeout < 0
    ) {
      throw new TypeError(
        "page.waitForTimeout requires a non-negative number of milliseconds",
      );
    }
    await this.#resolve();
    await this.#services.sleep(timeout);
  }

  async title(): Promise<string> {
    return this.#evaluate("document.title", false);
  }

  async info(): Promise<Record<string, unknown>> {
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      const dialog = this.#services.pendingDialog(sessionId);
      if (dialog) return { dialog };
      return evaluateInSession(
        this.#services,
        sessionId,
        "({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})",
        false,
      );
    });
  }

  /** Accept the JavaScript dialog currently blocking this Page, if any. */
  async acceptDialog(promptText?: string): Promise<boolean> {
    if (promptText !== undefined && typeof promptText !== "string") {
      throw new TypeError("page.acceptDialog promptText must be a string");
    }
    return this.#handleJavaScriptDialog(true, promptText);
  }

  /** Dismiss the JavaScript dialog currently blocking this Page, if any. */
  async dismissDialog(): Promise<boolean> {
    return this.#handleJavaScriptDialog(false);
  }

  async evaluate<T = unknown>(
    expression: string | ((argument: any) => T | Promise<T>),
    argument?: unknown,
  ): Promise<T> {
    const hasArgument = arguments.length >= 2;
    return this.#evaluate(expression, hasArgument, argument, true);
  }

  /** Wait until a Page expression returns a truthy value. */
  async waitForFunction(
    expression: string | ((argument: any) => unknown | Promise<unknown>),
    argument?: unknown,
    options: PageWaitForFunctionOptions = {},
  ): Promise<true> {
    if (
      arguments.length === 2 &&
      typeof expression === "function" &&
      expression.length === 0 &&
      looksLikeWaitForFunctionOptions(argument)
    ) {
      const signature = publicApiEntry("Page.waitForFunction")?.signature;
      throw new TypeError(
        `page.waitForFunction options are the third argument; pass undefined when omitting the callback argument. Expected: ${signature}`,
      );
    }
    validatePublicApiOptions("Page.waitForFunction", options);
    // Passing `undefined` is how callers omit the optional argument while
    // supplying the third options parameter, matching Playwright's shape.
    const hasArgument = arguments.length >= 2 && argument !== undefined;
    const serializedArgument = validateEvaluateInput(
      "page.waitForFunction",
      expression,
      hasArgument,
      argument,
    );
    const timeoutMs = options.timeout ?? 10_000;
    const pollingMs = options.polling ?? 100;
    const source = waitForFunctionExpression(
      expression,
      hasArgument,
      serializedArgument,
    );
    const page = await this.#resolve();

    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      await this.#activate(page.targetId);
      const deadline = this.#services.now() + timeoutMs;
      let lastUrl = "";
      let lastTitle = "";
      try {
        while (this.#services.now() <= deadline) {
          const remaining = Math.max(1, deadline - this.#services.now());
          const executionTimeoutMs = remaining;
          const transportTimeoutMs =
            remaining + WAIT_FOR_FUNCTION_TRANSPORT_GRACE_MS;
          const evaluationStartedAt = this.#services.now();
          try {
            let response;
            try {
              response = await this.#services.cdp(
                "Runtime.evaluate",
                {
                  expression: source,
                  returnByValue: true,
                  awaitPromise: true,
                  timeout: executionTimeoutMs,
                },
                sessionId,
                transportTimeoutMs,
              );
            } catch (error) {
              throw normalizeProtocolExecutionTimeout(
                error,
                this.#services.now() - evaluationStartedAt,
                executionTimeoutMs,
              );
            }
            const state = runtimeValue(response, source);
            if (isWaitForFunctionState(state)) {
              lastUrl = state.url;
              lastTitle = state.title;
              if (state.matched) return true as const;
            }
          } catch (error) {
            if (isEvaluationExecutionDeadlineError(error)) {
              break;
            }
            if (isRuntimeEvaluateTransportTimeout(error)) {
              throw await recoverPageEvaluationTimeout(
                this.#services,
                sessionId,
                "page.waitForFunction",
                timeoutMs,
              );
            }
            if (!isRetryablePageEvaluationError(error)) {
              throw enrichPageCallbackReferenceError(
                error,
                "page.waitForFunction",
              );
            }
            if (this.#services.now() >= deadline) break;
          }

          const waitMs = deadline - this.#services.now();
          if (waitMs <= 0) break;
          await this.#services.sleep(Math.min(pollingMs, waitMs));
        }
      } finally {
        // The predicate may mutate the DOM, so snapshot refs are no longer
        // guaranteed to identify the same elements.
        await this.#invalidateRefs(page);
      }
      throw waitForFunctionTimeoutError(
        this.spaceId,
        this.label,
        timeoutMs,
        lastUrl,
        lastTitle,
      );
    });
  }

  /**
   * Run window.fetch inside this Page and return a CDP-serializable response.
   * Relative URLs, cookies, and service workers use the addressed document's
   * browser context. Browser CORS still applies.
   */
  async fetch(
    url: string,
    options: PageFetchOptions = {},
  ): Promise<PageFetchResponse> {
    assertUrl(url);
    const { payload, saveAs } = pageFetchPayload(url, options);
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      await this.#activate(page.targetId);
      const response = await evaluateInSession<PageFetchResult>(
        this.#services,
        sessionId,
        fetchInPage,
        true,
        payload,
        payload.timeoutMs + 1_000,
      );
      if ("fetchError" in response) {
        throw new Error(response.fetchError);
      }
      if (!saveAs) return response;
      if (typeof response.bodyBase64 !== "string") {
        throw new Error("page.fetch received no binary response body");
      }
      await mkdir(dirname(saveAs), { recursive: true });
      await writeFile(saveAs, Buffer.from(response.bodyBase64, "base64"));
      const { bodyBase64: _bodyBase64, ...metadata } = response;
      return { ...metadata, savedPath: saveAs };
    });
  }

  /** Send one CDP command through this Page's target session. */
  async cdp(
    method: string,
    params: Record<string, unknown> = {},
    options: CdpOptions = {},
  ): Promise<any> {
    assertCdpCall("Page.cdp", method, params, options);
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      // A modal dialog already belongs to the active Page. Re-activating it
      // can hand browser control to the user before CDP gets a chance to close
      // the dialog, so send this one command directly to its existing session.
      if (method !== "Page.handleJavaScriptDialog") {
        await this.#activate(page.targetId);
      }
      try {
        return await this.#services.cdp(
          method,
          params,
          sessionId,
          options.timeout,
        );
      } finally {
        // Raw CDP can navigate or mutate the document, so existing refs are no
        // longer safe even when the command looked observational.
        await this.#invalidateRefs(page);
      }
    });
  }

  async waitForSelector(
    selector: string,
    options: PageWaitForSelectorOptions = {},
  ): Promise<true> {
    validatePublicApiOptions("Page.waitForSelector", options);
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      await this.#activate(page.targetId);
      const refMap = await this.#refMapForAction(page, sessionId, selector);
      return waitForSelectorInPage(
        this.#services,
        sessionId,
        refMap,
        selector,
        options,
        (timeoutMs) =>
          this.#services.ensureFrameSessions(page.targetId, timeoutMs),
      );
    });
  }

  async waitForLoadState(
    state: "domcontentloaded" | "load" | "networkidle" = "load",
    options: PageWaitForLoadStateOptions = {},
  ): Promise<void> {
    validatePublicApiOptions("Page.waitForLoadState", options);
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      await this.#activate(page.targetId);
      try {
        await waitForLoadStateInPage(this.#services, sessionId, state, options);
      } finally {
        await this.#invalidateRefs(page);
      }
    });
  }

  /** Drain only CDP events routed to this Page session. */
  async events(): Promise<any[]> {
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, ({ sessionId }) =>
      this.#services.drainEvents(sessionId),
    );
  }

  async screenshot(
    options: PageScreenshotOptions = {},
  ): Promise<string | string[]> {
    validatePublicApiOptions("Page.screenshot", options);
    const { path, fullPage, maxHeight, tiles, ...captureOptions } = options;
    if (path !== undefined) {
      assertAbsoluteFilePath(path, "page.screenshot path");
    }
    if ((tiles || maxHeight !== undefined) && fullPage !== true) {
      throw new TypeError(
        "page.screenshot tiles and maxHeight need fullPage: true",
      );
    }
    if ((tiles || maxHeight !== undefined) && captureOptions.clip) {
      throw new TypeError(
        "page.screenshot tiles and maxHeight cannot be combined with clip",
      );
    }
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      await this.#activate(page.targetId);
      if (fullPage !== true || captureOptions.clip) {
        return this.#services.screenshot(
          path,
          fullPage === undefined
            ? captureOptions
            : { ...captureOptions, full: fullPage },
          sessionId,
        );
      }
      const measure = () =>
        evaluateInSession<{
          width: number;
          height: number;
          x?: number;
          y?: number;
          vw?: number;
        }>(
          this.#services,
          sessionId,
          "({ width: Math.max(document.documentElement.scrollWidth, innerWidth), height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, innerHeight), x: scrollX, y: scrollY, vw: innerWidth })",
          false,
        );
      const size = await measure();
      let width = Math.max(1, Math.ceil(size?.width || 1));
      let height = Math.max(1, Math.ceil(size?.height || 1));
      // A single captureBeyondViewport capture of a tall page stalls at
      // random in headless Chrome for ~16 s, past the CDP timeout, and blocks
      // the renderer meanwhile. Pages taller than one region are captured in
      // regions instead: the viewport is emulated at the region height, each
      // region is scrolled into view and captured as a plain viewport shot,
      // and every capture gets its own short timeout with retries. Without
      // emulation (a host that refuses it) regions fall back to
      // captureBeyondViewport with the same retries.
      let emulated = false;
      const capturesRegions =
        height >
        Math.min(
          FULL_PAGE_REGION_HEIGHT,
          tiles ? Infinity : (maxHeight ?? DEFAULT_FULL_PAGE_MAX_HEIGHT),
        );
      if (capturesRegions) {
        try {
          await this.#services.cdp(
            "Emulation.setDeviceMetricsOverride",
            {
              width: Math.max(1, Math.round(size?.vw || width)),
              height: FULL_PAGE_REGION_HEIGHT,
              deviceScaleFactor: 0,
              mobile: false,
            },
            sessionId,
          );
          emulated = true;
          const emulatedSize = await measure();
          width = Math.max(1, Math.ceil(emulatedSize?.width || width));
          height = Math.max(1, Math.ceil(emulatedSize?.height || height));
        } catch {
          emulated = false;
        }
      }
      const scrollTo = (y: number) =>
        evaluateInSession(
          this.#services,
          sessionId,
          `scrollTo(0, ${y})`,
          false,
        );
      const captureRegion = async (
        regionPath: string | undefined,
        y: number,
        regionHeight: number,
      ): Promise<string> => {
        let lastError: unknown;
        for (const [
          attempt,
          timeoutMs,
        ] of FULL_PAGE_REGION_TIMEOUTS_MS.entries()) {
          // A retry nudges the scroll position so Chrome paints a new frame.
          if (attempt > 0) await scrollTo(y + 1);
          await scrollTo(y);
          try {
            return await this.#services.screenshot(
              regionPath,
              {
                ...captureOptions,
                full: !emulated,
                timeoutMs,
                clip: { x: 0, y, width, height: regionHeight },
              },
              sessionId,
            );
          } catch (error) {
            if (!isCdpRequestTimeoutError(error)) throw error;
            lastError = error;
          }
        }
        throw Object.assign(
          new Error(
            `page.screenshot: the region at y=${y} (${regionHeight} px) did not capture after ${FULL_PAGE_REGION_TIMEOUTS_MS.length} attempts. Try a viewport screenshot, or a smaller maxHeight with tiles: true.`,
            { cause: lastError },
          ),
          { code: "EGO_SCREENSHOT_TIMED_OUT" },
        );
      };
      try {
        if (tiles) {
          const tileHeight = maxHeight ?? DEFAULT_TILE_HEIGHT;
          const count = Math.min(MAX_TILES, Math.ceil(height / tileHeight));
          const paths: string[] = [];
          for (let i = 0; i < count; i += 1) {
            const y = i * tileHeight;
            const tileFile =
              path === undefined ? undefined : tilePath(path, i + 1);
            const tileBottom = Math.min(height, y + tileHeight);
            if (tileBottom - y <= FULL_PAGE_REGION_HEIGHT) {
              paths.push(await captureRegion(tileFile, y, tileBottom - y));
            } else {
              paths.push(
                await this.#captureStitched(
                  tileFile,
                  y,
                  tileBottom,
                  captureRegion,
                ),
              );
            }
          }
          if (count * tileHeight < height) {
            bufferOutput(
              `[ego-browser] page.screenshot: the page is ${height} px tall; ${count} tiles cover the top ${count * tileHeight} px. Pass a larger maxHeight for fewer, taller tiles.\n`,
            );
          }
          return paths;
        }
        const limit = maxHeight ?? DEFAULT_FULL_PAGE_MAX_HEIGHT;
        if (height > limit) {
          bufferOutput(
            `[ego-browser] page.screenshot: the page is ${height} px tall; captured the top ${limit} px. Use { fullPage: true, tiles: true } for the whole page.\n`,
          );
        }
        const bottom = Math.min(height, limit);
        if (bottom <= FULL_PAGE_REGION_HEIGHT) {
          return await captureRegion(path, 0, bottom);
        }
        return await this.#captureStitched(path, 0, bottom, captureRegion);
      } finally {
        if (emulated) {
          await this.#services
            .cdp("Emulation.clearDeviceMetricsOverride", {}, sessionId)
            .catch(() => undefined);
        }
        await evaluateInSession(
          this.#services,
          sessionId,
          `scrollTo(${Math.round(size?.x || 0)}, ${Math.round(size?.y || 0)})`,
          false,
        ).catch(() => undefined);
      }
    });
  }

  /** Capture [top, bottom) in regions and join them into one PNG file. */
  async #captureStitched(
    path: string | undefined,
    top: number,
    bottom: number,
    captureRegion: (
      regionPath: string | undefined,
      y: number,
      regionHeight: number,
    ) => Promise<string>,
  ): Promise<string> {
    const outputPath =
      path ??
      join(
        tmpdir(),
        `ego-browser-shot-${process.pid}-${Date.now()}-${++stitchedShotSeq}.png`,
      );
    const parts: string[] = [];
    try {
      for (let y = top; y < bottom; y += FULL_PAGE_REGION_HEIGHT) {
        parts.push(
          await captureRegion(
            `${outputPath}.part-${parts.length + 1}.png`,
            y,
            Math.min(FULL_PAGE_REGION_HEIGHT, bottom - y),
          ),
        );
      }
      const images = await Promise.all(parts.map((part) => readFile(part)));
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, stitchPngsVertically(images));
      return outputPath;
    } finally {
      await Promise.all(parts.map((part) => rm(part, { force: true })));
    }
  }

  async click(
    selector: string,
    options: PageClickOptions = {},
  ): Promise<PageActionReceipt> {
    validatePublicApiOptions("Page.click", options);
    return this.#runAction(
      selector,
      (sessionId, refMap, iframeSessions, services) =>
        clickInPage(
          services,
          sessionId,
          refMap,
          selector,
          options,
          this.keyboard.modifierMask(),
          iframeSessions,
        ),
      {
        actionName: "page.click",
        guardFileChooser: true,
        timeout: options.timeout,
      },
    );
  }

  async dblclick(
    selector: string,
    options: Omit<PageClickOptions, "clickCount"> = {},
  ): Promise<PageActionReceipt> {
    validatePublicApiOptions("Page.dblclick", options);
    return this.#runAction(
      selector,
      (sessionId, refMap, iframeSessions, services) =>
        clickInPage(
          services,
          sessionId,
          refMap,
          selector,
          { ...options, clickCount: 2 },
          this.keyboard.modifierMask(),
          iframeSessions,
        ),
      {
        actionName: "page.dblclick",
        guardFileChooser: true,
        timeout: options.timeout,
      },
    );
  }

  async hover(
    selector: string,
    options: PageHoverOptions = {},
  ): Promise<PageActionReceipt> {
    validatePublicApiOptions("Page.hover", options);
    return this.#runAction(
      selector,
      (sessionId, refMap, iframeSessions, services) =>
        hoverInPage(
          services,
          sessionId,
          refMap,
          selector,
          options,
          this.keyboard.modifierMask(),
          iframeSessions,
        ),
      { actionName: "page.hover", timeout: options.timeout },
    );
  }

  async dragAndDrop(
    sourceSelector: string,
    targetSelector: string,
    options: PageDragAndDropOptions = {},
  ): Promise<PageActionReceipt> {
    validatePublicApiOptions("Page.dragAndDrop", options);
    return this.#runAction(
      [sourceSelector, targetSelector],
      (sessionId, refMap, iframeSessions, services) =>
        dragAndDropInPage(
          services,
          sessionId,
          refMap,
          sourceSelector,
          targetSelector,
          options,
          this.keyboard.modifierMask(),
          iframeSessions,
        ),
      { actionName: "page.dragAndDrop", timeout: options.timeout },
    );
  }

  async fill(
    selector: string,
    value: string,
    options: PageFillOptions = {},
  ): Promise<PageActionReceipt> {
    validatePublicApiOptions("Page.fill", options);
    return this.#runAction(
      selector,
      (sessionId, refMap, iframeSessions, services) =>
        fillInPage(
          services,
          sessionId,
          refMap,
          selector,
          value,
          options,
          iframeSessions,
        ),
      { actionName: "page.fill", timeout: options.timeout },
    );
  }

  async selectOption(
    selector: string,
    valueOrValues: PageSelectOption | PageSelectOption[] | null,
    options: { timeout?: number } = {},
  ): Promise<string[]> {
    validatePublicApiOptions("Page.selectOption", options);
    const choices =
      valueOrValues === null
        ? []
        : Array.isArray(valueOrValues)
          ? valueOrValues
          : [valueOrValues];
    choices.forEach(validateSelectOptionChoice);
    const timeoutMs = options.timeout ?? DEFAULT_PAGE_ACTION_TIMEOUT_MS;
    const page = await this.#resolve();
    return this.#runInputBoundary(page, (sessionId) =>
      this.#retryElementAction(
        "page.selectOption",
        timeoutMs,
        sessionId,
        (remainingMs) =>
          this.#resolveActionTargets(page, sessionId, remainingMs, selector),
        ({ refMap, iframeSessions }, services) =>
          selectOptionInPage(
            services,
            sessionId,
            refMap,
            selector,
            choices,
            iframeSessions,
          ),
      ),
    );
  }

  async focus(
    selector: string,
    options: { timeout?: number } = {},
  ): Promise<PageActionReceipt> {
    validatePublicApiOptions("Page.focus", options);
    return this.#runAction(
      selector,
      (sessionId, refMap, iframeSessions, services) =>
        focusInPage(services, sessionId, refMap, selector, iframeSessions),
      { actionName: "page.focus", timeout: options.timeout },
    );
  }

  async press(
    selector: string,
    chord: string,
    options: PagePressOptions = {},
  ): Promise<PageActionReceipt> {
    validatePublicApiOptions("Page.press", options);
    const { timeout, ...pressOptions } = options;
    return this.#runAction(
      selector,
      async (sessionId, refMap, iframeSessions, services) => {
        await focusInPage(
          services,
          sessionId,
          refMap,
          selector,
          iframeSessions,
        );
        await this.keyboard.pressInSession(sessionId, chord, pressOptions);
      },
      {
        actionName: "page.press",
        guardFileChooser: true,
        timeout,
      },
    );
  }

  async setInputFiles(
    selector: string,
    path: string | string[],
  ): Promise<PageActionReceipt> {
    return this.#runAction(
      selector,
      (sessionId, refMap, iframeSessions, services) =>
        setInputFilesInPage(
          services,
          sessionId,
          refMap,
          selector,
          path,
          iframeSessions,
        ),
      { actionName: "page.setInputFiles" },
    );
  }

  waitForFileChooser(
    options: PageWaitForFileChooserOptions = {},
  ): Promise<FileChooser> {
    validatePublicApiOptions("Page.waitForFileChooser", options);
    const timeoutMs = options.timeout ?? 10_000;
    if (this.#pendingFileChooser) {
      throw new Error("this Page is already waiting for a file chooser");
    }

    const pending: PendingFileChooser = {
      arm: (async () => {
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
          await this.#activate(page.targetId);
          const interception = this.#services.prepareFileChooser(sessionId, {
            timeoutMs,
            cancel: false,
          });
          await interception.ready;
          return { page, interception };
        });
      })(),
    };
    this.#pendingFileChooser = pending;
    return (async () => {
      let armed: ArmedFileChooser | undefined;
      try {
        armed = await pending.arm;
        const event = await armed.interception.event;
        return new FileChooser(this.#services, armed, event);
      } catch (error) {
        if (armed) await armed.interception.dispose(asError(error));
        throw error;
      } finally {
        if (this.#pendingFileChooser === pending) {
          this.#pendingFileChooser = undefined;
        }
      }
    })();
  }

  async close(): Promise<void> {
    const page = await this.#resolve();
    await this.#services.gate.withSpace(this.spaceId, async () => {
      const tabs = await this.#services.listTabs();
      const live = tabs.some((tab) => tab.targetId === page.targetId);
      if (!live) {
        await this.#services.ledger.closePage(this.spaceId, this.label);
        this.#services.pageRefs.clear(page.targetId);
        throw new Error(`page ${this.label} was closed`);
      }
      if (tabs.length <= 1) {
        const anchorTargetId = await this.#services.createTab("about:blank");
        try {
          await this.#services.ledger.keepUnmanaged(
            this.spaceId,
            anchorTargetId,
            "unknown",
          );
        } catch (error) {
          // The original page is still live, so a failed anchor bookkeeping
          // write can safely roll the new anchor back before aborting close.
          await this.#services
            .cdp("Target.closeTarget", { targetId: anchorTargetId })
            .catch(() => {});
          throw error;
        }
      }
      const result = await this.#services.cdp("Target.closeTarget", {
        targetId: page.targetId,
      });
      if (result?.success !== true) {
        throw new Error(`failed to close page ${this.label}`);
      }
      const disappeared = await waitForTargetToDisappear(
        this.#services,
        page.targetId,
        PAGE_CLOSE_CONFIRM_TIMEOUT_MS,
      );
      if (!disappeared) {
        // Keep the durable label while the native tab still exists. The caller
        // can retry close safely instead of leaving an unmanaged orphan.
        throw new Error(
          `page ${this.label} did not close within ${PAGE_CLOSE_CONFIRM_TIMEOUT_MS}ms`,
        );
      }
      this.#services.invalidateSession(page.targetId);
      this.#services.pageRefs.clear(page.targetId);
      await this.#services.ledger.closePage(this.spaceId, this.label);
    });
  }

  async #resolve(): Promise<PageTarget> {
    // A response or download waiter armed just before this call must be
    // listening before the action it watches can start.
    if (this.#waiterArms.size > 0) {
      await Promise.allSettled([...this.#waiterArms]);
    }
    return this.#resolveEntry();
  }

  async #resolveEntry(): Promise<PageTarget> {
    const entry = await this.#services.ledger
      .getPage(this.spaceId, this.label)
      .catch(async (error) => {
        throw await this.#task[describeMissingPageToken](this.label, error);
      });
    this.#targetId = entry.targetId;
    this.#openedBy = entry.openedBy;
    markPageObserved(this.spaceId, entry.targetId);
    return { spaceId: this.spaceId, targetId: entry.targetId };
  }

  async #evaluate<T>(
    expression: string | ((argument: any) => T | Promise<T>),
    hasArgument: boolean,
    argument?: unknown,
    activate = false,
  ): Promise<T> {
    const serializedArgument = validateEvaluateInput(
      "page.evaluate",
      expression,
      hasArgument,
      argument,
    );
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      if (activate) await this.#activate(page.targetId);
      try {
        return await evaluateInSession<T>(
          this.#services,
          sessionId,
          expression,
          hasArgument,
          serializedArgument,
          PAGE_EVALUATE_TRANSPORT_TIMEOUT_MS,
          PAGE_EVALUATE_EXECUTION_TIMEOUT_MS,
        );
      } catch (error) {
        if (isEvaluationExecutionDeadlineError(error)) {
          throw evaluationExecutionDeadlineError(
            "page.evaluate",
            PAGE_EVALUATE_EXECUTION_TIMEOUT_MS,
          );
        }
        if (isRuntimeEvaluateTransportTimeout(error)) {
          throw await recoverPageEvaluationTimeout(
            this.#services,
            sessionId,
            "page.evaluate",
            PAGE_EVALUATE_TRANSPORT_TIMEOUT_MS,
          );
        }
        if (typeof expression === "function") {
          throw enrichPageCallbackReferenceError(error, "page.evaluate");
        }
        throw error;
      }
    });
  }

  async #runAction(
    selector: string | string[],
    operation: (
      sessionId: string,
      refMap: RefMap,
      iframeSessions: Map<string, string>,
      services: PageModelServices,
    ) => Promise<void>,
    options: {
      actionName?: string;
      guardFileChooser?: boolean;
      timeout?: number;
    } = {},
  ): Promise<PageActionReceipt> {
    const page = await this.#resolve();
    const selectors = Array.isArray(selector) ? selector : [selector];
    const timeoutMs = options.timeout ?? DEFAULT_PAGE_ACTION_TIMEOUT_MS;
    const actionName = options.actionName ?? "page action";
    const { receipt } = await this.#runActionBoundary(
      page,
      (sessionId) =>
        this.#retryElementAction(
          actionName,
          timeoutMs,
          sessionId,
          (remainingMs) =>
            this.#resolveActionTargets(
              page,
              sessionId,
              remainingMs,
              ...selectors,
            ),
          ({ refMap, iframeSessions }, services) =>
            operation(sessionId, refMap, iframeSessions, services),
        ),
      options.guardFileChooser,
    );
    return receipt;
  }

  async #resolveActionTargets(
    page: PageTarget,
    sessionId: string,
    remainingMs: number,
    ...selectors: string[]
  ): Promise<{ refMap: RefMap; iframeSessions: Map<string, string> }> {
    const refMap = await this.#refMapForAction(page, sessionId, ...selectors);
    const iframeSessions = await this.#services.ensureFrameSessions(
      page.targetId,
      Math.max(1, remainingMs),
    );
    return { refMap, iframeSessions };
  }

  /** Services whose CDP transport reports the first `Input.*` command. */
  #inputTrackingServices(onInput: () => void): PageModelServices {
    const services = this.#services;
    return {
      ...services,
      cdp(method, params, sessionId, timeoutMs) {
        if (method.startsWith("Input.")) onInput();
        return services.cdp(method, params, sessionId, timeoutMs);
      },
    };
  }

  /**
   * Retry an element action until its deadline. Until the first `Input.*`
   * command reaches the page, failures may include a vanished frame or a lost
   * iframe session and are retried after rediscovering frames. Once input was
   * dispatched only element-state transients are retried, so a gesture that
   * already reached the page is never dispatched twice.
   */
  async #retryElementAction<Prepared, Result>(
    actionName: string,
    timeoutMs: number,
    pageSessionId: string,
    prepare: (remainingMs: number) => Promise<Prepared>,
    perform: (
      prepared: Prepared,
      services: PageModelServices,
    ) => Promise<Result>,
  ): Promise<Result> {
    const deadline = this.#services.now() + timeoutMs;
    let lastBlocker: Error | undefined;
    // Whether any attempt reached the page with input. Such an attempt is never
    // repeated, but its effects (a submit, a navigation) may still land.
    let anyInputDispatched = false;
    while (true) {
      let inputDispatched = false;
      const services = this.#inputTrackingServices(() => {
        inputDispatched = true;
        anyInputDispatched = true;
      });
      try {
        const prepared = await prepare(deadline - this.#services.now());
        return await perform(prepared, services);
      } catch (error) {
        const remainingMs = deadline - this.#services.now();
        // Frame discovery runs on the remaining budget; a transport timeout at
        // the deadline is this action's timeout, reported with the last real
        // blocker rather than as a CDP failure.
        const exhausted =
          !inputDispatched &&
          isCdpRequestTimeoutError(error) &&
          remainingMs <= 0;
        const retryable = inputDispatched
          ? isRetryableElementStateError(error)
          : isRetryableResolutionError(error, pageSessionId);
        if (!retryable && !exhausted) throw error;
        if (remainingMs <= 0) {
          const blocker = exhausted && lastBlocker ? lastBlocker : error;
          const timeoutError = new ElementResolutionError(
            `${actionName} timed out after ${timeoutMs}ms: ${blocker.message}`,
            "transient",
          );
          timeoutError.mayHaveLateEffects = anyInputDispatched;
          throw timeoutError;
        }
        lastBlocker = error;
        await this.#services.sleep(
          Math.min(PAGE_ACTION_RESOLUTION_RETRY_MS, remainingMs),
        );
      }
    }
  }

  async #runRawAction(
    operation: (sessionId: string) => Promise<void>,
  ): Promise<void> {
    const page = await this.#resolve();
    try {
      await this.#runInputBoundary(page, operation);
    } catch (error) {
      // A modal dialog is now the page's observable result. The interrupted
      // driver stack has already unwound, so no later click/key steps resume
      // unexpectedly after the caller handles the dialog.
      if (isPageDialogOpenedError(error)) return;
      throw error;
    }
  }

  async #runObservedAction(
    operation: (sessionId: string) => Promise<void>,
  ): Promise<PageActionReceipt> {
    const page = await this.#resolve();
    const { receipt } = await this.#runActionBoundary(page, operation, true);
    return receipt;
  }

  async #handleJavaScriptDialog(
    accept: boolean,
    promptText?: string,
  ): Promise<boolean> {
    const page = await this.#resolve();
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      try {
        await this.#services.cdp(
          "Page.handleJavaScriptDialog",
          {
            accept,
            ...(promptText === undefined ? {} : { promptText }),
          },
          sessionId,
        );
        // A handled dialog resumes its callback and may mutate the DOM. A
        // no-dialog response leaves the page untouched, so its refs stay valid.
        await this.#invalidateRefs(page);
        return true;
      } catch (error) {
        if (isNoJavaScriptDialogError(error)) return false;
        throw error;
      }
    });
  }

  async #runInputBoundary<T>(
    page: PageTarget,
    operation: (sessionId: string) => Promise<T>,
  ): Promise<T> {
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      await this.#activate(page.targetId);
      return operation(sessionId);
    });
  }

  async #runActionBoundary<T>(
    page: PageTarget,
    operation: (sessionId: string) => Promise<T>,
    guardFileChooser = false,
  ): Promise<{ value: T; receipt: PageActionReceipt }> {
    const explicitDownload = this.#pendingDownload;
    const armedDownload = explicitDownload
      ? await explicitDownload.arm
      : undefined;
    if (armedDownload && armedDownload.page.targetId !== page.targetId) {
      throw new Error("download waiter belongs to a different Page");
    }
    const explicitFileChooser = guardFileChooser
      ? this.#pendingFileChooser
      : undefined;
    if (explicitFileChooser) {
      const armed = await explicitFileChooser.arm;
      if (armed.page.targetId !== page.targetId) {
        throw new Error("file chooser waiter belongs to a different Page");
      }
    }
    return this.#services.gate.withPage(page, async ({ sessionId }) => {
      await this.#activate(page.targetId);
      await armedDownload?.interception.ready(sessionId);
      const fileChooserGuard =
        guardFileChooser && !explicitFileChooser
          ? this.#services.prepareFileChooser(sessionId, {
              timeoutMs: 1_000,
              cancel: true,
            })
          : undefined;
      try {
        await fileChooserGuard?.ready;
        const before = new Set(
          (await this.#services.listTabs()).map((tab) => tab.targetId),
        );
        let actionError: unknown;
        let value: T | undefined;
        try {
          value = await operation(sessionId);
        } catch (error) {
          actionError = error;
        }

        if (isPageDialogOpenedError(actionError)) {
          const dialog =
            this.#services.pendingDialog(sessionId) || actionError.dialog;
          return {
            value: undefined as T,
            receipt: { dialog },
          };
        }

        // A popup is normally created synchronously by the input event. A short
        // settle covers native tab-list propagation without turning this into a
        // navigation wait or silently changing the page's active state.
        await this.#services.sleep(50);
        let popupError: unknown;
        const popups: Array<{ label: string; targetId: string }> = [];
        try {
          const after = await this.#services.listTabs();
          for (const tab of after) {
            if (before.has(tab.targetId)) continue;
            const managed = await this.#services.ledger.addPage(
              this.spaceId,
              tab.targetId,
              { openedBy: "agent" },
            );
            recordDiscoveredPage(this.spaceId, managed, this.label, tab.url);
            popups.push({ label: managed.label, targetId: managed.targetId });
          }
        } catch (error) {
          popupError = error;
        }

        if (fileChooserGuard?.peek()) {
          throw unhandledFileChooserError();
        }

        if (actionError) throw actionError;
        if (popupError) throw popupError;
        return {
          value: value as T,
          receipt: popups.length > 0 ? { popups } : {},
        };
      } finally {
        await fileChooserGuard?.dispose();
      }
    });
  }

  async #refMapForAction(
    page: PageTarget,
    sessionId: string,
    ...selectors: string[]
  ): Promise<RefMap> {
    if (!selectors.some((selector) => parseRef(selector))) {
      return this.#services.pageRefs.forTarget(page.targetId);
    }
    await this.#loadRefs(page);
    const registry = this.#services.pageRefs;
    registry.invalidateChangedDocuments(
      page.targetId,
      await this.#pageDocuments(page, sessionId),
    );
    await this.#saveRefs(page);
    const refs = registry.forTarget(page.targetId);
    for (const selector of selectors) {
      const refId = parseRef(selector);
      if (!refId) continue;
      if (registry.isInvalidated(page.targetId, refId)) {
        throw new ElementResolutionError(
          `Stale ref: @${refId}; take a new snapshot`,
          "permanent",
        );
      }
      if (!refs.get(refId)) {
        throw new ElementResolutionError(
          `Unknown ref: ${refId}; take a new snapshot`,
          "permanent",
        );
      }
    }
    return refs;
  }

  async #pageDocuments(
    page: PageTarget,
    sessionId: string,
  ): Promise<Map<string, string>> {
    const iframeSessions = await this.#services.ensureFrameSessions(
      page.targetId,
    );
    const readTree = async (session: string) => {
      const response = await this.#services.cdp(
        "Page.getFrameTree",
        {},
        session,
      );
      return (response.result || response).frameTree;
    };
    const tree = await readTree(sessionId);
    const documents = new Map<string, string>();
    const visit = (node) => {
      if (
        typeof node?.frame?.id !== "string" ||
        typeof node.frame.loaderId !== "string"
      )
        return;
      documents.set(
        node.frame.id,
        JSON.stringify([
          tree.frame.id,
          tree.frame.loaderId,
          node.frame.id,
          node.frame.loaderId,
        ]),
      );
      for (const child of node.childFrames || []) visit(child);
    };
    visit(tree);
    const root = documents.get(tree?.frame?.id);
    if (!root)
      throw new ElementResolutionError(
        "Cannot verify Page document; take a new snapshot",
        "transient",
      );
    // The Page tree excludes out-of-process frames. A failed session read must
    // reach the retry boundary, not persistently expire refs in a live frame.
    const frames = await Promise.all(
      [...new Set(iframeSessions.values())]
        .filter((session) => session !== sessionId)
        .map(readTree),
    );
    for (const frame of frames) visit(frame);
    documents.set("", root);
    return documents;
  }

  async #loadRefs(page: PageTarget): Promise<void> {
    const stored = await this.#services.ledger.getPage(
      page.spaceId,
      this.label,
    );
    this.#services.pageRefs.restore(page.targetId, stored.refs);
  }

  async #saveRefs(page: PageTarget): Promise<void> {
    const refs = this.#services.pageRefs.exportState(page.targetId);
    if (refs)
      await this.#services.ledger.setPageRefs(page.spaceId, this.label, refs);
  }

  async #invalidateRefs(page: PageTarget): Promise<void> {
    await this.#loadRefs(page);
    this.#services.pageRefs.invalidate(page.targetId);
    await this.#saveRefs(page);
  }

  async #registerSnapshotRefs(
    page: PageTarget,
    result: any,
    replace: boolean,
  ): Promise<RefMap> {
    const nativeRefs = result?.refs || [];
    const originalIds = nativeRefs.map((ref) =>
      String(ref.refId ?? ref.backendNodeId),
    );
    const registry = this.#services.pageRefs;
    const refs = replace
      ? registry.replace(page.targetId, nativeRefs)
      : registry.merge(page.targetId, nativeRefs);
    if (typeof result?.content === "string") {
      result.content = rewriteSnapshotRefIds(
        result.content,
        new Map(
          nativeRefs.map((ref, index) => [
            originalIds[index],
            String(ref.refId),
          ]),
        ),
      );
    }
    await this.#saveRefs(page);
    return refs;
  }

  async #snapshotHeader(page: PageTarget): Promise<string> {
    try {
      const [tabs, ledger] = await Promise.all([
        this.#services.listTabs(),
        this.#services.ledger.read(this.spaceId),
      ]);
      return snapshotSourceHeader({
        currentLabel: this.label,
        currentTargetId: page.targetId,
        ledger,
        pageBudget: this.#services.pageBudget,
        spaceId: this.spaceId,
        spaceName: this.#spaceName,
        tabs,
      });
    } catch {
      return `[${this.label} | space ${JSON.stringify(this.#spaceName)}(${this.spaceId})]`;
    }
  }

  async #activate(targetId: string): Promise<void> {
    await this.#services.cdp("Target.activateTarget", { targetId });
    this.#services.setPreferredTarget(targetId);
  }
}

function describeResponseMatcher(matcher: ResponseMatcher): string {
  if (typeof matcher === "string") return JSON.stringify(matcher);
  if (matcher instanceof RegExp) return matcher.toString();
  return "a response predicate";
}

function snapshotSettleOptions(
  settle: PageSnapshotOptions["settle"],
): PageSettleOptions | undefined {
  if (settle === undefined || settle === false) return undefined;
  if (settle === true) return {};
  validatePublicApiOptions("Page.waitForSettled", settle);
  return settle;
}

function pageSnapshotOptionsError(message: string): TypeError {
  const signature = publicApiEntry("Page.snapshot")?.signature;
  return new TypeError(`${message}. Expected: ${signature}`);
}

function snapshotSourceHeader(input: {
  currentLabel: string;
  currentTargetId: string;
  ledger: PageLedger;
  pageBudget: number;
  spaceId: number;
  spaceName: string;
  tabs: RuntimeTab[];
}): string {
  const tabsByTarget = new Map(input.tabs.map((tab) => [tab.targetId, tab]));
  const managedTargets = new Set(
    Object.values(input.ledger.pages).map((page) => page.targetId),
  );
  const current = tabsByTarget.get(input.currentTargetId);
  const currentTitle = compactPageTitle(
    current?.title || current?.url || "untitled",
  );
  const pages = Object.entries(input.ledger.pages).map(([label, page]) => {
    const tab = tabsByTarget.get(page.targetId);
    const title = compactPageTitle(tab?.title || tab?.url || "untitled");
    return `${label}${page.targetId === input.currentTargetId ? "*" : ""} ${JSON.stringify(title)}`;
  });
  const untracked = input.tabs.filter(
    (tab) => !managedTargets.has(tab.targetId),
  ).length;
  const managed = pages.length;
  const budget =
    managed >= input.pageBudget - 1
      ? ` | budget ${managed}/${input.pageBudget}`
      : "";
  const inventory = pages.length > 0 ? ` — ${pages.join(", ")}` : "";
  return `[${input.currentLabel} ${JSON.stringify(currentTitle)} | space ${JSON.stringify(input.spaceName)}(${input.spaceId}): ${managed} managed, ${untracked} untracked${inventory}${budget}]`;
}

async function evaluateInSession<T>(
  services: PageModelServices,
  sessionId: string,
  expression: string | ((argument: any) => T | Promise<T>),
  hasArgument: boolean,
  serializedArgument?: unknown,
  timeoutMs?: number,
  executionTimeoutMs?: number,
): Promise<T> {
  const startedAt = services.now();
  if (typeof expression === "string") {
    let response;
    try {
      response = await services.cdp(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
          ...(executionTimeoutMs === undefined
            ? {}
            : { timeout: executionTimeoutMs }),
        },
        sessionId,
        timeoutMs,
      );
    } catch (error) {
      throw normalizeProtocolExecutionTimeout(
        error,
        services.now() - startedAt,
        executionTimeoutMs,
      );
    }
    return runtimeValue(response, expression) as T;
  }

  const source = expression.toString();
  let response;
  try {
    response = await services.cdp(
      "Runtime.evaluate",
      {
        expression: `(async function __egoPageEvaluate() {
        return await ${pageFunctionCallExpression(
          source,
          hasArgument,
          serializedArgument,
        )};
      })()`,
        returnByValue: true,
        awaitPromise: true,
        ...(executionTimeoutMs === undefined
          ? {}
          : { timeout: executionTimeoutMs }),
      },
      sessionId,
      timeoutMs,
    );
  } catch (error) {
    throw normalizeProtocolExecutionTimeout(
      error,
      services.now() - startedAt,
      executionTimeoutMs,
    );
  }
  return runtimeValue(response, source) as T;
}

function validateEvaluateInput(
  apiName: string,
  expression: unknown,
  hasArgument: boolean,
  argument: unknown,
): unknown {
  if (typeof expression !== "string" && typeof expression !== "function") {
    throw new TypeError(`${apiName} expects a function or string expression`);
  }
  if (typeof expression === "string") {
    if (expression.length === 0) {
      throw new TypeError(`${apiName} expression must not be empty`);
    }
    if (hasArgument) {
      throw new TypeError(
        `${apiName} string expression does not accept an argument`,
      );
    }
    return undefined;
  }
  return hasArgument ? serializeEvaluateArgument(apiName, argument) : undefined;
}

function serializeEvaluateArgument(
  apiName: string,
  argument: unknown,
): unknown {
  return serializeJsonValue(
    argument,
    `${apiName} argument must be JSON-serializable`,
  );
}

function waitForFunctionExpression(
  expression: string | ((argument: any) => unknown | Promise<unknown>),
  hasArgument: boolean,
  serializedArgument: unknown,
): string {
  if (typeof expression === "string") {
    return `(async function __egoWaitForFunction() { return { matched: Boolean(await (${expression})), url: location.href, title: document.title }; })()`;
  }
  const source = expression.toString();
  return `(async function __egoWaitForFunction() { return { matched: Boolean(await ${pageFunctionCallExpression(
    source,
    hasArgument,
    serializedArgument,
  )}), url: location.href, title: document.title }; })()`;
}

function pageFunctionCallExpression(
  source: string,
  hasArgument: boolean,
  serializedArgument: unknown,
): string {
  if (!hasArgument) return `(${source})()`;
  const json = JSON.stringify(serializedArgument);
  return `(${source})(JSON.parse(${JSON.stringify(json)}))`;
}

function isWaitForFunctionState(
  value: unknown,
): value is { matched: boolean; url: string; title: string } {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.matched === "boolean" &&
    typeof state.url === "string" &&
    typeof state.title === "string"
  );
}

function waitForFunctionTimeoutError(
  spaceId: number,
  pageLabel: string,
  timeoutMs: number,
  lastUrl: string,
  lastTitle: string,
): Error {
  const title = lastTitle
    ? `; last title was ${JSON.stringify(lastTitle)}`
    : "";
  const popup = peekUnhandledPageNotices().find(
    (notice) => notice.spaceId === spaceId && notice.openerLabel === pageLabel,
  );
  const popupHint = popup
    ? ` Popup ${popup.label} opened from ${pageLabel} at ${JSON.stringify(popup.url)}; inspect task.page(${JSON.stringify(popup.label)}) before retrying the preceding action.`
    : "";
  return new Error(
    `page.waitForFunction timed out after ${timeoutMs}ms on page ${pageLabel}; last URL was ${JSON.stringify(lastUrl)}${title}.${popupHint}`,
  );
}

function isRetryablePageEvaluationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("Execution context was destroyed") ||
    error.message.includes("Cannot find context with specified id") ||
    error.message.includes("Inspected target navigated")
  );
}

function isRuntimeEvaluateTransportTimeout(error: unknown): boolean {
  return (
    (isCdpRequestTimeoutError(error) && error.method === "Runtime.evaluate") ||
    (error instanceof Error &&
      error.message.includes("CDP request timed out: Runtime.evaluate"))
  );
}

function isEvaluationExecutionDeadlineError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: string }).code === "EGO_PAGE_EXECUTION_DEADLINE"
  );
}

function isProtocolExecutionTimeout(
  error: unknown,
  elapsedMs?: number,
  timeoutMs?: number,
): boolean {
  return (
    error instanceof Error &&
    (/Execution was terminated|Script execution timed out/i.test(
      error.message,
    ) ||
      (error.message === "Internal error" &&
        timeoutMs !== undefined &&
        elapsedMs !== undefined &&
        elapsedMs >= timeoutMs - 100))
  );
}

function normalizeProtocolExecutionTimeout(
  error: unknown,
  elapsedMs: number,
  timeoutMs?: number,
): unknown {
  if (!isProtocolExecutionTimeout(error, elapsedMs, timeoutMs)) return error;
  if (error instanceof Error) {
    (error as Error & { code?: string }).code = "EGO_PAGE_EXECUTION_DEADLINE";
  }
  return error;
}

function evaluationExecutionDeadlineError(
  apiName: string,
  timeoutMs: number,
): PageEvaluationTimeoutError {
  return new PageEvaluationTimeoutError(
    `${apiName} exceeded its ${timeoutMs}ms page-execution safety limit. The current JavaScript execution was stopped and the Page is ready for another command, but work scheduled earlier may still produce late side effects.`,
    {
      timeoutMs,
      executionStopped: true,
      mayHaveLateEffects: true,
      pageResponsive: true,
    },
  );
}

async function recoverPageEvaluationTimeout(
  services: PageModelServices,
  sessionId: string,
  apiName: string,
  timeoutMs: number,
): Promise<PageEvaluationTimeoutError> {
  if (await pageEvaluationHealthProbe(services, sessionId)) {
    return new PageEvaluationTimeoutError(
      `${apiName} timed out after ${timeoutMs}ms while waiting for page JavaScript. The Page is responsive, but the evaluation is still pending and may produce late side effects. Reload or close the Page when that would be unsafe.`,
      {
        timeoutMs,
        executionStopped: false,
        mayHaveLateEffects: true,
        pageResponsive: true,
      },
    );
  }

  let terminationSent = false;
  try {
    await services.cdp(
      "Runtime.terminateExecution",
      {},
      sessionId,
      PAGE_EVALUATE_TERMINATE_TIMEOUT_MS,
    );
    terminationSent = true;
  } catch (error) {
    if (!isCdpRequestTimeoutError(error)) throw error;
  }

  if (
    terminationSent &&
    (await pageEvaluationHealthProbe(services, sessionId))
  ) {
    return new PageEvaluationTimeoutError(
      `${apiName} timed out after ${timeoutMs}ms and the renderer stopped responding. The current execution was stopped and the Page recovered, but work scheduled earlier may still produce late side effects.`,
      {
        timeoutMs,
        executionStopped: true,
        mayHaveLateEffects: true,
        pageResponsive: true,
      },
    );
  }

  return new PageEvaluationTimeoutError(
    `${apiName} timed out after ${timeoutMs}ms and the Page is still unresponsive. Execution could not be confirmed stopped; reload or close the Page before continuing.`,
    {
      timeoutMs,
      executionStopped: false,
      mayHaveLateEffects: true,
      pageResponsive: false,
    },
  );
}

async function pageEvaluationHealthProbe(
  services: PageModelServices,
  sessionId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const startedAt = services.now();
    try {
      const response = await services.cdp(
        "Runtime.evaluate",
        {
          expression: "1",
          returnByValue: true,
          awaitPromise: false,
          timeout: PAGE_EVALUATE_HEALTH_EXECUTION_TIMEOUT_MS,
        },
        sessionId,
        PAGE_EVALUATE_HEALTH_TIMEOUT_MS,
      );
      return response?.result?.value === 1;
    } catch (error) {
      if (isRuntimeEvaluateTransportTimeout(error)) return false;
      if (
        attempt === 0 &&
        isProtocolExecutionTimeout(
          error,
          services.now() - startedAt,
          PAGE_EVALUATE_HEALTH_EXECUTION_TIMEOUT_MS,
        )
      ) {
        // Runtime.terminateExecution may consume the next evaluation rather
        // than the original one. Probe once more before declaring the Page bad.
        continue;
      }
      throw error;
    }
  }
  return false;
}

function enrichPageCallbackReferenceError(
  error: unknown,
  apiName: string,
): unknown {
  if (
    !(error instanceof Error) ||
    !/\bReferenceError: .* is not defined/.test(error.message) ||
    error.message.includes("cannot access variables from the Node.js script")
  ) {
    return error;
  }
  error.message +=
    `\n${apiName}() callbacks run inside the Page and cannot access variables ` +
    "from the Node.js script. Define the value inside the callback or pass " +
    "JSON data as the second argument.";
  return error;
}

function serializeJsonValue(value: unknown, message: string): unknown {
  try {
    const json = JSON.stringify(value, (_key, item) => {
      if (
        typeof item === "bigint" ||
        (typeof item === "number" && !Number.isFinite(item))
      ) {
        throw new TypeError("unsupported value");
      }
      return item;
    });
    if (json === undefined) throw new TypeError("unsupported value");
    return JSON.parse(json);
  } catch (error) {
    throw new TypeError(message, { cause: error });
  }
}

// The script does not run in the caller's shell working directory: the host
// starts the Node context from the application's own directory, which is not
// writable on Windows. Reject relative paths up front instead of surfacing a
// confusing EPERM from that directory.
function assertAbsoluteFilePath(path: unknown, label: string): void {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new TypeError(`${label} must be an absolute file path`);
  }
}

function pageFetchPayload(
  url: string,
  options: PageFetchOptions,
): { payload: PageFetchPayload; saveAs?: string } {
  validatePublicApiOptions("Page.fetch", options);
  const { timeout = 20_000, saveAs, ...requestOptions } = options;
  if (saveAs !== undefined) {
    assertAbsoluteFilePath(saveAs, "page.fetch saveAs");
  }
  return {
    payload: {
      url,
      options: serializeJsonValue(
        requestOptions,
        "page.fetch options must be JSON-serializable",
      ) as Record<string, unknown>,
      timeoutMs: timeout,
      responseType: saveAs ? "base64" : "text",
    },
    ...(saveAs ? { saveAs } : {}),
  };
}

async function fetchInPage({
  url,
  options,
  timeoutMs,
  responseType,
}: PageFetchPayload): Promise<PageFetchResult> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await window.fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const metadata = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers,
    };
    if (responseType === "text") {
      return { ...metadata, body: await response.text() };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return { ...metadata, bodyBase64: btoa(binary) } as PageFetchResult;
  } catch (error) {
    if (controller.signal.aborted) {
      return { fetchError: `page.fetch timed out after ${timeoutMs}ms` };
    }
    let requestUrl = url;
    try {
      requestUrl = new URL(url, window.location.href).href;
    } catch {
      // Keep the caller's URL when it cannot be resolved in the Page.
    }
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    return {
      fetchError:
        `page.fetch uses window.fetch and obeys browser CORS. ` +
        `Request ${JSON.stringify(requestUrl)} from ${JSON.stringify(window.location.origin)} failed: ${detail}`,
    };
  } finally {
    window.clearTimeout(timer);
  }
}

function looksLikeWaitForFunctionOptions(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.every((key) => key === "timeout" || key === "polling")
  );
}

function isNoJavaScriptDialogError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /no (?:javascript )?dialog (?:is showing|is open|to handle)/i.test(
    error.message,
  );
}

function validateSelectOptionChoice(
  choice: PageSelectOption,
  index: number,
): void {
  const path = `page.selectOption valueOrValues[${index}]`;
  if (typeof choice === "string") return;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    throw new TypeError(
      `${path} must be a string or an object with value, label, or index`,
    );
  }
  const keys = Object.keys(choice);
  const unknown = keys.find(
    (key) => key !== "value" && key !== "label" && key !== "index",
  );
  if (unknown) {
    throw new TypeError(`${path} has unknown field ${JSON.stringify(unknown)}`);
  }
  if (
    choice.value === undefined &&
    choice.label === undefined &&
    choice.index === undefined
  ) {
    throw new TypeError(`${path} must specify value, label, or index`);
  }
  if (choice.value !== undefined && typeof choice.value !== "string") {
    throw new TypeError(`${path}.value must be a string`);
  }
  if (choice.label !== undefined && typeof choice.label !== "string") {
    throw new TypeError(`${path}.label must be a string`);
  }
  if (
    choice.index !== undefined &&
    (!Number.isInteger(choice.index) || choice.index < 0)
  ) {
    throw new TypeError(`${path}.index must be a non-negative integer`);
  }
}

function assertUrl(url: string): void {
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError("page URL must be a non-empty string");
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function unhandledFileChooserError(): Error & { code: string } {
  const error = new Error(
    "This action opened a file chooser, which was cancelled before the system dialog appeared. " +
      "Use page.setInputFiles() for an existing file input, or call " +
      "page.waitForFileChooser() before the action when the input is created dynamically.",
  ) as Error & { code: string };
  error.code = "EGO_FILE_CHOOSER_OPENED";
  return error;
}

function matchingPopupWaitError(
  spaceId: number,
  openerLabel: string,
  lastUrl: string,
  matches: (url: string) => boolean,
): (Error & { code: string }) | undefined {
  const popup = peekUnhandledPageNotices().find(
    (notice) =>
      notice.spaceId === spaceId &&
      notice.openerLabel === openerLabel &&
      typeof notice.url === "string" &&
      matches(notice.url),
  );
  if (!popup) return undefined;

  const error = new Error(
    `page ${openerLabel} did not navigate from ${JSON.stringify(lastUrl)}, ` +
      `but popup ${popup.label} opened from it at ${JSON.stringify(popup.url)}. ` +
      `The triggering action already succeeded; do not repeat it. Continue with ` +
      `task.page(${JSON.stringify(popup.label)}).`,
  ) as Error & { code: string };
  error.code = "EGO_URL_OPENED_IN_POPUP";
  return error;
}

function assertCdpCall(
  apiName: "Page.cdp" | "TaskSpace.cdp",
  method: string,
  params: Record<string, unknown>,
  options: CdpOptions,
): void {
  if (typeof method !== "string" || method.length === 0) {
    throw new TypeError("cdp method must be a non-empty string");
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new TypeError("cdp params must be an object");
  }
  validatePublicApiOptions(apiName, options);
}

async function waitForTargetToDisappear(
  services: PageModelServices,
  targetId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = services.now() + timeoutMs;
  while (true) {
    const tabs = await services.listTabs();
    if (!tabs.some((tab) => tab.targetId === targetId)) return true;
    const remaining = deadline - services.now();
    if (remaining <= 0) return false;
    await services.sleep(Math.min(PAGE_CLOSE_CONFIRM_INTERVAL_MS, remaining));
  }
}

function tabInventory(
  task: TaskSpace,
  services: PageModelServices,
  ledger: PageLedger,
  tabs: RuntimeTab[],
): TabInventoryItem[] {
  const managedByTarget = new Map(
    Object.entries(ledger.pages).map(([label, entry]) => [
      entry.targetId,
      { label, entry },
    ]),
  );
  return tabs.map((tab) => {
    const managed = managedByTarget.get(tab.targetId);
    if (!managed) {
      const openedBy = ledger.unmanagedTargets[tab.targetId] || "unknown";
      return {
        targetId: tab.targetId,
        page: new UnmanagedPage(
          task,
          tab.targetId,
          openedBy,
          unmanagedPageConstructorToken,
        ),
        title: tab.title || "",
        url: tab.url || "",
        active: Boolean(tab.active),
        openedBy,
      };
    }
    const entry = { label: managed.label, ...managed.entry };
    return {
      targetId: tab.targetId,
      label: managed.label,
      page: new Page(task, managed.label, services, entry),
      title: tab.title || "",
      url: tab.url || "",
      active: Boolean(tab.active),
      openedBy: entry.openedBy,
    };
  });
}

function assertUnmanagedPage(page: unknown): asserts page is UnmanagedPage {
  if (!(page instanceof UnmanagedPage)) {
    throw new TypeError(
      "task.adopt requires an untracked page returned by task.tabs()",
    );
  }
}

function pageBudgetError(
  task: TaskSpace,
  limit: number,
  ledger: PageLedger,
  tabs: RuntimeTab[],
): PageBudgetError {
  const tabsByTarget = new Map(tabs.map((tab) => [tab.targetId, tab]));
  const entries = Object.entries(ledger.pages);
  const lines = entries.map(([label, page]) => {
    const tab = tabsByTarget.get(page.targetId);
    const title = compactPageTitle(tab?.title || tab?.url || "untitled");
    return `  ${label.padEnd(6)} ${JSON.stringify(title)}${tab?.active ? " active" : ""}`;
  });
  const suggestion = entries[0]?.[0] || "p1";
  return new PageBudgetError(
    task.id,
    limit,
    [
      `Page budget reached (${entries.length}/${limit}) in space ${JSON.stringify(task.name)}.`,
      "",
      ...lines,
      "",
      `Close: await task.page('${suggestion}').close()`,
      `Reuse: await task.page('${suggestion}').goto(url)`,
    ].join("\n"),
  );
}

function compactPageTitle(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function configuredPageBudget(): number {
  const configured = Number(process.env.EGO_BROWSER_PAGE_BUDGET || 8);
  return Number.isInteger(configured) && configured > 0 ? configured : 8;
}

function tilePath(path: string, n: number): string {
  const match = /^(.*?)(\.[a-z0-9]+)?$/i.exec(path)!;
  return `${match[1]}-${n}${match[2] || ".png"}`;
}

/** The host or the Page budget refused another Page. */
function isPageCapacityError(error: unknown): boolean {
  const code = (error as { error_code?: unknown })?.error_code;
  return (
    code === "EGO_RESOURCE_LIMIT" ||
    code === "EGO_PAGE_BUDGET_REACHED" ||
    /Page budget reached|Resource limit reached/.test(
      String((error as Error)?.message || ""),
    )
  );
}

/** Mark the focused field (through shadow roots and frames) as a secret. */
function markSecretFieldExpression(name: string): string {
  return `(() => {
    let doc = document;
    let active = doc.activeElement;
    for (let depth = 0; active && depth < 32; depth += 1) {
      if (active.shadowRoot && active.shadowRoot.activeElement) {
        active = active.shadowRoot.activeElement;
      } else if (active.contentDocument && active.contentDocument.activeElement) {
        doc = active.contentDocument;
        active = doc.activeElement;
      } else break;
    }
    if (!active || active === doc.body) return false;
    active.setAttribute(${JSON.stringify(SECRET_FIELD_ATTRIBUTE)}, ${JSON.stringify(name)});
    doc.documentElement.setAttribute(${JSON.stringify(SECRET_DOCUMENT_ATTRIBUTE)}, "");
    document.documentElement.setAttribute(${JSON.stringify(SECRET_DOCUMENT_ATTRIBUTE)}, "");
    return true;
  })()`;
}

/** A selector usable with querySelectorAll in the page, or undefined. */
function cssOnly(selector: string | undefined): string | undefined {
  if (selector === undefined) return undefined;
  if (/^(loc=|xpath=|text=|@|role=|css=)/.test(selector)) {
    return selector.startsWith("css=") ? selector.slice(4) : undefined;
  }
  return selector;
}

/** Runs in the page: scroll the last item (or the window) one step further. */
function scrollStep({ itemSelector }: { itemSelector?: string }): boolean {
  let items: Element[] = [];
  if (itemSelector) {
    try {
      items = Array.from(document.querySelectorAll(itemSelector));
    } catch {
      items = [];
    }
  }
  const last = items[items.length - 1];
  if (last) last.scrollIntoView({ block: "end" });
  window.scrollBy(0, Math.max(200, Math.round(window.innerHeight * 0.9)));
  // Inner scroll containers: move the nearest scrollable ancestor too.
  let node = last?.parentElement || null;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (
      /(auto|scroll)/.test(style.overflowY) &&
      node.scrollHeight > node.clientHeight
    ) {
      node.scrollTop = node.scrollHeight;
      break;
    }
    node = node.parentElement;
  }
  return true;
}

/** A cheap fingerprint of the current document's content. */
async function pageSignature(
  services: PageModelServices,
  sessionId: string,
): Promise<string> {
  return evaluateInSession<string>(
    services,
    sessionId,
    "(() => { const t = document.body ? document.body.innerText : ''; let h = 0; for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) | 0; return location.href + '|' + t.length + '|' + h; })()",
    false,
  );
}

/** Turn PDF bytes into a read() result. */
export function pdfReadResult(
  bytes: Buffer,
  url: string,
  maxChars: number,
): ReadResult {
  const text = extractPdfText(bytes);
  const { markdown, truncated } = truncateMarkdown(pdfMarkdown(text), maxChars);
  let title = text.info.title || "";
  if (!title) {
    try {
      title = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    } catch {
      title = url;
    }
  }
  return {
    url,
    title,
    ...(text.info.author ? { byline: text.info.author } : {}),
    markdown,
    links: [],
    words: countWords(markdown),
    truncated,
    source: "pdf",
    pages: text.pages,
    ...(text.warning ? { warning: text.warning } : {}),
  };
}

/** Learned site tools bound to one Page (page.site(id)). */
class SiteTools {
  readonly #page: Page;
  readonly #siteId: string;
  readonly #workspace: string;

  constructor(page: Page, siteId: string, workspace: string) {
    this.#page = page;
    this.#siteId = siteId;
    this.#workspace = workspace;
  }

  get id(): string {
    return this.#siteId;
  }

  /** The site's tools with their arguments and how to call them. */
  async tools(): Promise<
    Array<{
      name: string;
      kind: "node" | "browser";
      api: number;
      description: string;
      args: Record<string, unknown>;
      returns?: unknown;
    }>
  > {
    const { manifest } = await findSiteSkill(this.#siteId, {
      agentWorkspace: this.#workspace,
    });
    return siteToolList(manifest);
  }

  /** The site's notes (Markdown) as { file, content }. */
  async notes(): Promise<Array<{ file: string; content: string }>> {
    const { siteDir, manifest } = await findSiteSkill(this.#siteId, {
      agentWorkspace: this.#workspace,
    });
    const out: Array<{ file: string; content: string }> = [];
    for (const note of manifest.notes || []) {
      const path = resolvePath(siteDir, note);
      const rel = relative(resolvePath(siteDir), path);
      if (rel.startsWith("..") || isAbsolutePath(rel)) continue;
      try {
        out.push({ file: note, content: await readFile(path, "utf8") });
      } catch {
        // A missing note is reported by validate:site-skills.
      }
    }
    return out;
  }

  /**
   * Run a tool with this Page. Node tools must declare "api": 2 and receive
   * (page, args); browser tools run inside this Page.
   */
  async run(toolName: string, args: Record<string, unknown> = {}) {
    if (typeof toolName !== "string" || !toolName) {
      throw new TypeError("site(id).run(name, args) requires a tool name");
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new TypeError("site(id).run args must be an object");
    }
    const { siteDir, manifest } = await findSiteSkill(this.#siteId, {
      agentWorkspace: this.#workspace,
    });
    const nodeTool = (manifest.nodeTools || {})[toolName] as any;
    if (nodeTool) {
      if (nodeTool.api !== 2) {
        throw attachHint(
          new Error(
            `site tool ${this.#siteId}/${toolName} uses the v1 helper API and cannot run with a Page`,
          ),
          `Run it with await runSiteTool(${JSON.stringify(this.#siteId)}, ${JSON.stringify(toolName)}, args) in a v1 script, or port it to "api": 2.`,
        );
      }
      const path = resolvePath(siteDir, nodeTool.path);
      const rel = relative(resolvePath(siteDir), path);
      if (rel.startsWith("..") || isAbsolutePath(rel)) {
        throw new Error("site tool path must stay inside the site skill");
      }
      const module = await import(
        `${pathToFileURL(path).href}?t=${Date.now()}`
      );
      const tool = module[nodeTool.callable];
      if (typeof tool !== "function") {
        throw new Error(
          `site skill ${JSON.stringify(this.#siteId)} is missing Node callable ${JSON.stringify(nodeTool.callable)}`,
        );
      }
      return tool(this.#page, args);
    }
    if ((manifest.browserTools || {})[toolName]) {
      const source = await loadBrowserToolSource(this.#siteId, toolName, {
        agentWorkspace: this.#workspace,
      });
      return this.#page.evaluate(wrapBrowserTool(source, args));
    }
    const names = siteToolList(manifest).map((tool) => tool.name);
    throw attachHint(
      new Error(
        `site ${JSON.stringify(this.#siteId)} has no tool ${JSON.stringify(toolName)}; tools: ${names.join(", ") || "none"}`,
      ),
      `List them with await page.site(${JSON.stringify(this.#siteId)}).tools().`,
    );
  }
}

/** A manifest's tools as a flat list. */
export function siteToolList(manifest: any): Array<{
  name: string;
  kind: "node" | "browser";
  api: number;
  description: string;
  args: Record<string, unknown>;
  returns?: unknown;
}> {
  const out: Array<{
    name: string;
    kind: "node" | "browser";
    api: number;
    description: string;
    args: Record<string, unknown>;
    returns?: unknown;
  }> = [];
  for (const [name, schema] of Object.entries<any>(manifest?.nodeTools || {})) {
    out.push({
      name,
      kind: "node",
      api: schema?.api === 2 ? 2 : 1,
      description: schema?.description || "",
      args: schema?.args || {},
      ...(schema?.returns ? { returns: schema.returns } : {}),
    });
  }
  for (const [name, schema] of Object.entries<any>(
    manifest?.browserTools || {},
  )) {
    out.push({
      name,
      kind: "browser",
      api: 2,
      description: schema?.description || "",
      args: schema?.args || {},
      ...(schema?.returns ? { returns: schema.returns } : {}),
    });
  }
  return out;
}

/**
 * Page actions reported to the host's round log (ego.logEvent), when the host
 * offers one: action name, Page label, target, duration, outcome and error
 * code. Never typed values, page content, or URL paths (only the origin).
 */
const LOGGED_PAGE_ACTIONS = [
  "goto",
  "reload",
  "click",
  "dblclick",
  "hover",
  "dragAndDrop",
  "fill",
  "fillSecret",
  "selectOption",
  "focus",
  "press",
  "setInputFiles",
  "screenshot",
  "snapshot",
  "close",
  "read",
  "tables",
  "structuredData",
  "search",
  "dismissConsent",
  "scrollToLoad",
  "fetch",
  "waitForSelector",
  "waitForSettled",
] as const;

const SELECTOR_ACTIONS = new Set([
  "fillSecret",
  "click",
  "dblclick",
  "hover",
  "fill",
  "selectOption",
  "focus",
  "press",
  "setInputFiles",
  "waitForSelector",
]);

/** What the round log may say about an action's target. */
export function logTarget(action: string, args: unknown[]): string | undefined {
  const first = args[0];
  if (action === "goto" || action === "fetch") {
    if (typeof first !== "string") return undefined;
    try {
      return new URL(first).origin;
    } catch {
      return undefined;
    }
  }
  if (action === "search") {
    const options = args[1] as { engine?: string } | undefined;
    return options?.engine ?? "auto";
  }
  if (action === "dragAndDrop") {
    return [args[0], args[1]]
      .filter((value) => typeof value === "string")
      .join(" -> ")
      .slice(0, 200);
  }
  if (SELECTOR_ACTIONS.has(action) && typeof first === "string") {
    return first.slice(0, 200);
  }
  return undefined;
}

for (const action of LOGGED_PAGE_ACTIONS) {
  const original = (Page.prototype as any)[action];
  if (typeof original !== "function") continue;
  Object.defineProperty(Page.prototype, action, {
    configurable: true,
    writable: true,
    value: async function loggedPageAction(this: Page, ...args: unknown[]) {
      const services = pageServices.get(this);
      if (!services || !services.hostCapabilities().logEvent) {
        return original.apply(this, args);
      }
      const startedAt = services.now();
      const entry = (ok: boolean, error?: unknown) => {
        const code = (error as { error_code?: unknown })?.error_code;
        const target = logTarget(action, args);
        services.logEvent({
          page: this.label,
          action: `page.${action}`,
          ...(target === undefined ? {} : { target }),
          ms: Math.max(0, services.now() - startedAt),
          ok,
          ...(typeof code === "string" ? { error_code: code } : {}),
        });
      };
      try {
        const result = await original.apply(this, args);
        entry(true);
        return result;
      } catch (error) {
        entry(false, error);
        throw error;
      }
    },
  });
}
