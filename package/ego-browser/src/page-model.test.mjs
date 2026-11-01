import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { NativeOperationGate } from "../dist/src/native-gate.js";
import { CdpRequestTimeoutError } from "../dist/src/browser-runtime.js";
import { decodePng, encodePng } from "../dist/src/png-stitch.js";
import { PageLedgerStore } from "../dist/src/page-ledger.js";
import {
  captureTaskSpaceUserBoundary,
  createTaskSpaceHandle,
  initializeTaskSpaceHandle,
} from "../dist/src/page-model.js";
import { PageRefRegistry } from "../dist/src/page-ref-registry.js";
import {
  consumeUnhandledPageNotices,
  resetPageNotices,
} from "../dist/src/page-discovery.js";

async function withFixture(fn) {
  const rootDir = await mkdtemp(join(tmpdir(), "ego-page-model-test-"));
  try {
    return await fn(createFixture(rootDir));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

function createFixture(rootDir) {
  const calls = [];
  const tabs = new Map();
  let nextTarget = 1;
  let selectedSpace = null;
  let activeTarget = null;
  let popupOnNextClick = null;
  let fileChooserOnNextClick = null;
  let activeFileChooserWaiter = null;
  let systemFileChooserOpened = false;
  let timeoutNextMouseDispatch = false;
  let loseSessionOnNextMouseRelease = false;
  let loseFrameOnNextResolution = null;
  let dialogOnNextClick = null;
  let dialogOnNextFileSet = null;
  const pendingDialogs = new Map();
  let rejectedClickPointsRemaining = 0;
  let interceptedClickPointsRemaining = 0;
  let scrollClickPointsRemaining = 0;
  let fillElementKind = "input";
  let fillText = "";
  let fillTransform = null;
  let fillInsertionCount = 0;
  let ignoredFillInsertionsRemaining = 0;
  let focusResult = { focused: true };
  let unsafeFillActivationTarget = null;
  let selectedValues = [];
  let selectOptions = [
    { value: "nl", label: "Netherlands" },
    { value: "one", label: "One" },
    { value: "two", label: "Two" },
  ];
  let navigateOnNextClickUrl = null;
  let elementPresent = true;
  let elementVisible = true;
  let documentReadyState = "complete";
  let domContentLoaded = true;
  let timeoutNextLifecycleEvaluate = false;
  let timeoutNextUrlEvaluate = false;
  let waitFunctionResults = [];
  let fetchFailure = null;
  let nowMs = 1_000;
  const pageEvents = new Map();
  const networkSessions = new Set();
  const networkRequests = new Map();
  const networkLastActivityAt = new Map();
  const sessionOverrides = new Map();
  const sessionTargets = new Map();
  const snapshotOptions = [];
  const browserEventListeners = new Set();
  const sleepDurations = [];

  function openPendingPopup() {
    if (!popupOnNextClick) return;
    const targetId = `target-${nextTarget++}`;
    tabs.set(targetId, {
      targetId,
      url: popupOnNextClick,
      title: "Popup",
      active: false,
    });
    popupOnNextClick = null;
  }
  async function ensureTargetSession(targetId) {
    assert(tabs.has(targetId), `unknown target ${targetId}`);
    calls.push(["ensureSession", targetId]);
    const sessionId = sessionOverrides.get(targetId) || `session:${targetId}`;
    sessionTargets.set(sessionId, targetId);
    return sessionId;
  }
  function targetForSession(sessionId) {
    return sessionTargets.get(sessionId) || sessionId?.slice("session:".length);
  }
  const gate = new NativeOperationGate({
    async selectSpace(spaceId) {
      selectedSpace = spaceId;
      calls.push(["selectSpace", spaceId]);
    },
    ensureSession: ensureTargetSession,
  });
  const services = {
    gate,
    pageRefs: new PageRefRegistry(),
    async createTab(url) {
      assert.equal(selectedSpace, 7);
      const targetId = `target-${nextTarget++}`;
      tabs.set(targetId, { targetId, url, title: url, active: true });
      activeTarget = targetId;
      calls.push(["createTab", url, targetId]);
      return targetId;
    },
    async listTabs() {
      assert.equal(selectedSpace, 7);
      return [...tabs.values()].map((tab) => ({
        ...tab,
        active: tab.targetId === activeTarget,
      }));
    },
    async cdp(method, params, sessionId, timeoutMs) {
      const call = ["cdp", method, params, sessionId];
      if (timeoutMs !== undefined) call.push(timeoutMs);
      calls.push(call);
      if (method === "Page.getFrameTree")
        return {
          frameTree: {
            frame: { id: "frame-1", loaderId: "main-document" },
            childFrames: ["frame-same", "frame-oopif", "frame-child"].map(
              (id) => ({
                frame: { id, loaderId: `document:${id}` },
              }),
            ),
          },
        };
      if (method === "Page.navigate") {
        const targetId = targetForSession(sessionId);
        tabs.get(targetId).url = params.url;
        tabs.get(targetId).title = params.url;
        return { frameId: "frame-1" };
      }
      if (method === "Runtime.evaluate") {
        if (loseFrameOnNextResolution) {
          const failure = loseFrameOnNextResolution;
          loseFrameOnNextResolution = null;
          const error = new Error(failure.message);
          if (failure.sessionId) error.sessionId = failure.sessionId;
          throw error;
        }
        const targetId = targetForSession(sessionId);
        const tab = tabs.get(targetId);
        if (params.expression.includes("__egoPageEvaluate")) {
          if (params.expression.includes("missingClosureForE2E")) {
            return {
              result: {
                type: "object",
                subtype: "error",
                description:
                  "ReferenceError: missingClosureForE2E is not defined",
              },
              exceptionDetails: {
                text: "Uncaught",
                lineNumber: 0,
                columnNumber: 0,
              },
            };
          }
          const match = /JSON\.parse\(("(?:\\.|[^"\\])*")\)/.exec(
            params.expression,
          );
          const argument = match ? JSON.parse(JSON.parse(match[1])) : undefined;
          if (params.expression.includes("window.fetch")) {
            if (fetchFailure) {
              const message = fetchFailure;
              fetchFailure = null;
              return {
                result: {
                  type: "object",
                  value: { fetchError: message },
                },
              };
            }
            const binary = argument?.responseType === "base64";
            return {
              result: {
                type: "object",
                value: {
                  ok: false,
                  status: 418,
                  statusText: "I'm a Teapot",
                  url: "https://example.test/api/teapot",
                  headers: {
                    "content-type": "text/plain",
                    "x-fixture": "page-fetch",
                  },
                  ...(binary
                    ? {
                        bodyBase64:
                          Buffer.from("\x89PNG\r\n\x1a\n").toString("base64"),
                      }
                    : { body: "short and stout" }),
                },
              },
            };
          }
          return {
            result: {
              type: "object",
              value: argument ?? null,
            },
          };
        }
        if (params.expression.includes("__egoActionableMatches")) {
          return params.returnByValue === false
            ? {
                result: {
                  type: "object",
                  objectId: elementVisible ? `element:${targetId}` : undefined,
                },
              }
            : { result: { type: "number", value: elementVisible ? 1 : 0 } };
        }
        if (params.expression.includes("__egoWaitForFunction")) {
          return {
            result: {
              type: "object",
              value: {
                matched: waitFunctionResults.shift() ?? false,
                url: tab.url,
                title: tab.title,
              },
            },
          };
        }
        if (
          timeoutNextLifecycleEvaluate &&
          (params.expression === "document.readyState" ||
            params.expression.includes("domContentLoadedEventEnd"))
        ) {
          timeoutNextLifecycleEvaluate = false;
          nowMs += timeoutMs ?? 0;
          throw new Error("CDP request timed out: Runtime.evaluate");
        }
        if (params.expression === "globalThis") {
          return {
            result: {
              type: "object",
              objectId: `global:${targetId}`,
            },
          };
        }
        if (params.expression === "location.href") {
          if (timeoutNextUrlEvaluate) {
            timeoutNextUrlEvaluate = false;
            nowMs += timeoutMs ?? 0;
            throw new Error("CDP request timed out: Runtime.evaluate");
          }
          return { result: { type: "string", value: tab.url } };
        }
        if (params.expression === "document.title") {
          return { result: { type: "string", value: tab.title } };
        }
        if (params.expression === "document.readyState") {
          return { result: { type: "string", value: documentReadyState } };
        }
        if (params.expression.includes("domContentLoadedEventEnd")) {
          return {
            result: {
              type: "object",
              value: {
                readyState: documentReadyState,
                domContentLoaded,
              },
            },
          };
        }
        if (params.expression.includes("performance.timeOrigin")) {
          return {
            result: {
              type: "object",
              value: {
                readyState: "complete",
                url: tab.url,
                timeOrigin: Date.now() + 1_000,
              },
            },
          };
        }
        if (params.expression.includes("__egoNavigationState")) {
          return {
            result: {
              type: "object",
              value: {
                url: tab.url,
                readyState: documentReadyState,
              },
            },
          };
        }
        if (
          /return __egoQueryAllOpenShadow\([^;]+\)\.length;/.test(
            params.expression,
          )
        ) {
          return {
            result: { type: "number", value: elementPresent ? 1 : 0 },
          };
        }
        if (params.expression.includes("ORDERED_NODE_SNAPSHOT_TYPE")) {
          return {
            result: { type: "number", value: elementPresent ? 1 : 0 },
          };
        }
        if (params.expression.includes("innerWidth")) {
          return {
            result: {
              type: "object",
              value: {
                url: tab.url,
                title: tab.title,
                w: targetId === "target-1" ? 801 : 802,
                h: 600,
                sx: 0,
                sy: 0,
                pw: 1200,
                ph: 900,
              },
            },
          };
        }
        if (params.returnByValue === false) {
          if (!elementPresent) {
            return { result: { type: "undefined" } };
          }
          return {
            result: {
              type: "object",
              objectId: `element:${targetId}`,
            },
          };
        }
        return { result: { type: "string", value: "complete" } };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration.includes("missingClosureForE2E")) {
          return {
            result: {
              type: "object",
              subtype: "error",
              description:
                "ReferenceError: missingClosureForE2E is not defined",
            },
            exceptionDetails: {
              text: "Uncaught",
              lineNumber: 0,
              columnNumber: 0,
            },
          };
        }
        if (params.functionDeclaration.includes("focusElementForAction")) {
          return {
            result: { type: "object", value: focusResult },
          };
        }
        if (params.functionDeclaration.includes("safeFillActivationTarget")) {
          return {
            result: {
              type: "object",
              value: unsafeFillActivationTarget
                ? { error: unsafeFillActivationTarget }
                : { safe: true },
            },
          };
        }
        if (params.functionDeclaration.includes("resolveFileInputForUpload")) {
          const targetId = targetForSession(sessionId);
          return {
            result: {
              type: "object",
              objectId: `file-input:${targetId}`,
            },
          };
        }
        if (params.functionDeclaration.includes("resolveFillTargetForAction")) {
          const targetId = targetForSession(sessionId);
          return {
            result: {
              type: "object",
              objectId: `element:${targetId}`,
            },
          };
        }
        if (params.functionDeclaration.includes("fillPreparation")) {
          return {
            result: {
              type: "object",
              value: {
                status: "needsinput",
                kind: fillElementKind,
                cursorPoint: { x: 40, y: 60 },
                before: fillText,
              },
            },
          };
        }
        if (params.functionDeclaration.includes("selectOptionsForAction")) {
          const choices = params.arguments?.[0]?.value ?? [];
          selectedValues = choices.map((choice) => {
            const option =
              typeof choice === "string"
                ? selectOptions.find(
                    (candidate) =>
                      candidate.value === choice || candidate.label === choice,
                  )
                : selectOptions.find(
                    (candidate, index) =>
                      (choice.value === undefined ||
                        candidate.value === choice.value) &&
                      (choice.label === undefined ||
                        candidate.label === choice.label) &&
                      (choice.index === undefined || index === choice.index),
                  );
            return option?.value;
          });
          return {
            result: { type: "object", value: { selected: selectedValues } },
          };
        }
        if (params.functionDeclaration.includes("readFilledValue")) {
          return {
            result: {
              type: "object",
              value: {
                actual: fillText,
                type: fillElementKind === "input" ? "text" : "",
              },
            },
          };
        }
        if (params.functionDeclaration.includes("checkVisibility")) {
          return { result: { type: "boolean", value: elementVisible } };
        }
        if (params.functionDeclaration.includes("window.scrollBy")) {
          return {
            result: {
              type: "object",
              value: {
                x: params.arguments?.[0]?.value?.deltaX ?? 0,
                y: params.arguments?.[0]?.value?.deltaY ?? 0,
              },
            },
          };
        }
        if (params.functionDeclaration.includes("window.fetch")) {
          if (fetchFailure) {
            const message = fetchFailure;
            fetchFailure = null;
            return {
              result: {
                type: "object",
                value: { fetchError: message },
              },
            };
          }
          const binary =
            params.arguments?.[0]?.value?.responseType === "base64";
          return {
            result: {
              type: "object",
              value: {
                ok: false,
                status: 418,
                statusText: "I'm a Teapot",
                url: "https://example.test/api/teapot",
                headers: {
                  "content-type": "text/plain",
                  "x-fixture": "page-fetch",
                },
                ...(binary
                  ? {
                      bodyBase64:
                        Buffer.from("\x89PNG\r\n\x1a\n").toString("base64"),
                    }
                  : { body: "short and stout" }),
              },
            },
          };
        }
        if (params.functionDeclaration.includes("getBoundingClientRect")) {
          if (scrollClickPointsRemaining > 0) {
            scrollClickPointsRemaining -= 1;
            return {
              result: {
                type: "object",
                value: {
                  scroll: { x: 80, y: 300, deltaX: 0, deltaY: 600 },
                },
              },
            };
          }
          if (
            interceptedClickPointsRemaining > 0 &&
            params.functionDeclaration.includes("elementFromPoint")
          ) {
            interceptedClickPointsRemaining -= 1;
            return {
              result: {
                type: "object",
                value: {
                  error: '<button id="overlay"> intercepts pointer events',
                },
              },
            };
          }
          if (rejectedClickPointsRemaining > 0) {
            rejectedClickPointsRemaining -= 1;
            return {
              result: {
                type: "object",
                value: { error: "element is not visible in the viewport" },
              },
            };
          }
          return {
            result: { type: "object", value: { x: 40, y: 60 } },
          };
        }
        if (params.functionDeclaration.includes("const probe = { seen")) {
          return { result: { type: "boolean", value: true } };
        }
        if (params.functionDeclaration.includes("target.dispatchEvent")) {
          openPendingPopup();
          return {
            result: {
              type: "object",
              value: { seen: false, fallback: true },
            },
          };
        }
        return {
          result: {
            type: "object",
            value: params.arguments?.[0]?.value ?? null,
          },
        };
      }
      if (method === "DOM.resolveNode") {
        const targetId = targetForSession(sessionId);
        return {
          object: {
            type: "object",
            objectId: `element:${targetId}:${params.backendNodeId}`,
          },
        };
      }
      if (method === "Runtime.releaseObject") return {};
      if (method === "Input.insertText") {
        if (ignoredFillInsertionsRemaining > 0) {
          ignoredFillInsertionsRemaining -= 1;
        } else {
          fillInsertionCount += 1;
          fillText = fillTransform
            ? fillTransform(params.text, fillText, fillInsertionCount)
            : params.text;
        }
        return {};
      }
      if (method === "Input.dispatchKeyEvent") {
        if (params.type === "rawKeyDown" && params.key === "Delete") {
          fillText = "";
        }
        return {};
      }
      if (method === "DOM.setFileInputFiles") {
        if (dialogOnNextFileSet) {
          const dialog = dialogOnNextFileSet;
          dialogOnNextFileSet = null;
          pendingDialogs.set(sessionId, dialog);
          const error = new Error(
            "a JavaScript dialog opened while DOM.setFileInputFiles was running",
          );
          error.code = "EGO_PAGE_DIALOG_OPENED";
          error.dialog = dialog;
          throw error;
        }
        return {};
      }
      if (method === "Network.enable") {
        if (!networkSessions.has(sessionId)) {
          networkRequests.set(sessionId, new Set());
          networkLastActivityAt.set(sessionId, nowMs);
        }
        networkSessions.add(sessionId);
        return {};
      }
      if (method === "Network.disable") {
        networkSessions.delete(sessionId);
        networkRequests.delete(sessionId);
        networkLastActivityAt.delete(sessionId);
        return {};
      }
      if (method === "Browser.getVersion") {
        return { product: "Ego Lite/Test" };
      }
      if (method === "Input.dispatchMouseEvent") {
        if (timeoutNextMouseDispatch) {
          timeoutNextMouseDispatch = false;
          throw new Error("CDP request timed out: Input.dispatchMouseEvent");
        }
        if (params.type === "mouseReleased") {
          if (loseSessionOnNextMouseRelease) {
            loseSessionOnNextMouseRelease = false;
            throw new Error("Session with given id not found");
          }
          if (dialogOnNextClick) {
            const dialog = dialogOnNextClick;
            dialogOnNextClick = null;
            pendingDialogs.set(sessionId, dialog);
            const error = new Error(
              "a JavaScript dialog opened while Input.dispatchMouseEvent was running",
            );
            error.code = "EGO_PAGE_DIALOG_OPENED";
            error.dialog = dialog;
            throw error;
          }
          if (fileChooserOnNextClick) {
            if (activeFileChooserWaiter) {
              activeFileChooserWaiter.emit(fileChooserOnNextClick);
            } else {
              systemFileChooserOpened = true;
            }
            fileChooserOnNextClick = null;
          }
          if (navigateOnNextClickUrl) {
            const targetId = targetForSession(sessionId);
            tabs.get(targetId).url = navigateOnNextClickUrl;
            tabs.get(targetId).title = navigateOnNextClickUrl;
            navigateOnNextClickUrl = null;
          }
          openPendingPopup();
        }
        return {};
      }
      if (method === "Target.activateTarget") {
        activeTarget = params.targetId;
        return { success: true };
      }
      if (method === "Target.setDiscoverTargets") return {};
      if (method === "Page.handleJavaScriptDialog") {
        if (!pendingDialogs.has(sessionId)) {
          throw new Error("No dialog is showing");
        }
        pendingDialogs.delete(sessionId);
        return {};
      }
      if (method === "Target.closeTarget") {
        tabs.delete(params.targetId);
        if (activeTarget === params.targetId) activeTarget = null;
        return { success: true };
      }
      throw new Error(`unexpected CDP method ${method}`);
    },
    async showAgentMousePosition(x, y) {
      calls.push(["showAgentMousePosition", x, y]);
    },
    async withTemporaryClipboardText(text, action) {
      calls.push(["clipboard", "write", text]);
      try {
        return await action();
      } finally {
        calls.push(["clipboard", "restore"]);
      }
    },
    async snapshot(options = {}) {
      const tab = tabs.get(activeTarget);
      snapshotOptions.push({ ...options });
      calls.push(["snapshot", activeTarget]);
      return {
        content: `snapshot:${tab?.url}`,
        refs: [
          {
            backendNodeId: 21,
            role: "button",
            name: "Run action",
          },
        ],
      };
    },
    async screenshot(path, options, sessionId) {
      calls.push(["screenshot", path, options, sessionId]);
      return path || "/tmp/generated-shot.png";
    },
    pendingDialog(sessionId) {
      return pendingDialogs.get(sessionId) || null;
    },
    prepareFileChooser(sessionId, { timeoutMs, cancel }) {
      calls.push(["prepareFileChooser", sessionId, { timeoutMs, cancel }]);
      let observed;
      let resolveEvent;
      let rejectEvent;
      const event = new Promise((resolve, reject) => {
        resolveEvent = resolve;
        rejectEvent = reject;
      });
      const waiter = {
        ready: Promise.resolve(),
        event,
        peek: () => observed,
        emit(value) {
          observed = value;
          resolveEvent(value);
        },
        async dispose(reason) {
          calls.push(["disposeFileChooser", sessionId, reason?.message]);
          if (activeFileChooserWaiter === waiter) {
            activeFileChooserWaiter = null;
          }
          if (!observed && reason) rejectEvent(reason);
        },
      };
      activeFileChooserWaiter = waiter;
      return waiter;
    },
    drainEvents(sessionId) {
      const events = pageEvents.get(sessionId) || [];
      pageEvents.set(sessionId, []);
      return events;
    },
    async ensureNetworkTracking(sessionIds) {
      for (const sessionId of new Set(sessionIds)) {
        if (!networkSessions.has(sessionId)) {
          await services.cdp("Network.enable", {}, sessionId);
        }
      }
    },
    async pageNetworkSessions(sessionId) {
      return [sessionId];
    },
    networkActivity(sessionIds) {
      let tracking = sessionIds.length > 0;
      let inflight = 0;
      let lastActivityAt = 0;
      for (const sessionId of new Set(sessionIds)) {
        if (!networkSessions.has(sessionId)) {
          tracking = false;
          continue;
        }
        inflight += networkRequests.get(sessionId)?.size ?? 0;
        lastActivityAt = Math.max(
          lastActivityAt,
          networkLastActivityAt.get(sessionId) ?? 0,
        );
      }
      return { tracking, inflight, lastActivityAt };
    },
    ensureSession: ensureTargetSession,
    async ensureFrameSessions() {
      return new Map();
    },
    invalidateSession(targetId) {
      calls.push(["invalidateSession", targetId]);
    },
    setPreferredTarget(targetId) {
      calls.push(["setPreferredTarget", targetId]);
    },
    supportsBackgroundPageDiscovery: () => true,
    subscribeBrowserEvents(listener) {
      browserEventListeners.add(listener);
      return () => browserEventListeners.delete(listener);
    },
    now: () => nowMs,
    sleep: async (ms) => {
      sleepDurations.push(ms);
      nowMs += ms;
    },
  };
  return {
    activeTarget: () => activeTarget,
    calls,
    gate,
    rootDir,
    services,
    sleepDurations,
    snapshotOptions,
    tabs,
    addExternalTab(targetId, url, { active = false, ...details } = {}) {
      tabs.set(targetId, { targetId, url, title: url, active, ...details });
      if (active) activeTarget = targetId;
    },
    openPopupOnNextClick(url) {
      popupOnNextClick = url;
    },
    openFileChooserOnNextClick(options = {}) {
      fileChooserOnNextClick = {
        backendNodeId: options.backendNodeId ?? 71,
        frameId: options.frameId ?? "frame-1",
        mode: options.mode ?? "selectSingle",
      };
    },
    systemFileChooserOpened: () => systemFileChooserOpened,
    timeoutNextMouseDispatch() {
      timeoutNextMouseDispatch = true;
    },
    loseSessionOnNextMouseRelease() {
      loseSessionOnNextMouseRelease = true;
    },
    loseFrameOnNextResolution(failure) {
      loseFrameOnNextResolution = failure;
    },
    openDialogOnNextClick(dialog = {}) {
      dialogOnNextClick = {
        type: dialog.type ?? "alert",
        message: dialog.message ?? "Confirm action",
        url: dialog.url ?? "https://example.test/dialog",
        ...(dialog.defaultPrompt === undefined
          ? {}
          : { defaultPrompt: dialog.defaultPrompt }),
      };
    },
    openDialogOnNextFileSet(dialog = {}) {
      dialogOnNextFileSet = {
        type: dialog.type ?? "confirm",
        message: dialog.message ?? "Replace the current project?",
        url: dialog.url ?? "https://example.test/upload",
        ...(dialog.defaultPrompt === undefined
          ? {}
          : { defaultPrompt: dialog.defaultPrompt }),
      };
    },
    rejectNextClickPoint() {
      rejectedClickPointsRemaining = 1;
    },
    rejectClickPoints(count) {
      rejectedClickPointsRemaining = count;
    },
    interceptNextClickPoint() {
      interceptedClickPointsRemaining = 1;
    },
    interceptClickPoints(count) {
      interceptedClickPointsRemaining = count;
    },
    scrollNextClickPoint(count = 1) {
      scrollClickPointsRemaining = count;
    },
    navigateOnNextClick(url) {
      navigateOnNextClickUrl = url;
    },
    configureFill({
      kind = "input",
      initialText = "",
      ignoreInsertions = 0,
      transform = null,
    }) {
      fillElementKind = kind;
      fillText = initialText;
      fillTransform = transform;
      fillInsertionCount = 0;
      ignoredFillInsertionsRemaining = ignoreInsertions;
    },
    configureFocusResult(result) {
      focusResult = result;
    },
    configureUnsafeFillActivation(target) {
      unsafeFillActivationTarget = target;
    },
    configureSelectOptions(options) {
      selectOptions = options.map((option) => ({ ...option }));
    },
    fillText: () => fillText,
    setElementState({ present = true, visible = true }) {
      elementPresent = present;
      elementVisible = visible;
    },
    setDocumentLifecycle({ readyState, domContentLoaded: loaded }) {
      documentReadyState = readyState;
      domContentLoaded = loaded;
    },
    timeoutNextLifecycleEvaluation() {
      timeoutNextLifecycleEvaluate = true;
    },
    timeoutNextUrlEvaluation() {
      timeoutNextUrlEvaluate = true;
    },
    setWaitFunctionResults(results) {
      waitFunctionResults = [...results];
    },
    failNextFetch(message) {
      fetchFailure = message;
    },
    setSession(targetId, sessionId) {
      sessionOverrides.set(targetId, sessionId);
    },
    selectedValues() {
      return [...selectedValues];
    },
    emitPageEvent(targetId, method, params = {}) {
      const sessionId = `session:${targetId}`;
      if (networkSessions.has(sessionId)) {
        const requests = networkRequests.get(sessionId) || new Set();
        if (method === "Network.requestWillBeSent" && params.requestId) {
          requests.add(params.requestId);
          networkLastActivityAt.set(sessionId, nowMs);
        } else if (
          (method === "Network.loadingFinished" ||
            method === "Network.loadingFailed") &&
          params.requestId
        ) {
          requests.delete(params.requestId);
          networkLastActivityAt.set(sessionId, nowMs);
        }
        networkRequests.set(sessionId, requests);
      }
      const events = pageEvents.get(sessionId) || [];
      events.push({ sessionId, method, params });
      pageEvents.set(sessionId, events);
    },
    emitBrowserEvent(method, params = {}) {
      for (const listener of [...browserEventListeners]) {
        listener({ method, params });
      }
    },
  };
}

function taskForRound(fixture, roundId, overrides = {}) {
  return createTaskSpaceHandle(
    { id: 7, name: "research", ownership: "agent" },
    {
      ledger: new PageLedgerStore({ rootDir: fixture.rootDir }),
      ...fixture.services,
      ...overrides,
    },
  );
}

async function openTestPage(task, url, gotoOptions = {}) {
  const page = await task.newPage();
  await page.goto(url, gotoOptions);
  return page;
}

async function waitForLedgerTarget(ledger, spaceId, targetId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const entry = Object.entries((await ledger.read(spaceId)).pages).find(
      ([, page]) => page.targetId === targetId,
    );
    if (entry) return { label: entry[0], ...entry[1] };
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ledger target ${targetId}`);
}

test("background discovery does not adopt the pre-existing tab baseline", async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    fixture.addExternalTab("target-existing", "https://example.test/existing");
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", { ledger });

    await initializeTaskSpaceHandle(task);
    const page = await openTestPage(task, "https://example.test/managed");

    assert.equal(page.label, "p1");
    assert.deepEqual((await ledger.read(7)).unmanagedTargets, {
      "target-existing": "unknown",
    });
    assert.deepEqual(consumeUnhandledPageNotices(), []);
  });
});

test("a created TaskSpace manages its sole default tab as agent page p1", async () => {
  await withFixture(async (fixture) => {
    fixture.addExternalTab("target-initial", "chrome://newtab/", {
      active: true,
    });
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", { ledger });

    await initializeTaskSpaceHandle(task, { created: true });

    const [initial] = await task.pages();
    assert.equal(initial.label, "p1");
    assert.equal(initial.targetId, "target-initial");
    assert.equal(initial.openedBy, "agent");

    const next = await task.newPage();
    assert.equal(next.label, "p2");
    assert.notEqual(next.targetId, initial.targetId);
  });
});

test("created-space initialization waits for a delayed default tab", async () => {
  await withFixture(async (fixture) => {
    fixture.addExternalTab("target-initial", "chrome://newtab/", {
      active: true,
    });
    let inventories = 0;
    const task = taskForRound(fixture, "round-a", {
      async listTabs() {
        inventories += 1;
        if (inventories === 1) return [];
        return fixture.services.listTabs();
      },
    });

    await initializeTaskSpaceHandle(task, { created: true });

    const [initial] = await task.pages();
    assert.equal(initial.label, "p1");
    assert.equal(initial.targetId, "target-initial");
    assert(inventories >= 2);
  });
});

test("created-space initialization refuses to guess between multiple tabs", async () => {
  await withFixture(async (fixture) => {
    fixture.addExternalTab("target-a", "chrome://newtab/", { active: true });
    fixture.addExternalTab("target-b", "about:blank");
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", { ledger });

    await assert.rejects(
      () => initializeTaskSpaceHandle(task, { created: true }),
      /new task space expected one default tab, found 2/,
    );
    assert.deepEqual((await ledger.read(7)).pages, {});
  });
});

test("created-space initialization times out when no default tab appears", async () => {
  await withFixture(async (fixture) => {
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", { ledger });

    await assert.rejects(
      () => initializeTaskSpaceHandle(task, { created: true }),
      /new task space did not expose its default tab within 2000ms/,
    );
    assert.deepEqual((await ledger.read(7)).pages, {});
  });
});

test("background target discovery adopts a delayed popup and reports its opener", async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", { ledger });
    await initializeTaskSpaceHandle(task);
    const source = await openTestPage(task, "https://example.test/source");
    fixture.addExternalTab("target-delayed", "https://example.test/delayed", {
      openerId: source.targetId,
    });

    fixture.emitBrowserEvent("Target.targetCreated", {
      targetInfo: {
        targetId: "target-delayed",
        type: "page",
        url: "https://example.test/delayed",
        openerId: source.targetId,
      },
    });

    // The ledger write can become visible before discovery publishes its notice.
    await fixture.services.gate.withSpace(7, () => undefined);
    const adopted = await waitForLedgerTarget(ledger, 7, "target-delayed");
    assert.equal(adopted.label, "p2");
    assert.deepEqual(consumeUnhandledPageNotices(), [
      {
        spaceId: 7,
        targetId: "target-delayed",
        label: "p2",
        openerLabel: "p1",
        url: "https://example.test/delayed",
      },
    ]);
  });
});

test("using a delayed popup suppresses its notice before round output", async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", { ledger });
    await initializeTaskSpaceHandle(task);
    const source = await openTestPage(task, "https://example.test/source");
    fixture.addExternalTab("target-delayed", "https://example.test/delayed", {
      openerId: source.targetId,
    });
    fixture.emitBrowserEvent("Target.targetCreated", {
      targetInfo: {
        targetId: "target-delayed",
        type: "page",
        url: "https://example.test/delayed",
        openerId: source.targetId,
      },
    });
    const adopted = await waitForLedgerTarget(ledger, 7, "target-delayed");

    assert.equal(
      await task.page(adopted.label).url(),
      "https://example.test/delayed",
    );
    assert.deepEqual(consumeUnhandledPageNotices(), []);
  });
});

test("tab reconciliation reports a late page without requiring an explicit wait", async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, "round-a");
    const source = await openTestPage(task, "https://example.test/source");
    fixture.addExternalTab("target-delayed", "https://example.test/delayed", {
      openerId: source.targetId,
    });

    const inventory = await task.tabs();
    const adopted = inventory.find(
      (item) => item.targetId === "target-delayed",
    );

    assert.equal(adopted.label, "p2");
    assert.deepEqual(consumeUnhandledPageNotices(), [
      {
        spaceId: 7,
        targetId: "target-delayed",
        label: "p2",
        openerLabel: "p1",
        url: "https://example.test/delayed",
      },
    ]);
  });
});

test("TaskSpace.waitForControl polls in milliseconds without taking control", async () => {
  await withFixture(async (fixture) => {
    let elapsedMs = 0;
    let probes = 0;
    const task = taskForRound(fixture, "round-a", {
      now: () => elapsedMs,
      async sleep(ms) {
        elapsedMs += ms;
      },
      async probeAgentControl() {
        probes += 1;
        return probes >= 3;
      },
    });

    await task.waitForControl({ interval: 25, timeout: 100 });

    assert.equal(probes, 3);
    assert.equal(elapsedMs, 50);
    assert.deepEqual(
      fixture.calls.filter(([name]) => name === "selectSpace"),
      [
        ["selectSpace", 7],
        ["selectSpace", 7],
        ["selectSpace", 7],
      ],
    );
  });
});

test("TaskSpace.waitForControl times out in milliseconds and validates options", async () => {
  await withFixture(async (fixture) => {
    let elapsedMs = 0;
    const task = taskForRound(fixture, "round-a", {
      now: () => elapsedMs,
      async sleep(ms) {
        elapsedMs += ms;
      },
      async probeAgentControl() {
        return false;
      },
    });

    await assert.rejects(
      () => task.waitForControl({ interval: 40, timeout: 90 }),
      /task\.waitForControl timed out after 90ms/,
    );
    assert.equal(elapsedMs, 90);
    await assert.rejects(
      () => task.waitForControl({ interval: 0 }),
      /interval must be a positive number of milliseconds/,
    );
    await assert.rejects(
      () => task.waitForControl({ timeout: 0 }),
      /timeout must be a positive number of milliseconds/,
    );
  });
});

test("Page.waitForTimeout validates and waits in milliseconds without activating the Page", async () => {
  await withFixture(async (fixture) => {
    const waits = [];
    const task = taskForRound(fixture, "round-a", {
      async sleep(ms) {
        waits.push(ms);
      },
    });
    const page = await openTestPage(task, "https://example.test/timer");
    waits.length = 0;
    fixture.calls.length = 0;

    await page.waitForTimeout(125);

    assert.deepEqual(waits, [125]);
    assert.deepEqual(fixture.calls, []);
    await assert.rejects(
      () => page.waitForTimeout(-1),
      /page\.waitForTimeout requires a non-negative number of milliseconds/,
    );
    await assert.rejects(
      () => page.waitForTimeout(Number.POSITIVE_INFINITY),
      /page\.waitForTimeout requires a non-negative number of milliseconds/,
    );
  });
});

test("Page.waitForFunction polls one Page with one JSON argument", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    const second = await openTestPage(task, "https://example.test/second");
    fixture.setWaitFunctionResults([false, false, true]);
    fixture.calls.length = 0;

    assert.equal(
      await first.waitForFunction(
        ({ selector }) => Boolean(document.querySelector(selector)),
        { selector: "#ready" },
        { timeout: 250, polling: 25 },
      ),
      true,
    );

    const probes = fixture.calls.filter(
      ([kind, method, params, sessionId]) =>
        kind === "cdp" &&
        method === "Runtime.evaluate" &&
        params.expression.includes("__egoWaitForFunction") &&
        sessionId === "session:target-1",
    );
    assert.equal(probes.length, 3);
    assert.match(probes[0][2].expression, /selector.*#ready/);
    assert(
      fixture.calls.some(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Target.activateTarget" &&
          params.targetId === first.targetId,
      ),
      "waitForFunction activates the addressed Page",
    );
    assert.equal(second.targetId, "target-2");
  });
});

test("Page.waitForFunction validates input and reports its timeout", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");

    await assert.rejects(
      () =>
        page.waitForFunction(() => false, undefined, {
          timeout: 60,
          polling: 25,
        }),
      (error) => {
        assert.match(
          error.message,
          /page\.waitForFunction timed out after 60ms/,
        );
        assert.match(error.message, /page p1/);
        assert.match(
          error.message,
          /last URL was "https:\/\/example\.test\/first"/,
        );
        return true;
      },
    );
    await assert.rejects(
      () => page.waitForFunction(42),
      /page\.waitForFunction expects a function or string expression/,
    );
    await assert.rejects(
      () => page.waitForFunction("document.readyState", { ignored: true }),
      /string expression does not accept an argument/,
    );
    await assert.rejects(
      () => page.waitForFunction(() => true, undefined, { timeout: 0 }),
      /timeout must be a positive number of milliseconds/,
    );
    await assert.rejects(
      () => page.waitForFunction(() => true, undefined, { polling: 0 }),
      /polling must be a positive number of milliseconds/,
    );
    await assert.rejects(
      () => page.waitForFunction(() => false, { timeout: 60 }),
      /options are the third argument.*pass undefined.*Expected: await page\.waitForFunction\(fnOrString, argument\?, \{ timeout\?, polling\? \}\)/,
    );
  });
});

test("Page.waitForFunction timeout points to an unhandled popup", async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/source");
    fixture.openPopupOnNextClick("https://example.test/popup");
    await page.click("#open-popup");

    await assert.rejects(
      () =>
        page.waitForFunction(() => false, undefined, {
          timeout: 60,
          polling: 25,
        }),
      (error) => {
        assert.match(error.message, /popup p2 opened from p1/i);
        assert.match(error.message, /task\.page\("p2"\)/);
        assert.match(error.message, /before retrying the preceding action/i);
        return true;
      },
    );
  });
});

test("Page.evaluate explains that its callback cannot capture Node variables", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");

    await assert.rejects(
      () => page.evaluate(() => missingClosureForE2E),
      (error) => {
        assert.match(
          error.message,
          /ReferenceError: missingClosureForE2E is not defined/,
        );
        assert.match(
          error.message,
          /page\.evaluate\(\) callbacks run inside the Page and cannot access variables from the Node\.js script/,
        );
        assert.match(error.message, /pass JSON data as the second argument/);
        return true;
      },
    );
  });
});

test("v2 methods reject option fields that are absent from the public schema", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    await assert.rejects(
      () => task.newPage({ reuse: true }),
      /task\.newPage does not accept arguments/,
    );
    assert.equal(fixture.tabs.size, 0, "validation runs before creating a tab");

    const page = await openTestPage(task, "https://example.test/options");
    await assert.rejects(
      () => page.click("button", { trial: true }),
      /page\.click received unknown option: trial/,
    );
    await assert.rejects(
      () => task.finish(null),
      /task\.finish options must be an object/,
    );
    await assert.rejects(
      () => task.finish({}),
      /task\.finish requires the keep option/,
    );
    assert.equal(task.close, undefined, "TaskSpace has one terminal API");
  });
});

test("TaskSpace uses spaceId and finishes while keeping every managed Page", async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls = [];
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const services = {
      ledger,
      async handOffTaskSpace() {
        lifecycleCalls.push("handOff");
      },
      async completeTaskSpace() {
        lifecycleCalls.push("finish");
      },
    };
    const task = taskForRound(fixture, "round-a", services);

    assert.equal(task.spaceId, 7);
    assert.equal(task.id, 7, "id remains a compatibility alias");
    await task.handOff();

    const finishTask = taskForRound(fixture, "round-b", services);
    const page = await finishTask.newPage();
    const receipt = await finishTask.finish({ keep: "all" });
    assert.deepEqual(receipt, {
      spaceId: 7,
      closedSpace: false,
      keptManagedLabels: [page.label],
      closedManagedLabels: [],
      preservedUnmanagedCount: 0,
    });
    assert.deepEqual((await ledger.read(7)).pages, {});
    assert.equal(fixture.tabs.has(page.targetId), true);

    assert.deepEqual(lifecycleCalls, ["handOff", "finish"]);
    assert(
      fixture.calls
        .filter(([name]) => name === "selectSpace")
        .every(([, spaceId]) => spaceId === 7),
    );
  });
});

test("TaskSpace finish keeps named Pages and protects unknown-origin Pages", async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls = [];
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", {
      ledger,
      async completeTaskSpace() {
        lifecycleCalls.push("finish");
      },
      async closeTaskSpace() {
        lifecycleCalls.push("close");
      },
    });
    const p1 = await openTestPage(task, "https://example.test/one");
    const p2 = await openTestPage(task, "https://example.test/two");
    const p3 = await openTestPage(task, "https://example.test/three");
    fixture.addExternalTab("target-user", "https://example.test/user");
    await ledger.addPage(7, "target-user", {
      as: "user-page",
      openedBy: "unknown",
    });

    const receipt = await task.finish({ keep: ["p2"] });

    assert.deepEqual(receipt, {
      spaceId: 7,
      closedSpace: false,
      keptManagedLabels: ["p2", "user-page"],
      closedManagedLabels: ["p1", "p3"],
      preservedUnmanagedCount: 0,
    });

    assert.deepEqual(lifecycleCalls, ["finish"]);
    assert.deepEqual([...fixture.tabs.keys()].sort(), [
      p2.targetId,
      "target-user",
    ]);
    assert.equal(fixture.tabs.has(p1.targetId), false);
    assert.equal(fixture.tabs.has(p3.targetId), false);
    assert.deepEqual((await ledger.read(7)).pages, {});
  });
});

test("TaskSpace finish closes the whole space when no Pages are retained", async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls = [];
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", {
      ledger,
      async completeTaskSpace() {
        lifecycleCalls.push("finish");
      },
      async closeTaskSpace() {
        lifecycleCalls.push("close");
      },
    });
    await openTestPage(task, "https://example.test/one");

    const receipt = await task.finish({ keep: [] });

    assert.deepEqual(receipt, {
      spaceId: 7,
      closedSpace: true,
      keptManagedLabels: [],
      closedManagedLabels: ["p1"],
      preservedUnmanagedCount: 0,
    });

    assert.deepEqual(lifecycleCalls, ["close"]);
    assert.equal(
      fixture.calls.some(
        ([name, method]) => name === "cdp" && method === "Target.closeTarget",
      ),
      false,
      "closing the whole space does not close its Pages one by one",
    );
    assert.deepEqual((await ledger.read(7)).pages, {});
  });
});

test("TaskSpace finish with no argument keeps nothing, like keep: []", async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls = [];
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", {
      ledger,
      async completeTaskSpace() {
        lifecycleCalls.push("finish");
      },
      async closeTaskSpace() {
        lifecycleCalls.push("close");
      },
    });
    await openTestPage(task, "https://example.test/one");

    const receipt = await task.finish();

    assert.equal(receipt.closedSpace, true);
    assert.deepEqual(receipt.closedManagedLabels, ["p1"]);
    assert.deepEqual(lifecycleCalls, ["close"]);
  });
});

test("TaskSpace finish keeps protected unmanaged tabs even with an empty keep list", async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls = [];
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", {
      ledger,
      async completeTaskSpace() {
        lifecycleCalls.push("finish");
      },
      async closeTaskSpace() {
        lifecycleCalls.push("close");
      },
    });
    const agentPage = await openTestPage(task, "https://example.test/agent");
    fixture.addExternalTab("target-user", "https://example.test/user");
    await ledger.keepUnmanaged(7, "target-user", "unknown");

    const receipt = await task.finish({ keep: [] });

    assert.deepEqual(receipt, {
      spaceId: 7,
      closedSpace: false,
      keptManagedLabels: [],
      closedManagedLabels: ["p1"],
      preservedUnmanagedCount: 1,
    });

    assert.deepEqual(lifecycleCalls, ["finish"]);
    assert.equal(fixture.tabs.has(agentPage.targetId), false);
    assert.equal(fixture.tabs.has("target-user"), true);
  });
});

test("TaskSpace finish validates every retained label before closing Pages", async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls = [];
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", {
      ledger,
      async completeTaskSpace() {
        lifecycleCalls.push("finish");
      },
      async closeTaskSpace() {
        lifecycleCalls.push("close");
      },
    });
    const p1 = await openTestPage(task, "https://example.test/one");
    const p2 = await openTestPage(task, "https://example.test/two");

    await assert.rejects(
      () => task.finish({ keep: ["p2", "missing"] }),
      /page label not found: missing/,
    );

    assert.deepEqual(lifecycleCalls, []);
    assert.equal(fixture.tabs.has(p1.targetId), true);
    assert.equal(fixture.tabs.has(p2.targetId), true);
    assert.deepEqual(Object.keys((await ledger.read(7)).pages), ["p1", "p2"]);
  });
});

test("Page reports existing labels when an Agent uses one it never created", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    await openTestPage(task, "https://example.test/one");

    const guessed = task.page("p2");
    assert.ok(guessed, "task.page returns a handle even for an unknown label");
    await assert.rejects(
      () => guessed.url(),
      (error) => {
        assert.match(error.message, /^page label not found: p2\. /);
        assert.match(error.message, /Managed Pages in task space 7: p1\./);
        assert.match(error.message, /await task\.newPage\(\)/);
        return true;
      },
    );
  });
});

test("Page reports a finished task when used after finish in the same round", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", {
      async completeTaskSpace() {},
    });
    const page = await openTestPage(task, "https://example.test/one");
    await task.finish({ keep: ["p1"] });

    await assert.rejects(
      () => page.url(),
      /^Error: page label not found: p1\. Task space 7 already finished/,
    );
  });
});

test("Page reports user ownership when a later round reuses a finished task's label", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", {
      async completeTaskSpace() {},
    });
    await openTestPage(task, "https://example.test/one");
    await task.finish({ keep: ["p1"] });

    const nextRound = createTaskSpaceHandle(
      { id: 7, name: "research", ownership: "user" },
      {
        ledger: new PageLedgerStore({ rootDir: fixture.rootDir }),
        ...fixture.services,
      },
    );
    await assert.rejects(
      () => nextRound.page("p1").url(),
      /^Error: page label not found: p1\. Task space 7 is owned by the user/,
    );
  });
});

test("handoff preserves user-created tabs as unknown and captures the active user page", async () => {
  await withFixture(async (fixture) => {
    const firstRound = taskForRound(fixture, "round-a", {
      async handOffTaskSpace() {},
    });
    const agentPage = await openTestPage(
      firstRound,
      "https://example.test/agent",
    );
    await firstRound.handOff();
    assert.equal(agentPage.label, "p1");
    fixture.addExternalTab("target-user", "https://example.test/user-created", {
      active: true,
    });

    const afterTakeover = taskForRound(fixture, "round-b");
    await captureTaskSpaceUserBoundary(afterTakeover);
    const userPage = afterTakeover.userPage();
    assert(userPage, "takeover captures the tab the user was viewing");
    assert.equal(userPage.targetId, "target-user");
    assert.equal(userPage.openedBy, "unknown");

    const inventory = await afterTakeover.tabs();
    const userItem = inventory.find((item) => item.targetId === "target-user");
    assert.equal(userItem.label, undefined);
    assert.equal(userItem.openedBy, "unknown");

    fixture.addExternalTab("target-popup", "https://example.test/agent-popup");
    const reconciled = await afterTakeover.tabs();
    assert.equal(
      reconciled.find((item) => item.targetId === "target-popup").openedBy,
      "agent",
    );
  });
});

test("failed native handoff removes the pending user-control boundary", async () => {
  await withFixture(async (fixture) => {
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", {
      ledger,
      async handOffTaskSpace() {
        throw new Error("native handoff failed");
      },
    });
    await openTestPage(task, "https://example.test/agent");

    await assert.rejects(() => task.handOff(), /native handoff failed/);
    assert.equal((await ledger.read(7)).userControlPending, false);
  });
});

test("TaskSpace keeps Page state when native finish fails", async () => {
  await withFixture(async (fixture) => {
    const ledger = new PageLedgerStore({ rootDir: fixture.rootDir });
    const task = taskForRound(fixture, "round-a", {
      ledger,
      async completeTaskSpace() {
        throw new Error("native finish failed");
      },
    });
    await openTestPage(task, "https://example.test/managed");

    await assert.rejects(
      () => task.finish({ keep: "all" }),
      /native finish failed/,
    );

    assert.deepEqual((await ledger.read(7)).pages, {
      p1: { targetId: "target-1", openedBy: "agent" },
    });
  });
});

test("a page label restores in a new round and goto reuses its target", async () => {
  await withFixture(async (fixture) => {
    const firstRound = taskForRound(fixture, "round-a");
    const created = await openTestPage(
      firstRound,
      "https://example.test/first",
    );

    assert.equal(created.label, "p1");
    assert.equal(created.spaceId, 7);
    assert.equal(created.targetId, "target-1");
    assert.equal(created.openedBy, "agent");
    assert.equal(fixture.tabs.size, 1);

    const secondRound = taskForRound(fixture, "round-b");
    const restored = secondRound.page("p1");
    const receipt = await restored.goto("https://example.test/second");

    assert.equal(restored.targetId, "target-1");
    assert.equal(fixture.tabs.size, 1, "goto must not create a second tab");
    assert.equal(
      fixture.tabs.get("target-1").url,
      "https://example.test/second",
    );
    assert.deepEqual(receipt, {});
    assert.match(
      await restored.snapshot(),
      /\[p1 .*space "research"\(7\).*\]\nsnapshot:https:\/\/example\.test\/second/,
    );
  });
});

test("Page.goto accepts Playwright-style navigation options", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.setDocumentLifecycle({
      readyState: "interactive",
      domContentLoaded: true,
    });
    fixture.calls.length = 0;

    await page.goto("https://example.test/second", {
      referer: "https://example.test/source",
      timeout: 250,
      waitUntil: "domcontentloaded",
    });

    const navigation = fixture.calls.find(
      ([kind, method]) => kind === "cdp" && method === "Page.navigate",
    );
    assert.deepEqual(navigation.slice(2, 4), [
      {
        url: "https://example.test/second",
        referrer: "https://example.test/source",
      },
      "session:target-1",
    ]);
  });
});

test("Page.goto commit waits for this navigation without waiting for the DOM", async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 5_000;
    let committed = false;
    let commitChecks = 0;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (method === "Page.navigate") {
          await baseCdp(method, params, sessionId, timeoutMs);
          return {
            result: { frameId: "frame-1", loaderId: "loader-new" },
          };
        }
        if (method === "Page.getFrameTree") {
          commitChecks += 1;
          return {
            result: {
              frameTree: {
                frame: {
                  id: "frame-1",
                  loaderId: committed ? "loader-new" : "loader-old",
                },
              },
            },
          };
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      },
      now: () => nowMs,
      async sleep(ms) {
        nowMs += ms;
        committed = true;
      },
    });
    const page = await openTestPage(task, "https://example.test/first");
    commitChecks = 0;
    committed = false;
    fixture.setDocumentLifecycle({
      readyState: "loading",
      domContentLoaded: false,
    });
    const callsBeforeGoto = fixture.calls.length;

    await page.goto("https://example.test/second", {
      timeout: 250,
      waitUntil: "commit",
    });

    assert.equal(commitChecks, 2);
    assert.equal(
      fixture.calls
        .slice(callsBeforeGoto)
        .some(
          ([kind, method]) => kind === "cdp" && method === "Runtime.evaluate",
        ),
      false,
      "commit must not wait for DOM readiness",
    );
  });
});

test("Page.goto starts network tracking before a network-idle navigation", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    const callsBeforeGoto = fixture.calls.length;

    await page.goto("https://example.test/second", {
      timeout: 1_000,
      waitUntil: "networkidle",
    });

    const methods = fixture.calls
      .slice(callsBeforeGoto)
      .filter(([kind]) => kind === "cdp")
      .map(([, method]) => method);
    assert(
      methods.indexOf("Network.enable") < methods.indexOf("Page.navigate"),
    );
    assert(
      !methods.includes("Network.disable"),
      "continuous tracking must remain enabled for requests that start before a later wait",
    );
  });
});

test("Page.goto timeout distinguishes a committed usable document", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.setDocumentLifecycle({
      readyState: "loading",
      domContentLoaded: false,
    });

    await assert.rejects(
      () =>
        page.goto("https://example.test/streaming", {
          timeout: 100,
          waitUntil: "load",
        }),
      (error) => {
        assert.equal(error.code, "EGO_NAVIGATION_TIMEOUT");
        assert.equal(error.committed, true);
        assert.equal(error.url, "https://example.test/streaming");
        assert.equal(error.readyState, "loading");
        assert.match(error.message, /navigation committed/);
        assert.match(error.message, /waitForLoadState\("load"\)/);
        return true;
      },
    );
  });
});

test("Page.goto timeout reports when no new document committed", async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 0;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (
          method === "Page.navigate" &&
          params.url === "https://example.test/never-committed"
        ) {
          nowMs = 100;
          throw new CdpRequestTimeoutError(method, timeoutMs, sessionId);
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      },
      now: () => nowMs,
    });
    const page = await openTestPage(task, "https://example.test/first");
    nowMs = 0;

    await assert.rejects(
      () =>
        page.goto("https://example.test/never-committed", {
          timeout: 100,
          waitUntil: "load",
        }),
      (error) => {
        assert.equal(error.code, "EGO_NAVIGATION_TIMEOUT");
        assert.equal(error.committed, false);
        assert.equal(error.url, undefined);
        assert.equal(error.readyState, undefined);
        assert.doesNotMatch(error.message, /Continue on this Page/);
        return true;
      },
    );
  });
});

test("Page.goto performs one final loader check at the timeout boundary", async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 0;
    let frameChecks = 0;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (method === "Page.navigate") {
          await baseCdp(method, params, sessionId, timeoutMs);
          return {
            result: { frameId: "frame-1", loaderId: "loader-new" },
          };
        }
        if (method === "Page.getFrameTree") {
          frameChecks += 1;
          return {
            result: {
              frameTree: {
                frame: {
                  id: "frame-1",
                  loaderId: frameChecks >= 3 ? "loader-new" : "loader-old",
                },
              },
            },
          };
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      },
      now: () => nowMs,
      async sleep(ms) {
        nowMs += ms;
      },
    });
    const page = await openTestPage(task, "https://example.test/first");
    nowMs = 0;
    frameChecks = 0;
    fixture.setDocumentLifecycle({
      readyState: "loading",
      domContentLoaded: false,
    });

    await assert.rejects(
      () =>
        page.goto("https://example.test/boundary", {
          timeout: 100,
          waitUntil: "load",
        }),
      (error) => {
        assert.equal(error.committed, true);
        assert.equal(error.url, "https://example.test/boundary");
        return true;
      },
    );
    assert.equal(frameChecks, 3);
  });
});

test("Page.reload reloads the current document and waits for the requested state", async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let loaderId = "loader-old";
    let reloading = false;
    let postReloadChecks = 0;
    let reloadParams;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (method === "Page.getFrameTree") {
          if (reloading) {
            postReloadChecks += 1;
            if (postReloadChecks >= 2) loaderId = "loader-new";
          }
          return {
            result: {
              frameTree: { frame: { id: "frame-1", loaderId } },
            },
          };
        }
        if (method === "Page.reload") {
          reloadParams = params;
          reloading = true;
          return {};
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      },
    });
    const page = await openTestPage(task, "https://example.test/first");
    fixture.setDocumentLifecycle({
      readyState: "interactive",
      domContentLoaded: true,
    });
    assert.deepEqual(
      await page.reload({ timeout: 250, waitUntil: "domcontentloaded" }),
      {},
    );
    assert.deepEqual(reloadParams, { loaderId: "loader-old" });
    assert.equal(
      postReloadChecks,
      2,
      "reload waits for a new main-frame loader",
    );
  });
});

test("Page.reload times out when no new document commits", async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 0;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (method === "Page.getFrameTree") {
          return {
            result: {
              frameTree: {
                frame: { id: "frame-1", loaderId: "loader-old" },
              },
            },
          };
        }
        if (method === "Page.reload") return {};
        return baseCdp(method, params, sessionId, timeoutMs);
      },
      now: () => nowMs,
      async sleep(ms) {
        nowMs += ms;
      },
    });
    const page = await openTestPage(task, "https://example.test/first");

    await assert.rejects(
      () => page.reload({ timeout: 100, waitUntil: "commit" }),
      /page\.reload timed out after 100ms waiting for commit/,
    );
  });
});

test("newPage creates a managed blank Page and leaves navigation to goto", async () => {
  await withFixture(async (fixture) => {
    const requestedUrl = "https://example.test/created-document";
    const task = taskForRound(fixture, "round-a");

    const page = await task.newPage();

    assert.equal(fixture.tabs.get(page.targetId).url, "about:blank");
    assert.equal(page.label, "p1");

    await page.goto(requestedUrl);
    assert.equal(fixture.tabs.get(page.targetId).url, requestedUrl);
  });
});

test("snapshot activates the addressed page, not whichever tab was current", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");

    assert.equal(fixture.activeTarget(), "target-2");
    assert.match(
      await first.snapshot(),
      /\[p1 .*space "research"\(7\).*\]\nsnapshot:https:\/\/example\.test\/first/,
    );
    assert.equal(fixture.activeTarget(), "target-1");
  });
});

test("snapshot defaults to the viewport, reports its source, and validates options", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/before");

    assert.match(
      await page.snapshot(),
      /snapshot:https:\/\/example\.test\/before/,
    );
    assert.deepEqual(fixture.snapshotOptions.at(-1), {
      scope: "only_within_viewport",
      includeActionMarks: true,
      includeStableLocator: true,
    });

    await page.snapshot({ scope: "full_page" });
    assert.deepEqual(fixture.snapshotOptions.at(-1), {
      scope: "full_page",
      includeActionMarks: true,
      includeStableLocator: true,
    });

    assert.match(
      await page.snapshot({ scope: "subtree", root: "@21" }),
      /snapshot:https:\/\/example\.test\/before/,
    );
    assert.deepEqual(fixture.snapshotOptions.at(-1), {
      scope: "subtree",
      root: 21,
      includeActionMarks: true,
      includeStableLocator: true,
    });

    await assert.rejects(
      () => page.snapshot({ scope: "subtree" }),
      /page\.snapshot subtree scope requires root to be a snapshot ref such as @21/,
    );
    await assert.rejects(
      () => page.snapshot({ scope: "full_page", root: "@21" }),
      /page\.snapshot root is only supported when scope is subtree/,
    );
    await assert.rejects(
      () => page.snapshot({ scope: "subtree", root: "css:#target" }),
      /page\.snapshot root must be a snapshot ref such as @21/,
    );
    await assert.rejects(
      () => page.snapshot({ scope: "subtree", root: "@999" }),
      /Unknown ref: 999/,
    );

    await assert.rejects(
      () => page.snapshot({ diff: true }),
      /page\.snapshot received unknown option: diff/,
    );
  });
});

test("viewport snapshots preserve native iframe contents and refs", async () => {
  for (const options of [{}, { scope: "only_within_viewport" }]) {
    await withFixture(async (fixture) => {
      const content = [
        "root",
        '  button "Host action" [ref=1]',
        "  iframe [ref=11]",
        "    root",
        '      button "Frame action" [ref=21]',
        "      iframe [ref=31]",
        "        root",
        '          button "Nested OOPIF action" [ref=41]',
        '  text "Host sibling"',
      ].join("\n");
      const task = taskForRound(fixture, "round-a", {
        async cdp(method, params, sessionId, timeoutMs) {
          if (method === "DOM.getFrameOwner") return { backendNodeId: 99 };
          if (method === "DOM.getBoxModel") {
            return { model: { content: [0, 0, 400, 0, 400, 300, 0, 300] } };
          }
          return fixture.services.cdp(method, params, sessionId, timeoutMs);
        },
        async ensureFrameSessions() {
          return new Map([
            ["frame-same", "session:target-1"],
            ["frame-oopif", "session:oopif"],
          ]);
        },
        async snapshot() {
          return {
            content,
            refs: [
              { refId: 1, backendNodeId: 1, role: "button" },
              { refId: 11, backendNodeId: 11, role: "iframe" },
              {
                refId: 21,
                backendNodeId: 21,
                role: "button",
                frameId: "frame-same",
              },
              {
                refId: 31,
                backendNodeId: 31,
                role: "iframe",
                frameId: "frame-same",
              },
              {
                refId: 41,
                backendNodeId: 21,
                role: "button",
                frameId: "frame-oopif",
              },
            ],
          };
        },
      });
      const page = await openTestPage(task, "https://example.test/iframe-host");

      assert.equal(
        (await page.snapshot(options)).split("\n").slice(1).join("\n"),
        content,
      );
      const refs = fixture.services.pageRefs.forTarget(page.targetId);
      assert.deepEqual([...refs.map.keys()], ["1", "11", "21", "31", "41"]);
      assert.equal(refs.get("21").frameId, "frame-same");
      assert.equal(refs.get("41").frameId, "frame-oopif");
      assert.equal(refs.get("41").backendNodeId, 21);

      for (const [ref, expectedSession] of [
        ["@21", "session:target-1"],
        ["@41", "session:oopif"],
      ]) {
        await page.snapshot(options);
        const beforeAction = fixture.calls.length;
        await page.click(ref);
        const actionCalls = fixture.calls.slice(beforeAction);
        const resolutions = actionCalls.filter(
          ([kind, method, params]) =>
            kind === "cdp" &&
            method === "DOM.resolveNode" &&
            params.backendNodeId === 21,
        );
        assert(resolutions.length > 0, `${ref} resolves its native node`);
        assert(
          resolutions.every(([, , , session]) => session === expectedSession),
          `${ref} resolves the colliding backendNodeId only in its own frame`,
        );
        assert(
          actionCalls.some(
            ([kind, method, params, session]) =>
              kind === "cdp" &&
              method === "Input.dispatchMouseEvent" &&
              params.type === "mouseReleased" &&
              session === expectedSession,
          ),
          `${ref} dispatches its click in the expected session`,
        );
      }
    });
  }
});

test("a viewport snapshot preserves previously registered offscreen iframe refs", async () => {
  await withFixture(async (fixture) => {
    const snapshotFixture = async ({ scope }) => {
      if (scope === "only_within_viewport") {
        return { content: 'root\n  heading "Host"', refs: [] };
      }
      return {
        content: [
          "root",
          '  heading "Host"',
          "  iframe [ref=11]",
          "    root",
          '      button "Hidden frame action" [ref=21]',
        ].join("\n"),
        refs: [
          { refId: 11, backendNodeId: 11, role: "iframe" },
          { refId: 21, backendNodeId: 21, role: "button" },
        ],
      };
    };
    const task = taskForRound(fixture, "round-a", {
      snapshot: snapshotFixture,
    });
    const page = await openTestPage(task, "https://example.test/iframe-host");
    await page.snapshot({ scope: "full_page" });
    assert.equal(
      fixture.services.pageRefs.forTarget(page.targetId).get("21")
        .backendNodeId,
      21,
      "the full snapshot initially advertises the iframe descendant",
    );

    const snapshot = await page.snapshot();

    assert.doesNotMatch(snapshot, /iframe \[ref=/);
    assert.doesNotMatch(snapshot, /Hidden frame action/);
    assert.equal(
      fixture.services.pageRefs.forTarget(page.targetId).get("11")
        .backendNodeId,
      11,
    );
    assert.equal(
      fixture.services.pageRefs.forTarget(page.targetId).get("21")
        .backendNodeId,
      21,
      "a partial viewport snapshot must not invalidate an omitted ref",
    );
    assert.equal(
      fixture.services.pageRefs.isInvalidated(page.targetId, "21"),
      false,
    );
  });
});

test("a subtree snapshot preserves refs outside the observed subtree", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", {
      async snapshot(options) {
        if (options.scope === "full_page") {
          return {
            content: [
              "root",
              '  button "First" [ref=21]',
              '  button "Second" [ref=22]',
            ].join("\n"),
            refs: [
              { refId: 21, backendNodeId: 21, role: "button", name: "First" },
              { refId: 22, backendNodeId: 22, role: "button", name: "Second" },
            ],
          };
        }
        return {
          content: ['button "First" [ref=21]'].join("\n"),
          refs: [
            { refId: 21, backendNodeId: 21, role: "button", name: "First" },
          ],
        };
      },
    });
    const page = await openTestPage(task, "https://example.test/two-actions");
    await page.snapshot({ scope: "full_page" });

    await page.snapshot({ scope: "subtree", root: "@21" });

    assert.equal(
      fixture.services.pageRefs.forTarget(page.targetId).get("22")
        .backendNodeId,
      22,
    );
    assert.equal(
      fixture.services.pageRefs.isInvalidated(page.targetId, "22"),
      false,
    );
  });
});

test("subtree snapshots preserve saved sibling roots when native refs are reused", async () => {
  await withFixture(async (fixture) => {
    const requestedRoots = [];
    const task = taskForRound(fixture, "round-a", {
      async snapshot(options) {
        if (options.scope !== "subtree") {
          return {
            content: "root\n  iframe [ref=1]\n  iframe [ref=2]",
            refs: [
              { refId: 1, backendNodeId: 35, role: "iframe" },
              { refId: 2, backendNodeId: 36, role: "iframe" },
            ],
          };
        }
        requestedRoots.push(options.root);
        return {
          content: 'iframe [ref=1]\n  button "First frame action" [ref=2]',
          refs: [
            { refId: 1, backendNodeId: options.root, role: "iframe" },
            {
              refId: 2,
              backendNodeId: 43,
              role: "button",
              frameId: "frame-child",
            },
          ],
        };
      },
    });
    const page = await openTestPage(task, "https://example.test/siblings");
    await page.snapshot();
    const first = await page.snapshot({ scope: "subtree", root: "@1" });
    assert.doesNotMatch(first, /button.*\[ref=2\]/);
    await page.snapshot({ scope: "subtree", root: "@2" });
    assert.deepEqual(requestedRoots, [35, 36]);
  });
});

test("a subtree snapshot inherits the root ref frame provenance", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", {
      async ensureFrameSessions() {
        return new Map([["frame-child", "session:target-1"]]);
      },
      async snapshot(options) {
        if (options.scope === "full_page") {
          return {
            content: [
              "root",
              "  iframe [ref=11]",
              "    root",
              '      button "Frame root" [ref=21]',
            ].join("\n"),
            refs: [
              { refId: 11, backendNodeId: 11, role: "iframe" },
              {
                refId: 21,
                backendNodeId: 21,
                role: "button",
                name: "Frame root",
              },
            ],
          };
        }
        return {
          content: [
            'button "Frame root" [ref=21]',
            '  link "Frame child" [ref=22]',
          ].join("\n"),
          refs: [
            {
              refId: 21,
              backendNodeId: 21,
              role: "button",
              name: "Frame root",
            },
            {
              refId: 22,
              backendNodeId: 22,
              role: "link",
              name: "Frame child",
            },
          ],
        };
      },
    });
    const page = await openTestPage(task, "https://example.test/frame");
    await page.snapshot({ scope: "full_page" });

    await page.snapshot({ scope: "subtree", root: "@21" });

    assert.deepEqual(
      fixture.services.pageRefs.forTarget(page.targetId).get("22"),
      {
        backendNodeId: 22,
        role: "link",
        name: "Frame child",
        nth: undefined,
        frameId: "frame-child",
        frameProvenance: "frame",
      },
    );
  });
});

for (const expression of ["document.title", () => document.title]) {
  test(`Page evaluate preserves snapshot refs for a read-only ${typeof expression}`, async () => {
    await withFixture(async (fixture) => {
      const task = taskForRound(fixture, "round-a");
      const page = await openTestPage(task, "https://example.test/select");
      await page.snapshot({ scope: "full_page" });
      await page.evaluate(expression);

      assert.deepEqual(await page.selectOption("@21", "nl"), ["nl"]);
      assert.equal(
        fixture.calls.filter(([kind]) => kind === "snapshot").length,
        1,
        "reading the Page must not require a new snapshot",
      );
      assert.equal(
        fixture.calls.find(([, method]) => method === "DOM.resolveNode")[2]
          .backendNodeId,
        21,
      );
    });
  });
}

test("read-only evaluate preserves a published ref across Agent rounds", async () => {
  await withFixture(async (fixture) => {
    const page = await openTestPage(
      taskForRound(fixture, "round-a"),
      "https://example.test/select",
    );
    await page.snapshot();
    const inspected = taskForRound(fixture, "round-b", {
      pageRefs: new PageRefRegistry(),
    }).page(page.label);
    await inspected.evaluate("document.title");
    const restored = taskForRound(fixture, "round-c", {
      pageRefs: new PageRefRegistry(),
    }).page(page.label);

    assert.deepEqual(await restored.selectOption("@21", "nl"), ["nl"]);
    assert.equal(
      fixture.calls.filter(([kind]) => kind === "snapshot").length,
      1,
      "each round must reuse the original published mapping",
    );
    assert.equal(
      fixture.calls.find(([, method]) => method === "DOM.resolveNode")[2]
        .backendNodeId,
      21,
    );
  });
});

test("subtree snapshot resolves its root in the addressed Page", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    const second = await openTestPage(task, "https://example.test/second");

    await first.snapshot();
    await second.snapshot();
    assert.equal(fixture.activeTarget(), "target-2");

    assert.match(
      await first.snapshot({ scope: "subtree", root: "ref=21" }),
      /\[p1 .*space "research"\(7\).*\]\nsnapshot:https:\/\/example\.test\/first/,
    );
    assert.equal(fixture.activeTarget(), "target-1");
    assert.deepEqual(fixture.snapshotOptions.at(-1), {
      scope: "subtree",
      root: 21,
      includeActionMarks: true,
      includeStableLocator: true,
    });
  });
});

test("metadata reads stay target-scoped while evaluate and screenshot activate their Page", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");

    assert.equal(fixture.activeTarget(), "target-2");
    assert.equal(await first.url(), "https://example.test/first");
    assert.equal(await first.title(), "https://example.test/first");
    assert.deepEqual(await first.info(), {
      url: "https://example.test/first",
      title: "https://example.test/first",
      w: 801,
      h: 600,
      sx: 0,
      sy: 0,
      pw: 1200,
      ph: 900,
    });
    assert.equal(
      fixture.activeTarget(),
      "target-2",
      "metadata reads must not activate the addressed page",
    );
    assert.deepEqual(
      await first.evaluate((value) => value, { source: "first" }),
      { source: "first" },
    );
    assert.equal(
      fixture.activeTarget(),
      "target-1",
      "page.evaluate must activate the page whose JavaScript it runs",
    );
    assert.equal(
      await first.screenshot({ path: "/tmp/first.png", fullPage: true }),
      "/tmp/first.png",
    );
    assert(
      fixture.calls.some(
        ([kind, path, options, sessionId]) =>
          kind === "screenshot" &&
          path === "/tmp/first.png" &&
          options.full === true &&
          !Object.hasOwn(options, "fullPage") &&
          sessionId === "session:target-1",
      ),
      "page.screenshot must map Playwright-style options to the v1 capture driver",
    );
    await assert.rejects(
      () => first.screenshot({ path: "/tmp/device.png", scale: "device" }),
      /scale must be one of css/,
    );
    assert.equal(
      await first.screenshot({ path: "/tmp/css.png", scale: "css" }),
      "/tmp/css.png",
    );
    assert(
      fixture.calls.some(
        ([kind, path, options, sessionId]) =>
          kind === "screenshot" &&
          path === "/tmp/css.png" &&
          options.scale === "css" &&
          sessionId === "session:target-1",
      ),
      "page.screenshot must forward the explicit scale mode",
    );
    await assert.rejects(
      () => first.screenshot("/tmp/legacy.png"),
      /options must be an object/,
    );
    for (const path of ["./step1-initial.png", "shots/before.png", ""]) {
      await assert.rejects(
        () => first.screenshot({ path }),
        /page\.screenshot path must be an absolute file path/,
        `page.screenshot must reject the relative path ${JSON.stringify(path)}`,
      );
    }
    assert(
      !fixture.calls.some(
        ([kind, path]) => kind === "screenshot" && !path.startsWith("/"),
      ),
      "relative screenshot paths must be rejected before capture",
    );
    assert.equal(
      fixture.activeTarget(),
      "target-1",
      "screenshot must activate the page before visual capture",
    );

    const pageCalls = fixture.calls.filter(
      ([kind, , , sessionId]) =>
        (kind === "cdp" || kind === "screenshot") &&
        sessionId === "session:target-1",
    );
    assert(pageCalls.length >= 5);
    assert(
      pageCalls.every(([, , , sessionId]) => sessionId === "session:target-1"),
    );
    const pageEvaluation = pageCalls.find(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Runtime.evaluate" &&
        params.expression.includes("__egoPageEvaluate"),
    );
    assert.match(pageEvaluation[2].expression, /value.*=> value/);
    assert.match(pageEvaluation[2].expression, /source/);
    assert.equal(
      pageCalls.some(
        ([kind, method]) =>
          kind === "cdp" && method === "Runtime.callFunctionOn",
      ),
      false,
    );
  });
});

test("Page evaluate rejects ambiguous or non-serializable arguments", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/evaluate");
    const cyclic = {};
    cyclic.self = cyclic;

    await assert.rejects(
      () => page.evaluate("document.title", { ignored: true }),
      /string expression does not accept an argument/,
    );
    await assert.rejects(
      () => page.evaluate((value) => value, cyclic),
      /argument must be JSON-serializable/,
    );
    await assert.rejects(
      () => page.evaluate(42),
      /expects a function or string expression/,
    );
  });
});

test("Page evaluate follows JSON omission rules in one CDP request", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/evaluate");
    fixture.calls.length = 0;

    const result = await page.evaluate((value) => value, {
      kept: 1,
      omitted: undefined,
      list: [undefined, "ready"],
    });

    assert.deepEqual(result, { kept: 1, list: [null, "ready"] });
    const evaluationCalls = fixture.calls.filter(
      ([kind, method]) =>
        kind === "cdp" &&
        (method === "Runtime.evaluate" ||
          method === "Runtime.callFunctionOn" ||
          method === "Runtime.releaseObject"),
    );
    assert.equal(evaluationCalls.length, 1);
    assert.equal(evaluationCalls[0][1], "Runtime.evaluate");
    assert.match(evaluationCalls[0][2].expression, /__egoPageEvaluate/);
  });
});

test("Page evaluate preserves a large nested JSON argument", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(
      task,
      "https://example.test/evaluate-complex",
    );
    const argument = {
      marker: "复杂 input 😀 quotes: \" ' ` and a newline\n",
      config: {
        enabled: true,
        nullable: null,
        flags: [true, false, null],
        nested: { level: { value: "深层值" } },
      },
      rows: Array.from({ length: 128 }, (_, index) => ({
        id: index,
        label: `row-${index}-数据`,
        tags: [`tag-${index % 7}`, "共享", `quoted-\"${index}\"`],
        metrics: { value: index * 3, valid: index % 2 === 0 },
      })),
    };

    const result = await page.evaluate(async (input) => input, argument);

    assert.deepEqual(result, argument);
    assert.equal(fixture.activeTarget(), page.targetId);
  });
});

test("Page evaluate preserves user exceptions that resemble protocol timeouts", async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (
          method === "Runtime.evaluate" &&
          params.expression.includes("userTimeoutLikeError")
        ) {
          return {
            result: {
              type: "object",
              subtype: "error",
              description: "Error: Execution was terminated",
            },
            exceptionDetails: { text: "Uncaught" },
          };
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      },
    });
    const page = await openTestPage(task, "https://example.test/evaluate");

    await assert.rejects(
      () =>
        page.evaluate(function userTimeoutLikeError() {
          throw new Error("Execution was terminated");
        }),
      (error) => {
        assert.equal(error.code, undefined);
        assert.match(error.message, /Execution was terminated/);
        return true;
      },
    );
  });
});

test("Page.waitForFunction gives one predicate the remaining overall timeout", async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let timedCall;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (
          method === "Runtime.evaluate" &&
          params.expression.includes("__egoWaitForFunction")
        ) {
          timedCall = { params, timeoutMs };
          return {
            result: {
              type: "object",
              value: {
                matched: true,
                url: "https://example.test/wait",
                title: "wait",
              },
            },
          };
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      },
    });
    const page = await openTestPage(task, "https://example.test/wait");

    assert.equal(
      await page.waitForFunction(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          return true;
        },
        undefined,
        { timeout: 2_500 },
      ),
      true,
    );
    assert.equal(timedCall.params.timeout, 2_500);
    assert.equal(timedCall.timeoutMs, 2_750);
  });
});

test("Page evaluate gives synchronous code an execution deadline", async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let first = true;
    let timedCall;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (
          first &&
          method === "Runtime.evaluate" &&
          params.expression.includes("__egoPageEvaluate")
        ) {
          first = false;
          timedCall = { params, timeoutMs };
          throw new Error("Execution was terminated");
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      },
    });
    const page = await openTestPage(task, "https://example.test/evaluate");

    await assert.rejects(
      () =>
        page.evaluate(() => {
          while (true) {}
        }),
      (error) => {
        assert.equal(error.code, "EGO_PAGE_EVALUATION_TIMED_OUT");
        assert.equal(error.executionStopped, true);
        assert.equal(error.mayHaveLateEffects, true);
        assert.equal(error.pageResponsive, true);
        assert.match(error.message, /execution was stopped/i);
        return true;
      },
    );
    assert.equal(timedCall.params.timeout, 14_000);
    assert.equal(timedCall.timeoutMs, 15_000);
    assert.deepEqual(await page.evaluate((value) => value, "ready"), "ready");
  });
});

test("Page evaluate distinguishes a responsive pending promise from a stuck renderer", async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let first = true;
    let probes = 0;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (
          first &&
          method === "Runtime.evaluate" &&
          params.expression.includes("__egoPageEvaluate")
        ) {
          first = false;
          throw new CdpRequestTimeoutError(method, timeoutMs, sessionId);
        }
        if (method === "Runtime.evaluate" && params.expression === "1") {
          probes += 1;
          return { result: { type: "number", value: 1 } };
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      },
    });
    const page = await openTestPage(task, "https://example.test/evaluate");

    await assert.rejects(
      () => page.evaluate(async () => new Promise(() => {})),
      (error) => {
        assert.equal(error.code, "EGO_PAGE_EVALUATION_TIMED_OUT");
        assert.equal(error.executionStopped, false);
        assert.equal(error.mayHaveLateEffects, true);
        assert.equal(error.pageResponsive, true);
        assert.match(error.message, /still pending/i);
        return true;
      },
    );
    assert.equal(probes, 1);
    assert.equal(
      fixture.calls.some(
        ([kind, method]) =>
          kind === "cdp" && method === "Runtime.terminateExecution",
      ),
      false,
    );
  });
});

test("Page evaluate terminates execution only after its health probe also times out", async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let initial = true;
    let healthChecks = 0;
    let terminateCalls = 0;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (
          initial &&
          method === "Runtime.evaluate" &&
          params.expression.includes("__egoPageEvaluate")
        ) {
          initial = false;
          throw new CdpRequestTimeoutError(method, timeoutMs, sessionId);
        }
        if (method === "Runtime.evaluate" && params.expression === "1") {
          healthChecks += 1;
          if (healthChecks === 1) {
            throw new CdpRequestTimeoutError(method, timeoutMs, sessionId);
          }
          return { result: { type: "number", value: 1 } };
        }
        if (method === "Runtime.terminateExecution") {
          terminateCalls += 1;
          return {};
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      },
    });
    const page = await openTestPage(task, "https://example.test/evaluate");

    await assert.rejects(
      () =>
        page.evaluate(() => {
          while (true) {}
        }),
      (error) => {
        assert.equal(error.code, "EGO_PAGE_EVALUATION_TIMED_OUT");
        assert.equal(error.executionStopped, true);
        assert.equal(error.mayHaveLateEffects, true);
        assert.equal(error.pageResponsive, true);
        assert.match(error.message, /renderer stopped responding/i);
        return true;
      },
    );
    assert.equal(terminateCalls, 1);
    assert.equal(healthChecks, 2);
  });
});

test("Page evaluate retries when termination is consumed by the first recovery probe", async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let initial = true;
    let healthChecks = 0;
    let terminateCalls = 0;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (
          initial &&
          method === "Runtime.evaluate" &&
          params.expression.includes("__egoPageEvaluate")
        ) {
          initial = false;
          throw new CdpRequestTimeoutError(method, timeoutMs, sessionId);
        }
        if (method === "Runtime.evaluate" && params.expression === "1") {
          healthChecks += 1;
          if (healthChecks === 1) {
            throw new CdpRequestTimeoutError(method, timeoutMs, sessionId);
          }
          if (healthChecks === 2) {
            throw new Error("Execution was terminated");
          }
          return { result: { type: "number", value: 1 } };
        }
        if (method === "Runtime.terminateExecution") {
          terminateCalls += 1;
          return {};
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      },
    });
    const page = await openTestPage(task, "https://example.test/evaluate");

    await assert.rejects(
      () =>
        page.evaluate(() => {
          while (true) {}
        }),
      (error) => {
        assert.equal(error.code, "EGO_PAGE_EVALUATION_TIMED_OUT");
        assert.equal(error.executionStopped, true);
        assert.equal(error.pageResponsive, true);
        return true;
      },
    );
    assert.equal(terminateCalls, 1);
    assert.equal(healthChecks, 3);
  });
});

test("Page fetch activates its target and returns a structured non-2xx response", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");

    const response = await first.fetch("/api/teapot", {
      method: "POST",
      headers: { "x-request": "page-fetch" },
      body: "payload",
      timeout: 250,
    });

    assert.deepEqual(response, {
      ok: false,
      status: 418,
      statusText: "I'm a Teapot",
      url: "https://example.test/api/teapot",
      headers: {
        "content-type": "text/plain",
        "x-fixture": "page-fetch",
      },
      body: "short and stout",
    });
    assert.equal(fixture.activeTarget(), first.targetId);
    const fetchCall = fixture.calls.find(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Runtime.evaluate" &&
        params.expression.includes("__egoPageEvaluate") &&
        params.expression.includes("window.fetch"),
    );
    const argumentMatch = /JSON\.parse\(("(?:\\.|[^"\\])*")\)/.exec(
      fetchCall[2].expression,
    );
    assert.deepEqual(JSON.parse(JSON.parse(argumentMatch[1])), {
      url: "/api/teapot",
      options: {
        method: "POST",
        headers: { "x-request": "page-fetch" },
        body: "payload",
      },
      timeoutMs: 250,
      responseType: "text",
    });
    assert.equal(fetchCall[3], "session:target-1");
    assert.equal(fetchCall[4], 1_250);
  });
});

test("Page fetch validates its JSON options and millisecond timeout", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/fetch");
    const cyclic = {};
    cyclic.self = cyclic;

    await assert.rejects(
      () => page.fetch("/api/text", { timeout: 0 }),
      /positive number of milliseconds/,
    );
    await assert.rejects(
      () => page.fetch("/api/text", { signal: {} }),
      /page\.fetch received unknown option: signal/,
    );
    await assert.rejects(
      () => page.fetch("/api/text", { headers: cyclic }),
      /headers must be an object with string values/,
    );
  });
});

test("Page fetch reports browser CORS failures without an evaluation wrapper", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/fetch");
    fixture.failNextFetch(
      'page.fetch uses window.fetch and obeys browser CORS. Request "https://cdn.example.test/image.png" from "https://example.test" failed: TypeError: Failed to fetch',
    );

    await assert.rejects(
      () => page.fetch("https://cdn.example.test/image.png"),
      (error) => {
        assert.match(error.message, /page\.fetch uses window\.fetch/);
        assert.match(error.message, /obeys browser CORS/);
        assert.doesNotMatch(error.message, /JavaScript evaluation failed/);
        return true;
      },
    );
  });
});

test("Page fetch saves a binary response without converting it to text", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/fetch");
    const path = join(fixture.rootDir, "downloads", "image.png");

    const response = await page.fetch("/image.png", { saveAs: path });

    assert.equal(response.savedPath, path);
    assert.equal(response.body, undefined);
    assert.deepEqual(await readFile(path), Buffer.from("\x89PNG\r\n\x1a\n"));
  });
});

test("Page fetch rejects a relative saveAs path before requesting", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/fetch");

    await assert.rejects(
      () => page.fetch("/image.png", { saveAs: "./image.png" }),
      /page\.fetch saveAs must be an absolute file path/,
    );
  });
});

test("Page click fails closed when native mouse dispatch times out", async () => {
  await withFixture(async (fixture) => {
    fixture.tabs.set("target-user", {
      targetId: "target-user",
      url: "https://example.test/user",
      title: "Existing user page",
      active: false,
    });
    const task = taskForRound(fixture, "round-a", { pageBudget: 2 });
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");
    fixture.openPopupOnNextClick("https://example.test/popup");
    fixture.timeoutNextMouseDispatch();

    await assert.rejects(
      () => first.click("#open-popup"),
      /CDP request timed out: Input\.dispatchMouseEvent/,
    );
    const inventory = await task.tabs();
    assert.equal(
      inventory.find((item) => item.targetId === "target-user").label,
      undefined,
      "a tab that existed before the action must remain untracked",
    );
    assert.equal(
      inventory.some((item) => item.targetId === "target-3"),
      false,
    );
    assert(
      fixture.calls.some(
        ([kind, method, , sessionId]) =>
          kind === "cdp" &&
          method === "Input.dispatchMouseEvent" &&
          sessionId === "session:target-1",
      ),
    );
    assert.equal(
      fixture.activeTarget(),
      "target-1",
      "click must leave its Page active",
    );
  });
});

test("Page click returns a pending JavaScript dialog without waiting for input completion", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/dialog");
    fixture.openDialogOnNextClick();

    assert.deepEqual(await page.click("#open-dialog"), {
      dialog: {
        type: "alert",
        message: "Confirm action",
        url: "https://example.test/dialog",
      },
    });
    assert.deepEqual(await page.info(), {
      dialog: {
        type: "alert",
        message: "Confirm action",
        url: "https://example.test/dialog",
      },
    });

    const activationsBeforeHandle = fixture.calls.filter(
      ([kind, method]) => kind === "cdp" && method === "Target.activateTarget",
    ).length;
    assert.equal(await page.acceptDialog(), true);
    assert.equal(await page.acceptDialog(), false);
    assert.equal(
      fixture.calls.filter(
        ([kind, method]) =>
          kind === "cdp" && method === "Target.activateTarget",
      ).length,
      activationsBeforeHandle,
      "handling a modal dialog must not re-activate its already active Page",
    );
    assert(
      fixture.calls.some(
        ([kind, method, , sessionId]) =>
          kind === "cdp" &&
          method === "Page.handleJavaScriptDialog" &&
          sessionId === "session:target-1",
      ),
    );
    assert.equal((await page.info()).url, "https://example.test/dialog");
  });
});

test("a no-dialog response keeps current snapshot refs", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/dialog");
    await page.snapshot({ scope: "full_page" });

    assert.equal(
      fixture.services.pageRefs.forTarget(page.targetId).get("21")
        .backendNodeId,
      21,
    );
    assert.equal(await page.dismissDialog(), false);
    assert.equal(
      fixture.services.pageRefs.forTarget(page.targetId).get("21")
        .backendNodeId,
      21,
      "an idempotent no-dialog call must not invalidate an unchanged DOM",
    );
  });
});

test("Page accepts prompt text and dismisses dialogs on its own session", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    const second = await openTestPage(task, "https://example.test/second");

    fixture.openDialogOnNextClick({
      type: "prompt",
      message: "Choose a name",
      defaultPrompt: "guest",
    });
    const promptReceipt = await first.click("#prompt");
    assert.equal(promptReceipt.dialog.defaultPrompt, "guest");
    assert.equal(await second.dismissDialog(), false);
    assert.equal(await first.acceptDialog("agent"), true);

    fixture.openDialogOnNextClick({ type: "confirm", message: "Continue?" });
    await first.click("#confirm");
    assert.equal(await first.dismissDialog(), true);

    const dialogCalls = fixture.calls.filter(
      ([kind, method]) =>
        kind === "cdp" && method === "Page.handleJavaScriptDialog",
    );
    assert.deepEqual(
      dialogCalls.map(([, , params, sessionId]) => [params, sessionId]),
      [
        [{ accept: false }, "session:target-2"],
        [{ accept: true, promptText: "agent" }, "session:target-1"],
        [{ accept: false }, "session:target-1"],
      ],
    );
  });
});

test("Page fill uses its target session and reports no popup when none opened", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");

    assert.deepEqual(await first.fill("#text-input", "filled"), {});
    const insertText = fixture.calls.find(
      ([kind, method]) => kind === "cdp" && method === "Input.insertText",
    );
    assert.deepEqual(insertText, [
      "cdp",
      "Input.insertText",
      { text: "filled" },
      "session:target-1",
    ]);
    const fillPreparation = fixture.calls.find(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Runtime.callFunctionOn" &&
        params.functionDeclaration.includes("fillPreparation"),
    );
    assert(fillPreparation, "fill must validate and select the target element");
    assert.deepEqual(
      fixture.calls.find(([kind]) => kind === "showAgentMousePosition"),
      ["showAgentMousePosition", 40, 60],
      "fill must move the visible agent cursor to its focused element",
    );
    assert.equal(
      fixture.calls.some(
        ([kind, method]) =>
          kind === "cdp" && method === "Input.dispatchMouseEvent",
      ),
      false,
      "the fill cursor hint must not synthesize a website mouse event",
    );
    assert.equal(
      fixture.calls.some(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Runtime.callFunctionOn" &&
          params.functionDeclaration.includes(
            "dispatchEvent(new Event('change'",
          ),
      ),
      false,
      "ordinary text fill must rely on native input instead of duplicate synthetic events",
    );
    assert.equal(
      fixture.activeTarget(),
      "target-1",
      "fill must leave its Page active",
    );
  });
});

test("Page fill retries an unchanged contenteditable once with a real click", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/editor");
    fixture.configureFill({
      kind: "contenteditable",
      initialText: "old text",
      ignoreInsertions: 1,
    });
    fixture.calls.length = 0;

    assert.deepEqual(await page.fill("[contenteditable]", "new text"), {});
    assert.equal(fixture.fillText(), "new text");
    assert.equal(
      fixture.calls.filter(
        ([kind, method]) => kind === "cdp" && method === "Input.insertText",
      ).length,
      2,
      "the standard input attempt should run once before the pointer fallback",
    );
    assert.deepEqual(
      fixture.calls
        .filter(
          ([kind, method]) =>
            kind === "cdp" && method === "Input.dispatchMouseEvent",
        )
        .map(([, , params]) => params.type),
      ["mouseMoved", "mousePressed", "mouseReleased"],
      "the fallback should perform exactly one real click",
    );
  });
});

test("Page fill refuses a pointer fallback that would activate an interactive descendant", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/editor");
    fixture.configureFill({
      kind: "contenteditable",
      initialText: "linked text",
      ignoreInsertions: 1,
    });
    fixture.configureUnsafeFillActivation(
      '<a href="https://example.test/link">',
    );
    fixture.calls.length = 0;

    await assert.rejects(
      () => page.fill("[contenteditable]", "replacement"),
      (error) => {
        assert.equal(error.kind, "permanent");
        assert.match(error.message, /cannot safely activate.*<a href=/i);
        return true;
      },
    );
    assert.equal(
      fixture.calls.some(
        ([kind, method]) =>
          kind === "cdp" && method === "Input.dispatchMouseEvent",
      ),
      false,
      "a fill fallback must not click an interactive descendant",
    );
  });
});

test("Page fill rejects when a contenteditable still ignores the pointer fallback", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/editor");
    fixture.configureFill({
      kind: "contenteditable",
      initialText: "old text",
      ignoreInsertions: 2,
    });

    await assert.rejects(
      () => page.fill("[contenteditable]", "new text"),
      /did not accept the text.*click the editor and use page\.keyboard/i,
    );
    assert.equal(fixture.fillText(), "old text");
  });
});

test("Page fill retries an unchanged regular input once with a real click", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/form");
    fixture.configureFill({ kind: "input", ignoreInsertions: 1 });
    fixture.calls.length = 0;

    assert.deepEqual(
      await page.fill("input[name=email]", "user@example.test"),
      {},
    );
    assert.equal(fixture.fillText(), "user@example.test");
    assert.deepEqual(
      fixture.calls
        .filter(
          ([kind, method]) =>
            kind === "cdp" && method === "Input.dispatchMouseEvent",
        )
        .map(([, , params]) => params.type),
      ["mouseMoved", "mousePressed", "mouseReleased"],
    );
  });
});

test("Page fill accepts application formatting without a pointer retry", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/formatted");
    fixture.configureFill({
      kind: "input",
      initialText: "$600,000",
      transform: (text) => `$${Number(text).toLocaleString("en-US")}`,
    });
    fixture.calls.length = 0;

    assert.deepEqual(await page.fill("#price", "610000"), {});
    assert.equal(fixture.fillText(), "$610,000");
    assert.equal(
      fixture.calls.filter(
        ([kind, method]) => kind === "cdp" && method === "Input.insertText",
      ).length,
      1,
      "a semantically equivalent formatted value must not be typed twice",
    );
  });
});

test("Page fill retries an appended value and accepts the transformed retry", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/formatted");
    fixture.configureFill({
      kind: "input",
      initialText: "$600,000",
      transform: (text, current, attempt) =>
        attempt === 1
          ? current + text
          : `$${Number(text).toLocaleString("en-US")}`,
    });
    fixture.calls.length = 0;

    assert.deepEqual(await page.fill("#price", "610000"), {});
    assert.equal(fixture.fillText(), "$610,000");
    assert.equal(
      fixture.calls.filter(
        ([kind, method]) => kind === "cdp" && method === "Input.insertText",
      ).length,
      2,
    );
  });
});

test("Page fill accepts a controlled component transformation", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/controlled");
    fixture.configureFill({
      kind: "input",
      initialText: "old",
      transform: (text) => text.toUpperCase(),
    });

    assert.deepEqual(await page.fill("#controlled", "hello"), {});
    assert.equal(fixture.fillText(), "HELLO");
  });
});

test("Page selectOption selects values through the addressed Page", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/form");

    assert.deepEqual(await page.selectOption("#country", "nl"), ["nl"]);
    assert.deepEqual(await page.selectOption("#tags", ["one", "two"]), [
      "one",
      "two",
    ]);
    assert.deepEqual(fixture.selectedValues(), ["one", "two"]);
  });
});

test("Page selectOption accepts Playwright-style labels, values, and indexes", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/form");

    fixture.configureSelectOptions([
      { value: "09", label: "September" },
      { value: "10", label: "October" },
    ]);
    assert.deepEqual(await page.selectOption("#month", { label: "October" }), [
      "10",
    ]);
    fixture.configureSelectOptions([
      { value: "AZ", label: "Arizona" },
      { value: "CA", label: "California" },
    ]);
    assert.deepEqual(await page.selectOption("#state", "Arizona"), ["AZ"]);
    fixture.configureSelectOptions([
      { value: "one", label: "One" },
      { value: "two", label: "Two" },
    ]);
    assert.deepEqual(
      await page.selectOption("#tags", [{ value: "one" }, { index: 1 }]),
      ["one", "two"],
    );
  });
});

test("Page selectOption validates option descriptors", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/form");

    assert.deepEqual(await page.selectOption("#month", null), []);
    assert.deepEqual(await page.selectOption("#month", []), []);
    await assert.rejects(
      () => page.selectOption("#month", {}),
      /must specify value, label, or index/,
    );
    await assert.rejects(
      () => page.selectOption("#month", { index: -1 }),
      /index must be a non-negative integer/,
    );
    await assert.rejects(
      () => page.selectOption("#month", { text: "October" }),
      /unknown field "text"/,
    );
  });
});

test("Page selectOption clears existing values before applying new choices", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/form");
    await page.selectOption("#tags", ["one", "two"]);

    const actionCall = fixture.calls.find(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Runtime.callFunctionOn" &&
        params.functionDeclaration.includes("selectOptionsForAction"),
    );
    assert(actionCall, "selectOption sends its browser-side action function");
    const selectOptionsForAction = Function(
      `return (${actionCall[2].functionDeclaration})`,
    )();
    const options = [
      { value: "one", label: "One", selected: false },
      { value: "two", label: "Two", selected: false },
      { value: "undefined", label: "Undefined", selected: true },
      { value: "", label: "None", selected: false },
    ];
    const select = {
      tagName: "SELECT",
      isConnected: true,
      disabled: false,
      multiple: true,
      options,
      ownerDocument: {
        defaultView: {
          getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        },
      },
      getBoundingClientRect: () => ({ width: 100, height: 30 }),
      get selectedOptions() {
        return options.filter((option) => option.selected);
      },
      dispatchEvent() {},
    };

    assert.deepEqual(selectOptionsForAction.call(select, ["one", "two"]), {
      selected: ["one", "two"],
    });
    assert.deepEqual(selectOptionsForAction.call(select, []), { selected: [] });
    assert.deepEqual(selectOptionsForAction.call(select, [""]), {
      selected: [""],
    });
    assert.deepEqual(
      options.filter((option) => option.selected).map((option) => option.value),
      [""],
      "an empty string is a valid option value",
    );
    assert.deepEqual(selectOptionsForAction.call(select, []), { selected: [] });

    options[1].disabled = true;
    assert.deepEqual(selectOptionsForAction.call(select, [{ value: "two" }]), {
      selected: ["two"],
    });
    assert.deepEqual(
      options.filter((option) => option.selected).map((option) => option.value),
      ["two"],
      "a disabled option remains programmatically selectable",
    );

    options[1].disabled = false;
    select.disabled = true;
    assert.deepEqual(selectOptionsForAction.call(select, ["one"]), {
      error: "element is disabled",
    });
    select.disabled = false;
    assert.deepEqual(selectOptionsForAction.call(select, ["one"]), {
      selected: ["one"],
    });

    select.getAttribute = (name) => (name === "aria-disabled" ? "true" : null);
    assert.deepEqual(selectOptionsForAction.call(select, ["one"]), {
      error: "element is disabled",
    });

    select.getAttribute = () => null;
    options[1].getAttribute = (name) =>
      name === "aria-disabled" ? "true" : null;
    assert.deepEqual(selectOptionsForAction.call(select, ["two"]), {
      selected: ["two"],
    });
  });
});

test("Page action receipts do not inject observation probes", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/before");
    fixture.navigateOnNextClick("https://example.test/after");
    fixture.calls.length = 0;

    assert.deepEqual(await page.click("#navigate"), {});
    assert.equal(await page.url(), "https://example.test/after");
    assert.equal(
      fixture.calls.some(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Runtime.evaluate" &&
          params.expression.includes("__egoBrowserActionProbes"),
      ),
      false,
    );
  });
});

test("Page pointer methods dispatch through the addressed target session", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");

    await first.dblclick("button.primary");
    await first.hover("button.primary");
    await first.dragAndDrop("#source", "#destination");

    const pointerCalls = fixture.calls.filter(
      ([kind, method]) =>
        kind === "cdp" && method === "Input.dispatchMouseEvent",
    );
    assert(pointerCalls.length >= 7);
    assert(
      pointerCalls.every((call) => call[3] === `session:${first.targetId}`),
      "all pointer events must use the addressed Page session",
    );
    assert(
      pointerCalls.every((call) => call.length === 4),
      "Page pointer input must use the runtime CDP timeout instead of a 1s action timeout",
    );
    assert.equal(
      fixture.calls.some(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Runtime.callFunctionOn" &&
          params.functionDeclaration.includes("__egoBrowserInputProbes"),
      ),
      false,
      "Page pointer input must not inject timeout probes into the site",
    );
    assert(
      pointerCalls.filter(
        ([, , params]) =>
          params.type === "mousePressed" && params.clickCount === 2,
      ).length === 1,
      "dblclick must finish with the second native press",
    );
    assert(
      pointerCalls.filter(([, , params]) => params.type === "mousePressed")
        .length >= 3,
      "dblclick must dispatch two press/release cycles before drag starts",
    );
    assert.equal(fixture.activeTarget(), first.targetId);
  });
});

test("Page mouse movement updates the Ego Lite agent cursor", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");

    await page.click("button.primary");
    await page.hover("button.primary");
    await page.dragAndDrop("#source", "#destination");
    await page.mouse.move(80, 100, { steps: 2 });

    const pageMoves = fixture.calls
      .filter(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchMouseEvent" &&
          params.type === "mouseMoved",
      )
      .map(([, , params]) => [params.x, params.y]);
    const visibleMoves = fixture.calls
      .filter(([kind]) => kind === "showAgentMousePosition")
      .map(([, x, y]) => [x, y]);

    assert.deepEqual(
      visibleMoves,
      pageMoves,
      "every successful page mouse move must update the visible agent cursor",
    );
  });
});

test("agent cursor rendering failures do not make successful page input retryable", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", {
      async showAgentMousePosition() {
        throw new Error("agent cursor overlay unavailable");
      },
    });
    const page = await openTestPage(task, "https://example.test/first");

    await page.click("button.primary");

    assert(
      fixture.calls.some(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchMouseEvent" &&
          params.type === "mouseReleased",
      ),
      "the website action still completes when only the visual cursor fails",
    );
  });
});

test("agent cursor animation does not delay page input completion", async () => {
  await withFixture(async (fixture) => {
    let finishAnimation;
    const animation = new Promise((resolve) => {
      finishAnimation = resolve;
    });
    const task = taskForRound(fixture, "round-a", {
      showAgentMousePosition() {
        return animation;
      },
    });
    const page = await openTestPage(task, "https://example.test/first");

    const outcome = await Promise.race([
      page.mouse.move(20, 30).then(() => "action-complete"),
      new Promise((resolve) =>
        setTimeout(() => resolve("animation-blocked"), 100),
      ),
    ]);
    finishAnimation();

    assert.equal(outcome, "action-complete");
  });
});

test("Page mouse primitives preserve button state on one target", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");

    await first.mouse.move(20, 30);
    await first.mouse.down();
    await first.mouse.move(40, 50);
    await first.mouse.up();
    await first.mouse.click(60, 70);
    await first.mouse.wheel(5, 120);

    const pointerCalls = fixture.calls.filter(
      ([kind, method]) =>
        kind === "cdp" && method === "Input.dispatchMouseEvent",
    );
    assert(pointerCalls.length >= 8);
    assert(
      pointerCalls.every((call) => call[3] === `session:${first.targetId}`),
    );
    assert(
      pointerCalls.some(
        ([, , params]) => params.type === "mouseMoved" && params.buttons === 1,
      ),
      "mouse.move must retain the pressed left button",
    );
    assert(
      pointerCalls.some(
        ([, , params]) =>
          params.type === "mouseWheel" &&
          params.deltaX === 5 &&
          params.deltaY === 120,
      ),
    );
    assert.equal(fixture.activeTarget(), first.targetId);
  });
});

test("Page mouse mirrors Playwright state, steps, and keyboard modifiers", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { platform: "darwin" });
    const page = await openTestPage(task, "https://example.test/first");

    await page.keyboard.down("Shift");
    await page.mouse.move(30, 20, { steps: 3 });
    await page.mouse.down({ button: "right" });
    await page.mouse.move(60, 50, { steps: 2 });
    await page.mouse.wheel(5, 10);
    await page.mouse.up({ button: "right" });
    await page.mouse.click(80, 70, { clickCount: 2 });
    await page.keyboard.up("Shift");

    const pointerCalls = fixture.calls.filter(
      ([kind, method]) =>
        kind === "cdp" && method === "Input.dispatchMouseEvent",
    );
    const moves = pointerCalls.filter(
      ([, , params]) => params.type === "mouseMoved",
    );
    assert.deepEqual(
      moves.slice(0, 3).map(([, , params]) => params.x),
      [10, 20, 30],
    );
    assert(
      moves
        .slice(0, 3)
        .every(
          ([, , params], index) =>
            Math.abs(params.y - (20 * (index + 1)) / 3) < 1e-9,
        ),
    );
    assert(
      pointerCalls.every(([, , params]) => params.modifiers === 8),
      "mouse input must carry the keyboard modifier state",
    );
    assert(
      moves
        .slice(3, 5)
        .every(
          ([, , params]) => params.button === "right" && params.buttons === 2,
        ),
      "mouse moves must retain the last pressed button",
    );
    assert.deepEqual(
      pointerCalls
        .filter(
          ([, , params]) => params.type === "mousePressed" && params.x === 80,
        )
        .map(([, , params]) => params.clickCount),
      [1, 2],
      "a double click must be two native click cycles",
    );
  });
});

test("Page mouse.wheel scrolls the addressed page", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");

    const sleepCountBeforeWheel = fixture.sleepDurations.length;
    await first.mouse.wheel(0, 450);

    const scrollCalls = fixture.calls.filter(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Input.dispatchMouseEvent" &&
        params.type === "mouseWheel",
    );
    assert(
      scrollCalls.length > 1,
      "a large wheel delta should be rendered as a short motion",
    );
    assert.equal(
      scrollCalls.reduce((total, [, , params]) => total + params.deltaY, 0),
      450,
    );
    assert(
      scrollCalls.every((call) => call[3] === `session:${first.targetId}`),
    );
    assert(
      fixture.sleepDurations
        .slice(sleepCountBeforeWheel)
        .reduce((total, duration) => total + duration, 0) <= 100,
      "the visual transition must stay short",
    );
    assert.equal(fixture.activeTarget(), first.targetId);
  });
});

test("Page keyboard press and type use the addressed target session", async () => {
  await withFixture(async (fixture) => {
    // Meta+A's native selectAll editing command is only synthesized on
    // darwin (see driver/keyboard.ts); pin the platform so this assertion
    // doesn't depend on the host OS actually running the test.
    const task = taskForRound(fixture, "round-a", { platform: "darwin" });
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");

    await first.keyboard.press("Meta+A");
    await first.keyboard.type("hello 世界");

    const keyCalls = fixture.calls.filter(
      ([kind, method]) =>
        kind === "cdp" &&
        (method === "Input.dispatchKeyEvent" || method === "Input.insertText"),
    );
    assert(keyCalls.length >= 3);
    assert(keyCalls.every((call) => call[3] === `session:${first.targetId}`));
    assert(
      keyCalls.every((call) => call.length === 4),
      "Page keyboard input must use the runtime CDP timeout instead of a 1s action timeout",
    );
    assert(
      keyCalls.some(
        ([, method, params]) =>
          method === "Input.dispatchKeyEvent" &&
          params.type === "rawKeyDown" &&
          params.code === "KeyA" &&
          params.modifiers === 4 &&
          params.commands?.includes("selectAll"),
      ),
      "Meta+A must retain the native selectAll editing command",
    );
    assert.deepEqual(
      keyCalls
        .filter(([, method]) => method === "Input.insertText")
        .map(([, , params]) => params.text),
      ["世", "界"],
      "characters outside the physical US layout use insertText",
    );
    assert.equal(fixture.activeTarget(), first.targetId);
  });
});

test("Page focus and selector-scoped press resolve and focus one element", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { platform: "darwin" });
    const page = await openTestPage(task, "https://example.test/editor");

    assert.deepEqual(await page.focus("[contenteditable]"), {});
    assert.deepEqual(
      await page.press("[contenteditable]", "ControlOrMeta+A", {
        delay: 5,
        timeout: 200,
      }),
      {},
    );

    const focusCalls = fixture.calls.filter(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Runtime.callFunctionOn" &&
        params.functionDeclaration.includes("focusElementForAction"),
    );
    assert.equal(focusCalls.length, 2);
    assert(focusCalls.every((call) => call[3] === `session:${page.targetId}`));
    const keyDown = fixture.calls.find(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Input.dispatchKeyEvent" &&
        params.type === "rawKeyDown" &&
        params.code === "KeyA",
    );
    assert.equal(keyDown[2].modifiers, 4);
  });
});

test("Page focus accepts a uniquely retargeted descendant", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/editor");
    fixture.configureFocusResult({ focused: true, retargeted: "descendant" });

    assert.deepEqual(await page.focus("#editor-wrapper"), {});
  });
});

test("Page focus reports ambiguous candidates once as a permanent failure", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/editor");
    fixture.configureFocusResult({
      error: "element contains multiple editable targets",
      details: {
        tagName: "TD",
        contentEditable: false,
        tabIndex: -1,
        activeTagName: "BODY",
        candidateCount: 2,
      },
    });
    fixture.calls.length = 0;

    await assert.rejects(
      () => page.focus("td"),
      (error) => {
        assert.equal(error.kind, "permanent");
        assert.match(
          error.message,
          /multiple editable targets.*td.*contenteditable=false.*tabIndex=-1.*active=body.*candidates=2/i,
        );
        return true;
      },
    );
    assert.equal(
      fixture.calls.filter(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Runtime.callFunctionOn" &&
          params.functionDeclaration.includes("focusElementForAction"),
      ).length,
      1,
      "a permanent focus failure must not consume the action timeout",
    );
  });
});

test("Page keyboard paste restores the clipboard after the native shortcut", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { platform: "darwin" });
    const page = await openTestPage(task, "https://example.test/table");

    assert.deepEqual(await page.keyboard.paste("a\tb\nc\td"), {});

    const writeIndex = fixture.calls.findIndex(
      (call) => call[0] === "clipboard" && call[1] === "write",
    );
    const pasteIndex = fixture.calls.findIndex(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Input.dispatchKeyEvent" &&
        params.type === "rawKeyDown" &&
        params.code === "KeyV",
    );
    const restoreIndex = fixture.calls.findIndex(
      (call) => call[0] === "clipboard" && call[1] === "restore",
    );
    assert(writeIndex >= 0 && writeIndex < pasteIndex);
    assert(pasteIndex < restoreIndex);
    assert.deepEqual(fixture.calls[writeIndex], [
      "clipboard",
      "write",
      "a\tb\nc\td",
    ]);
  });
});

test("Page keyboard paste forwards plain-text and HTML clipboard representations", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { platform: "darwin" });
    const page = await openTestPage(task, "https://example.test/table");
    const content = {
      text: "A\tB",
      html: "<table><tr><td>A</td><td>B</td></tr></table>",
    };

    assert.deepEqual(await page.keyboard.paste(content), {});
    assert.deepEqual(
      fixture.calls.find(
        (call) => call[0] === "clipboard" && call[1] === "write",
      ),
      ["clipboard", "write", content],
    );
  });
});

test("Page keyboard paste names the invalid argument type", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { platform: "win32" });
    const page = await openTestPage(task, "https://example.test/table");

    for (const [value, received] of [
      [undefined, "undefined"],
      [null, "null"],
      [["A", "B"], "an array"],
      [42, "number"],
    ]) {
      await assert.rejects(
        () => page.keyboard.paste(value),
        new RegExp(
          `requires a string or \\{ text, html\\? \\}, received ${received}$`,
        ),
      );
    }
    assert.equal(
      fixture.calls.some((call) => call[0] === "clipboard"),
      false,
    );
  });
});

test("Page keyboard paste still restores the clipboard when input fails", async () => {
  await withFixture(async (fixture) => {
    let restored = false;
    let failNextKey = true;
    const task = taskForRound(fixture, "round-a", {
      platform: "darwin",
      async withTemporaryClipboardText(_text, action) {
        try {
          return await action();
        } finally {
          restored = true;
        }
      },
      async cdp(method, params, sessionId, timeoutMs) {
        if (method === "Input.dispatchKeyEvent" && failNextKey) {
          failNextKey = false;
          throw new Error("keyboard transport failed");
        }
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      },
    });
    const page = await openTestPage(task, "https://example.test/table");

    await assert.rejects(
      () => page.keyboard.paste("one\ttwo"),
      /keyboard transport failed/,
    );
    assert.equal(restored, true);
  });
});

test("Page keyboard type uses the main keyboard for digits and period", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");

    await page.keyboard.type("0123456789.");

    const keyDowns = fixture.calls
      .filter(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchKeyEvent" &&
          params.type === "keyDown",
      )
      .map(([, , params]) => params);
    assert.deepEqual(
      keyDowns.map(({ key, code, location }) => ({ key, code, location })),
      [
        ...Array.from({ length: 10 }, (_, digit) => ({
          key: String(digit),
          code: `Digit${digit}`,
          location: 0,
        })),
        { key: ".", code: "Period", location: 0 },
      ],
    );
  });
});

test("Page keyboard mirrors Playwright key state and the US layout", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { platform: "darwin" });
    const page = await openTestPage(task, "https://example.test/first");

    await page.keyboard.down("Shift");
    await page.keyboard.down("a");
    await page.keyboard.down("a");
    await page.keyboard.up("a");
    await page.keyboard.up("Shift");
    await page.keyboard.press("Meta+V");
    await page.keyboard.press("Control++");
    await page.keyboard.insertText("世界");

    const keyEvents = fixture.calls
      .filter(
        ([kind, method]) =>
          kind === "cdp" && method === "Input.dispatchKeyEvent",
      )
      .map(([, , params]) => params);
    const aDowns = keyEvents.filter(
      (params) => params.type === "keyDown" && params.code === "KeyA",
    );
    assert.equal(aDowns[0].key, "A");
    assert.equal(aDowns[0].text, "A");
    assert.equal(aDowns[0].modifiers, 8);
    assert.equal(aDowns[0].autoRepeat, false);
    assert.equal(aDowns[1].autoRepeat, true);

    const paste = keyEvents.find(
      (params) => params.code === "KeyV" && params.type === "rawKeyDown",
    );
    assert.deepEqual(paste.commands, ["paste"]);
    const plus = keyEvents.find(
      (params) => params.key === "+" && params.type === "rawKeyDown",
    );
    assert.equal(plus.code, "Equal");
    assert.equal(plus.modifiers, 2);
    assert(
      fixture.calls.some(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.insertText" &&
          params.text === "世界",
      ),
    );
  });
});

test("Page keyboard maps portable editing shortcuts on macOS", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { platform: "darwin" });
    const page = await openTestPage(task, "https://example.test/first");

    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("ControlOrMeta+C");
    await page.keyboard.press("ControlOrMeta+V");
    await page.keyboard.press("ControlOrMeta+Z");
    await page.keyboard.press("Meta+ArrowUp");
    await page.keyboard.press("Meta+ArrowDown");

    const keyDowns = fixture.calls
      .filter(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchKeyEvent" &&
          params.type === "rawKeyDown",
      )
      .map(([, , params]) => params);
    const commandFor = (code) =>
      keyDowns.find((params) => params.code === code)?.commands;

    assert.deepEqual(commandFor("KeyA"), ["selectAll"]);
    assert.deepEqual(commandFor("KeyC"), ["copy"]);
    assert.deepEqual(commandFor("KeyV"), ["paste"]);
    assert.deepEqual(commandFor("KeyZ"), ["undo"]);
    assert.deepEqual(commandFor("ArrowUp"), ["moveToBeginningOfDocument"]);
    assert.deepEqual(commandFor("ArrowDown"), ["moveToEndOfDocument"]);
    assert(
      keyDowns
        .filter((params) => params.code?.startsWith("Key"))
        .every((params) => params.modifiers === 4),
      "ControlOrMeta must resolve to Meta on macOS",
    );
  });
});

test("Page keyboard accepts case-insensitive modifier names", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { platform: "darwin" });
    const page = await openTestPage(task, "https://example.test/first");

    await page.keyboard.press("ALT+CONTROL+META+SHIFT+A");
    await page.keyboard.press("CONTROLORMETA+A");

    const aDowns = fixture.calls
      .filter(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchKeyEvent" &&
          params.type === "rawKeyDown" &&
          params.code === "KeyA",
      )
      .map(([, , params]) => params);
    assert.equal(aDowns[0].modifiers, 15);
    assert.equal(aDowns[1].modifiers, 4);
    assert.deepEqual(aDowns[1].commands, ["selectAll"]);
  });
});

test("Page keyboard accepts case-insensitive named key names", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");

    await page.keyboard.press("ENTER");
    await page.keyboard.press("escape");
    await page.press("[contenteditable]", "ARROWDOWN");

    const keyDowns = fixture.calls
      .filter(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchKeyEvent" &&
          (params.type === "keyDown" || params.type === "rawKeyDown"),
      )
      .map(([, , params]) => params);
    assert.deepEqual(
      keyDowns.map(({ code }) => code),
      ["Enter", "Escape", "ArrowDown"],
    );
  });
});

test("Page keyboard keeps single-character key case significant", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");

    await page.keyboard.press("a");
    await page.keyboard.press("A");

    const keyDowns = fixture.calls
      .filter(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchKeyEvent" &&
          params.type === "keyDown" &&
          params.code === "KeyA",
      )
      .map(([, , params]) => params);
    assert.deepEqual(
      keyDowns.map(({ key, text }) => ({ key, text })),
      [
        { key: "a", text: "a" },
        { key: "A", text: "A" },
      ],
    );
  });
});

test("Page keyboard maps portable editing shortcuts on Windows", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { platform: "win32" });
    const page = await openTestPage(task, "https://example.test/first");

    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("ControlOrMeta+C");
    await page.keyboard.press("ControlOrMeta+V");
    await page.keyboard.press("ControlOrMeta+Z");
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Control+End");

    const keyDowns = fixture.calls
      .filter(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchKeyEvent" &&
          params.type === "rawKeyDown",
      )
      .map(([, , params]) => params);
    for (const code of ["KeyA", "KeyC", "KeyV", "KeyZ", "Home", "End"]) {
      const keyDown = keyDowns.find((params) => params.code === code);
      assert(keyDown, `${code} must be dispatched on Windows`);
      assert.equal(keyDown.modifiers, 2, `${code} must carry Control`);
      assert.deepEqual(
        keyDown.commands,
        [],
        "Windows relies on Chromium's native shortcut handling",
      );
    }
  });
});

test("Page keyboard type emits physical keys when possible and inserts unsupported text", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { platform: "darwin" });
    const page = await openTestPage(task, "https://example.test/first");

    await page.keyboard.type("Aé", { delay: 12 });

    const inputCalls = fixture.calls.filter(
      ([kind, method]) =>
        kind === "cdp" &&
        (method === "Input.dispatchKeyEvent" || method === "Input.insertText"),
    );
    assert(
      inputCalls.some(
        ([, method, params]) =>
          method === "Input.dispatchKeyEvent" &&
          params.type === "keyDown" &&
          params.code === "KeyA" &&
          params.text === "A",
      ),
    );
    assert(
      inputCalls.some(
        ([, method, params]) =>
          method === "Input.insertText" && params.text === "é",
      ),
    );
  });
});

test("Page keyboard releases pressed modifiers when a chord fails", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { platform: "darwin" });
    const page = await openTestPage(task, "https://example.test/first");

    await assert.rejects(
      () => page.keyboard.press("Shift+DefinitelyUnknown"),
      /Unknown key/,
    );
    await page.keyboard.type("a");

    const aDown = fixture.calls.find(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Input.dispatchKeyEvent" &&
        params.type === "keyDown" &&
        params.code === "KeyA",
    );
    assert.equal(aDown[2].key, "a");
    assert.equal(aDown[2].text, "a");
    assert.equal(aDown[2].modifiers, 0);
  });
});

test("Page keyboard suggests Playwright arrow-key names", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");

    for (const [legacy, supported] of [
      ["Left", "ArrowLeft"],
      ["Right", "ArrowRight"],
      ["Up", "ArrowUp"],
      ["Down", "ArrowDown"],
    ]) {
      await assert.rejects(
        () => page.keyboard.press(legacy),
        new RegExp(`Unknown key: "${legacy}"\\. Use "${supported}"`),
      );
    }
  });
});

test("low-level Page input skips action observers and returns no receipt", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { platform: "darwin" });
    const page = await openTestPage(task, "https://example.test/first");
    fixture.calls.length = 0;

    assert.equal(await page.mouse.move(10, 20), undefined);
    assert.equal(await page.mouse.down(), undefined);
    assert.equal(await page.mouse.up(), undefined);
    assert.equal(await page.mouse.wheel(0, 30), undefined);
    assert.equal(await page.keyboard.down("Shift"), undefined);
    assert.equal(await page.keyboard.up("Shift"), undefined);
    assert.equal(await page.keyboard.type("a"), undefined);
    assert.equal(await page.keyboard.insertText("é"), undefined);
    assert.equal(
      fixture.calls.some(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Runtime.evaluate" &&
          params.expression.includes("__egoBrowserActionProbes"),
      ),
      false,
      "low-level input must not inject action-observation state into the page",
    );
  });
});

test("Page keyboard omits synthetic dispatch while file input stays target-scoped", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");

    assert.equal(first.keyboard.dispatch, undefined);
    await first.setInputFiles("#upload", ["/tmp/one.txt", "/tmp/two.txt"]);

    const uploadCall = fixture.calls.find(
      ([kind, method]) => kind === "cdp" && method === "DOM.setFileInputFiles",
    );
    assert.deepEqual(uploadCall[2].files, ["/tmp/one.txt", "/tmp/two.txt"]);
    assert.equal(uploadCall[3], `session:${first.targetId}`);
    assert.equal(fixture.activeTarget(), first.targetId);
  });
});

test("Page.setInputFiles resolves labels without opening a system chooser", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/upload");

    await page.setInputFiles("label[for=upload]", [
      "/tmp/one.txt",
      "/tmp/two.txt",
    ]);

    const resolveCall = fixture.calls.find(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Runtime.callFunctionOn" &&
        params.functionDeclaration.includes("resolveFileInputForUpload"),
    );
    assert(resolveCall, "the resolved element is normalized to its file input");
    const uploadCall = fixture.calls.find(
      ([kind, method]) => kind === "cdp" && method === "DOM.setFileInputFiles",
    );
    assert.deepEqual(uploadCall[2], {
      files: ["/tmp/one.txt", "/tmp/two.txt"],
      objectId: `file-input:${page.targetId}`,
    });
    assert.equal(fixture.systemFileChooserOpened(), false);

    await page.setInputFiles("#upload", []);
    const uploadCalls = fixture.calls.filter(
      ([kind, method]) => kind === "cdp" && method === "DOM.setFileInputFiles",
    );
    assert.deepEqual(uploadCalls.at(-1)[2].files, []);
  });
});

test("Page.waitForFileChooser handles a dynamically created file input", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(
      task,
      "https://example.test/dynamic-upload",
    );
    fixture.openFileChooserOnNextClick({
      backendNodeId: 91,
      mode: "selectMultiple",
    });

    const chooserPromise = page.waitForFileChooser({ timeout: 1_234 });
    await page.click("#open-upload");
    const chooser = await chooserPromise;
    assert.equal(chooser.isMultiple(), true);
    await chooser.setFiles(["/tmp/one.txt", "/tmp/two.txt"]);

    const prepared = fixture.calls.find(
      ([kind]) => kind === "prepareFileChooser",
    );
    assert.deepEqual(prepared, [
      "prepareFileChooser",
      `session:${page.targetId}`,
      { timeoutMs: 1_234, cancel: false },
    ]);
    const uploadCall = fixture.calls.find(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "DOM.setFileInputFiles" &&
        params.backendNodeId === 91,
    );
    assert.deepEqual(uploadCall[2].files, ["/tmp/one.txt", "/tmp/two.txt"]);
    assert.equal(fixture.systemFileChooserOpened(), false);
  });
});

test("FileChooser.setFiles returns a dialog opened by the upload", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(
      task,
      "https://example.test/dynamic-upload",
    );
    fixture.openFileChooserOnNextClick({ backendNodeId: 93 });
    fixture.openDialogOnNextFileSet();

    const chooserPromise = page.waitForFileChooser();
    await page.click("#open-upload");
    const chooser = await chooserPromise;

    assert.deepEqual(await chooser.setFiles("/tmp/project.sb3"), {
      dialog: {
        type: "confirm",
        message: "Replace the current project?",
        url: "https://example.test/upload",
      },
    });
    assert.equal(await page.acceptDialog(), true);
  });
});

test("FileChooser.setFiles uses the current Page session after reconnect", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(
      task,
      "https://example.test/dynamic-upload",
    );
    fixture.openFileChooserOnNextClick({ backendNodeId: 92 });

    const chooserPromise = page.waitForFileChooser();
    await page.click("#open-upload");
    const chooser = await chooserPromise;
    fixture.setSession(page.targetId, "fresh-upload-session");

    await chooser.setFiles("/tmp/fresh.txt");

    const uploadCall = fixture.calls.find(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "DOM.setFileInputFiles" &&
        params.backendNodeId === 92,
    );
    assert.equal(uploadCall[3], "fresh-upload-session");
  });
});

test("unhandled file choosers are cancelled before a system dialog appears", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/upload-guard");
    fixture.openFileChooserOnNextClick();

    await assert.rejects(
      () => page.click("#open-upload"),
      (error) => {
        assert.equal(error.code, "EGO_FILE_CHOOSER_OPENED");
        assert.match(error.message, /page\.setInputFiles/);
        assert.match(error.message, /page\.waitForFileChooser/);
        return true;
      },
    );

    const prepared = fixture.calls.find(
      ([kind]) => kind === "prepareFileChooser",
    );
    assert.equal(prepared[2].cancel, true);
    assert.equal(fixture.systemFileChooserOpened(), false);
  });
});

test("Page and TaskSpace CDP commands preserve their intended scope", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");

    const pageResult = await first.cdp(
      "Runtime.evaluate",
      { expression: "document.title" },
      { timeout: 1_234 },
    );
    const taskResult = await task.cdp(
      "Browser.getVersion",
      {},
      { timeout: 987 },
    );

    assert.equal(pageResult.result.value, "https://example.test/first");
    assert.equal(taskResult.product, "Ego Lite/Test");
    assert(
      fixture.calls.some(
        ([kind, method, , sessionId, timeout]) =>
          kind === "cdp" &&
          method === "Runtime.evaluate" &&
          sessionId === "session:target-1" &&
          timeout === 1_234,
      ),
      "page.cdp must use the Page session and millisecond timeout",
    );
    assert(
      fixture.calls.some(
        ([kind, method, , sessionId, timeout]) =>
          kind === "cdp" &&
          method === "Browser.getVersion" &&
          sessionId === undefined &&
          timeout === 987,
      ),
      "task.cdp must use the selected space without a Page session",
    );
  });
});

test("Page waits and events remain isolated to the addressed target", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    const second = await openTestPage(task, "https://example.test/second");

    assert.equal(
      await first.waitForSelector("#ready", {
        timeout: 250,
        state: "visible",
      }),
      true,
    );
    fixture.setDocumentLifecycle({
      readyState: "interactive",
      domContentLoaded: true,
    });
    await first.waitForLoadState("domcontentloaded", { timeout: 250 });
    fixture.setDocumentLifecycle({
      readyState: "complete",
      domContentLoaded: true,
    });
    await first.waitForLoadState();
    fixture.emitPageEvent(first.targetId, "Network.requestWillBeSent", {
      requestId: "request-first",
    });
    fixture.emitPageEvent(first.targetId, "Network.loadingFinished", {
      requestId: "request-first",
    });
    await first.waitForLoadState("networkidle", {
      timeout: 500,
      idleMs: 100,
    });

    fixture.emitPageEvent(first.targetId, "Runtime.consoleAPICalled", {
      value: "first",
    });
    fixture.emitPageEvent(second.targetId, "Runtime.consoleAPICalled", {
      value: "second",
    });
    assert.deepEqual(
      (await second.events()).map((event) => event.params.value),
      ["second"],
    );
    assert.deepEqual(
      (await first.events()).map((event) => event.method),
      [
        "Network.requestWillBeSent",
        "Network.loadingFinished",
        "Runtime.consoleAPICalled",
      ],
      "network-idle must preserve the addressed Page event stream",
    );

    assert(
      fixture.calls.some(
        ([kind, method, , sessionId]) =>
          kind === "cdp" &&
          method === "Network.enable" &&
          sessionId === "session:target-1",
      ),
      "network idle must enable events on the addressed Page session",
    );
  });
});

test("Page network-idle sees an earlier request without consuming events", async () => {
  await withFixture(async (fixture) => {
    let now = 0;
    let childBusy = true;
    let childFinishedAt = 0;
    const task = taskForRound(fixture, "round-a", {
      now: () => now,
      async sleep(ms) {
        now += ms;
        if (childBusy && now >= 150) {
          childBusy = false;
          childFinishedAt = now;
        }
      },
      async ensureNetworkTracking() {},
      async pageNetworkSessions(sessionId) {
        return [sessionId, "session:oopif-child"];
      },
      networkActivity(sessionIds) {
        assert.deepEqual(sessionIds, [
          "session:target-1",
          "session:oopif-child",
        ]);
        return {
          tracking: true,
          inflight: childBusy ? 1 : 0,
          lastActivityAt: childBusy ? 0 : childFinishedAt,
        };
      },
    });
    const page = await openTestPage(task, "https://example.test/network-idle");
    fixture.emitPageEvent(page.targetId, "Runtime.consoleAPICalled", {
      value: "preserve this event",
    });

    await page.waitForLoadState("networkidle", {
      timeout: 500,
      idleMs: 100,
    });

    assert.equal(
      childBusy,
      false,
      "a request started before the wait must finish",
    );
    assert(now >= 250, "the idle window begins after the earlier request ends");
    assert.deepEqual(
      (await page.events()).map((event) => event.params.value),
      ["preserve this event"],
      "network-idle must not consume unrelated Page events",
    );
  });
});

test("Page waitForURL follows a popup from about:blank without activating it", async () => {
  await withFixture(async (fixture) => {
    let elapsedMs = 0;
    let popupTargetId;
    const expectedUrl = "https://example.test/delayed-popup";
    const task = taskForRound(fixture, "round-a", {
      now: () => elapsedMs,
      async sleep(ms) {
        elapsedMs += ms;
        if (popupTargetId && elapsedMs >= 150) {
          fixture.tabs.get(popupTargetId).url = expectedUrl;
        }
      },
    });
    const source = await openTestPage(task, "https://example.test/source");
    fixture.openPopupOnNextClick("about:blank");
    const receipt = await source.click("#open-popup");
    popupTargetId = receipt.popups[0].targetId;
    const popup = task.page(receipt.popups[0].label);
    fixture.addExternalTab("target-user", "https://example.test/user", {
      active: true,
    });
    const activationCallsBefore = fixture.calls.filter(
      ([kind, method]) => kind === "cdp" && method === "Target.activateTarget",
    ).length;

    await popup.waitForURL(expectedUrl, { timeout: 500 });
    await popup.waitForURL(/delayed-popup$/, { timeout: 1 });
    await popup.waitForURL("**/delayed-popup", { timeout: 1 });
    await popup.waitForURL(
      (url) =>
        url.hostname === "example.test" && url.pathname === "/delayed-popup",
      { timeout: 1 },
    );

    assert.equal(await popup.url(), expectedUrl);
    assert.equal(
      fixture.activeTarget(),
      "target-user",
      "waiting for a URL must not steal the active tab",
    );
    assert.equal(
      fixture.calls.filter(
        ([kind, method]) =>
          kind === "cdp" && method === "Target.activateTarget",
      ).length,
      activationCallsBefore,
    );
  });
});

test("Page.waitForEvent arms before a click and resolves the opened popup", async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, "round-a");
    const source = await openTestPage(task, "https://example.test/source");
    fixture.openPopupOnNextClick("https://example.test/popup");

    const popupPromise = source.waitForEvent("popup", { timeout: 1_000 });
    const receipt = await source.click("#open-popup");
    const popup = await popupPromise;

    assert.equal(popup.label, receipt.popups[0].label);
    assert.equal(await popup.url(), "https://example.test/popup");
    assert.deepEqual(consumeUnhandledPageNotices(), []);
  });
});

test("Page.waitForEvent exposes a Playwright-style download object", async () => {
  await withFixture(async (fixture) => {
    const sourcePath = join(fixture.rootDir, "download-source.txt");
    const outputPath = join(fixture.rootDir, "saved", "report.txt");
    await writeFile(sourcePath, "download body");
    let resolveDownload;
    const event = new Promise((resolve) => {
      resolveDownload = resolve;
    });
    const calls = [];
    const artifact = {
      url: "https://example.test/report",
      suggestedFilename: "report.txt",
      finished: Promise.resolve(),
      async saveAs(path) {
        calls.push(["saveAs", path]);
        await mkdir(dirname(path), { recursive: true });
        await copyFile(sourcePath, path);
      },
      async path() {
        return sourcePath;
      },
      async failure() {
        return null;
      },
      async cancel() {
        calls.push(["cancel"]);
      },
      async delete() {
        calls.push(["delete"]);
      },
    };
    const task = taskForRound(fixture, "round-a", {
      prepareDownload(targetId, options) {
        calls.push(["prepare", targetId, options]);
        return {
          async ready(sessionId) {
            calls.push(["ready", sessionId]);
          },
          event,
          async dispose(error) {
            calls.push(["dispose", error?.message]);
          },
        };
      },
      async cdp(method, params, sessionId, timeoutMs) {
        const result = await fixture.services.cdp(
          method,
          params,
          sessionId,
          timeoutMs,
        );
        if (
          method === "Input.dispatchMouseEvent" &&
          params.type === "mouseReleased"
        ) {
          resolveDownload(artifact);
        }
        return result;
      },
    });
    const source = await openTestPage(task, "https://example.test/source");

    const downloadPromise = source.waitForEvent("download", {
      timeout: 1_000,
    });
    await source.click("#download");
    const download = await downloadPromise;

    assert.equal(download.page(), source);
    assert.equal(download.url(), "https://example.test/report");
    assert.equal(download.suggestedFilename(), "report.txt");
    assert.equal(await download.path(), sourcePath);
    assert.equal(await download.failure(), null);
    await download.saveAs(outputPath);
    assert.equal(await readFile(outputPath, "utf8"), "download body");
    await download.cancel();
    await download.delete();
    assert.deepEqual(calls.slice(0, 2), [
      ["prepare", source.targetId, { timeoutMs: 1_000 }],
      ["ready", `session:${source.targetId}`],
    ]);
    assert.deepEqual(calls.slice(-3), [
      ["saveAs", outputPath],
      ["cancel"],
      ["delete"],
    ]);
  });
});

test("waitForEvent(download) is listening before a later evaluate runs", async () => {
  await withFixture(async (fixture) => {
    const order = [];
    let resolveDownload;
    const event = new Promise((resolve) => {
      resolveDownload = resolve;
    });
    // Make the waiter's own Page lookup slow, so without the arm barrier the
    // evaluate would reach the page before the download waiter listened.
    const store = new PageLedgerStore({ rootDir: fixture.rootDir });
    let delayNextLookup = false;
    const ledger = new Proxy(store, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== "getPage") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args) => {
          if (delayNextLookup) {
            delayNextLookup = false;
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          return value.apply(target, args);
        };
      },
    });
    const task = taskForRound(fixture, "round-a", {
      ledger,
      prepareDownload() {
        return {
          async ready() {
            // A slow arm: without the barrier, evaluate would run first.
            await new Promise((resolve) => setTimeout(resolve, 30));
            order.push("ready");
          },
          event,
          async dispose() {},
        };
      },
      async cdp(method, params, sessionId, timeoutMs) {
        if (
          method === "Runtime.evaluate" &&
          String(params?.expression).includes("startDownload")
        ) {
          order.push("evaluate");
          resolveDownload({
            url: "https://example.test/file",
            suggestedFilename: "file.txt",
            finished: Promise.resolve(),
            async saveAs() {},
            async path() {
              return "/tmp/file.txt";
            },
            async failure() {
              return null;
            },
            async cancel() {},
            async delete() {},
          });
        }
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      },
    });
    const page = await openTestPage(task, "https://example.test/source");

    delayNextLookup = true;
    const pending = page.waitForEvent("download", { timeout: 1_000 });
    await page.evaluate("globalThis.startDownload = 1");
    const download = await pending;

    assert.equal(download.suggestedFilename(), "file.txt");
    assert.deepEqual(order, ["ready", "evaluate"]);
  });
});

test("Page reapplies download behavior after its CDP session reconnects", async () => {
  await withFixture(async (fixture) => {
    let markFirstReady;
    const firstReady = new Promise((resolve) => {
      markFirstReady = resolve;
    });
    let resolveDownload;
    const event = new Promise((resolve) => {
      resolveDownload = resolve;
    });
    const readySessions = [];
    const artifact = {
      url: "https://example.test/report",
      suggestedFilename: "report.txt",
      finished: Promise.resolve(),
      async saveAs() {},
      async path() {
        return join(fixture.rootDir, "report.txt");
      },
      async failure() {
        return null;
      },
      async cancel() {},
      async delete() {},
    };
    const task = taskForRound(fixture, "round-a", {
      prepareDownload() {
        return {
          async ready(sessionId) {
            readySessions.push(sessionId);
            if (readySessions.length === 1) markFirstReady();
          },
          event,
          async dispose() {},
        };
      },
      async cdp(method, params, sessionId, timeoutMs) {
        const result = await fixture.services.cdp(
          method,
          params,
          sessionId,
          timeoutMs,
        );
        if (
          method === "Input.dispatchMouseEvent" &&
          params.type === "mouseReleased"
        ) {
          resolveDownload(artifact);
        }
        return result;
      },
    });
    const source = await openTestPage(task, "https://example.test/source");

    const downloadPromise = source.waitForEvent("download", {
      timeout: 1_000,
    });
    await firstReady;
    fixture.setSession(source.targetId, "session:reconnected");
    await source.click("#download");
    await downloadPromise;

    assert.deepEqual(readySessions, [
      `session:${source.targetId}`,
      "session:reconnected",
    ]);
  });
});

test("Page.waitForEvent ignores an older popup and resolves the next one", async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, "round-a");
    const source = await openTestPage(task, "https://example.test/source");
    fixture.openPopupOnNextClick("https://example.test/old-popup");

    const oldReceipt = await source.click("#open-old-popup");
    fixture.openPopupOnNextClick("https://example.test/next-popup");
    const popupPromise = source.waitForEvent("popup", { timeout: 1_000 });
    const nextReceipt = await source.click("#open-next-popup");
    const popup = await popupPromise;

    assert.notEqual(popup.label, oldReceipt.popups[0].label);
    assert.equal(popup.label, nextReceipt.popups[0].label);
    assert.equal(await popup.url(), "https://example.test/next-popup");
    assert.deepEqual(
      consumeUnhandledPageNotices().map((notice) => notice.targetId),
      [oldReceipt.popups[0].targetId],
    );
  });
});

test("Page.waitForEvent rejects unsupported events and times out cleanly", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const source = await openTestPage(task, "https://example.test/source");

    assert.throws(
      () => source.waitForEvent("request", { timeout: 10 }),
      /only supports the popup and download events/,
    );
    await assert.rejects(
      source.waitForEvent("popup", { timeout: 5 }),
      /page\.waitForEvent\("popup"\) timed out after 5ms/,
    );
  });
});

test("Page.waitForURL immediately reports a matching popup opened by this Page", async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, "round-a");
    const source = await openTestPage(task, "https://example.test/source");
    fixture.openPopupOnNextClick("https://example.test/drive/home");
    await source.click("#open-popup");

    await assert.rejects(
      source.waitForURL("**/drive/home", { timeout: 15_000 }),
      (error) => {
        assert.equal(error.code, "EGO_URL_OPENED_IN_POPUP");
        assert.match(error.message, /p1 did not navigate/);
        assert.match(error.message, /popup p2 opened/);
        assert.match(error.message, /task\.page\("p2"\)/);
        assert.match(error.message, /triggering action already succeeded/i);
        assert.doesNotMatch(error.message, /timed out/);
        return true;
      },
    );
  });
});

test("Page.waitForURL still succeeds when the opener itself reaches the URL", async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, "round-a");
    const source = await openTestPage(task, "https://example.test/source");
    const expectedUrl = "https://example.test/drive/home";
    fixture.openPopupOnNextClick(expectedUrl);
    fixture.navigateOnNextClick(expectedUrl);
    await source.click("#open-popup");

    await source.waitForURL(/\/drive\/home/, { timeout: 500 });
  });
});

test("Page waitForURL validates its matcher and reports the last URL", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "about:blank");

    await assert.rejects(
      () => page.waitForURL("https://example.test/never", { timeout: 10 }),
      /waitForURL timed out after 10ms.*last URL was "about:blank"/,
    );
    await assert.rejects(
      () => page.waitForURL("", { timeout: 10 }),
      /non-empty string, RegExp, or function/,
    );
    await assert.rejects(
      () => page.waitForURL(42, { timeout: 10 }),
      /non-empty string, RegExp, or function/,
    );
    await assert.rejects(
      () => page.waitForURL(async () => true, { timeout: 10 }),
      /predicate must return a boolean synchronously/,
    );
    await assert.rejects(
      () => page.waitForURL((url) => url.includes("/search?"), { timeout: 10 }),
      /url\.includes is not a function.*receives a URL object; use url\.href/,
    );
    await assert.rejects(
      () => page.waitForURL("**/{ready", { timeout: 10 }),
      /Invalid URL glob.*unmatched '\{'/,
    );
    await assert.rejects(
      () => page.waitForURL(/blank/, { timeout: 0 }),
      /positive number of milliseconds/,
    );
  });
});

test("Page waitForURL retries a transient evaluation timeout", async () => {
  await withFixture(async (fixture) => {
    const expectedUrl = "https://example.test/after-timeout";
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, expectedUrl);
    fixture.timeoutNextUrlEvaluation();

    await page.waitForURL(expectedUrl, { timeout: 2_000 });
    assert.equal(await page.url(), expectedUrl);
  });
});

test("Page waitForSelector supports Playwright-style element states", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");

    fixture.setElementState({ present: true, visible: false });
    assert.equal(
      await page.waitForSelector("#ready", { state: "attached" }),
      true,
    );
    assert.equal(
      await page.waitForSelector("#ready", { state: "hidden" }),
      true,
    );

    fixture.setElementState({ present: false });
    assert.equal(
      await page.waitForSelector("#ready", { state: "detached" }),
      true,
    );
    assert.equal(
      await page.waitForSelector("#ready", { state: "hidden" }),
      true,
    );

    fixture.setElementState({ present: true, visible: true });
    assert.equal(
      await page.waitForSelector("#ready", { state: "visible" }),
      true,
    );
  });
});

test("Page wait methods reject invalid states and millisecond timeouts", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");

    fixture.setDocumentLifecycle({
      readyState: "interactive",
      domContentLoaded: false,
    });
    await assert.rejects(
      () => page.waitForLoadState("domcontentloaded", { timeout: 1 }),
      /waitForLoadState\(domcontentloaded\) timed out/,
    );
    fixture.setDocumentLifecycle({
      readyState: "interactive",
      domContentLoaded: true,
    });
    await page.waitForLoadState("domcontentloaded", { timeout: 1 });

    fixture.timeoutNextLifecycleEvaluation();
    await assert.rejects(
      () => page.waitForLoadState("load", { timeout: 10 }),
      /waitForLoadState\(load\) timed out after 10ms/,
    );

    await assert.rejects(
      () => page.waitForLoadState("commit"),
      /supports only "domcontentloaded", "load", and "networkidle"/,
    );
    await assert.rejects(
      () => page.waitForSelector("#ready", { timeout: 0 }),
      /positive number of milliseconds/,
    );
    await assert.rejects(
      () => page.waitForSelector("#ready", { state: "stable" }),
      /state must be one of/,
    );
    await assert.rejects(
      () => task.cdp("Page.navigate"),
      /only supports Target\. and Browser\. commands/,
    );
  });
});

test("Page actions resolve snapshot refs inside the addressed page", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");
    const second = await openTestPage(task, "https://example.test/second");

    await first.snapshot();
    await second.snapshot();
    await first.click("@21");
    await second.fill("@21", "page-scoped");

    const firstResolveCall = fixture.calls.find(
      ([kind, method, params, sessionId]) =>
        kind === "cdp" &&
        method === "DOM.resolveNode" &&
        params.backendNodeId === 21 &&
        sessionId === "session:target-1",
    );
    const secondResolveCall = fixture.calls.find(
      ([kind, method, params, sessionId]) =>
        kind === "cdp" &&
        method === "DOM.resolveNode" &&
        params.backendNodeId === 21 &&
        sessionId === "session:target-2",
    );
    assert(
      firstResolveCall,
      "click must resolve through the first Page session",
    );
    assert(
      secondResolveCall,
      "fill must resolve through the second Page session",
    );
    assert.equal(fixture.activeTarget(), second.targetId);
  });
});

test("consecutive clicks preserve sibling refs from one snapshot", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", {
      async snapshot() {
        return {
          content:
            'button "First" [ref=19]\nbutton "Second" [ref=22]\nbutton "Third" [ref=23]',
          refs: [19, 22, 23].map((refId) => ({
            refId,
            backendNodeId: refId + 100,
            role: "button",
          })),
        };
      },
    });
    const page = await openTestPage(task, "https://example.test/buttons");
    await page.snapshot();

    await page.click("@19");
    await page.click("@22");
    await page.click("@23");

    assert.deepEqual(
      fixture.calls
        .filter(([, method]) => method === "DOM.resolveNode")
        .map(([, , params]) => params.backendNodeId),
      [119, 122, 123],
    );
  });
});

test("fill and press reuse a published ref in a new round", async () => {
  await withFixture(async (fixture) => {
    const page = await openTestPage(
      taskForRound(fixture, "round-a"),
      "https://example.test/input",
    );
    await page.snapshot();
    await fixture.services.sleep(4_000);
    const restored = taskForRound(fixture, "round-b", {
      pageRefs: new PageRefRegistry(),
    }).page(page.label);

    await restored.fill("@21", "M2");
    await restored.press("@21", "Enter");

    assert(
      fixture.calls.some(
        ([, method, params]) =>
          method === "Input.dispatchKeyEvent" && params.key === "Enter",
      ),
    );
    assert.equal(
      fixture.calls.filter(([kind]) => kind === "snapshot").length,
      1,
      "reusing the same node must not trigger a new snapshot",
    );
  });
});

test("raw keyboard input preserves unchanged refs into the next round", async () => {
  await withFixture(async (fixture) => {
    const page = await openTestPage(
      taskForRound(fixture, "round-a"),
      "https://example.test/input",
    );
    await page.snapshot();
    await page.keyboard.press("Tab");
    const restored = taskForRound(fixture, "round-b", {
      pageRefs: new PageRefRegistry(),
    }).page(page.label);

    await restored.click("@21");
    assert.equal(
      fixture.calls.find(([, method]) => method === "DOM.resolveNode")[2]
        .backendNodeId,
      21,
    );
  });
});

test("a new round restores the published ref without renumbering from a fresh snapshot", async () => {
  await withFixture(async (fixture) => {
    fixture.services.snapshot = async () => {
      fixture.calls.push(["snapshot", fixture.activeTarget()]);
      return {
        content: 'button "Second" [ref=1]',
        refs: [{ refId: 1, backendNodeId: 42, role: "button", name: "Second" }],
      };
    };
    const firstRound = taskForRound(fixture, "round-a");
    const created = await openTestPage(
      firstRound,
      "https://example.test/first",
    );
    await created.snapshot();
    const snapshotsBefore = fixture.calls.filter(
      ([kind]) => kind === "snapshot",
    ).length;

    fixture.services.snapshot = async () => {
      fixture.calls.push(["snapshot", created.targetId]);
      return {
        content: 'button "First" [ref=1]',
        refs: [{ refId: 1, backendNodeId: 21, role: "button", name: "First" }],
      };
    };
    const secondRound = taskForRound(fixture, "round-b", {
      pageRefs: new PageRefRegistry(),
    });
    await secondRound.page(created.label).click("@1");

    assert.equal(
      fixture.calls.filter(([kind]) => kind === "snapshot").length,
      snapshotsBefore,
      "the saved mapping must survive a new round without reconstructing native ids",
    );
    const resolved = fixture.calls.filter(
      ([, method]) => method === "DOM.resolveNode",
    );
    assert.equal(resolved.at(-1)[2].backendNodeId, 42);
  });
});

test("an unknown Page ref fails without guessing a mapping from a new snapshot", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");

    await assert.rejects(() => page.click("@99"), /Unknown ref: 99/);
    assert.deepEqual(
      fixture.calls.filter(([kind]) => kind === "snapshot"),
      [],
    );
  });
});

test("raw CDP ref invalidation survives a new Agent round", async () => {
  await withFixture(async (fixture) => {
    const page = await openTestPage(
      taskForRound(fixture, "round-a"),
      "https://example.test/first",
    );
    await page.snapshot();
    await page.cdp("Page.getFrameTree");
    const restored = taskForRound(fixture, "round-b", {
      pageRefs: new PageRefRegistry(),
    }).page(page.label);

    await assert.rejects(() => restored.click("@21"), /Stale ref: @21/);
    assert.equal(
      fixture.calls.filter(([, method]) => method === "DOM.resolveNode").length,
      0,
    );
  });
});

for (const persistentFailure of [false, true]) {
  test(`cross-round refs survive an iframe document read failure${persistentFailure ? " after the action times out" : " during the first action"}`, async () => {
    await withFixture(async (fixture) => {
      let frameSession = "session:oopif";
      let failFrameRead = false;
      const baseCdp = fixture.services.cdp;
      const overrides = {
        async cdp(method, params, sessionId) {
          if (method === "Page.getFrameTree") {
            if (sessionId === "session:target-1") {
              return {
                frameTree: {
                  frame: { id: "main-frame", loaderId: "main-document" },
                },
              };
            }
            if (failFrameRead) {
              failFrameRead = persistentFailure;
              frameSession = "session:oopif-reconnected";
              throw Object.assign(
                new Error("Session with given id not found"),
                {
                  sessionId,
                },
              );
            }
            return {
              frameTree: {
                frame: { id: "child-frame", loaderId: "same-document" },
              },
            };
          }
          return baseCdp(method, params, sessionId);
        },
        async snapshot() {
          return {
            content: 'textbox "Cell address" [ref=19]',
            refs: [{ refId: 19, backendNodeId: 42, frameId: "child-frame" }],
          };
        },
        async ensureFrameSessions() {
          return new Map([["child-frame", frameSession]]);
        },
      };
      const page = await openTestPage(
        taskForRound(fixture, "round-a", overrides),
        "https://example.test/iframe",
      );
      await page.snapshot();
      failFrameRead = true;
      let restored = taskForRound(fixture, "round-b", {
        ...overrides,
        pageRefs: new PageRefRegistry(),
      }).page(page.label);

      if (persistentFailure) {
        await assert.rejects(
          () => restored.press("@19", "Enter", { timeout: 100 }),
          /timed out.*Session with given id not found/,
        );
        failFrameRead = false;
        restored = taskForRound(fixture, "round-c", {
          ...overrides,
          pageRefs: new PageRefRegistry(),
        }).page(page.label);
      }
      await restored.press("@19", "Enter");

      assert.equal(
        fixture.calls.filter(
          ([, method, params]) =>
            method === "Input.dispatchKeyEvent" &&
            params.type === "keyUp" &&
            params.key === "Enter",
        ).length,
        1,
        "document verification must recover before dispatching input once",
      );
      assert(
        fixture.calls.some(
          ([, method, params, sessionId]) =>
            method === "DOM.resolveNode" &&
            params.backendNodeId === 42 &&
            sessionId === "session:oopif-reconnected",
        ),
      );
    });
  });
}

for (const mode of ["page", "same-process iframe", "OOPIF"]) {
  const frameId = mode === "page" ? undefined : "child-frame";
  test(`saved refs reject a changed ${mode} document even when backend ids repeat`, async () => {
    await withFixture(async (fixture) => {
      let loaderId = "old-document";
      const baseCdp = fixture.services.cdp;
      const overrides = {
        async cdp(method, params, sessionId) {
          if (method === "Page.getFrameTree")
            return {
              frameTree:
                sessionId === "session:oopif"
                  ? { frame: { id: "child-frame", loaderId } }
                  : {
                      frame: {
                        id: "main-frame",
                        loaderId: frameId ? "main-document" : loaderId,
                      },
                      childFrames:
                        mode === "OOPIF"
                          ? []
                          : [{ frame: { id: "child-frame", loaderId } }],
                    },
            };
          return baseCdp(method, params, sessionId);
        },
        async snapshot() {
          return {
            content: 'button "Save" [ref=1]',
            refs: [
              {
                refId: 1,
                backendNodeId: 42,
                frameId,
                role: "button",
                name: "Save",
              },
            ],
          };
        },
        async ensureFrameSessions() {
          return new Map([
            [
              "child-frame",
              mode === "OOPIF" ? "session:oopif" : "session:target-1",
            ],
          ]);
        },
      };
      const first = taskForRound(fixture, "round-a", overrides);
      const page = await openTestPage(first, "https://example.test/first");
      await page.snapshot();
      loaderId = "new-document";
      const restored = taskForRound(fixture, "round-b", {
        ...overrides,
        pageRefs: new PageRefRegistry(),
      }).page(page.label);

      await assert.rejects(
        () => restored.snapshot({ scope: "subtree", root: "@1" }),
        /Stale ref: @1/,
      );
      assert.equal(
        fixture.calls.filter(([, method]) => method === "DOM.resolveNode")
          .length,
        0,
      );
      const fresh = await restored.snapshot();
      assert.doesNotMatch(
        fresh,
        /\[ref=1\]/,
        "a new document cannot inherit an old public ref",
      );
    });
  });
}

test("a navigation during snapshot capture never publishes refs for a mixed document", async () => {
  await withFixture(async (fixture) => {
    let loaderId = "before";
    let captures = 0;
    const baseCdp = fixture.services.cdp;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId) {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "main", loaderId } } };
        return baseCdp(method, params, sessionId);
      },
      async snapshot() {
        captures += 1;
        loaderId = `after-${captures}`;
        return {
          content: 'button "Save" [ref=1]',
          refs: [{ refId: 1, backendNodeId: 42 }],
        };
      },
    });
    const page = await openTestPage(task, "https://example.test/first");
    await assert.rejects(() => page.snapshot(), /Page changed during snapshot/);
    assert.equal(
      captures,
      3,
      "a page that keeps changing is retried, then fails",
    );
    assert.equal(
      fixture.services.pageRefs.forTarget(page.targetId).get("1"),
      undefined,
    );
  });
});

test("a snapshot retries once a navigation during capture settles", async () => {
  await withFixture(async (fixture) => {
    let loaderId = "before";
    let captures = 0;
    const baseCdp = fixture.services.cdp;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId) {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "main", loaderId } } };
        return baseCdp(method, params, sessionId);
      },
      async snapshot() {
        captures += 1;
        loaderId = "after";
        return {
          content: 'button "Save" [ref=1]',
          refs: [{ refId: 1, backendNodeId: 42 }],
        };
      },
    });
    const page = await openTestPage(task, "https://example.test/first");
    assert.match(await page.snapshot(), /\[ref=1\]/);
    assert.equal(captures, 2);
  });
});

test("Page click uses the wheel motion engine to bring an element into view", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.scrollNextClickPoint();

    await page.click("#offscreen");

    const pointCalls = fixture.calls.filter(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Runtime.callFunctionOn" &&
        params.functionDeclaration.includes("getBoundingClientRect"),
    );
    assert(
      pointCalls.length >= 2,
      "the element position is rechecked after scrolling",
    );
    assert.doesNotMatch(pointCalls[0][2].functionDeclaration, /scrollIntoView/);
    const stabilityCall = pointCalls.find(([, , params]) =>
      params.functionDeclaration.includes("setTimeout(finish, 100)"),
    );
    assert(stabilityCall, "the final point check samples element stability");
    assert.match(
      stabilityCall[2].functionDeclaration,
      /setTimeout\(finish, 100\)/,
      "stability sampling must not wait indefinitely for background animation frames",
    );
    assert.doesNotMatch(
      stabilityCall[2].functionDeclaration,
      /firstRect|element is not stable/,
      "click safety follows the recomputed hit point instead of requiring a static rectangle",
    );
    const wheelCalls = fixture.calls.filter(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Input.dispatchMouseEvent" &&
        params.type === "mouseWheel",
    );
    assert(wheelCalls.length > 1);
    assert.equal(
      wheelCalls.reduce((total, [, , params]) => total + params.deltaY, 0),
      600,
    );
    const wheelEnd = fixture.calls.lastIndexOf(wheelCalls.at(-1));
    const press = fixture.calls.findIndex(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Input.dispatchMouseEvent" &&
        params.type === "mousePressed",
    );
    assert(
      wheelEnd < press,
      "scrolling must finish before the click is dispatched",
    );
  });
});

test("Page fill uses the wheel motion engine to bring an element into view", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.scrollNextClickPoint();

    await page.fill("#offscreen-field", "filled");

    const pointCalls = fixture.calls.filter(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Runtime.callFunctionOn" &&
        params.functionDeclaration.includes("getBoundingClientRect"),
    );
    assert(
      pointCalls.length >= 2,
      "the field position is rechecked after scrolling",
    );
    assert.doesNotMatch(pointCalls[0][2].functionDeclaration, /scrollIntoView/);
    assert.doesNotMatch(
      pointCalls[0][2].functionDeclaration,
      /requestAnimationFrame|element is not stable/,
      "fill scrolling must not block keyboard input on element motion",
    );
    const wheelCalls = fixture.calls.filter(
      ([kind, method, params]) =>
        kind === "cdp" &&
        method === "Input.dispatchMouseEvent" &&
        params.type === "mouseWheel",
    );
    assert(wheelCalls.length > 1);
    assert.equal(
      wheelCalls.reduce((total, [, , params]) => total + params.deltaY, 0),
      600,
    );
    const insertText = fixture.calls.findIndex(
      ([kind, method]) => kind === "cdp" && method === "Input.insertText",
    );
    const wheelEnd = fixture.calls.lastIndexOf(wheelCalls.at(-1));
    assert(
      wheelEnd < insertText,
      "scrolling must finish before text input is dispatched",
    );
  });
});

test("Page click retries a transient visibility change before dispatching input", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.rejectNextClickPoint();

    assert.deepEqual(await page.click("#temporarily-hidden"), {});
    assert.equal(
      fixture.calls.filter(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Runtime.callFunctionOn" &&
          params.functionDeclaration.includes("setTimeout(finish, 100)"),
      ).length,
      2,
    );
    assert(
      fixture.calls.some(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchMouseEvent" &&
          params.type === "mouseReleased",
      ),
    );
  });
});

test("Page click retries when an iframe disappears during session discovery", async () => {
  await withFixture(async (fixture) => {
    let discoveries = 0;
    const discoveryTimeouts = [];
    const task = taskForRound(fixture, "round-a", {
      async ensureFrameSessions(_targetId, timeoutMs) {
        discoveries += 1;
        discoveryTimeouts.push(timeoutMs);
        if (discoveries === 1) {
          throw new Error("Frame with the given frameId is not found.");
        }
        return new Map();
      },
    });
    const page = await openTestPage(task, "https://example.test/first");

    assert.deepEqual(await page.click("#ready", { timeout: 1_000 }), {});
    assert.equal(discoveries, 2);
    assert.deepEqual(discoveryTimeouts, [1_000, 500]);
  });
});

test("Page click does not re-dispatch a gesture after its session was lost", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.loseSessionOnNextMouseRelease();

    await assert.rejects(
      () => page.click("#submit", { timeout: 1_000 }),
      /Session with given id not found/,
    );
    assert.equal(
      fixture.calls.filter(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchMouseEvent" &&
          params.type === "mousePressed",
      ).length,
      1,
      "a gesture that already reached the page must not be dispatched again",
    );
  });
});

test("Page click reports the action timeout instead of a tail discovery timeout", async () => {
  await withFixture(async (fixture) => {
    const discoveryTimeouts = [];
    const task = taskForRound(fixture, "round-a", {
      async ensureFrameSessions(_targetId, timeoutMs) {
        discoveryTimeouts.push(timeoutMs);
        if (timeoutMs < 250) {
          const error = new Error("CDP request timed out: Target.getTargets");
          error.code = "EGO_CDP_REQUEST_TIMEOUT";
          throw error;
        }
        return new Map();
      },
    });
    const page = await openTestPage(task, "https://example.test/first");
    fixture.rejectClickPoints(100);

    await assert.rejects(
      () => page.click("#changing", { timeout: 1_000 }),
      /page\.click timed out after 1000ms.*not visible/i,
    );
    assert(
      discoveryTimeouts.every((timeoutMs) => timeoutMs <= 1_000),
      `frame discovery must never exceed the action timeout: ${discoveryTimeouts}`,
    );
  });
});

test("Page click retries when an iframe disappears while the element is resolved", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.loseFrameOnNextResolution({
      message: "Frame with the given frameId is not found.",
    });

    assert.deepEqual(await page.click("#ready", { timeout: 1_000 }), {});
    assert.equal(
      fixture.calls.filter(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchMouseEvent" &&
          params.type === "mousePressed",
      ).length,
      1,
    );
  });
});

test("Page click retries when an iframe session is lost while the element is resolved", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.loseFrameOnNextResolution({
      message: "Session with given id not found",
      sessionId: "session:frame-gone",
    });

    assert.deepEqual(await page.click("#ready", { timeout: 1_000 }), {});
  });
});

test("Page click fails fast when its own session is lost while the element is resolved", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.loseFrameOnNextResolution({
      message: "Session with given id not found",
      sessionId: "session:target-1",
    });

    await assert.rejects(
      () => page.click("#ready", { timeout: 1_000 }),
      /Session with given id not found/,
    );
    assert.equal(
      fixture.calls.some(
        ([kind, method]) =>
          kind === "cdp" && method === "Input.dispatchMouseEvent",
      ),
      false,
    );
  });
});

test("Page click reports the last transient state after its timeout", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.rejectClickPoints(100);

    await assert.rejects(
      () => page.click("#changing", { timeout: 1_000 }),
      /page\.click timed out after 1000ms.*not visible/i,
    );
    assert.equal(
      fixture.calls.filter(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Runtime.callFunctionOn" &&
          params.functionDeclaration.includes("getBoundingClientRect"),
      ).length,
      3,
    );
    assert.equal(
      fixture.calls.some(
        ([kind, method]) =>
          kind === "cdp" && method === "Input.dispatchMouseEvent",
      ),
      false,
    );
  });
});

test("Page click waits for a temporary pointer interceptor", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.interceptNextClickPoint();

    assert.deepEqual(await page.click("#covered", { timeout: 100 }), {});
    assert(
      fixture.calls.some(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchMouseEvent" &&
          params.type === "mouseReleased",
      ),
      "input is dispatched after the overlay disappears",
    );
  });
});

test("Page click times out while a pointer interceptor remains", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.interceptClickPoints(100);

    await assert.rejects(
      () => page.click("#covered", { timeout: 100 }),
      /page\.click timed out after 100ms.*overlay.*intercepts pointer events/i,
    );
    assert.equal(
      fixture.calls.some(
        ([kind, method]) =>
          kind === "cdp" && method === "Input.dispatchMouseEvent",
      ),
      false,
      "an intercepted high-level click must not dispatch any mouse input",
    );
  });
});

test("an action timeout before any input reports no late effects and a hint", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.interceptClickPoints(100);

    await assert.rejects(
      () => page.click("#covered", { timeout: 100 }),
      (error) => {
        assert.match(error.message, /page\.click timed out after 100ms/);
        assert.equal(error.mayHaveLateEffects, false);
        assert.equal(typeof error.hint, "string");
        assert.match(error.stack, /\n {2}hint: /);
        return true;
      },
    );
  });
});

test("an action timeout after input reached the page reports late effects", async () => {
  await withFixture(async (fixture) => {
    const { ElementResolutionError } =
      await import("../dist/src/element-resolver.js");
    let releases = 0;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        const result = await fixture.services.cdp(
          method,
          params,
          sessionId,
          timeoutMs,
        );
        // The gesture reached the page, then the element kept changing.
        if (
          method === "Input.dispatchMouseEvent" &&
          params.type === "mouseReleased"
        ) {
          releases += 1;
          throw new ElementResolutionError(
            "element is not visible after the click",
            "transient",
          );
        }
        return result;
      },
    });
    const page = await openTestPage(task, "https://example.test/first");

    await assert.rejects(
      () => page.click("#submit", { timeout: 100 }),
      (error) => {
        assert.match(error.message, /page\.click timed out after 100ms/);
        assert.equal(error.mayHaveLateEffects, true);
        return true;
      },
    );
    assert(releases >= 1, "the click reached the page");
  });
});

test("Page click force bypasses only the pointer interception check", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    fixture.interceptClickPoints(100);

    assert.deepEqual(
      await page.click("#intentionally-covered", { force: true }),
      {},
    );
    assert(
      fixture.calls.some(
        ([kind, method, params]) =>
          kind === "cdp" &&
          method === "Input.dispatchMouseEvent" &&
          params.type === "mouseReleased",
      ),
    );
  });
});

test("close leaves an anchor tab and the next page gets a new label", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const first = await openTestPage(task, "https://example.test/first");

    await first.close();
    assert.equal(fixture.tabs.has("target-1"), false);
    assert.equal(
      fixture.tabs.size,
      1,
      "the task space must retain an anchor tab",
    );
    await assert.rejects(
      () => task.page("p1").goto("https://example.test/closed"),
      /page p1 was closed/,
    );

    const second = await openTestPage(task, "https://example.test/second");
    assert.equal(second.label, "p2");
    assert.equal(second.targetId, "target-3");
  });
});

test("close waits for the target to disappear before retiring its label", async () => {
  await withFixture(async (fixture) => {
    let closeRequested = false;
    let postCloseReads = 0;
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (method === "Target.closeTarget") {
          closeRequested = true;
          return { success: true };
        }
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      },
      async listTabs() {
        await fixture.services.listTabs();
        if (closeRequested && ++postCloseReads === 3) {
          fixture.tabs.delete("target-1");
        }
        return [...fixture.tabs.values()];
      },
    });
    const page = await openTestPage(task, "https://example.test/first");

    await page.close();

    assert.equal(postCloseReads, 3);
    await assert.rejects(
      () => task.page(page.label).title(),
      /page p1 was closed/,
    );
  });
});

test("close keeps the page managed when the target never disappears", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (method === "Target.closeTarget") return { success: true };
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      },
    });
    const page = await openTestPage(task, "https://example.test/first");

    await assert.rejects(() => page.close(), /did not close within 2000ms/);

    const inventory = await task.tabs();
    assert.equal(inventory[0].label, page.label);
    assert.equal(await page.title(), "https://example.test/first");
  });
});

test("a ledger failure closes the newly created uncommitted tab", async () => {
  await withFixture(async (fixture) => {
    const task = createTaskSpaceHandle(
      { id: 7, name: "research", ownership: "agent" },
      {
        ...fixture.services,
        ledger: {
          async reconcile() {
            return { pages: {} };
          },
          async addPage() {
            throw new Error("ledger unavailable");
          },
        },
      },
    );

    await assert.rejects(
      () => openTestPage(task, "https://example.test/uncommitted"),
      /ledger unavailable/,
    );
    assert.equal(fixture.tabs.size, 0);
    assert(
      fixture.calls.some(
        ([kind, method]) => kind === "cdp" && method === "Target.closeTarget",
      ),
    );
  });
});

test("pages returns managed Page handles while tabs returns the complete inventory", async () => {
  await withFixture(async (fixture) => {
    fixture.tabs.set("target-user", {
      targetId: "target-user",
      url: "https://example.test/user",
      title: "User page",
      active: false,
    });
    const task = taskForRound(fixture, "round-a");
    const managed = await openTestPage(task, "https://example.test/managed");
    fixture.tabs.set("target-popup", {
      targetId: "target-popup",
      url: "https://example.test/popup",
      title: "Late popup",
      active: false,
    });

    const pages = await task.pages();
    const tabs = await task.tabs();
    const managedItem = tabs.find((item) => item.label === "p1");
    const popupItem = tabs.find((item) => item.label === "p2");
    const unknownItem = tabs.find((item) => item.targetId === "target-user");

    assert.deepEqual(
      pages.map((page) => page.label),
      ["p1", "p2"],
    );
    assert(pages.every((page) => typeof page.url === "function"));
    assert.equal(
      pages.some((page) => page.targetId === "target-user"),
      false,
    );
    assert.equal(managedItem.page.label, "p1");
    assert.equal(managedItem.page.targetId, managed.targetId);
    assert.equal(managedItem.title, "https://example.test/managed");
    assert.equal(managedItem.openedBy, "agent");
    assert.equal(popupItem.page.label, "p2");
    assert.equal(popupItem.openedBy, "agent");
    assert.equal(unknownItem.label, undefined);
    assert.equal(unknownItem.page.targetId, "target-user");
    assert.equal(unknownItem.page.spaceId, 7);
    assert.equal(unknownItem.page.openedBy, "unknown");
    assert.equal(unknownItem.page.snapshot, undefined);
    assert.equal(unknownItem.page.goto, undefined);
    assert.equal(unknownItem.page.close, undefined);
    assert.equal(unknownItem.title, "User page");
    assert.equal(unknownItem.openedBy, "unknown");
    assert.equal(task.listPages, undefined);
  });
});

test("tabs automatically manages a tab created during agent control", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    await openTestPage(task, "https://example.test/managed");
    fixture.tabs.set("target-popup", {
      targetId: "target-popup",
      url: "https://example.test/popup",
      title: "Late popup",
      active: false,
    });

    const popup = (await task.tabs()).find(
      (item) => item.targetId === "target-popup",
    );

    assert.equal(popup.label, "p2");
    assert.equal(popup.openedBy, "agent");
    assert.equal(popup.page.label, "p2");
  });
});

test("adopt turns a live untracked page into a managed page", async () => {
  await withFixture(async (fixture) => {
    fixture.tabs.set("target-user", {
      targetId: "target-user",
      url: "https://example.test/user",
      title: "User page",
      active: true,
    });
    const task = taskForRound(fixture, "round-a");
    const [{ page: untracked }] = await task.tabs();

    const adopted = await task.adopt(untracked, { as: "notes" });

    assert.equal(adopted.label, "notes");
    assert.equal(adopted.targetId, "target-user");
    assert.equal(adopted.openedBy, "unknown");
    assert.match(
      await adopted.snapshot(),
      /\[notes .*space "research"\(7\).*\]\nsnapshot:https:\/\/example\.test\/user/,
    );
    assert.deepEqual(
      (await task.tabs()).map(({ label, openedBy }) => ({
        label,
        openedBy,
      })),
      [{ label: "notes", openedBy: "unknown" }],
    );
  });
});

test("adopt rejects stale, cross-space, and already managed handles", async () => {
  await withFixture(async (fixture) => {
    fixture.tabs.set("target-user", {
      targetId: "target-user",
      url: "https://example.test/user",
      title: "User page",
      active: true,
    });
    const task = taskForRound(fixture, "round-a");
    const [{ page: untracked }] = await task.tabs();
    const otherTask = createTaskSpaceHandle(
      { id: 8, name: "other", ownership: "agent" },
      {
        ledger: new PageLedgerStore({ rootDir: fixture.rootDir }),
        ...fixture.services,
      },
    );

    await assert.rejects(
      () => otherTask.adopt(untracked),
      /belongs to space 7, not space 8/,
    );

    const adopted = await task.adopt(untracked);
    await assert.rejects(
      () => task.adopt(untracked),
      /target target-user is already page p1/,
    );

    const inventory = await task.tabs();
    assert.equal(inventory[0].page.label, adopted.label);
    fixture.tabs.delete("target-user");
    const stale = untracked;
    await assert.rejects(
      () => task.adopt(stale),
      /untracked page target-user is no longer open/,
    );
  });
});

test("adopt applies the managed-page budget before changing the ledger", async () => {
  await withFixture(async (fixture) => {
    fixture.tabs.set("target-user", {
      targetId: "target-user",
      url: "https://example.test/user",
      title: "User page",
      active: false,
    });
    const task = taskForRound(fixture, "round-a", { pageBudget: 1 });
    await openTestPage(task, "https://example.test/managed");
    const untracked = (await task.tabs()).find(
      (item) => item.targetId === "target-user",
    ).page;

    await assert.rejects(
      () => task.adopt(untracked),
      /Page budget reached \(1\/1\)/,
    );
    const after = await task.tabs();
    assert.equal(
      after.find((item) => item.targetId === "target-user").label,
      undefined,
    );
  });
});

test("release leaves an adopted page open and retires its label", async () => {
  await withFixture(async (fixture) => {
    fixture.tabs.set("target-user", {
      targetId: "target-user",
      url: "https://example.test/user",
      title: "User page",
      active: true,
    });
    const task = taskForRound(fixture, "round-a");
    const untracked = (await task.tabs())[0].page;
    const adopted = await task.adopt(untracked);

    const released = await task.release(adopted.label);

    assert.equal(released.targetId, "target-user");
    assert.equal(fixture.tabs.has("target-user"), true);
    assert.equal((await task.tabs())[0].label, undefined);
    await assert.rejects(() => adopted.snapshot(), /page p1 was released/);
    const adoptedAgain = await task.adopt(released);
    assert.equal(adoptedAgain.label, "p2");
  });
});

test("release refuses to orphan a page created by the agent", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const created = await openTestPage(task, "https://example.test/agent");

    await assert.rejects(
      () => task.release(created.label),
      /page p1 was created by the agent; close it instead/,
    );
    assert.equal(fixture.tabs.has(created.targetId), true);
    assert.equal((await task.tabs())[0].label, "p1");
  });
});

test("tabs retires a managed label when its browser tab disappeared", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/managed");
    fixture.tabs.delete(page.targetId);

    assert.deepEqual(await task.tabs(), []);
    await assert.rejects(
      () => task.page("p1").snapshot(),
      /page p1 was closed/,
    );
  });
});

test("newPage rejects before creating a tab when the managed budget is full", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { pageBudget: 2 });
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");

    await assert.rejects(
      () => openTestPage(task, "https://example.test/third"),
      (error) => {
        assert.match(
          error.message,
          /Page budget reached \(2\/2\) in space "research"/,
        );
        assert.match(error.message, /p1\s+"https:\/\/example\.test\/first"/);
        assert.match(
          error.message,
          /Close: await task\.page\('p1'\)\.close\(\)/,
        );
        assert.match(
          error.message,
          /Reuse: await task\.page\('p1'\)\.goto\(url\)/,
        );
        return true;
      },
    );
    assert.equal(
      fixture.tabs.size,
      2,
      "budget rejection must happen before createTab",
    );

    await first.close();
    const replacement = await openTestPage(task, "https://example.test/third");
    assert.equal(replacement.label, "p3");
    assert.equal(fixture.tabs.size, 2);
  });
});

test("a tab closed outside the runtime frees budget on the next newPage", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", { pageBudget: 2 });
    const first = await openTestPage(task, "https://example.test/first");
    await openTestPage(task, "https://example.test/second");
    fixture.tabs.delete(first.targetId);

    const replacement = await openTestPage(task, "https://example.test/third");

    assert.equal(replacement.label, "p3");
    assert.equal(fixture.tabs.size, 2);
    await assert.rejects(
      () => task.page("p1").snapshot(),
      /page p1 was closed/,
    );
  });
});

test("newPage never closes a managed page when native returns its target again", async () => {
  await withFixture(async (fixture) => {
    const firstTask = taskForRound(fixture, "round-a");
    const first = await openTestPage(firstTask, "https://example.test/first");
    const closeCallsBefore = fixture.calls.filter(
      ([kind, method]) => kind === "cdp" && method === "Target.closeTarget",
    ).length;
    const secondTask = taskForRound(fixture, "round-a", {
      async createTab() {
        return first.targetId;
      },
    });

    await assert.rejects(
      () => openTestPage(secondTask, "https://example.test/second"),
      /did not create a distinct tab.*already page p1/,
    );

    assert.equal(fixture.tabs.has(first.targetId), true);
    assert.equal(
      fixture.calls.filter(
        ([kind, method]) => kind === "cdp" && method === "Target.closeTarget",
      ).length,
      closeCallsBefore,
    );
  });
});

/** Answer the settle probe like a Page that drew little text 800 ms ago. */
function settleProbeServices(fixture, pageState = {}) {
  const probes = [];
  return {
    probes,
    overrides: {
      async cdp(method, params, sessionId, timeoutMs) {
        if (
          method === "Runtime.evaluate" &&
          params.expression.includes("egoBrowser.settle") &&
          !params.expression.includes("__egoSettleProbe")
        ) {
          probes.push("release");
          return { result: { type: "boolean", value: true } };
        }
        if (
          method === "Runtime.evaluate" &&
          params.expression.includes("egoBrowser.settle")
        ) {
          const full = params.expression.includes("innerText");
          probes.push(full ? "full" : "light");
          if (full) {
            assert.match(
              params.expression,
              /disconnect\(\)[\s\S]*delete globalThis\[key\]/,
              "the last snapshot probe removes the observer",
            );
          }
          return {
            result: {
              type: "object",
              value: {
                __egoSettleProbe: true,
                url: "https://example.test/first",
                readyState: "complete",
                quietMs: 900,
                mutations: 0,
                ageMs: 800,
                ...(full ? { nodes: 18, textChars: 40 } : {}),
                ...pageState,
              },
            },
          };
        }
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      },
    },
  };
}

test("snapshot adds a stats line and a rendering warning after the header", async () => {
  await withFixture(async (fixture) => {
    const { probes, overrides } = settleProbeServices(fixture);
    const task = taskForRound(fixture, "round-a", overrides);
    const page = await openTestPage(task, "https://example.test/first");

    const text = await page.snapshot();
    assert.match(
      text,
      /^\[p1 [^\n]*\]\n\[stats nodes=18 refs=1 text=40 readyState=complete domChanging=no\]\n\[warning page may still be rendering: the page loaded 800 ms ago and has little text\. Wait for the content \(page\.waitForSelector or page\.waitForSettled\), then snapshot again\.\]\nsnapshot:https:\/\/example\.test\/first$/,
    );
    assert.deepEqual(probes, ["light", "full"]);
    assert.equal(
      fixture.snapshotOptions.at(-1).format,
      undefined,
      "SDK-only options never reach the native snapshot",
    );
  });
});

test("snapshot format object returns the text, stats and warnings", async () => {
  await withFixture(async (fixture) => {
    const { overrides } = settleProbeServices(fixture, { textChars: 4_000 });
    const task = taskForRound(fixture, "round-a", overrides);
    const page = await openTestPage(task, "https://example.test/first");

    const result = await page.snapshot({ format: "object" });
    assert.equal(typeof result.text, "string");
    assert.match(result.text, /\[stats nodes=18 refs=1 text=4000 /);
    assert.deepEqual(result.stats, {
      nodes: 18,
      refs: 1,
      textChars: 4_000,
      readyState: "complete",
      domChanging: false,
    });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.settle, undefined);
    assert.doesNotMatch(result.text, /\[warning/);

    await assert.rejects(
      () => page.snapshot({ format: "json" }),
      /format must be one of text, object/,
    );
  });
});

test("snapshot leaves the stats out when the page cannot be probed", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const page = await openTestPage(task, "https://example.test/first");
    const result = await page.snapshot({ format: "object" });
    assert.equal(result.stats, undefined);
    assert.deepEqual(result.warnings, []);
    assert.match(result.text, /\]\nsnapshot:https:\/\/example\.test\/first$/);
  });
});

test("a failed snapshot or stats probe still removes the observer", async () => {
  await withFixture(async (fixture) => {
    const { probes, overrides } = settleProbeServices(fixture);
    let failSnapshot = true;
    const task = taskForRound(fixture, "round-a", {
      ...overrides,
      async snapshot(options) {
        if (failSnapshot) throw new Error("native snapshot failed");
        return fixture.services.snapshot(options);
      },
    });
    const page = await openTestPage(task, "https://example.test/first");
    await assert.rejects(() => page.snapshot(), /native snapshot failed/);
    assert.deepEqual(probes, ["light", "release"], "the error path releases");

    // An unknown subtree root fails before the native snapshot runs.
    probes.length = 0;
    failSnapshot = false;
    await assert.rejects(
      () => page.snapshot({ scope: "subtree", root: "@999" }),
      /Unknown ref|ref/,
    );
    assert.deepEqual(probes, ["light", "release"]);

    // A stats probe that does not answer falls back to an explicit release.
    probes.length = 0;
    const silentStats = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (
          method === "Runtime.evaluate" &&
          String(params.expression).includes("innerText") &&
          String(params.expression).includes("egoBrowser.settle")
        ) {
          probes.push("full");
          throw new Error("CDP request timed out: Runtime.evaluate");
        }
        return overrides.cdp(method, params, sessionId, timeoutMs);
      },
    });
    const quiet = await openTestPage(silentStats, "https://example.test/first");
    assert.match(await quiet.snapshot(), /snapshot:/);
    assert.deepEqual(probes, ["light", "full", "release"]);
  });
});

test("snapshot settle waits for the page before the snapshot", async () => {
  await withFixture(async (fixture) => {
    const { probes, overrides } = settleProbeServices(fixture, {
      textChars: 4_000,
    });
    const task = taskForRound(fixture, "round-a", overrides);
    const page = await openTestPage(task, "https://example.test/first");

    const result = await page.snapshot({
      settle: { quietMs: 800, timeout: 2_000 },
      format: "object",
    });
    assert.equal(result.settle.settled, true);
    assert.equal(result.settle.readyState, "complete");
    assert.deepEqual(probes, ["light", "release", "light", "full"]);
    assert(
      fixture.calls.some(
        ([kind, method]) => kind === "cdp" && method === "Network.enable",
      ),
      "settle tracks fetch/XHR requests",
    );
    assert.match(await page.snapshot({ settle: true }), /\[stats /);

    await assert.rejects(
      () => page.snapshot({ settle: "yes" }),
      /settle must be true, false, or an options object/,
    );
    await assert.rejects(
      () => page.snapshot({ settle: { quiet: 1 } }),
      /waitForSettled received unknown option: quiet/,
    );
  });
});

test("waitForSettled resolves with what it saw and counts until matches", async () => {
  await withFixture(async (fixture) => {
    const { overrides } = settleProbeServices(fixture);
    const task = taskForRound(fixture, "round-a", overrides);
    const page = await openTestPage(task, "https://example.test/first");

    const settled = await page.waitForSettled({ until: "#ready" });
    assert.equal(settled.settled, true);
    assert.equal(settled.matches, 1);
    assert.equal(settled.pendingRequests, 0);

    fixture.setElementState({ present: false });
    const missing = await page.waitForSettled({
      until: "#ready",
      timeout: 300,
    });
    assert.equal(missing.settled, false);
    assert.equal(missing.matches, 0);
    assert.equal(missing.reason, "#ready matched 0 of 1");

    await assert.rejects(
      () => page.waitForSettled({ minCount: 0 }),
      /minCount must be a positive integer/,
    );
  });
});

/** Page event subscriptions and response bodies for the network tests. */
function responseServices(fixture, bodies = {}) {
  const listeners = new Map();
  const network = {
    overrides: {
      subscribePageEvents(targetId, listener) {
        const set = listeners.get(targetId) || new Set();
        set.add(listener);
        listeners.set(targetId, set);
        return () => set.delete(listener);
      },
      async cdp(method, params, sessionId, timeoutMs) {
        if (method === "Network.getResponseBody") {
          return bodies[params.requestId] ?? { body: "", base64Encoded: false };
        }
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      },
    },
    listenerCount(targetId) {
      return listeners.get(targetId)?.size ?? 0;
    },
    respond(
      targetId,
      requestId,
      url,
      { type = "Fetch", mimeType = "application/json" } = {},
    ) {
      const emit = (method, params) => {
        for (const listener of [...(listeners.get(targetId) || [])]) {
          listener({ sessionId: `session:${targetId}`, method, params });
        }
      };
      emit("Network.requestWillBeSent", {
        requestId,
        type,
        request: { url, method: "GET" },
      });
      emit("Network.responseReceived", {
        requestId,
        type,
        response: { url, status: 200, statusText: "OK", headers: {}, mimeType },
      });
      emit("Network.loadingFinished", { requestId, encodedDataLength: 20 });
    },
  };
  return network;
}

test("waitForResponse arms before the action and resolves with the parsed body", async () => {
  await withFixture(async (fixture) => {
    const network = responseServices(fixture, {
      "req-2": { body: '{"items":["a","b"]}', base64Encoded: false },
    });
    const listenersAtInput = [];
    let page;
    // Make the waiter's own Page lookup slow, so without the arm barrier the
    // click would reach the page before the waiter subscribed.
    const store = new PageLedgerStore({ rootDir: fixture.rootDir });
    let delayNextLookup = false;
    const ledger = new Proxy(store, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== "getPage") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args) => {
          if (delayNextLookup) {
            delayNextLookup = false;
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          return value.apply(target, args);
        };
      },
    });
    const task = taskForRound(fixture, "round-a", {
      ...network.overrides,
      ledger,
      async cdp(method, params, ...rest) {
        if (method === "Input.dispatchMouseEvent") {
          listenersAtInput.push(network.listenerCount(page.targetId));
        }
        return network.overrides.cdp(method, params, ...rest);
      },
    });
    page = await openTestPage(task, "https://example.test/first");

    delayNextLookup = true;
    const pending = page.waitForResponse(/\/api\/items/);
    await page.click("#ready");
    assert(listenersAtInput.length > 0, "the click sent input");
    assert(
      listenersAtInput.every((count) => count === 1),
      `the waiter listens before the click reaches the page: ${listenersAtInput}`,
    );
    network.respond(page.targetId, "req-1", "https://example.test/api/other");
    network.respond(
      page.targetId,
      "req-2",
      "https://example.test/api/items?q=a",
    );
    const response = await pending;

    assert.equal(response.url, "https://example.test/api/items?q=a");
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { items: ["a", "b"] });
    assert.equal(
      network.listenerCount(page.targetId),
      0,
      "the waiter unsubscribes",
    );
    assert(
      fixture.calls.some(
        ([kind, method]) => kind === "cdp" && method === "Network.enable",
      ),
    );
  });
});

test("waitForResponse times out with the matcher in the message and validates input", async () => {
  await withFixture(async (fixture) => {
    const network = responseServices(fixture);
    const task = taskForRound(fixture, "round-a", network.overrides);
    const page = await openTestPage(task, "https://example.test/first");

    await assert.rejects(
      () => page.waitForResponse("/api/never", { timeout: 20 }),
      (error) => {
        assert.match(
          error.message,
          /page\.waitForResponse timed out after 20ms waiting for "\/api\/never"/,
        );
        return true;
      },
    );
    assert.equal(network.listenerCount(page.targetId), 0);
    assert.throws(
      () => page.waitForResponse(42),
      /matcher must be a non-empty URL string, a RegExp, or a function/,
    );
    assert.throws(
      () => page.waitForResponse("/api", { maxBodyBytes: -1 }),
      /maxBodyBytes must be a positive integer/,
    );
  });
});

test("captureResponses collects matching responses until stop", async () => {
  await withFixture(async (fixture) => {
    const network = responseServices(fixture, {
      g1: { body: '{"data":1}', base64Encoded: false },
      g2: { body: '{"data":2}', base64Encoded: false },
    });
    const task = taskForRound(fixture, "round-a", network.overrides);
    const page = await openTestPage(task, "https://example.test/first");

    const capture = await page.captureResponses({ match: "graphql" });
    network.respond(page.targetId, "g1", "https://example.test/graphql?op=1");
    network.respond(page.targetId, "skip", "https://example.test/rest");
    network.respond(page.targetId, "g2", "https://example.test/graphql?op=2");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capture.responses().length, 2);
    const responses = await capture.stop();
    network.respond(page.targetId, "g3", "https://example.test/graphql?op=3");

    assert.deepEqual(
      responses.map((response) => response.json),
      [{ data: 1 }, { data: 2 }],
    );
    assert.equal(
      await capture.stop(),
      await capture.stop(),
      "stop is idempotent",
    );
    assert.equal(network.listenerCount(page.targetId), 0);
    await assert.rejects(
      () => page.captureResponses({ match: 7 }),
      /match must be a non-empty URL string, a RegExp, or a function/,
    );
  });
});

/** Host-extension services backed by an in-memory memo store. */
function hostServices(capabilities, extra = {}) {
  const memo = new Map(Object.entries(extra.memo || {}));
  const events = [];
  return {
    memo,
    events,
    overrides: {
      hostCapabilities: () => capabilities,
      async taskSpaceMemo(key, write) {
        events.push(["memo", key, write ? write.value : undefined]);
        if (write) {
          if (write.value === null) memo.delete(key);
          else memo.set(key, write.value);
          return { found: write.value !== null, value: write.value };
        }
        return memo.has(key)
          ? { found: true, value: memo.get(key) }
          : { found: false, value: null };
      },
      logEvent(entry) {
        events.push(["log", entry]);
      },
      ...extra.overrides,
    },
  };
}

test("task.memo reads, writes and deletes through the host", async () => {
  await withFixture(async (fixture) => {
    const host = hostServices({ taskSpaceMemo: true });
    const task = taskForRound(fixture, "round-a", host.overrides);

    assert.equal(await task.memo("step"), undefined);
    assert.deepEqual(await task.memo("step", { done: 1 }), { done: 1 });
    assert.deepEqual(await task.memo("step"), { done: 1 });
    assert.equal(await task.memo("step", null), undefined);
    assert.equal(await task.memo("step"), undefined);
    await assert.rejects(() => task.memo("__ego.pageUrls"), /reserved/);
    await assert.rejects(() => task.memo(""), /non-empty string key/);
    await assert.rejects(() => task.memo("k", undefined), /JSON-serializable/);
    await assert.rejects(() => task.memo("k", 1, 2), /accepts \(key\)/);
    assert(
      fixture.calls.some(([name, id]) => name === "selectSpace" && id === 7),
      "memo runs with the space selected",
    );
  });
});

test("host extensions fail clearly on a host without them", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a", {
      hostCapabilities: () => ({}),
    });
    for (const call of [
      () => task.memo("k"),
      () => task.restorePages(),
      () => task.handOff({ relay: true }),
    ]) {
      await assert.rejects(call, (error) => {
        assert.equal(error.error_code, "EGO_UNSUPPORTED_ON_HOST");
        assert.match(error.message, /not supported on this browser host/);
        return true;
      });
    }
  });
});

test("goto remembers each label's URL so restorePages can relabel tabs", async () => {
  await withFixture(async (fixture) => {
    const host = hostServices({
      taskSpaceMemo: true,
      restoreTaskSpaceTabs: true,
    });
    const task = taskForRound(fixture, "round-a", host.overrides);
    const p1 = await openTestPage(task, "https://example.test/one");
    await openTestPage(task, "https://example.test/two");
    assert.deepEqual(host.memo.get("__ego.pageUrls"), {
      [p1.label]: "https://example.test/one",
      p2: "https://example.test/two",
    });

    // A browser restart: the ledger is new and the tabs are gone.
    const restartedLedger = new PageLedgerStore({
      rootDir: join(fixture.rootDir, "after-restart"),
    });
    const restored = taskForRound(fixture, "round-b", {
      ...host.overrides,
      ledger: restartedLedger,
      async restoreTaskSpaceTabs() {
        fixture.addExternalTab("target-r2", "https://example.test/two");
        fixture.addExternalTab("target-r1", "https://example.test/one");
        fixture.addExternalTab("target-r3", "https://example.test/new");
        return {
          tabs: [
            { targetId: "target-r2", url: "https://example.test/two" },
            { targetId: "target-r1", url: "https://example.test/one" },
            { targetId: "target-r3", url: "https://example.test/new" },
          ],
          skipped: ["file:///tmp/x"],
        };
      },
    });
    const result = await restored.restorePages();
    assert.deepEqual(result.pages, [
      { label: "p2", url: "https://example.test/two" },
      { label: "p1", url: "https://example.test/one" },
      { label: "p3", url: "https://example.test/new" },
    ]);
    assert.deepEqual(result.skipped, ["file:///tmp/x"]);
    const pages = (await restartedLedger.read(7)).pages;
    assert.equal(pages.p1.targetId, "target-r1");
    assert.equal(pages.p2.targetId, "target-r2");
    assert.equal(pages.p1.openedBy, "agent");
  });
});

test("handOff with relay keeps control and returns the relay files", async () => {
  await withFixture(async (fixture) => {
    const lifecycle = [];
    const task = taskForRound(fixture, "round-a", {
      hostCapabilities: () => ({ handOffRelay: true }),
      async handOffRelay() {
        lifecycle.push("relay");
        return { relay: { screenshot: "/tmp/s.png", snapshot: "/tmp/s.txt" } };
      },
      async handOffTaskSpace() {
        lifecycle.push("handOff");
      },
    });
    const page = await openTestPage(task, "https://example.test/one");
    assert.deepEqual(await task.handOff({ relay: true }), {
      relay: { screenshot: "/tmp/s.png", snapshot: "/tmp/s.txt" },
    });
    assert.deepEqual(lifecycle, ["relay"]);
    await page.goto("https://example.test/two");
    await assert.rejects(
      () => task.handOff({ relay: "yes" }),
      /relay must be boolean/,
    );
  });
});

test("Page actions are written to the host round log without values", async () => {
  await withFixture(async (fixture) => {
    const host = hostServices({ logEvent: true });
    const task = taskForRound(fixture, "round-a", host.overrides);
    const page = await openTestPage(task, "https://example.test/path?q=secret");
    await page.fill("#name", "typed secret");
    await assert.rejects(() => page.click("#name", { trial: true }));
    const logs = host.events
      .filter(([kind]) => kind === "log")
      .map(([, entry]) => entry);
    const goto = logs.find((entry) => entry.action === "page.goto");
    assert.equal(goto.target, "https://example.test");
    assert.equal(goto.page, page.label);
    assert.equal(goto.ok, true);
    assert.equal(typeof goto.ms, "number");
    const fill = logs.find((entry) => entry.action === "page.fill");
    assert.equal(fill.target, "#name");
    assert(!JSON.stringify(logs).includes("secret"), "no values or queries");
    const failed = logs.find((entry) => entry.action === "page.click");
    assert.equal(failed.ok, false);
  });
});

test("Page actions are not logged on a host without a round log", async () => {
  await withFixture(async (fixture) => {
    const host = hostServices({});
    const task = taskForRound(fixture, "round-a", host.overrides);
    await openTestPage(task, "https://example.test/one");
    assert.equal(host.events.filter(([kind]) => kind === "log").length, 0);
  });
});

test("task.map runs every URL on reused Pages and reports failures", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, "round-a");
    const seen = [];
    const results = await task.map(
      [
        "https://example.test/a",
        "https://example.test/b",
        "https://example.test/c",
      ],
      async (page, url, index) => {
        seen.push(page.label);
        if (index === 1) throw new Error("boom");
        return `${index}:${url}`;
      },
      { concurrency: 2 },
    );
    assert.deepEqual(
      results.map((result) => result.ok),
      [true, false, true],
    );
    assert.equal(results[0].value, "0:https://example.test/a");
    assert.equal(results[1].error, "boom");
    assert.equal(new Set(seen).size, 2, "two Pages are reused");
    assert.equal((await task.pages()).length, 0, "the Pages are closed");
    assert.deepEqual(await task.map([], () => 1), []);
    await assert.rejects(() => task.map("x", () => 1), /array of URL strings/);
    await assert.rejects(
      () => task.map([], () => 1, { concurrency: 0 }),
      /concurrency must be a positive integer/,
    );
  });
});

/** Answer isolated-world extraction calls with fixed values. */
function isolatedServices(fixture, answers) {
  const evaluations = [];
  return {
    evaluations,
    overrides: {
      async cdp(method, params, sessionId, timeoutMs) {
        if (method === "Page.getFrameTree") {
          return { frameTree: { frame: { id: "frame-main" } } };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: 42 };
        }
        if (method === "Runtime.evaluate" && params.contextId === 42) {
          evaluations.push(params.expression);
          for (const [marker, value] of answers) {
            if (params.expression.includes(marker)) {
              return { result: { type: "object", value } };
            }
          }
          return { result: { type: "undefined" } };
        }
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      },
    },
  };
}

test("page.read runs in an isolated world and truncates Markdown", async () => {
  await withFixture(async (fixture) => {
    const body = Array.from(
      { length: 50 },
      (_v, i) => `## Part ${i}\n\n${"text ".repeat(30).trim()}`,
    ).join("\n\n");
    const { evaluations, overrides } = isolatedServices(fixture, [
      ["embed[original-url]", { pdf: false, url: "https://example.test/a" }],
      [
        "SKIP_TAGS",
        {
          url: "https://example.test/a",
          title: "A",
          markdown: `# A\n\n${body}`,
          links: [],
          source: "article",
        },
      ],
    ]);
    const task = taskForRound(fixture, "round-a", overrides);
    const page = await openTestPage(task, "https://example.test/a");
    const result = await page.read({ maxChars: 1000 });
    assert.equal(result.truncated, true);
    assert(result.markdown.length <= 1000);
    assert.equal(result.source, "article");
    assert(result.words > 30);
    assert.equal(evaluations.length, 2, "PDF check, then extraction");
    await assert.rejects(
      () => page.read({ mode: "full", selector: "main" }),
      /mode or selector, not both/,
    );
    await assert.rejects(() => page.read({ mode: "all" }), /must be one of/);
  });
});

test("page.read explains a selector error and warns on a near-empty page", async () => {
  await withFixture(async (fixture) => {
    let answer = { error: "selector matched no element: #x" };
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (method === "Page.getFrameTree") {
          return { frameTree: { frame: { id: "f" } } };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: 9 };
        }
        if (method === "Runtime.evaluate" && params.contextId === 9) {
          return { result: { type: "object", value: answer } };
        }
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      },
    });
    const page = await openTestPage(task, "https://example.test/a");
    await assert.rejects(
      () => page.read({ selector: "#x" }),
      (error) => {
        assert.match(error.message, /page\.read: selector matched no element/);
        assert.match(error.hint, /snapshot/);
        return true;
      },
    );
    answer = {
      url: "https://example.test/a",
      title: "A",
      markdown: "Loading",
      links: [],
      source: "body",
    };
    const thin = await page.read({ selector: "body" });
    assert.match(thin.warning, /very little readable text/);
  });
});

test("page.tables turns grids into rows and writes one table as CSV", async () => {
  await withFixture(async (fixture) => {
    const { overrides } = isolatedServices(fixture, [
      [
        "SKIP_TABLE",
        {
          tables: [
            {
              kind: "table",
              selector: "#t",
              caption: "Scores",
              grid: [
                ["Name", "Score"],
                ["Ann", "1,000"],
              ],
              headerRows: 1,
            },
            {
              kind: "grid",
              selector: "#g",
              grid: [["x"], ["y"]],
              headerRows: 0,
            },
          ],
        },
      ],
    ]);
    const task = taskForRound(fixture, "round-a", overrides);
    const page = await openTestPage(task, "https://example.test/a");
    const tables = await page.tables();
    assert.equal(tables.length, 2);
    assert.deepEqual(tables[0].rows, [{ Name: "Ann", Score: "1,000" }]);
    assert.equal(tables[0].caption, "Scores");
    assert.equal(tables[0].csv, undefined, "CSV only when asked");
    const path = join(fixture.rootDir, "out", "t.csv");
    const [saved] = await page.tables({ index: 0, saveAs: path });
    assert.equal(await readFile(path, "utf8"), 'Name,Score\r\nAnn,"1,000"\r\n');
    assert.equal(saved.csv, 'Name,Score\r\nAnn,"1,000"\r\n');
    await assert.rejects(
      () => page.tables({ saveAs: path }),
      /writes one table, but 2 matched; pass index/,
    );
    await assert.rejects(
      () => page.tables({ index: 5 }),
      /out of range: found 2 tables/,
    );
    await assert.rejects(
      () => page.tables({ index: -1 }),
      /non-negative integer/,
    );
    await assert.rejects(
      () => page.tables({ index: 0, saveAs: "relative.csv" }),
      /absolute/,
    );
  });
});

function searchTask(fixture, pages) {
  return taskForRound(fixture, "round-a", {
    async cdp(method, params, sessionId, timeoutMs) {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "f" } } };
      }
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: 3 };
      }
      if (method === "Runtime.evaluate" && params.contextId === 3) {
        const engine = /"engine":"(\w+)"/.exec(
          JSON.parse(
            /JSON\.parse\(("(?:[^"\\]|\\.)*")\)/.exec(params.expression)[1],
          ),
        )[1];
        return { result: { type: "object", value: pages[engine] } };
      }
      return fixture.services.cdp(method, params, sessionId, timeoutMs);
    },
  });
}

test("page.search treats unrelated results and 'nothing found' as doubtful", async () => {
  await withFixture(async (fixture) => {
    const unrelated = {
      url: "https://www.bing.com/search?q=rust",
      results: [
        { title: "Air New Zealand", url: "https://air.test/", snippet: "Fly" },
        { title: "Speedtest", url: "https://speed.test/", snippet: "Fast" },
      ],
    };
    const related = {
      url: "https://html.duckduckgo.com/html/?q=rust",
      results: [
        { title: "Rust lifetimes", url: "https://rust.test/", snippet: "" },
      ],
    };
    const google = {
      url: "https://www.google.com/sorry/index",
      blocked: "Google showed its unusual-traffic check (/sorry/)",
      results: [],
    };
    let page = await searchTask(fixture, {
      bing: unrelated,
      duckduckgo: related,
      google,
    }).newPage();
    const better = await page.search("rust lifetimes");
    assert.equal(better.engine, "duckduckgo", "the next engine answers");
    assert.equal(better.warning, undefined);

    page = await searchTask(fixture, {
      bing: unrelated,
      duckduckgo: { ...google, url: "https://html.duckduckgo.com/html/" },
      google,
    }).newPage();
    const doubtful = await page.search("rust lifetimes");
    assert.equal(doubtful.engine, "bing", "the doubtful answer is kept last");
    assert.equal(doubtful.results.length, 2);
    assert.match(doubtful.warning, /no result mentions any word/);
    assert.equal(doubtful.blocked.length, 2);

    page = await searchTask(fixture, {
      bing: {
        url: "https://www.bing.com/search?q=x",
        results: [],
        noResults: true,
      },
    }).newPage();
    const none = await page.search("linux kernel", { engine: "bing" });
    assert.equal(none.noResults, true);
    assert.match(none.warning, /bing says it found nothing/);
  });
});

test("page.search reports blocked engines and falls through to the next", async () => {
  await withFixture(async (fixture) => {
    const pages = {
      bing: { url: "https://www.bing.com/search?q=x", results: [] },
      duckduckgo: {
        url: "https://html.duckduckgo.com/html/?q=x",
        results: [
          {
            title: "Result",
            url: "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2F",
            snippet: "S",
          },
        ],
      },
      google: {
        url: "https://www.google.com/sorry/index",
        blocked: "Google showed its unusual-traffic check (/sorry/)",
        results: [],
      },
    };
    const task = taskForRound(fixture, "round-a", {
      async cdp(method, params, sessionId, timeoutMs) {
        if (method === "Page.getFrameTree") {
          return { frameTree: { frame: { id: "f" } } };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: 3 };
        }
        if (method === "Runtime.evaluate" && params.contextId === 3) {
          const engine = /"engine":"(\w+)"/.exec(
            JSON.parse(
              /JSON\.parse\(("(?:[^"\\]|\\.)*")\)/.exec(params.expression)[1],
            ),
          )[1];
          return { result: { type: "object", value: pages[engine] } };
        }
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      },
    });
    const page = await task.newPage();
    const auto = await page.search("x");
    assert.equal(auto.engine, "duckduckgo");
    assert.equal(
      auto.results[0].url,
      "https://a.test/",
      "tracking links unwrap",
    );
    assert.equal(auto.blocked.length, 1);
    assert.equal(auto.blocked[0].engine, "bing");
    assert.match(auto.blocked[0].reason, /no results could be read/);

    const google = await page.search("x", { engine: "google" });
    assert.equal(google.engine, null);
    assert.deepEqual(google.results, []);
    assert.match(google.blocked[0].reason, /sorry/);
    assert.match(google.blocked[0].hint, /bing/);
    await assert.rejects(() => page.search(" "), /non-empty query/);
    await assert.rejects(
      () => page.search("x", { engine: "yahoo" }),
      /engine must be one of auto, bing, duckduckgo, google/,
    );
  });
});

function tallPageTask(
  fixture,
  { height, stallFirstCaptureAt, refuseEmulation = false } = {},
) {
  let stalled = false;
  return taskForRound(fixture, "round-a", {
    async cdp(method, params, sessionId, timeoutMs) {
      if (method.startsWith("Emulation.")) {
        fixture.calls.push(["cdp", method, params, sessionId]);
        if (refuseEmulation) throw new Error(`unsupported ${method}`);
        return {};
      }
      if (
        method === "Runtime.evaluate" &&
        String(params.expression).includes(
          "document.documentElement.scrollWidth, innerWidth",
        )
      ) {
        return {
          result: {
            type: "object",
            value: { width: 8, height, x: 0, y: 120 },
          },
        };
      }
      if (
        method === "Runtime.evaluate" &&
        String(params.expression).startsWith("scrollTo(")
      ) {
        fixture.calls.push(["scroll", params.expression]);
        return { result: { type: "undefined" } };
      }
      return fixture.services.cdp(method, params, sessionId, timeoutMs);
    },
    async screenshot(path, options, sessionId) {
      fixture.calls.push(["screenshot", path, options, sessionId]);
      if (stallFirstCaptureAt === options.clip?.y && !stalled) {
        stalled = true;
        throw new CdpRequestTimeoutError(
          "Page.captureScreenshot",
          options.timeoutMs,
          sessionId,
        );
      }
      // A one-colour PNG of the clip size, coloured by its y offset.
      const { width, height: h, y } = options.clip;
      const rgba = Buffer.alloc(width * h * 4, (y / 1000) % 256);
      const file = path || join(fixture.rootDir, `shot-${y}.png`);
      await writeFile(file, encodePng({ width, height: h, rgba }));
      return file;
    },
  });
}

test("fullPage screenshots stop at maxHeight or split into tiles", async () => {
  await withFixture(async (fixture) => {
    const task = tallPageTask(fixture, { height: 9000 });
    const page = await openTestPage(task, "https://example.test/tall");
    const base = join(fixture.rootDir, "ego-tall.png");
    const tiles = await page.screenshot({
      fullPage: true,
      tiles: true,
      path: base,
    });
    assert.deepEqual(
      tiles,
      [1, 2, 3].map((n) => base.replace(".png", `-${n}.png`)),
    );
    const shots = fixture.calls.filter(([name]) => name === "screenshot");
    assert.deepEqual(
      shots.map(([, , options]) => options.clip),
      [
        { x: 0, y: 0, width: 8, height: 4000 },
        { x: 0, y: 4000, width: 8, height: 4000 },
        { x: 0, y: 8000, width: 8, height: 1000 },
      ],
    );
    assert(
      shots.every(([, , options]) => options.full === false),
      "regions are plain viewport captures of the emulated viewport",
    );
    const emulation = fixture.calls
      .filter(([kind, method]) => kind === "cdp" && /^Emulation\./.test(method))
      .map(([, method, params]) => [method, params]);
    assert.deepEqual(emulation, [
      [
        "Emulation.setDeviceMetricsOverride",
        { width: 8, height: 4000, deviceScaleFactor: 0, mobile: false },
      ],
      ["Emulation.clearDeviceMetricsOverride", {}],
    ]);
    assert(
      shots.every(([, , options]) => options.timeoutMs === 5000),
      "every region capture has its own short timeout",
    );
    assert.deepEqual(
      fixture.calls.filter(([name]) => name === "scroll").map(([, e]) => e),
      [
        "scrollTo(0, 0)",
        "scrollTo(0, 4000)",
        "scrollTo(0, 8000)",
        "scrollTo(0, 120)",
      ],
      "each region is scrolled into view, then the scroll position is restored",
    );

    const capped = join(fixture.rootDir, "capped.png");
    assert.equal(
      await page.screenshot({ fullPage: true, maxHeight: 5000, path: capped }),
      capped,
    );
    const cappedImage = decodePng(await readFile(capped));
    assert.deepEqual([cappedImage.width, cappedImage.height], [8, 5000]);

    const whole = join(fixture.rootDir, "whole.png");
    await page.screenshot({ fullPage: true, path: whole });
    const image = decodePng(await readFile(whole));
    assert.deepEqual(
      [image.width, image.height],
      [8, 9000],
      "a page under 16000 px is captured whole, stitched from regions",
    );
    // Rows keep their region's colour: 0 above 4000 px, 4 from 4000, 8 from 8000.
    assert.equal(image.rgba[3999 * 8 * 4], 0);
    assert.equal(image.rgba[4000 * 8 * 4], 4);
    assert.equal(image.rgba[8999 * 8 * 4], 8);
    const leftovers = (await readdir(fixture.rootDir)).filter((name) =>
      name.includes(".part-"),
    );
    assert.deepEqual(leftovers, [], "region files are removed after stitching");
    await assert.rejects(
      () => page.screenshot({ tiles: true }),
      /need fullPage: true/,
    );
  });
});

test("full-page regions fall back to captureBeyondViewport without emulation", async () => {
  await withFixture(async (fixture) => {
    const task = tallPageTask(fixture, { height: 6000, refuseEmulation: true });
    const page = await openTestPage(task, "https://example.test/tall");
    const file = join(fixture.rootDir, "fallback.png");
    assert.equal(await page.screenshot({ fullPage: true, path: file }), file);
    const shots = fixture.calls.filter(([name]) => name === "screenshot");
    assert.deepEqual(
      shots.map(([, , options]) => [options.full, options.clip.y]),
      [
        [true, 0],
        [true, 4000],
      ],
    );
    assert(
      !fixture.calls.some(
        ([, method]) => method === "Emulation.clearDeviceMetricsOverride",
      ),
      "nothing to clear when the override was refused",
    );
    const image = decodePng(await readFile(file));
    assert.deepEqual([image.width, image.height], [8, 6000]);
  });
});

test("a stalled full-page region capture is retried, not fatal", async () => {
  await withFixture(async (fixture) => {
    const task = tallPageTask(fixture, {
      height: 3000,
      stallFirstCaptureAt: 0,
    });
    const page = await openTestPage(task, "https://example.test/tall");
    const file = join(fixture.rootDir, "retry.png");
    assert.equal(await page.screenshot({ fullPage: true, path: file }), file);
    const shots = fixture.calls.filter(([name]) => name === "screenshot");
    assert.deepEqual(
      shots.map(([, , options]) => options.timeoutMs),
      [5000, 10000],
    );
    assert.deepEqual(
      fixture.calls.filter(([name]) => name === "scroll").map(([, e]) => e),
      [
        "scrollTo(0, 0)",
        "scrollTo(0, 1)",
        "scrollTo(0, 0)",
        "scrollTo(0, 120)",
      ],
      "the retry nudges the scroll position so Chrome paints a new frame",
    );
  });
});

test("page.site runs v2 Node tools with the Page and explains v1 tools", async () => {
  await withFixture(async (fixture) => {
    const workspace = join(fixture.rootDir, "workspace");
    const site = join(workspace, "learnings", "demo");
    await mkdir(join(site, "tools"), { recursive: true });
    await mkdir(join(site, "browser-tools"), { recursive: true });
    await mkdir(join(site, "notes"), { recursive: true });
    const schema = (path, callable, api) => ({
      description: "tool",
      path,
      ...(callable ? { callable } : {}),
      ...(api ? { api } : {}),
      args: {},
      returns: { type: "object", description: "value" },
    });
    await writeFile(
      join(site, "manifest.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        domains: ["demo.test"],
        notes: ["notes/overview.md"],
        nodeTools: {
          v2: schema("tools/v2.js", "run", 2),
          v1: schema("tools/v2.js", "run"),
        },
        browserTools: { title: schema("browser-tools/title.js") },
      }),
    );
    await writeFile(
      join(site, "tools", "v2.js"),
      "export async function run(page, args) { return { label: page.label, args }; }",
    );
    await writeFile(
      join(site, "browser-tools", "title.js"),
      "async (args) => 'title:' + args.n",
    );
    await writeFile(join(site, "notes", "overview.md"), "# Demo notes\n");
    const task = taskForRound(fixture, "round-a", {
      agentWorkspace: () => workspace,
    });
    const page = await openTestPage(task, "https://demo.test/");
    const demo = page.site("demo");
    assert.deepEqual(await demo.run("v2", { q: 1 }), {
      label: page.label,
      args: { q: 1 },
    });
    await assert.rejects(
      () => demo.run("v1"),
      (error) => {
        assert.match(error.message, /uses the v1 helper API/);
        assert.match(error.hint, /runSiteTool\("demo", "v1"/);
        return true;
      },
    );
    await assert.rejects(() => demo.run("missing"), /tools: v2, v1, title/);
    assert.deepEqual(
      (await demo.tools()).map((tool) => [tool.name, tool.kind, tool.api]),
      [
        ["v2", "node", 2],
        ["v1", "node", 1],
        ["title", "browser", 2],
      ],
    );
    assert.deepEqual(await demo.notes(), [
      { file: "notes/overview.md", content: "# Demo notes\n" },
    ]);
    await assert.rejects(
      () => page.site("nope").tools(),
      /site skill not found/,
    );
    assert.throws(() => page.site(""), /requires a site id/);
  });
});

test("page.fillSecret focuses the target, then the host types the secret", async () => {
  await withFixture(async (fixture) => {
    const order = [];
    const task = taskForRound(fixture, "round-a", {
      hostCapabilities: () => ({ fillSecret: true }),
      async fillSecret(name, options) {
        order.push(["fillSecret", name, options]);
        return { filled: true, secret: name, origin: "https://example.test" };
      },
    });
    const page = await openTestPage(task, "https://example.test/login");
    const result = await page.fillSecret("#password", "site-password");
    assert.deepEqual(result, {
      filled: true,
      secret: "site-password",
      origin: "https://example.test",
    });
    assert.deepEqual(order, [
      ["fillSecret", "site-password", { targetId: page.targetId, clear: true }],
    ]);
    await page.fillSecret("#password", "site-password", { clear: false });
    assert.equal(order.at(-1)[2].clear, false);
    await assert.rejects(() => page.fillSecret("", "x"), TypeError);
    await assert.rejects(() => page.fillSecret("#password"), /secret's name/);
    await assert.rejects(
      () => page.fillSecret("#password", "x", { value: "no" }),
      /unknown option: value/,
    );
  });
});

test("page.fillSecret on a non-focusable target says it is not a text field", async () => {
  await withFixture(async (fixture) => {
    let hostCalled = false;
    const task = taskForRound(fixture, "round-a", {
      hostCapabilities: () => ({ fillSecret: true }),
      async fillSecret() {
        hostCalled = true;
        return { filled: true };
      },
    });
    const page = await openTestPage(task, "https://example.test/login");
    fixture.configureFocusResult({
      error: "element is not focusable",
      details: { tagName: "DIV", contentEditable: false, tabIndex: -1 },
    });
    await assert.rejects(
      () => page.fillSecret("#password", "site-password"),
      (error) => {
        assert.match(
          error.message,
          /^page\.fillSecret: #password is not a text field: element is not focusable \(div/,
        );
        assert.doesNotMatch(error.message, /matched 0/);
        assert.match(error.hint, /cannot take typed text/);
        return true;
      },
    );
    assert.equal(hostCalled, false, "the host never types into a non-field");
  });
});

test("page.fillSecret reports host errors with a hint and needs host support", async () => {
  await withFixture(async (fixture) => {
    const previous = globalThis.ego;
    globalThis.ego = {
      getHostCapabilities: () => ({ fillSecret: true }),
      async fillSecret() {
        return {
          error: "secret is not registered for this origin",
          error_code: "EGO_SECRET_ORIGIN_MISMATCH",
        };
      },
    };
    try {
      const task = taskForRound(fixture, "round-a");
      const page = await openTestPage(task, "https://example.test/login");
      await assert.rejects(
        () => page.fillSecret("#password", "other-site"),
        (error) => {
          assert.equal(error.error_code, "EGO_SECRET_ORIGIN_MISMATCH");
          assert.match(error.hint, /origins it was stored for/);
          return true;
        },
      );
    } finally {
      globalThis.ego = previous;
    }
    const plain = taskForRound(fixture, "round-b", {
      hostCapabilities: () => ({}),
    });
    const page = await openTestPage(plain, "https://example.test/login");
    await assert.rejects(
      () => page.fillSecret("#password", "x"),
      (error) => error.error_code === "EGO_UNSUPPORTED_ON_HOST",
    );
  });
});

test("finishing an ephemeral space reports it closed, even with keep: all", async () => {
  await withFixture(async (fixture) => {
    const lifecycle = [];
    const task = createTaskSpaceHandle(
      { id: 7, name: "throwaway", ownership: "agent", profileId: "ephemeral" },
      {
        ledger: new PageLedgerStore({ rootDir: fixture.rootDir }),
        ...fixture.services,
        async completeTaskSpace() {
          lifecycle.push("finish");
        },
        async closeTaskSpace() {
          lifecycle.push("close");
        },
      },
    );
    assert.equal(task.profileId, "ephemeral");
    const page = await openTestPage(task, "https://example.test/one");
    const receipt = await task.finish({ keep: "all" });
    assert.deepEqual(receipt, {
      spaceId: 7,
      closedSpace: true,
      keptManagedLabels: [],
      closedManagedLabels: [page.label],
      preservedUnmanagedCount: 0,
    });
    assert.deepEqual(lifecycle, ["finish"]);
  });
});
